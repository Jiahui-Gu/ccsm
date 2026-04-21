import * as fs from 'fs';
import * as path from 'path';

/**
 * Security boundary for the renderer-exposed memory:* IPC family.
 *
 * The renderer can ask us to read/write only files named `CLAUDE.md`.
 * Anything else — a parent directory traversal attempt, a different
 * filename, a UNC path on Windows — MUST be rejected. We do the check
 * here, not at the IPC layer, so unit tests can cover it directly.
 *
 * Accepted shapes:
 *   - Absolute path whose basename is exactly `CLAUDE.md`.
 *
 * Rejected shapes:
 *   - Relative paths (no way to resolve without leaking cwd semantics).
 *   - Paths whose basename differs even by case (`claude.md`, `Claude.md`).
 *   - Paths whose normalized form contains `..` (belt-and-braces — even
 *     after basename check we don't want attackers to rely on OS resolution
 *     quirks to smuggle a traversal through).
 */
export function isAllowedMemoryPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0) return false;
  // Must be absolute to avoid ambiguous-cwd behavior across platforms.
  if (!path.isAbsolute(p)) return false;
  const normalized = path.normalize(p);
  // Disallow anything that looks like it's trying to traverse after
  // normalization (normalize usually collapses `..` but on symlinked
  // structures attackers might still smuggle one in).
  if (normalized.split(path.sep).some((seg) => seg === '..')) return false;
  // Case-sensitive basename — `CLAUDE.md` only. Claude CLI itself is strict
  // about this filename, so relaxing case here would be a silent divergence.
  if (path.basename(normalized) !== 'CLAUDE.md') return false;
  return true;
}

export type MemoryRead =
  | { ok: true; content: string; exists: true }
  | { ok: true; content: ''; exists: false }
  | { ok: false; error: string };

export function readMemoryFile(p: string): MemoryRead {
  if (!isAllowedMemoryPath(p)) {
    return { ok: false, error: 'invalid_path' };
  }
  try {
    if (!fs.existsSync(p)) {
      return { ok: true, content: '', exists: false };
    }
    const content = fs.readFileSync(p, 'utf8');
    return { ok: true, content, exists: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'read_failed' };
  }
}

export type MemoryWrite =
  | { ok: true }
  | { ok: false; error: string };

export function writeMemoryFile(p: string, content: string): MemoryWrite {
  if (!isAllowedMemoryPath(p)) {
    return { ok: false, error: 'invalid_path' };
  }
  if (typeof content !== 'string') {
    return { ok: false, error: 'invalid_content' };
  }
  try {
    // Ensure the parent directory exists — for user-memory at ~/.claude
    // it might not (fresh install with no prior Claude CLI use).
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'write_failed' };
  }
}

export function memoryFileExists(p: string): boolean {
  if (!isAllowedMemoryPath(p)) return false;
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
