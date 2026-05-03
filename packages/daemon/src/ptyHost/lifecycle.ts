// Lifecycle ops over the per-session Entry registry.
//
// Extracted from electron/ptyHost/index.ts (Task #738 Phase B). Each function
// takes the `sessions` Map as its first argument and otherwise has no module
// state — index.ts owns the singleton map and binds these into the public
// API. Keeping them pure-of-module-state makes the lifecycle layer
// independently testable and lets a future ptyHost replacement (e.g. a
// multi-process pool) swap registries without rewriting the operations.
//
// The `spawn` op delegates Entry construction to entryFactory.makeEntry; the
// rest are direct map / pty.* operations. Process-tree cleanup on `kill`
// goes through processKiller (Phase A helper).

import { sessionWatcher } from '../sessionWatcher/index.js';
import { killProcessSubtree } from './processKiller.js';
import { DEFAULT_COLS, DEFAULT_ROWS, makeEntry } from './entryFactory.js';
import type { Entry } from './entryFactory.js';

export interface PtySessionInfo {
  sid: string;
  pid: number;
  cols: number;
  rows: number;
  /** Working directory the PTY was actually spawned with (post-`resolveSpawnCwd`
   *  fallback). Diverges from the renderer's `session.cwd` ONLY when the
   *  requested cwd was missing/unreadable, in which case `resolveSpawnCwd`
   *  falls back to homedir. Surfaced so e2e probes can verify that picked
   *  cwds reach the real PTY (#628). */
  cwd: string;
}

export interface AttachResult {
  snapshot: string;
  cols: number;
  rows: number;
  pid: number;
}

function infoFromEntry(sid: string, e: Entry): PtySessionInfo {
  return { sid, pid: e.pty.pid, cols: e.cols, rows: e.rows, cwd: e.cwd };
}

export function spawn(
  sessions: Map<string, Entry>,
  sid: string,
  cwd: string,
  claudePath: string,
  opts?: { cols?: number; rows?: number; onCwdRedirect?: (newCwd: string) => void },
): PtySessionInfo {
  const existing = sessions.get(sid);
  if (existing) return infoFromEntry(sid, existing);
  const cols = opts?.cols ?? DEFAULT_COLS;
  const rows = opts?.rows ?? DEFAULT_ROWS;
  const entry = makeEntry(sid, cwd, claudePath, cols, rows, {
    onExit: (s) => { sessions.delete(s); },
    onCwdRedirect: opts?.onCwdRedirect,
  });
  sessions.set(sid, entry);
  return infoFromEntry(sid, entry);
}

export function list(sessions: Map<string, Entry>): PtySessionInfo[] {
  return Array.from(sessions.entries()).map(([sid, e]) => infoFromEntry(sid, e));
}

export function attach(sessions: Map<string, Entry>, sid: string): AttachResult | null {
  const entry = sessions.get(sid);
  if (!entry) return null;
  // Caller registers their webContents via the IPC handler (see
  // registerPtyHostIpc) — the bare API only returns the snapshot. Renderer
  // tests can use this without an IPC round-trip.
  return {
    snapshot: entry.serialize.serialize(),
    cols: entry.cols,
    rows: entry.rows,
    pid: entry.pty.pid,
  };
}

export function detach(_sessions: Map<string, Entry>, sid: string): void {
  // No-op at the API level — IPC handler clears the per-webContents
  // registration. Kept on the surface so the preload bridge has a symmetric
  // attach/detach pair.
  void sid;
}

export function input(sessions: Map<string, Entry>, sid: string, data: string): void {
  const entry = sessions.get(sid);
  if (!entry) return;
  try {
    entry.pty.write(data);
  } catch {
    /* pty already exited — exit handler will clean up */
  }
}

export function resize(
  sessions: Map<string, Entry>,
  sid: string,
  cols: number,
  rows: number,
): void {
  const entry = sessions.get(sid);
  if (!entry) return;
  if (cols < 2 || rows < 2) return;
  try {
    entry.pty.resize(cols, rows);
    entry.headless.resize(cols, rows);
    entry.cols = cols;
    entry.rows = rows;
  } catch (e) {
    console.warn(
      `[ptyHost] resize ${sid} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function kill(sessions: Map<string, Entry>, sid: string): boolean {
  const entry = sessions.get(sid);
  if (!entry) return false;
  // Capture pid BEFORE pty.kill() — the binding may zero it after kill.
  const pid = entry.pty.pid;
  try {
    entry.pty.kill();
  } catch {
    /* already dead */
  }
  // ConPTY's kill only terminates the cmd.exe / OpenConsole wrapper; on Windows
  // the claude.exe child (and its grandchildren) survive as orphans. On
  // mac/linux the pgid may also have stragglers. Walk the tree via a
  // platform-native call to guarantee a clean shutdown.
  killProcessSubtree(pid);
  // Belt-and-braces: also stop the watcher synchronously here so a
  // pty.kill that races with onExit can't leak the fs.watch handle.
  // sessionWatcher.stopWatching is idempotent.
  try { sessionWatcher.stopWatching(sid); } catch { /* never throws */ }
  return true;
}

export function get(sessions: Map<string, Entry>, sid: string): PtySessionInfo | null {
  const entry = sessions.get(sid);
  if (!entry) return null;
  return infoFromEntry(sid, entry);
}

// L4 PR-A (#861) + PR-B (#865): async, chunked snapshot of the headless
// authoritative buffer, paired with the per-entry monotonic chunk seq.
//
// SerializeAddon.serialize() itself is synchronous and walks the entire
// scrollback (cap 10000 lines). With the bumped cap the serialized string can
// reach ~MBs for long sessions; concatenating + handing back the full string
// in one tick would briefly block the main thread. We yield to the event loop
// every CHUNK_LINES (~1000) lines via setImmediate so other I/O (IPC, JSONL
// tail, OSC sniffer fanout) keeps making progress while a large snapshot is
// being assembled. The returned value is still the FULL serialized string —
// chunking is purely a yield strategy, not a streaming protocol.
//
// PR-B adds the `seq` field: captured ATOMICALLY with `serialize.serialize()`
// (both happen synchronously, no chunk can arrive between them under Node's
// single-threaded event loop). The renderer compares each live `pty:data`
// chunk's seq against this value to drop chunks already baked into the
// snapshot, eliminating the race between attach-fanout and snapshot read.
//
// Returns `{snapshot:'', seq:0}` when the sid isn't registered (callers
// treat empty as "no snapshot available", same as `attach` returning null).
export const SNAPSHOT_CHUNK_LINES = 1000;

export interface BufferSnapshot {
  snapshot: string;
  /** Value of `entry.seq` at the moment `serialize.serialize()` ran. Live
   *  chunks delivered with `seq <= snapshot.seq` are already represented
   *  in `snapshot` and must be dropped by the renderer; chunks with
   *  `seq > snapshot.seq` are the post-snapshot live tail and must be
   *  written after the snapshot. */
  seq: number;
}

export async function getBufferSnapshot(
  sessions: Map<string, Entry>,
  sid: string,
): Promise<BufferSnapshot> {
  const entry = sessions.get(sid);
  if (!entry) return { snapshot: '', seq: 0 };
  // Capture seq + serialized string atomically (both sync, no awaits).
  const seq = entry.seq;
  const full = entry.serialize.serialize();
  if (!full) return { snapshot: '', seq };
  // Split on '\n' so we yield on a line boundary; preserves the original
  // separator on rejoin. setImmediate is available in Electron main (Node
  // event loop). We deliberately avoid Promise.resolve()-style microtask
  // yields — those don't drain macrotask I/O.
  const lines = full.split('\n');
  if (lines.length <= SNAPSHOT_CHUNK_LINES) return { snapshot: full, seq };
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += SNAPSHOT_CHUNK_LINES) {
    out.push(lines.slice(i, i + SNAPSHOT_CHUNK_LINES).join('\n'));
    if (i + SNAPSHOT_CHUNK_LINES < lines.length) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return { snapshot: out.join('\n'), seq };
}

// Kill every running pty. Call from app `before-quit` so renderer-side
// claude processes don't leak past Electron exit.
export function killAll(sessions: Map<string, Entry>): void {
  for (const sid of [...sessions.keys()]) {
    kill(sessions, sid);
  }
}
