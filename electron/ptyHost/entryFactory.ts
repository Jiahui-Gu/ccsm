// Per-session Entry construction.
//
// Extracted from electron/ptyHost/index.ts (Task #738 Phase B). The factory
// owns the wiring of one PTY: it picks --resume vs --session-id, ensures the
// import-resume JSONL is co-located with the spawn cwd's projectDir,
// constructs the headless mirror, attaches the data/exit pumps, and starts
// the JSONL tail-watcher.
//
// Side effects (sessions-map mutation, broadcast IPC) are NOT performed here;
// the caller passes:
//   - `onExit(sid)` — invoked AFTER the headless is disposed and per-attached
//     `pty:exit` broadcast has fanned out, so the caller can drop the entry
//     from its registry.
//   - `onCwdRedirect(newCwd)` — bubbled up to the renderer when the import
//     resume helper actually copied the JSONL into a new projectDir (#603).
//
// Keeping the factory I/O-typed via callbacks (rather than reaching back into
// index.ts) makes it unit-testable without an Electron runtime.
//
// SRP: single responsibility = "build one Entry"; lifecycle ops over the
// registry live in lifecycle.ts.

import * as pty from 'node-pty';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { WebContents } from 'electron';
import { sessionWatcher } from '../sessionWatcher';
import {
  ensureResumeJsonlAtSpawnCwd,
  findJsonlForSid,
  resolveJsonlPath,
  toClaudeSid,
} from './jsonlResolver';
import { resolveSpawnCwd } from './cwdResolver';
import { emitPtyData } from './dataFanout';

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;
// L4 PR-A (#861): scrollback bumped from 5000 -> 10000 lines so the headless
// terminal becomes a session-level authoritative buffer suitable for serving
// re-attach replays, not just the live screen. 10000 was 80/20-decided by the
// owner; bump only here and in any future replay-budget calculation.
export const SCROLLBACK = 10000;

// L4 PR-C (#863): when the visible xterm cannot keep up with PTY output the
// headless mirror's `write(data, cb)` callback is invoked asynchronously.
// We track the number of in-flight (pending-callback) headless writes per
// entry and `console.warn` once each time the count crosses this threshold,
// so production lag is observable without dropping any data. Threshold of
// 100 chunks is a coarse "something is wrong" signal — typical busy PTY
// bursts settle in <10 pending writes. Re-arms after the count drains back
// below the threshold.
export const BACKPRESSURE_WARN_THRESHOLD = 100;

export interface Entry {
  pty: pty.IPty;
  headless: HeadlessTerminal;
  serialize: SerializeAddon;
  // Multiple webContents may attach (e.g. devtools/preview windows); broadcast
  // pty:data to all of them. Keyed by webContents id so detach cleanup is O(1)
  // and we don't pin destroyed senders.
  attached: Map<number, WebContents>;
  cols: number;
  rows: number;
  /** Resolved spawn cwd (after `resolveSpawnCwd` fallback). Captured here
   *  so `listPtySessions` / `getPtySession` can return it without re-deriving. */
  cwd: string;
  /** L4 PR-B (#865): monotonic per-entry chunk counter, incremented on
   *  every `p.onData` BEFORE the chunk is written to the headless / fanned
   *  out. The renderer attach flow uses it together with
   *  `getBufferSnapshot` to dedupe live chunks against the snapshot:
   *  `getBufferSnapshot` returns `{snapshot, seq}` capturing the value of
   *  this counter at snapshot time, and any live chunk with `chunk.seq <=
   *  snap.seq` is already baked into the snapshot. Because Node's event
   *  loop is single-threaded, increment + write + broadcast + snapshot
   *  read all happen atomically relative to one another — there is no
   *  window where `headless.write` runs but the broadcast carries a stale
   *  seq. */
  seq: number;
  /** L4 PR-C (#863): count of headless `write(data, cb)` calls whose
   *  callback has not yet fired. Bumped on every dispatch, decremented in
   *  the write callback. Crossing `BACKPRESSURE_WARN_THRESHOLD` triggers a
   *  one-shot console.warn (re-arms when the counter drains back below the
   *  threshold). Observe-only — no chunk is ever dropped. */
  pendingHeadlessWrites: number;
  /** L4 PR-C (#863): edge-trigger guard for the backpressure warn so a
   *  long stall doesn't spam the log. Reset to false when the counter
   *  drops back below the threshold. */
  backpressureWarned: boolean;
}

export interface MakeEntryDeps {
  /** Called after the pty exits, the headless mirror is disposed and the
   *  pty:exit IPC has fanned out. Caller drops the entry from its map here. */
  onExit: (sid: string) => void;
  /** Forwarded to `ensureResumeJsonlAtSpawnCwd` — fired only when the helper
   *  actually copied the JSONL into a new projectDir (#603). */
  onCwdRedirect?: (newCwd: string) => void;
}

/**
 * L4 PR-C (#863): explicit per-chunk dispatch.
 *
 * One PTY chunk fans out to TWO sinks atomically (single-threaded JS event
 * loop guarantee — no other code can interleave between these statements):
 *
 *   1. `entry.headless.write(chunk, cb)` — the headless terminal is the
 *      session-level source-of-truth scrollback (PR-A #861). Visible xterm
 *      attaches replay from a snapshot of this buffer (PR-B #865), and any
 *      future feature that needs durable per-session output (search,
 *      export, AI summary) reads from here.
 *
 *   2. `wc.send('pty:data', { sid, chunk, seq })` for every attached
 *      webContents — the live wire to whichever visible xterm is currently
 *      mirroring this session. `seq` is the same monotonic counter that
 *      `getBufferSnapshot` captures, so the renderer can dedupe live
 *      chunks against the snapshot replay (PR-B contract).
 *
 * `seq` is bumped BEFORE either sink runs so both observe the same value.
 *
 * Backpressure (observe-only): the headless write callback decrements
 * `entry.pendingHeadlessWrites`. If a sustained burst pushes the counter
 * past `BACKPRESSURE_WARN_THRESHOLD`, we `console.warn` once (re-arms
 * after the counter drains). No chunk is ever dropped — this is purely a
 * production diagnostic for slow-mirror conditions.
 *
 * This function is exported so PR-D (resize/SIGWINCH) and PR-E
 * (detach/reattach) have a stable hook point: anything that needs to
 * observe or wrap the per-chunk fan-out goes here, not in `p.onData`.
 *
 * L4 PR-E (#864): the headless write here is what makes detach/reattach
 * "free" — when `entry.attached` is empty (no visible xterm) the headless
 * still receives every chunk, so a later reattach can replay the entire
 * missed window via `getBufferSnapshot` + drain (PR-B contract). PR-E
 * adds NO new code path here; it's the existing sink behavior + the
 * tests under `__tests__/detachReattach.test.ts` that pin the contract
 * across multiple detach/reattach cycles.
 *
 * Exported for unit tests; production code calls it via `p.onData` only.
 */
export function dispatchPtyChunk(sid: string, entry: Entry, chunk: string): void {
  // Bump seq BEFORE write/broadcast so the broadcast payload carries the
  // same seq the renderer will use to dedupe against `getBufferSnapshot`
  // (PR-B contract). Single-threaded: no interleave possible.
  entry.seq += 1;
  const seq = entry.seq;

  // Sink 1: headless source-of-truth buffer. Pass a callback so we can
  // observe write completion for backpressure diagnostics.
  entry.pendingHeadlessWrites += 1;
  // L4 PR-E (#864): suppress the backpressure warn when no visible
  // xterm is attached. While detached the headless mirror is the only
  // consumer; pending writes there are self-paced (no slow IPC), and
  // a long-running background session can still legitimately accumulate
  // chunks before the user reattaches. Spamming `console.warn` for a
  // session no human is currently watching is noise. When a renderer
  // re-attaches, normal threshold semantics resume — and any stalled
  // counter still re-arms via the write-callback re-arm branch below.
  if (
    entry.attached.size > 0 &&
    entry.pendingHeadlessWrites > BACKPRESSURE_WARN_THRESHOLD &&
    !entry.backpressureWarned
  ) {
    entry.backpressureWarned = true;
    console.warn(
      `[ptyHost] backpressure: sid=${sid} pendingHeadlessWrites=${entry.pendingHeadlessWrites} ` +
        `(>${BACKPRESSURE_WARN_THRESHOLD}); visible xterm or headless mirror is lagging. ` +
        `No data dropped — this is observe-only.`,
    );
  }
  entry.headless.write(chunk, () => {
    entry.pendingHeadlessWrites -= 1;
    if (entry.pendingHeadlessWrites <= BACKPRESSURE_WARN_THRESHOLD) {
      // Re-arm so the next over-threshold burst warns again.
      entry.backpressureWarned = false;
    }
  });

  // Sink 2: visible-xterm IPC fanout. Best-effort per attached webContents
  // — a destroyed sender or an IPC throw must not wedge the PTY pump.
  for (const wc of entry.attached.values()) {
    if (!wc.isDestroyed()) {
      try {
        wc.send('pty:data', { sid, chunk, seq });
      } catch {
        /* renderer gone — best effort */
      }
    }
  }

  // Sink 3 (module-level listeners): notify pipeline OSC sniffer is the
  // only production consumer today. Listeners are best-effort — throws
  // don't propagate back to ptyHost so a misbehaving sink can't wedge
  // the PTY. Kept inside dispatchPtyChunk (not a separate hook) so the
  // single fan-out point is the only place chunk-handling lives.
  emitPtyData(sid, chunk);
}

export function makeEntry(
  sid: string,
  cwd: string,
  claudePath: string,
  cols: number,
  rows: number,
  deps: MakeEntryDeps,
): Entry {
  const claudeSid = toClaudeSid(sid);
  const sourceJsonl = findJsonlForSid(claudeSid);
  const flag = sourceJsonl ? '--resume' : '--session-id';
  const args = [flag, claudeSid];

  const spawnCwd = resolveSpawnCwd(cwd);

  // See `ensureResumeJsonlAtSpawnCwd` for the bug context (#603) — copies
  // the import-source JSONL into the spawn cwd's projectDir so
  // `claude --resume <sid>` can find it. No-op when source already lives
  // under the right projectKey (the common case for sessions originally
  // run from a still-existing cwd).
  //
  // When a copy actually happens, the live JSONL the CLI now appends to
  // lives under `projectKey(spawnCwd)`, NOT under `projectKey(session.cwd)`.
  // The renderer's sessionTitles bridge passes `session.cwd` to the SDK
  // (`renameSession` / `getSessionInfo` / `listForProject`), so without a
  // redirect the bridge would keep reading/writing the now-frozen SOURCE
  // file (#603 reviewer Layer-1 finding). Notify the caller so it can
  // patch `session.cwd` to `spawnCwd` in the renderer store.
  if (sourceJsonl) {
    const result = ensureResumeJsonlAtSpawnCwd(claudeSid, spawnCwd, sourceJsonl);
    if (result.copied && deps.onCwdRedirect) {
      try {
        deps.onCwdRedirect(spawnCwd);
      } catch (err) {
        console.warn(
          `[ptyHost] cwd-redirect notify for ${sid} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const p = pty.spawn(claudePath, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: spawnCwd,
    env: process.env as { [key: string]: string },
  });

  const headless = new HeadlessTerminal({
    cols,
    rows,
    scrollback: SCROLLBACK,
    allowProposedApi: true,
  });
  const serialize = new SerializeAddon();
  headless.loadAddon(serialize);

  const entry: Entry = {
    pty: p,
    headless,
    serialize,
    attached: new Map(),
    cols,
    rows,
    cwd: spawnCwd,
    seq: 0,
    pendingHeadlessWrites: 0,
    backpressureWarned: false,
  };

  p.onData((chunk) => dispatchPtyChunk(sid, entry, chunk));

  p.onExit(({ exitCode, signal }) => {
    // Broadcast exit to anyone still listening, then drop the entry. Using
    // `sessionId` in the payload (not just `sid`) matches the renderer-side
    // ttyd-exit shape so the existing exit handler can be reused.
    for (const wc of entry.attached.values()) {
      if (!wc.isDestroyed()) {
        try {
          wc.send('pty:exit', {
            sessionId: sid,
            code: exitCode ?? null,
            signal: signal ?? null,
          });
        } catch {
          /* renderer gone */
        }
      }
    }
    try {
      headless.dispose();
    } catch {
      /* already disposed */
    }
    deps.onExit(sid);
    // Stop the JSONL tail-watcher so we don't keep an fs.watch handle
    // pinned for a dead session.
    try { sessionWatcher.stopWatching(sid); } catch { /* never throws */ }
  });

  // Start a JSONL tail-watcher for this session. The watcher emits
  // 'state-changed' on the singleton in electron/sessionWatcher; main.ts
  // bridges those events to the renderer (`session:state` IPC channel).
  try {
    const jsonlPath = resolveJsonlPath(claudeSid, spawnCwd);
    if (jsonlPath) sessionWatcher.startWatching(sid, jsonlPath, spawnCwd);
  } catch {
    /* watcher start is best-effort; PTY still owns its lifecycle */
  }

  return entry;
}
