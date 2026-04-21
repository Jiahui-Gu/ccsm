// Helpers for the FileTree component: parse Glob/LS tool result strings into
// a flat list of paths, then build a recursive node tree.
//
// Glob output is newline-separated absolute paths.
// LS output is an ASCII-tree like:
//   - /root/path/
//     - file.ts
//     - sub/
//       - inner.ts
// The leading "NOTE:" line and any trailing blank lines are ignored.

export interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
}

const LS_INDENT = 2;

/**
 * Parse a Glob result (newline-separated paths) into a flat string[].
 * Empty lines and obvious banners ("No files found", "NOTE:") are dropped.
 */
export function parseGlobResult(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('NOTE:')) continue;
    if (/^no files? found/i.test(line)) continue;
    out.push(line);
  }
  return out;
}

/**
 * Parse an LS result into a flat list of absolute paths (files + dirs).
 * Each "- name" line is a child; indentation depth defines nesting.
 * The first "- /abs/root/" line establishes the base path.
 */
export function parseLsResult(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const stack: Array<{ depth: number; path: string }> = [];
  const out: string[] = [];
  let rootSet = false;

  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (raw.startsWith('NOTE:')) continue;
    const m = raw.match(/^(\s*)-\s+(.+?)\/?\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    const namePart = m[2];
    const isDir = /\/\s*$/.test(raw) || (!rootSet && namePart.includes('/'));
    const depth = Math.floor(indent / LS_INDENT);

    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].path : '';
    let full: string;
    if (!rootSet) {
      // The very first entry is the absolute root directory.
      full = namePart.replace(/\/+$/, '');
      rootSet = true;
    } else {
      full = parent ? `${parent}/${namePart}` : namePart;
    }
    out.push(full);
    if (isDir) stack.push({ depth, path: full });
  }
  return out;
}

/**
 * Auto-detect: if any line starts with "- ", treat as LS; otherwise Glob.
 */
export function parseFileToolResult(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const looksLikeLs = /^\s*-\s+/m.test(trimmed);
  return looksLikeLs ? parseLsResult(trimmed) : parseGlobResult(trimmed);
}

/**
 * Build a recursive tree from a flat list of paths. Paths can be a mix of
 * absolute (POSIX or Windows) and need not share a common root; the tree is
 * rooted at the longest common ancestor when one exists, else "" (virtual).
 *
 * Nodes are sorted: directories first, then files; both alphabetically
 * (case-insensitive).
 */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  if (paths.length === 0) return [];

  // Normalize separators — Windows paths from claude.exe arrive with backslash.
  const normalized = paths.map((p) => p.replace(/\\/g, '/'));

  // A path ending with "/" denotes a directory explicitly. Track which
  // segments are known-dir from the input set.
  const knownDirs = new Set<string>();
  for (const p of normalized) {
    if (p.endsWith('/')) knownDirs.add(p.replace(/\/+$/, ''));
  }

  const root: FileTreeNode = { name: '', path: '', isDir: true, children: [] };

  for (const raw of normalized) {
    const p = raw.replace(/\/+$/, '');
    if (!p) continue;
    const segments = p.split('/').filter(Boolean);
    const isAbs = raw.startsWith('/') || /^[A-Za-z]:/.test(raw);

    let cursor = root;
    let pathSoFar = isAbs && raw.startsWith('/') ? '' : '';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      pathSoFar = pathSoFar ? `${pathSoFar}/${seg}` : (isAbs && raw.startsWith('/') ? `/${seg}` : seg);
      const isLast = i === segments.length - 1;
      const expectDir = !isLast || knownDirs.has(p);
      let child = cursor.children.find((c) => c.name === seg);
      if (!child) {
        child = {
          name: seg,
          path: pathSoFar,
          isDir: expectDir,
          children: []
        };
        cursor.children.push(child);
      } else if (expectDir) {
        child.isDir = true;
      }
      cursor = child;
    }
  }

  // Collapse the tree: if root has exactly one directory child and it's the
  // common ancestor, keep that as the visible root rather than a forest.
  sortTree(root);
  return root.children;
}

function sortTree(node: FileTreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  for (const c of node.children) sortTree(c);
}

/**
 * Count total nodes in a forest (used to decide default expand state).
 */
export function countNodes(nodes: FileTreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1 + countNodes(node.children);
  }
  return n;
}
