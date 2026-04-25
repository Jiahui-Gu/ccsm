import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

/**
 * Stream-parse a session's JSONL transcript from `~/.claude/projects/<key>/<sid>.jsonl`
 * and return the raw frames (one per non-empty line). The CLI / Agent SDK
 * is the writer — ccsm just reads. This replaces the SQLite `messages`
 * table that ccsm used to maintain alongside the on-disk transcript: the
 * SQLite copy was always a redundant secondary write of data the CLI was
 * already persisting. Renderer projects these frames into MessageBlock via
 * `framesToBlocks` (same path as the import flow).
 *
 * Returned shape is `unknown[]`: each element is whatever JSON.parse of one
 * JSONL line yielded. The renderer's `framesToBlocks` already tolerates
 * mixed/unknown frame types and silently no-ops on anything it doesn't
 * recognise, so we don't pre-filter here. Malformed lines are skipped with
 * a console warning rather than aborting the whole load — a single bad
 * line shouldn't blank an otherwise-valid session.
 */
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// Cap per session. Mirrors the cap in `import-history.ts` — well past any
// realistic conversation length while still bounding memory if a JSONL
// happens to be pathological. Same value, same rationale.
const MAX_FRAMES = 50_000;

/**
 * Convert a session's `cwd` into the project-key folder name the CLI uses
 * under `~/.claude/projects/`. The CLI's slug rule (verified empirically
 * against a real `~/.claude/projects/` listing on Windows + macOS) replaces
 * `/`, `\`, and `:` with `-`. Examples:
 *   `C:\Users\jiahuigu\ccsm-research\ccsm` → `C--Users-jiahuigu-ccsm-research-ccsm`
 *   `/Users/x/proj`                        → `-Users-x-proj`
 * Exported for unit testing — also used on the renderer side via IPC so we
 * keep the slug logic in exactly one place.
 */
export function projectKeyFromCwd(cwd: string): string {
  if (!cwd || typeof cwd !== 'string') return '';
  return cwd.replace(/[\\/:]/g, '-');
}

export type LoadHistoryResult =
  | { ok: true; frames: unknown[] }
  | { ok: false; error: 'invalid_args' | 'not_found' | 'read_error'; detail?: string };

/**
 * Load a session's JSONL frames given its `cwd` (used to derive the project
 * folder) and `sessionId` (the JSONL filename, sans extension). Returns a
 * tagged result so the renderer can distinguish "no transcript yet" (newly
 * spawned session that hasn't received its first frame) from a real read
 * error (permission, malformed path).
 *
 *   - `not_found` — file doesn't exist (newly spawned session, or the user
 *     never ran this session through the CLI). Renderer treats as empty.
 *   - `read_error` — fs error other than ENOENT. Renderer surfaces via
 *     `LoadHistoryErrorBlock`.
 */
export async function loadHistoryFromJsonl(
  cwd: string,
  sessionId: string
): Promise<LoadHistoryResult> {
  // Reject any path component that would let a malicious renderer break out
  // of `~/.claude/projects/`. Same defense-in-depth as `import-history.ts`.
  const safeKey = path.basename(projectKeyFromCwd(cwd));
  const safeSid = path.basename(String(sessionId ?? ''));
  if (!safeKey || !safeSid) return { ok: false, error: 'invalid_args' };
  if (safeKey.includes('..') || safeSid.includes('..')) {
    return { ok: false, error: 'invalid_args' };
  }
  const file = path.join(PROJECTS_ROOT, safeKey, `${safeSid}.jsonl`);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(PROJECTS_ROOT) + path.sep)) {
    return { ok: false, error: 'invalid_args' };
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { ok: false, error: 'not_found' };
    return { ok: false, error: 'read_error', detail: code ?? String(err) };
  }
  if (!stat.isFile()) return { ok: false, error: 'not_found' };

  return new Promise((resolve) => {
    const stream = fs.createReadStream(resolved, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const out: unknown[] = [];
    let count = 0;
    let errored = false;
    const finish = () => {
      rl.removeAllListeners();
      stream.destroy();
      if (errored) return; // already resolved
      resolve({ ok: true, frames: out });
    };
    rl.on('line', (line) => {
      if (!line) return;
      if (count >= MAX_FRAMES) {
        finish();
        return;
      }
      count++;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Skip malformed lines — same policy as scan / import readers.
      }
    });
    rl.on('close', finish);
    stream.on('error', (err) => {
      if (errored) return;
      errored = true;
      rl.removeAllListeners();
      stream.destroy();
      const code = (err as NodeJS.ErrnoException)?.code;
      resolve({ ok: false, error: 'read_error', detail: code ?? err.message });
    });
  });
}
