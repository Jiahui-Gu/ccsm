import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

export type ScannableSession = {
  sessionId: string;
  cwd: string;
  title: string;
  mtime: number;
  projectDir: string;
  model: string | null;
};

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// `os.tmpdir()` is platform-aware: returns `%LOCALAPPDATA%\Temp` on Windows,
// `/tmp` on Linux, `/var/folders/.../T/` on macOS. We capture it at module
// load — it's a process-wide constant for any given user.
const TMP_ROOT = os.tmpdir();

/**
 * Heuristic filter for our own short-lived spawn cwds. Dogfood H found
 * 92% of `~/.claude/projects/` entries on a real user's machine were
 * app-spawned temporary dirs (paths like `<tmpdir>/ccsm-…` or the legacy
 * `<tmpdir>/agentory-…` from before the CCSM rename), drowning the import
 * picker in noise.
 *
 * Match conditions (any one):
 *   1. cwd starts with the platform temp dir AND a path segment begins with
 *      `ccsm-` or `agentory-` (the prefixes our own spawn helpers use today
 *      and historically).
 *   2. cwd appears under common cross-platform temp roots and matches the
 *      same segment rule. Belt-and-suspenders for cases where `os.tmpdir()`
 *      resolves to a path that doesn't match the on-disk cwd verbatim
 *      (symlinks, drive-letter casing on Windows).
 *
 * Function name kept as `isCCSMTempCwd` for low-churn — it's an internal
 * helper and renaming it cascades through every caller site for no user
 * benefit. Exported for unit testing.
 */
export function isCCSMTempCwd(cwd: string): boolean {
  if (!cwd || typeof cwd !== 'string') return false;
  // Normalise separators so the segment check works on both Windows-style
  // (`\`) and POSIX (`/`) inputs without case-folding the whole path.
  const normalized = cwd.replace(/\\/g, '/');
  // Look for any path segment that starts with `ccsm-` or the legacy
  // `agentory-` prefix — this matches every spawn flavour we use today
  // (`ccsm-A2N1-…`, `ccsm-bugl-bash`, `ccsm-probe-import-…`) and historical
  // transcripts written before the CCSM rename. The leading `/` rules out
  // matching a user-named directory like `my-agentory-project`.
  const hasTempSegment = /(^|\/)(ccsm|agentory)-/.test(normalized);
  if (!hasTempSegment) return false;
  const tmpNorm = TMP_ROOT.replace(/\\/g, '/');
  // Case-insensitive prefix on Windows (drive letter case can differ between
  // `os.tmpdir()` and what the CLI recorded). Cheap on every other platform —
  // file paths there are case-sensitive but `os.tmpdir()` returns the same
  // casing the kernel does, so the lower-cased compare still matches.
  const cwdLow = normalized.toLowerCase();
  const tmpLow = tmpNorm.toLowerCase();
  if (cwdLow.startsWith(tmpLow)) return true;
  // Belt-and-suspenders for common temp roots that `os.tmpdir()` might not
  // surface (e.g. `/tmp` on macOS where it's actually `/var/folders/...`).
  const COMMON_TEMP_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/'];
  for (const p of COMMON_TEMP_PREFIXES) {
    if (cwdLow.startsWith(p)) return true;
  }
  // Windows fallback: detect `…/AppData/Local/Temp/` regardless of drive
  // (some users' OS install lives on D: but tmpdir resolves to C:).
  if (/\/appdata\/local\/temp\//i.test(cwdLow)) return true;
  return false;
}

// Read just enough of the head of a jsonl to determine cwd + a usable title.
// CLI-written transcripts can be hundreds of MB; we never read the whole file.
const MAX_HEAD_LINES = 200;

export async function scanImportableSessions(): Promise<ScannableSession[]> {
  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(PROJECTS_ROOT);
  } catch {
    return [];
  }

  const out: ScannableSession[] = [];
  for (const dir of dirs) {
    const projDir = path.join(PROJECTS_ROOT, dir);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(projDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.slice(0, -'.jsonl'.length);
      const full = path.join(projDir, f);
      try {
        const head = await readHead(full);
        if (!head) continue;
        // Drop our own short-lived spawn cwds — they're noise to the
        // user. See `isCCSMTempCwd` for the heuristic.
        if (isCCSMTempCwd(head.cwd)) continue;
        const stat = await fs.promises.stat(full);
        out.push({
          sessionId,
          cwd: head.cwd,
          title: head.title,
          mtime: stat.mtimeMs,
          projectDir: dir,
          model: head.model
        });
      } catch {
        // skip unreadable / malformed files
      }
    }
  }

  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

type Head = { cwd: string; title: string; model: string | null };

function readHead(file: string): Promise<Head | null> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let cwd = '';
    let aiTitle = '';
    let firstUserText = '';
    let model: string | null = null;
    let lines = 0;
    let firstFrameInspected = false;
    let isSidechain = false;
    const finish = () => {
      rl.removeAllListeners();
      stream.destroy();
      // Sub-agent transcripts (those spawned by the Task tool) are not
      // independently importable — they're a slice of a parent run and
      // resuming them out of context produces nonsense. The CLI marks them
      // by setting `parentUuid` non-null OR `isSidechain: true` on the very
      // first frame. Skip those.
      if (isSidechain) {
        resolve(null);
        return;
      }
      const title = aiTitle || firstUserText || '(untitled session)';
      if (!cwd && !aiTitle && !firstUserText && !model) {
        resolve(null);
        return;
      }
      resolve({ cwd: cwd || '~', title, model });
    };
    rl.on('line', (line) => {
      lines++;
      if (lines > MAX_HEAD_LINES) {
        finish();
        return;
      }
      if (!line) return;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        return;
      }
      if (!firstFrameInspected) {
        firstFrameInspected = true;
        if (isSidechainFrame(d)) {
          isSidechain = true;
          finish();
          return;
        }
      }
      if (typeof d.cwd === 'string' && !cwd) cwd = d.cwd;
      if (d.type === 'ai-title' && typeof d.aiTitle === 'string') {
        aiTitle = d.aiTitle;
      }
      if (!firstUserText && d.type === 'user' && d.message) {
        const txt = extractUserText(d.message);
        if (txt) firstUserText = truncate(txt, 80);
      }
      if (!model) {
        const m = extractModel(d);
        if (m) model = m;
      }
      if (cwd && aiTitle && model) {
        finish();
      }
    });
    rl.on('close', finish);
    rl.on('error', () => resolve(null));
  });
}

function extractUserText(message: any): string {
  const c = message?.content;
  if (typeof c === 'string') return cleanCommandWrapper(c);
  if (!Array.isArray(c)) return '';
  for (const part of c) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      const cleaned = cleanCommandWrapper(part.text);
      if (cleaned) return cleaned;
    }
  }
  return '';
}

// Slash-command lines are wrapped in <command-name>...</command-name> XML and
// look like noise as titles. Skip them.
function cleanCommandWrapper(text: string): string {
  if (text.startsWith('<command-')) return '';
  return text.trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Derive a frequency-ranked list of recently-used cwds from a scan result.
 *
 * Algorithm (task #293 — dogfood-driven default-cwd correctness):
 *   1. Take the last `windowSize=10` sessions by mtime (most-recent first).
 *   2. Count how often each cwd appears in that window.
 *   3. Return the top `max=10` cwds sorted by frequency desc, ties broken by
 *      most-recent occurrence so a directory the user just opened wins over
 *      an equally-frequent but stale one.
 *
 * Why frequency over pure recency: a one-off `cd` into a side project
 * shouldn't override the directory the user actually works in 9 days out
 * of 10. The CLI transcript history is exactly the right signal for "where
 * does this user usually work" — we just had to read it correctly.
 *
 * Drops placeholder `~` entries the scanner emits when no `cwd` field was
 * found in the transcript head; those would default the picker to the
 * user's home dir, which is rarely useful.
 */
export function deriveRecentCwds(
  sessions: ReadonlyArray<Pick<ScannableSession, 'cwd' | 'mtime'>>,
  max = 10,
  windowSize = 10
): string[] {
  if (sessions.length === 0) return [];
  const ordered = [...sessions].sort((a, b) => b.mtime - a.mtime).slice(0, windowSize);
  const counts = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  for (const s of ordered) {
    const cwd = s.cwd;
    if (!cwd || cwd === '~') continue;
    counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
    if (!lastSeen.has(cwd)) lastSeen.set(cwd, s.mtime);
  }
  if (counts.size === 0) return [];
  const ranked = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return (lastSeen.get(b[0]) ?? 0) - (lastSeen.get(a[0]) ?? 0);
  });
  return ranked.slice(0, max).map(([cwd]) => cwd);
}

// A frame written by the CLI for a sub-agent (Task tool spawn) carries either
// `parentUuid` (non-null string) or `isSidechain: true` on its first line.
// Keep this loose — the CLI only sets the field on sub-agent transcripts and
// regular sessions emit `parentUuid: null` (or omit it entirely).
export function isSidechainFrame(d: unknown): boolean {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  if (o.isSidechain === true) return true;
  if (typeof o.parentUuid === 'string' && o.parentUuid.length > 0) return true;
  return false;
}

// Pure head-parsing helper, exported for unit testing. Given an array of jsonl
// lines (already parsed-back-to-strings or raw), return the same Head shape
// the streaming reader produces.
export function parseHead(lines: string[]): Head | null {
  let cwd = '';
  let aiTitle = '';
  let firstUserText = '';
  let model: string | null = null;
  let firstFrameInspected = false;
  for (let i = 0; i < lines.length && i < MAX_HEAD_LINES; i++) {
    const line = lines[i];
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!firstFrameInspected) {
      firstFrameInspected = true;
      if (isSidechainFrame(d)) return null;
    }
    if (typeof d.cwd === 'string' && !cwd) cwd = d.cwd;
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string') aiTitle = d.aiTitle;
    if (!firstUserText && d.type === 'user' && d.message) {
      const txt = extractUserText(d.message);
      if (txt) firstUserText = truncate(txt, 80);
    }
    if (!model) {
      const m = extractModel(d);
      if (m) model = m;
    }
    if (cwd && aiTitle && model) break;
  }
  if (!cwd && !aiTitle && !firstUserText && !model) return null;
  const title = aiTitle || firstUserText || '(untitled session)';
  return { cwd: cwd || '~', title, model };
}

// CLI transcripts carry the model on assistant frames as `message.model`.
// Some older / synthetic frames may put it at the top level — accept both.
function extractModel(d: any): string | null {
  if (typeof d?.message?.model === 'string' && d.message.model) return d.message.model;
  if (typeof d?.model === 'string' && d.model) return d.model;
  return null;
}
