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

import { sessionWatcher } from '../sessionWatcher';
import { killProcessSubtree } from './processKiller';
import { DEFAULT_COLS, DEFAULT_ROWS, makeEntry } from './entryFactory';
import type { Entry } from './entryFactory';
import { loadScrollbackLines } from '../prefs/scrollback';

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
  // #888 follow-up: the legacy `snapshot` field was removed. The renderer
  // already paints from `getBufferSnapshot` (PR-B contract) and discarded
  // the attach-time snapshot, so serializing the (potentially 10K-line)
  // headless buffer here was pure waste — it produced 1 of 2-3 main-process
  // serialize calls per attach. The visible-buffer paint pipeline is
  // unchanged: attach registers the wc; the renderer drives the buffered-
  // listener + getBufferSnapshot + drain sequence.
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
  // registerPtyHostIpc) — the bare API only returns the entry geometry.
  // The visible-buffer paint goes through `getBufferSnapshot` (PR-B);
  // we deliberately do NOT serialize the headless buffer here.
  return {
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

// Max wait for pty.onExit to fire after kill() before we give up and resolve
// the kill promise anyway. The renderer awaits `kill(sid)` before bumping
// reloadNonce; if the pty is wedged we still want the renderer to fall through
// to the spawn-on-null fallback rather than hanging the UI. 3s comfortably
// covers ConPTY teardown + processKiller subtree walk on slow Windows boxes
// while staying short enough that a stuck kill doesn't feel broken.
export const KILL_EXIT_TIMEOUT_MS = 3000;

// Dedupe re-entrant kills for the same sid (e.g. user spam-clicks Reload).
// Keyed by `sessions` Map so multiple registries (tests) don't collide.
const pendingKills: WeakMap<Map<string, Entry>, Map<string, Promise<boolean>>> =
  new WeakMap();

function getPendingKills(sessions: Map<string, Entry>): Map<string, Promise<boolean>> {
  let m = pendingKills.get(sessions);
  if (!m) {
    m = new Map();
    pendingKills.set(sessions, m);
  }
  return m;
}

export function kill(sessions: Map<string, Entry>, sid: string): Promise<boolean> {
  const inflight = getPendingKills(sessions).get(sid);
  if (inflight) return inflight;

  const entry = sessions.get(sid);
  if (!entry) return Promise.resolve(false);

  // Capture pid BEFORE pty.kill() — the binding may zero it after kill.
  const pid = entry.pty.pid;

  // Race fix (#1277 review): pty.kill() returns synchronously but the entry
  // is removed from `sessions` only when the onExit pump in entryFactory
  // fires (async). Without awaiting that, a renderer doing
  // `await ccsmPty.kill(sid)` then re-attaching can land on the dying entry,
  // skip the spawn-on-null fallback, and end up registered to a dead pty
  // that immediately fires pty:exit → user sees a crash overlay. Hold the
  // kill IPC open until either onExit fires (entry removed, headless
  // disposed, watchers stopped) or KILL_EXIT_TIMEOUT_MS elapses.
  //
  // We register the promise in `pendingKills` BEFORE side effects so a
  // concurrent caller dedupes correctly; we delete the slot inside `settle`
  // AFTER `resolve()`. Order matters: with a sync `pty.kill()` mock that
  // fires `onExit` immediately, settle runs inside the Promise executor,
  // so the slot must already exist when settle fires (otherwise the slot
  // delete is a no-op then a stale `set` re-inserts a resolved promise,
  // and the next `kill()` for the same sid short-circuits forever).
  let resolveOuter!: (v: boolean) => void;
  const promise = new Promise<boolean>((r) => { resolveOuter = r; });
  getPendingKills(sessions).set(sid, promise);

  let settled = false;
  let exitDisposable: { dispose(): void } | undefined;
  const settle = (v: boolean) => {
    if (settled) return;
    settled = true;
    // Best-effort dispose of the listener; if the binding's onExit already
    // fired and disposed itself this is a no-op.
    try { exitDisposable?.dispose(); } catch { /* ignore */ }
    clearTimeout(timer);
    // Free the dedup slot BEFORE resolving so anything `await kill()`s
    // and immediately calls `kill()` again (e.g. spawn-on-null then
    // user-driven reload) gets a fresh kill, not a no-op short-circuit.
    if (getPendingKills(sessions).get(sid) === promise) {
      getPendingKills(sessions).delete(sid);
    }
    resolveOuter(v);
  };

  try {
    exitDisposable = entry.pty.onExit(() => settle(true));
  } catch {
    /* onExit registration failed (already-exited binding) — fall through;
       the timeout will resolve us, and processKiller below still runs. */
  }

  const timer = setTimeout(() => settle(false), KILL_EXIT_TIMEOUT_MS);

  try {
    entry.pty.kill();
  } catch {
    /* already dead — onExit may or may not fire; timeout covers us */
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

  return promise;
}

export function get(sessions: Map<string, Entry>, sid: string): PtySessionInfo | null {
  const entry = sessions.get(sid);
  if (!entry) return null;
  return infoFromEntry(sid, entry);
}

// L4 PR-A (#861) + PR-B (#865): async, chunked snapshot of the headless
// authoritative buffer, paired with the per-entry monotonic chunk seq.
//
// SerializeAddon.serialize() itself is synchronous and walks the requested
// rows from the bottom of the scrollback (cap configurable via the
// `scrollbackLines` user preference, default 1500 — see
// `electron/prefs/scrollback.ts`). With the bumped cap the serialized
// string can still reach hundreds of KB; concatenating + handing back the
// full string in one tick would briefly block the main thread. We yield
// to the event loop every CHUNK_LINES (~1000) lines via setImmediate so
// other I/O (IPC, JSONL tail, OSC sniffer fanout) keeps making progress
// while a large snapshot is being assembled. The returned value is still
// the FULL serialized string — chunking is purely a yield strategy, not
// a streaming protocol.
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
  // PR-B contract: serialize captures whatever lives in the headless buffer
  // at this instant, paired with `seq`. We bound the payload to the user's
  // configured scrollback cap (last N rows from the bottom of the scrollback)
  // so a long-running session doesn't return MB of lines on every attach.
  // Cap honors the live setting (read fresh per call), so the user's
  // change takes effect on the next attach without restarting the entry.
  const full = entry.serialize.serialize({ scrollback: loadScrollbackLines() });
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
// claude processes don't leak past Electron exit. Fire-and-forget — we don't
// block app teardown on the per-pty onExit/timeout dance; the kill signal +
// processKiller subtree walk dispatch synchronously inside `kill()` before
// the awaited onExit, which is what actually reaps the children.
export function killAll(sessions: Map<string, Entry>): void {
  for (const sid of [...sessions.keys()]) {
    void kill(sessions, sid);
  }
}
