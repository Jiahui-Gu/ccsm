// PTY session registry singleton (daemon-side).
//
// Task #108 (frag-3.5.1 §3.5.1.1 + §3.5.1.2 + frag-6-7 §6.6.1 step 4/6).
//
// What this module owns (registry + lifecycle ops):
//   - The one `Map<sid, Entry>` for the daemon process. (Module-level
//     state is intentional — there is one PTY pool per daemon, same as
//     the electron-side singleton it replaces.)
//   - Lifecycle ops: spawn / attach / detach / input / resize / kill /
//     list / get / killAll / windDown.
//   - The singleton fanout-registry instance (port of L4 PR-A
//     scrollback fan-out — every Connect / envelope subscriber attaches
//     here).
//   - The shutdown drain glue:
//       step 4 (`wind-down-pty-children`): SIGTERM each pgroup, wait
//         per-child deadline, escalate to ccsm_native terminal-kill /
//         JobObject.TerminateJobObject. Removes PIDs from the
//         `childPidRegistry` set so the orchestrator's waitpid loop
//         sees them drain.
//       step 6 (`close-fanout-registry`): bulk-close every subscriber
//         with `daemon-shutdown` reason. This replaces the explicit
//         "deferred to #108" placeholder in daemon/src/index.ts.
//
// What this module does NOT own (delegated):
//   - The actual node-pty + xterm-headless wiring — entry.ts.
//   - The lifecycle FSM transition table — pty/lifecycle.ts (T37).
//   - Per-platform terminal kill — lifecycle/force-kill.ts +
//     pty/win-jobobject.ts + pty/sigchld-reaper.ts.
//   - Snapshot semaphore / drop-slowest watermark / replay-burst
//     exemption — separate decider modules in pty/.
//
// Singleton vs DI:
//   The registry is exposed as a default singleton (`ptyRegistry`) but
//   the factory `createPtyRegistry()` is the testable seam. The daemon
//   shell imports the singleton; tests construct fresh instances per
//   case to avoid cross-test state. Same pattern as
//   `electron/sessionWatcher` and `electron/ptyHost`.

import type * as pty from 'node-pty';
import {
  createFanoutRegistry,
  type DrainReason,
  type FanoutRegistry,
} from './fanout-registry.js';
import {
  makeEntry,
  type Entry,
  type EntryDeps,
  type SpawnOptions,
} from './entry.js';
import {
  transition,
  type PtyLifecycleEvent,
  type PtyLifecycleStateOrInitial,
} from './lifecycle.js';
import type { PtySubscribeFrame } from '../handlers/pty-subscribe.js';

/** Dependencies the registry needs from the daemon shell (DI seam for
 *  tests + future native-binding swap). */
export interface RegistryDeps {
  /** Sink invoked when a PTY entry is created with the freshly-spawned
   *  PID. The daemon shell wires this to add the PID to the
   *  module-level `childPidRegistry` set used by:
   *    - lifecycle/force-kill.ts (terminal-kill on shutdown overrun)
   *    - lifecycle/shutdownDrain.ts step 4 (waitpid loop)
   *    - lifecycle/sigchld-reaper.ts (POSIX SIGCHLD adoption) */
  readonly registerChildPid: (sid: string, pid: number) => void;
  /** Sink invoked when a PTY exits or is force-killed. The daemon shell
   *  wires this to REMOVE the PID from the same registry the
   *  registerChildPid sink populated. */
  readonly unregisterChildPid: (sid: string, pid: number) => void;
  /** Optional logger. */
  readonly logger?: {
    warn: (obj: Record<string, unknown>, msg?: string) => void;
    info: (obj: Record<string, unknown>, msg?: string) => void;
  };
  /** Per-platform graceful kill — defaults to `pty.IPty.kill('SIGTERM')`
   *  on POSIX and a node-pty internal kill on Windows. Tests pass a
   *  spy. */
  readonly killGracefully?: (entry: Entry) => void;
  /** Per-platform terminal kill — defaults to `pty.IPty.kill('SIGKILL')`
   *  on POSIX. On Windows the JobObject `TerminateJobObject` lives in
   *  pty/win-jobobject.ts and the daemon shell wires it through here.
   *  Tests pass a spy. */
  readonly killTerminally?: (entry: Entry) => void;
  /** Optional injection seam forwarded to entry.ts spawn. */
  readonly spawn?: typeof pty.spawn;
}

/** The lifecycle FSM state the registry tracks per session. The FSM
 *  itself is pure (decider in pty/lifecycle.ts); the registry owns the
 *  current-state slot per entry so it can apply transitions on events
 *  without re-deriving from event history. */
export interface RegistrySessionState {
  state: PtyLifecycleStateOrInitial;
}

export interface PtyRegistry {
  /** The shared fanout-registry instance for this registry. Connect /
   *  envelope `pty.subscribe` handlers register their subscriber here. */
  readonly fanout: FanoutRegistry<PtySubscribeFrame>;

  /** Spawn a new PTY for `sid`. Throws if `sid` is already registered
   *  (caller MUST kill the old one first; spawning twice is a logic
   *  bug per the proto's `SpawnPty` non-idempotency contract). */
  spawn(opts: SpawnOptions): Entry;

  /** Send `data` to the PTY's stdin. No-op if `sid` is unknown or the
   *  entry has already exited. */
  input(sid: string, data: string | Uint8Array): void;

  /** Resize the PTY. No-op if `sid` is unknown or the entry has
   *  already exited. */
  resize(sid: string, cols: number, rows: number): void;

  /** Get an Entry by sid. Returns undefined if unknown. */
  get(sid: string): Entry | undefined;

  /** Snapshot of current sessions (id + cols + rows + cwd + pid +
   *  state). Used by the proto's `ListPty` RPC and by /healthz
   *  session-count provider. */
  list(): ReadonlyArray<{
    readonly sid: string;
    readonly cols: number;
    readonly rows: number;
    readonly cwd: string;
    readonly pid: number;
    readonly state: PtyLifecycleStateOrInitial;
  }>;

  /** Number of sessions currently registered (any state). Cheap; used
   *  by /healthz. */
  size(): number;

  /** Snapshot of currently-registered child PIDs. Used by the daemon
   *  shell to populate the force-kill sink's getChildPids snapshot. */
  getChildPids(): ReadonlyArray<number>;

  /** Get the FSM state for `sid`. Returns 'initial' if unknown. */
  getState(sid: string): PtyLifecycleStateOrInitial;

  /** Async snapshot of the headless serialized buffer + current seq.
   *  Used by Connect `GetPtyBufferSnapshot` + Connect `StreamPtyData`
   *  resume path (snapshot replay before live tail). */
  snapshot(sid: string): Promise<{ buffer: string; seq: number } | null>;

  /** Graceful kill — sends SIGTERM (POSIX) / Windows-equivalent. The
   *  PTY's `onExit` will subsequently run the unregister sink. Returns
   *  true if a kill was sent, false if `sid` was unknown / already
   *  exiting. */
  kill(sid: string): boolean;

  /** Force-kill all surviving entries — used by daemon shutdown drain
   *  step 4 after the per-child SIGTERM grace window expires. Calls
   *  `killTerminally` on every non-exited entry. Idempotent. */
  killAll(): void;

  /**
   * Shutdown drain step 4 (`wind-down-pty-children`). Algorithm:
   *   1. For every entry: FSM `running → shutting_down`. Errors logged
   *      and ignored — the kill still runs.
   *   2. Send SIGTERM to every entry via `killGracefully`.
   *   3. Wait up to `perChildDeadlineMs` per child for `entry.exited`
   *      to flip to true (PTY's own onExit hook drives this).
   *   4. Survivors get `killTerminally` (SIGKILL / TerminateJobObject).
   *   5. FSM final sweep: any still-not-exited entry → `paused`
   *      (frag-3.5.1 §3.5.1.2 step 8).
   *
   * The shutdown orchestrator (lifecycle/shutdownDrain.ts) provides
   * the per-child deadline (default 200 ms per frag-6-7 §6.6.1 step 4)
   * and races the whole call against a step-level 2 s ceiling.
   */
  windDown(opts: { perChildDeadlineMs: number }): Promise<void>;

  /** Shutdown drain step 6 (`close-fanout-registry`). Drain every
   *  session entry in the fanout-registry with the supplied reason.
   *  Returns the number of subscribers closed (for the aggregated
   *  log line the orchestrator emits). */
  closeAllSubscribers(reason: DrainReason): number;
}

/** Build a fresh registry. The daemon shell calls this once at boot
 *  and exports the result as the `ptyRegistry` singleton. Tests
 *  construct their own instances per case. */
export function createPtyRegistry(deps: RegistryDeps): PtyRegistry {
  const sessions = new Map<string, Entry>();
  const states = new Map<string, RegistrySessionState>();
  const fanout = createFanoutRegistry<PtySubscribeFrame>({
    onSubscriberError: (err, ctx) => {
      deps.logger?.warn(
        {
          event: 'pty.fanout.subscriber-error',
          sid: ctx.sessionId,
          phase: ctx.phase,
          err: String(err),
        },
        'fanout-registry subscriber threw',
      );
    },
  });

  function applyTransition(sid: string, event: PtyLifecycleEvent): void {
    const slot = states.get(sid);
    if (!slot) return;
    const result = transition(slot.state, event);
    if (result.ok) {
      slot.state = result.transition.state;
    } else {
      // Illegal transitions are logged but not thrown. The lifecycle
      // FSM is the source-of-truth for "what state shall this row be
      // in"; the registry must not crash on a stale event (e.g.
      // re-firing `kill` on an already-exited entry). The DB-write
      // sink (a future #105 follow-up) reads `slot.state`, so the
      // FSM stays consistent regardless.
      deps.logger?.warn(
        {
          event: 'pty.lifecycle.illegal-transition',
          sid,
          from: result.error.from,
          eventKind: result.error.event,
        },
        'pty lifecycle illegal transition (no-op)',
      );
    }
  }

  function defaultKillGracefully(entry: Entry): void {
    try {
      // node-pty `kill(signal?)` accepts a POSIX signal name; on
      // Windows it ignores the arg and falls back to its internal
      // kill which uses TerminateProcess on the PTY's pgroup.
      entry.pty.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    } catch (err) {
      deps.logger?.warn(
        { event: 'pty.kill-graceful-failed', sid: entry.sid, err: String(err) },
        'graceful kill threw',
      );
    }
  }

  function defaultKillTerminally(entry: Entry): void {
    try {
      // POSIX: SIGKILL. Windows: node-pty's internal TerminateProcess
      // is the same code path as graceful — the JobObject-level
      // TerminateJobObject is wired by the daemon shell through
      // `deps.killTerminally` so this default is only the last-resort
      // fallback.
      entry.pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
    } catch (err) {
      deps.logger?.warn(
        { event: 'pty.kill-terminal-failed', sid: entry.sid, err: String(err) },
        'terminal kill threw',
      );
    }
  }

  const killGracefully = deps.killGracefully ?? defaultKillGracefully;
  const killTerminally = deps.killTerminally ?? defaultKillTerminally;

  function spawn(opts: SpawnOptions): Entry {
    if (sessions.has(opts.sid)) {
      throw new Error(`pty already registered for sid: ${opts.sid}`);
    }

    const entryDeps: EntryDeps = {
      fanoutRegistry: fanout,
      registerChildPid: deps.registerChildPid,
      ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
      ...(deps.logger !== undefined ? { logger: { warn: deps.logger.warn } } : {}),
      onExit: (sid, pid, exitCode, signal) => {
        // Translate the exit into the FSM event the lifecycle table
        // expects.
        applyTransition(sid, {
          kind: 'exit',
          exitCode: exitCode ?? 0,
          signal: signal ?? null,
        });
        // Drain any still-attached subscribers with the appropriate
        // reason so they cleanly end their stream rather than waiting
        // for a transport-level disconnect.
        const reasonKind: DrainReason['kind'] =
          (exitCode ?? 0) === 0 ? 'pty-exit' : 'pty-crashed';
        fanout.drainSession(sid, { kind: reasonKind });
        // Remove the PID from the daemon-wide bookkeeping (force-kill
        // sink + shutdown drain waitpid loop both read this set).
        if (typeof pid === 'number') {
          deps.unregisterChildPid(sid, pid);
        }
        // Drop from the registry; the next spawn for this sid is a
        // fresh entry (matches the lifecycle FSM "exited / crashed
        // are terminal — fresh row required" rule).
        sessions.delete(opts.sid);
        states.delete(opts.sid);
        deps.logger?.info(
          { event: 'pty.exit', sid, pid, exitCode, signal },
          'pty exited',
        );
      },
    };

    const entry = makeEntry(opts, entryDeps);
    sessions.set(opts.sid, entry);
    states.set(opts.sid, { state: 'initial' });
    applyTransition(opts.sid, { kind: 'start' });
    deps.logger?.info(
      {
        event: 'pty.spawn',
        sid: opts.sid,
        pid: entry.pid,
        cwd: entry.cwd,
        cols: entry.cols,
        rows: entry.rows,
      },
      'pty spawned',
    );
    return entry;
  }

  function input(sid: string, data: string | Uint8Array): void {
    const e = sessions.get(sid);
    if (!e || e.exited) return;
    try {
      // node-pty IPty.write accepts string only; convert bytes to
      // utf-8. (Renderer keystroke chunks are utf-8 already; binary
      // pasts go through the same path.)
      const s = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      e.pty.write(s);
    } catch (err) {
      deps.logger?.warn(
        { event: 'pty.input-failed', sid, err: String(err) },
        'pty.write threw',
      );
    }
  }

  function resize(sid: string, cols: number, rows: number): void {
    const e = sessions.get(sid);
    if (!e || e.exited) return;
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
      deps.logger?.warn(
        { event: 'pty.resize-invalid', sid, cols, rows },
        'invalid resize dimensions; ignored',
      );
      return;
    }
    try {
      e.pty.resize(cols, rows);
      e.headless.resize(cols, rows);
      e.cols = cols;
      e.rows = rows;
    } catch (err) {
      deps.logger?.warn(
        { event: 'pty.resize-failed', sid, err: String(err) },
        'pty.resize / headless.resize threw',
      );
    }
  }

  function get(sid: string): Entry | undefined {
    return sessions.get(sid);
  }

  function list(): ReadonlyArray<{
    readonly sid: string;
    readonly cols: number;
    readonly rows: number;
    readonly cwd: string;
    readonly pid: number;
    readonly state: PtyLifecycleStateOrInitial;
  }> {
    const out: Array<{
      sid: string;
      cols: number;
      rows: number;
      cwd: string;
      pid: number;
      state: PtyLifecycleStateOrInitial;
    }> = [];
    for (const [sid, e] of sessions) {
      out.push({
        sid,
        cols: e.cols,
        rows: e.rows,
        cwd: e.cwd,
        pid: e.pid,
        state: states.get(sid)?.state ?? 'initial',
      });
    }
    return out;
  }

  function size(): number {
    return sessions.size;
  }

  function getChildPids(): ReadonlyArray<number> {
    const pids: number[] = [];
    for (const e of sessions.values()) {
      if (!e.exited) pids.push(e.pid);
    }
    return pids;
  }

  function getState(sid: string): PtyLifecycleStateOrInitial {
    return states.get(sid)?.state ?? 'initial';
  }

  async function snapshot(sid: string): Promise<{ buffer: string; seq: number } | null> {
    const e = sessions.get(sid);
    if (!e) return null;
    // xterm-headless `write()` queues parsing into a microtask-driven
    // pump; reading `serialize()` immediately after the producer's
    // synchronous `headless.write(chunk)` would observe an empty
    // buffer because the parser has not yet drained. Flush by writing
    // an empty string with a callback — the callback fires only after
    // the queue (including any prior writes) has been processed. The
    // empty write is a no-op for the buffer itself.
    await new Promise<void>((resolve) => {
      e.headless.write('', () => resolve());
    });
    // Capture seq AT the moment we read the serialized buffer so the
    // pair is consistent (single-threaded JS guarantee — no other code
    // can interleave between these two synchronous statements). This
    // matches the L4 PR-B (#865) contract used by the renderer to
    // dedupe live chunks against the snapshot.
    const seq = e.seq;
    const buffer = e.serialize.serialize();
    return { buffer, seq };
  }

  function kill(sid: string): boolean {
    const e = sessions.get(sid);
    if (!e || e.exited) return false;
    if (e.shuttingDown) return false;
    e.shuttingDown = true;
    applyTransition(sid, { kind: 'shutdown_request' });
    killGracefully(e);
    return true;
  }

  function killAll(): void {
    for (const e of sessions.values()) {
      if (e.exited) continue;
      try {
        killTerminally(e);
      } catch (err) {
        deps.logger?.warn(
          { event: 'pty.killAll-failed', sid: e.sid, err: String(err) },
          'killAll terminal-kill threw',
        );
      }
    }
  }

  async function windDown(opts: { perChildDeadlineMs: number }): Promise<void> {
    const all = Array.from(sessions.values());
    if (all.length === 0) return;

    // Step 1+2: FSM running → shutting_down + SIGTERM each entry.
    for (const e of all) {
      if (e.exited) continue;
      if (!e.shuttingDown) {
        e.shuttingDown = true;
        applyTransition(e.sid, { kind: 'shutdown_request' });
      }
      killGracefully(e);
    }

    // Step 3: wait up to perChildDeadlineMs per child. Implemented as
    // one parallel race per entry — each waiter resolves either when
    // the entry's own onExit flips `exited` to true, or when the
    // per-child deadline timer fires.
    const pollMs = Math.max(5, Math.min(50, Math.floor(opts.perChildDeadlineMs / 5)));
    await Promise.all(
      all.map(
        (e) =>
          new Promise<void>((resolve) => {
            if (e.exited) return resolve();
            const start = Date.now();
            const timer = setInterval(() => {
              if (e.exited || Date.now() - start >= opts.perChildDeadlineMs) {
                clearInterval(timer);
                resolve();
              }
            }, pollMs);
            // Unref so the timer cannot keep the event loop alive
            // past the orchestrator's eventual process.exit.
            if (typeof timer.unref === 'function') timer.unref();
          }),
      ),
    );

    // Step 4: survivors get terminal-kill.
    for (const e of all) {
      if (!e.exited) {
        applyTransition(e.sid, { kind: 'force_kill' });
        try {
          killTerminally(e);
        } catch (err) {
          deps.logger?.warn(
            { event: 'pty.windDown-terminal-kill-failed', sid: e.sid, err: String(err) },
            'windDown terminal-kill threw',
          );
        }
      }
    }

    // Step 5: FSM final sweep. Any entry still not exited at this
    // point gets paused per frag-3.5.1 §3.5.1.2 step 8 — the next
    // boot's recovery pass will respawn them via `resume`.
    for (const e of all) {
      if (!e.exited) {
        applyTransition(e.sid, { kind: 'pause' });
      }
    }
  }

  function closeAllSubscribers(reason: DrainReason): number {
    let count = 0;
    for (const sid of sessions.keys()) {
      const subs = fanout.getSubscribers(sid);
      count += subs.length;
      fanout.drainSession(sid, reason);
    }
    return count;
  }

  return {
    fanout,
    spawn,
    input,
    resize,
    get,
    list,
    size,
    getChildPids,
    getState,
    snapshot,
    kill,
    killAll,
    windDown,
    closeAllSubscribers,
  };
}
