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
  opts?: {
    cols?: number;
    rows?: number;
    onCwdRedirect?: (newCwd: string) => void;
    /** When set, spawn args include `--resume <forkSourceSid> --fork-session
     *  --session-id <sid>` so the new session boots with the source's
     *  transcript but writes a fresh JSONL keyed to `sid`. Threaded through
     *  to `makeEntry` — see entryFactory.ts for the flag-picker. */
    forkSourceSid?: string;
  },
): PtySessionInfo {
  const existing = sessions.get(sid);
  if (existing) return infoFromEntry(sid, existing);
  const cols = opts?.cols ?? DEFAULT_COLS;
  const rows = opts?.rows ?? DEFAULT_ROWS;
  const entry = makeEntry(
    sid,
    cwd,
    claudePath,
    cols,
    rows,
    {
      onExit: (s) => { sessions.delete(s); },
      onCwdRedirect: opts?.onCwdRedirect,
    },
    opts?.forkSourceSid,
  );
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

// Graceful-flush + teardown budget. Reload now sends a soft signal (Ctrl+C
// via PTY — see `\x03` write in `kill()`) instead of going straight to
// `pty.kill()`, which on Windows ConPTY translates to `TerminateProcess` and
// delivers no signal to the child. The claude CLI's transcript writer
// (`Km_`) buffers JSONL entries with a 100 ms `setTimeout` → `appendFile`
// (no fsync), and its SIGINT/SIGTERM/SIGBREAK/SIGHUP handlers each await a
// flush with a ~2 s internal budget. Without a graceful signal those queued
// entries (plus any mid-stream tokens) are lost — after respawn
// `claude --resume <sid>` reads JSONL from disk, so the missing tail is gone
// permanently.
//
// 3 s comfortably covers claude's 2 s flush window plus margin for OS
// write-back / processKiller subtree walk on slow Windows boxes, while
// staying short enough that a wedged kill doesn't feel broken (renderer
// still falls through to the spawn-on-null fallback via the timer-branch
// hard-kill below).
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

  // Capture pid BEFORE pty.write/kill — the binding may zero it after either
  // (signal dispatch and explicit kill both can clear pid in node-pty).
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

  const timer = setTimeout(() => {
    // Wedged-pty zombie cleanup (#1277 follow-up): the 3s timeout fired
    // before onExit, which means the cleanup pump in entryFactory never
    // ran and `sessions` still holds this sid. If we just resolved here a
    // subsequent `pty:attach` from the renderer's reloadNonce bump would
    // return the zombie entry, skip the spawn-on-null fallback, and
    // register the viewer on a dead pty → crash overlay, manual Retry.
    //
    // Force-evict the entry so attach returns null and the renderer gets
    // a transparent fresh PTY. The soft `\x03` signal didn't reap the
    // process inside the flush budget — escalate to hard kill + subtree
    // walk. On Windows node-pty emulates signals so SIGKILL may be a
    // no-op, in which case `killProcessSubtree` (platform-native: taskkill
    // /T /F on Windows, killpg on Unix) is what actually reaps the tree.
    try {
      entry.pty.kill('SIGKILL');
    } catch (e) {
      console.warn(
        `[ptyHost] kill ${sid} wedged: SIGKILL also failed (${e instanceof Error ? e.message : String(e)}); pid ${pid} may leak`,
      );
    }
    // ConPTY's kill only terminates the cmd.exe / OpenConsole wrapper; on
    // Windows the claude.exe child (and its grandchildren) survive as
    // orphans. On mac/linux the pgid may also have stragglers. Walk the
    // tree via a platform-native call to guarantee a clean shutdown.
    // Deferred to the hard-fallback branch ONLY — running this on the
    // graceful path would kill claude mid-flush and defeat the soft-signal
    // strategy.
    killProcessSubtree(pid);
    if (sessions.get(sid) === entry) sessions.delete(sid);
    settle(false);
  }, KILL_EXIT_TIMEOUT_MS);

  // Soft signal: write Ctrl+C (`\x03`) to the PTY. On Windows ConPTY this is
  // translated on stdin into a console CTRL_C_EVENT → SIGINT to the child;
  // on Unix the terminal line discipline converts `\x03` to SIGINT for the
  // foreground process group. One code path, both platforms — no FFI, no
  // `process.kill` differences. claude registers SIGINT/SIGTERM/SIGBREAK/
  // SIGHUP handlers that all funnel into `nK(code)` → awaits `dWH.flush()`
  // (2 s internal budget), so this is the signal that lets the 100 ms
  // buffered transcript writer drain before exit. If the process is already
  // dead the write throws — the onExit listener or the timer covers us.
  //
  // NOTE: this assumes interactive claude. Claude's `-p` / `--print`
  // non-interactive mode ignores SIGINT (it's designed to run to completion
  // for scripting). CCSM never spawns claude in print mode — every PTY
  // session is a fully interactive REPL — but if that ever changes the
  // graceful path here needs to be reconsidered.
  try {
    entry.pty.write('\x03');
  } catch {
    /* already dead — onExit may or may not fire; timeout covers us */
  }
  // Belt-and-braces: stop the watcher synchronously here so a write that
  // races with onExit can't leak the fs.watch handle.
  // sessionWatcher.stopWatching is idempotent. Stopping the JSONL watcher
  // does not interfere with claude's own writes — it just closes our
  // observer-side fs.watch handle.
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

  // Round-4 fix (PR #1355 dogfood): `entry.seq` is bumped synchronously
  // by `dispatchPtyChunk` BEFORE the chunk is fully absorbed by
  // `entry.headless.write` (xterm.js `write` is async — the chunk goes
  // into an internal WriteBuffer that drains on a parser tick). Under a
  // fast-burst producer, `entry.seq` can advance past what
  // `entry.serialize.serialize()` will produce, because the headless
  // buffer hasn't parsed those bytes yet. The renderer's dedupe gate
  // (`seq > snapSeq` drops buffered chunks at or below snapSeq) then
  // discards live chunks whose content was supposed to be in the
  // snapshot but in fact wasn't — every byte from those chunks vanishes.
  //
  // Verified empirically: dogfood validator with a stub bursting 200
  // lines reproduces "23 chunks / 14650 bytes broadcast, 0 visible in
  // the warm entry's buffer." Real claude doesn't reproduce because
  // its inter-chunk pacing exceeds the headless parser tick.
  //
  // Fix: drain the headless parser queue BEFORE capturing seq. Write a
  // zero-length chunk; xterm processes writes in FIFO order, so its
  // callback fires only after every previously-queued chunk has been
  // parsed into the buffer. THEN read `entry.seq` and serialize — at
  // that point seq reflects "the seq of the last chunk fully
  // represented in the serialize output." Node main is single-threaded
  // JS, so no `dispatchPtyChunk` can interleave between the drain
  // resolving and the synchronous seq+serialize read on the next line.
  //
  // Typically completes in one parser tick (≤12ms); 250ms ceiling guards
  // against a wedged parser so the snapshot IPC can never hang forever.
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    const timer = setTimeout(finish, 250);
    try {
      entry.headless.write('', () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      // headless was disposed mid-call — resolve so the caller can
      // proceed with whatever serialize() can still produce. The
      // surrounding caller handles `snapshot === ''` gracefully.
      clearTimeout(timer);
      finish();
    }
  });

  // Capture seq + serialized string atomically (both sync, no awaits).
  // DO NOT add awaits between the drain above and this seq capture —
  // any yield here re-introduces the async race the drain just closed.
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

// Kill every running pty. Returns a Promise that resolves after every
// per-session `kill()` has settled (graceful onExit or 3 s wedged-fallback).
// Callers that need to block app teardown on the flush (e.g. `before-quit`)
// MUST `await` this; legacy fire-and-forget call sites can `void killAll(...)`.
//
// Rationale: `kill()` now writes `\x03` and waits up to KILL_EXIT_TIMEOUT_MS
// for claude to drain its 100 ms-buffered JSONL writer. If `before-quit`
// returned synchronously the way the pre-graceful code did, the Electron
// process would exit before the timer ran and claude would be killed by
// process teardown without ever flushing — worse than the old hard-kill
// path. The hide-the-window-then-await-quit dance in `appLifecycle.ts`
// keeps the UX instant while honoring the flush budget in the background.
export function killAll(sessions: Map<string, Entry>): Promise<void> {
  const sids = [...sessions.keys()];
  return Promise.all(sids.map((sid) => kill(sessions, sid))).then(() => undefined);
}
