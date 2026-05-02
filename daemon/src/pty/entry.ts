// Per-session PTY Entry construction (daemon-side).
//
// Task #108 (frag-3.5.1 §3.5.1.1 + frag-6-7 §6.6.1 step 4).
//
// What this module owns (factory / sink wiring):
//   - Spawning the node-pty IPty for one session (real claude CLI in
//     production; injectable spawn for tests).
//   - Building the per-session @xterm/headless mirror + serialize addon
//     so detach/reattach replays from the daemon-side authoritative
//     scrollback (port of electron/ptyHost/entryFactory.ts L4 PR-A
//     #861 — same SCROLLBACK contract).
//   - Wiring the PTY `onData` pump into BOTH sinks atomically:
//       1. headless.write — the source-of-truth scrollback
//       2. fanoutRegistry.broadcast — every Connect/envelope subscriber
//   - Wiring `onExit` to drain the fanout-registry session entry with
//     the appropriate DrainReason and remove the PID from the
//     daemon-wide childPidRegistry so the shutdown drain step 4 stops
//     waitpid'ing on it.
//
// What this module does NOT own (decider / producer / other sinks):
//   - JSONL --resume vs --session-id pick — caller resolves argv. The
//     deferred-port lives at electron/ptyHost/jsonlResolver.ts; #150
//     ("N28 claude CLI subprocess 搬 daemon") will copy that down.
//   - Lifecycle FSM transitions — owned by daemon/src/pty/lifecycle.ts
//     (T37). The entry factory exposes `onExit(exitCode, signal)` so
//     the registry singleton can run the FSM transition + DB write.
//   - JobObject creation on Windows / pdeathsig on Linux — owned by
//     ccsm_native + daemon/src/pty/win-jobobject.ts + sigchld-reaper.
//     The factory passes the freshly-spawned PID into a caller-injected
//     `registerChildPid` sink so those subsystems can adopt it.
//   - Backpressure pause/resume (#143) — orthogonal; would wrap
//     `dispatchPtyChunk` here when it lands.
//   - Subscriber LRU cap (#149) — orthogonal; lives in the registry.
//
// SRP per feedback_single_responsibility:
//   - DECIDER: none here (the FSM is separate).
//   - PRODUCER: node-pty `onData` / `onExit` events.
//   - SINK: headless.write, fanoutRegistry.broadcast, registerChildPid,
//           unregisterChildPid, FSM transition request callback.

import * as pty from 'node-pty';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { FanoutRegistry } from './fanout-registry.js';
import type { PtySubscribeFrame } from '../handlers/pty-subscribe.js';

/** Default PTY geometry. Mirrors electron/ptyHost/entryFactory.ts so a
 *  caller that does not pass cols/rows gets the same screen as the old
 *  electron-owned PTY. */
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;

/** L4 PR-A (#861) parity: 10000-line scrollback so the headless
 *  terminal is the session-level authoritative buffer suitable for
 *  serving re-attach replays, not just the live screen. */
export const SCROLLBACK = 10_000;

/**
 * Spawn options for one PTY session. The factory is intentionally
 * argv-agnostic — JSONL / --resume / --session-id resolution belongs
 * to the caller (electron today, #150 will move it to the daemon).
 */
export interface SpawnOptions {
  readonly sid: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly cols?: number;
  readonly rows?: number;
  /** Environment for the child. Defaults to `process.env`. Tests pass
   *  a minimal object to avoid leaking the test runner env. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Per-Entry sinks the registry injects. Keeping them callback-shaped
 * (rather than reaching back into the registry) keeps the entry
 * unit-testable without a full registry fixture.
 */
export interface EntryDeps {
  /** Fan-out registry singleton — the entry calls `broadcast(sid, frame)`
   *  on every PTY data chunk. */
  readonly fanoutRegistry: FanoutRegistry<PtySubscribeFrame>;
  /** Called once with the freshly-spawned PID. The registry forwards
   *  this to:
   *    - `daemon/src/index.ts` `childPidRegistry` (so shutdown step 4
   *      knows which PIDs to await via ccsm_native.sigchld.waitpid)
   *    - `daemon/src/pty/win-jobobject.ts` (so a JobObject is opened
   *      on Windows for terminal-kill on supervisor escalation) — wired
   *      by the registry, NOT the entry, since the JobHandle goes into
   *      a separate registry array (`jobObjectRegistry`). */
  readonly registerChildPid: (sid: string, pid: number) => void;
  /** Called once when the PTY exits (for any reason). The registry
   *  removes the PID from `childPidRegistry` so step 4 stops looking
   *  for it and drains the fanout-registry session entry. */
  readonly onExit: (
    sid: string,
    pid: number | undefined,
    exitCode: number | undefined,
    signal: string | undefined,
  ) => void;
  /** Optional injection seam for tests — defaults to real `pty.spawn`.
   *  Tests pass a stub IPty so they do not actually spawn a child. */
  readonly spawn?: typeof pty.spawn;
  /** Optional logger for non-fatal anomalies (broadcast threw, etc.). */
  readonly logger?: {
    warn: (obj: Record<string, unknown>, msg?: string) => void;
  };
}

export interface Entry {
  readonly sid: string;
  readonly pty: pty.IPty;
  readonly headless: HeadlessTerminal;
  readonly serialize: SerializeAddon;
  /** Resolved spawn cwd. */
  readonly cwd: string;
  /** Reported by node-pty. Captured here so `windDown` can pass it to
   *  the per-platform terminal-kill primitive without re-querying. */
  readonly pid: number;
  cols: number;
  rows: number;
  /** Monotonic per-entry chunk counter — bumped before each broadcast.
   *  Snapshot consumers read this together with the serialized buffer
   *  to dedupe live chunks against the snapshot replay (frag-3.5.1
   *  §3.5.1.4 + parity with electron L4 PR-B #865). */
  seq: number;
  /** True after the entry has begun shutdown (kill / windDown). The
   *  registry uses this to suppress duplicate work on repeat kill. */
  shuttingDown: boolean;
  /** True after `onExit` has fired. Read-only; the registry uses this
   *  to short-circuit `kill` / `windDown` on already-dead entries. */
  exited: boolean;
}

/**
 * Per-chunk dispatch — the single fan-out point for one PTY's `onData`
 * pump. Bumps seq BEFORE either sink runs so both observe the same
 * value (single-threaded JS guarantee). Errors thrown by either sink
 * are caught + logged so a misbehaving subscriber cannot wedge the
 * PTY pump.
 *
 * Exported for unit tests; production code calls it via `pty.onData`
 * inside `makeEntry`.
 */
export function dispatchPtyChunk(
  entry: Entry,
  chunk: string,
  fanoutRegistry: FanoutRegistry<PtySubscribeFrame>,
  logger?: EntryDeps['logger'],
): void {
  entry.seq += 1;
  const seq = entry.seq;

  // Sink 1: headless source-of-truth buffer.
  try {
    entry.headless.write(chunk);
  } catch (err) {
    logger?.warn(
      { event: 'pty.entry.headless-write-failed', sid: entry.sid, err: String(err) },
      'headless write threw; chunk lost from scrollback only (subscribers still receive it)',
    );
  }

  // Sink 2: fan-out to every Connect / envelope subscriber. The
  // registry catches per-subscriber errors internally; a throw from
  // broadcast itself would mean the registry crashed and the daemon
  // should not silently swallow that.
  const data = Buffer.from(chunk, 'utf8');
  const frame: PtySubscribeFrame = {
    kind: 'delta',
    seq,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
  fanoutRegistry.broadcast(entry.sid, frame);
}

/**
 * Build one PTY Entry — spawns the child, builds the headless mirror,
 * wires both sinks, and registers the PID with the daemon-wide
 * shutdown bookkeeping.
 *
 * The factory does NOT register itself in the session registry; the
 * caller (registry singleton) owns that.
 *
 * Throws if `pty.spawn` throws — the registry catches and surfaces an
 * RPC-level error to the caller.
 */
export function makeEntry(opts: SpawnOptions, deps: EntryDeps): Entry {
  const cols = opts.cols ?? DEFAULT_COLS;
  const rows = opts.rows ?? DEFAULT_ROWS;
  const env = (opts.env ?? process.env) as { [key: string]: string };
  const spawnFn = deps.spawn ?? pty.spawn;

  const p = spawnFn(opts.command, opts.args.slice(), {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: opts.cwd,
    env,
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
    sid: opts.sid,
    pty: p,
    headless,
    serialize,
    cwd: opts.cwd,
    pid: p.pid,
    cols,
    rows,
    seq: 0,
    shuttingDown: false,
    exited: false,
  };

  p.onData((chunk: string) => {
    dispatchPtyChunk(entry, chunk, deps.fanoutRegistry, deps.logger);
  });

  p.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    entry.exited = true;
    try {
      headless.dispose();
    } catch {
      /* already disposed */
    }
    // Translate node-pty's numeric signal back into the canonical
    // POSIX name when possible (the lifecycle FSM + DB row both
    // record signal as a string).
    const signalName =
      typeof signal === 'number' && signal > 0 ? `SIG${signal}` : undefined;
    deps.onExit(entry.sid, entry.pid, exitCode ?? undefined, signalName);
  });

  // Adopt the freshly-spawned PID into the daemon-wide bookkeeping.
  // Done synchronously after spawn so a SIGTERM arriving during the
  // very next event-loop tick still finds the PID in the registry.
  deps.registerChildPid(opts.sid, p.pid);

  return entry;
}
