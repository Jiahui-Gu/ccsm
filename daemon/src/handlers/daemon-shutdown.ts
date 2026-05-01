// T20 — daemon.shutdown handler (graceful drain sequence).
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md
//     §6.6.1 "Daemon-side logger" → ordered shutdown sequence (the
//     authoritative 7-step drain ordering, r2-obs P0-3 + r3-rel P0-R1).
//   - docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
//     §3.5.1.2 step 5 (snapshot semaphore drain on shutdown).
//   - docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md
//     §3.4.1.h (this RPC is on the SUPERVISOR_RPCS allowlist; routed by T16
//     dispatcher).
//   - docs/superpowers/specs/v0.3-design.md §6.4 (this `daemon.shutdown` RPC
//     is the uninstall/manual path — distinct from `daemon.shutdownForUpgrade`
//     T21 which writes the atomic marker file. T20 writes NO marker.)
//
// Single Responsibility (per feedback_single_responsibility):
//   - Decider (this module): builds the ordered shutdown plan from a fixed
//     spec table and runs the steps in order against an injected actions
//     provider. Owns step ordering, idempotency, deadline accounting.
//   - Producer: T14 control-socket transport receives the inbound envelope
//     and calls `createDaemonShutdownHandler(actions).handle(req, ctx)`.
//   - Sinks: every actual side effect (stop accepting spawns, drain the
//     snapshot semaphore, mark sessions shutting_down/paused, close
//     subscribers, checkpoint+close DB, pino.final, process.exit) lives
//     behind the `ShutdownActions` interface. The handler invokes them in
//     spec order and never performs the I/O itself. This keeps the handler
//     testable end-to-end with vi.fn() mocks and lets each action evolve
//     independently as the corresponding subsystem (T37 lifecycle, T40
//     semaphore, T41 fan-out, T28 schema, T22 marker) lands.
//
// What this handler does NOT own (deferred to other tasks):
//   - T25 force-kill fallback after the deadline elapses. The plan exposes
//     `forceKillDeadlineMs` (5_000 ms) and the handler logs / records
//     deadline overrun; the actual SIGKILL escalation is T25 territory.
//   - The atomic shutdown marker write (T21 `daemon.shutdownForUpgrade`).
//     T20 explicitly skips this — the spec distinguishes the two RPCs by
//     marker presence so the supervisor crash-loop counter (frag-6-7 §6.1)
//     can tell upgrade-clean from manual/uninstall shutdown.
//   - `pino.final` flush + `process.exit(0)`: these are sinks injected by
//     `actions.finalizeLogger` and `actions.exitProcess`. The handler
//     resolves its reply BEFORE invoking exit so the ack reaches the wire.

import { isSupervisorRpc } from '../envelope/supervisor-rpcs.js';

/** Ordered step identifiers — match the spec sequence in §6.6.1 1..7 (the
 *  pure-pino step 6 is collapsed into `finalizeLogger` here; `exitProcess`
 *  is step 7). The literal strings appear in the plan + log lines so a
 *  reader can grep §6.6.1 step N → this handler. */
export const SHUTDOWN_STEPS = [
  'mark-draining', // step 1: state = 'draining' (rejects new spawns/subscribes).
  'clear-heartbeats', // step 2: clearInterval all per-stream heartbeats.
  'reject-pending', // step 3: aggregate-reject pending bridge calls.
  'drain-snapshot-semaphore', // §3.5.1.2 step 5: cancel queued snapshot waiters.
  'wind-down-sessions', // step 4: SIGTERM/SIGKILL children, mark exited/paused, WAL checkpoint, db.close.
  'close-subscribers', // step 5: drain fan-out registry, ONE aggregated log line.
  'finalize-logger', // step 6: pino.final flush.
  'exit-process', // step 7: process.exit(0).
] as const;

export type ShutdownStep = (typeof SHUTDOWN_STEPS)[number];

/**
 * Why each step exists, lifted from §6.6.1 + §3.5.1.2 + §3.5.1.5 — kept on
 * the plan so the wire response is self-explanatory and the spec ordering is
 * machine-checkable from a snapshot test. The order MUST NOT change without
 * a spec edit (r3-rel R1 reorder lock).
 */
export interface ShutdownPlanStep {
  readonly step: ShutdownStep;
  readonly specRef: string;
  readonly description: string;
}

/** Authoritative, ordered, frozen plan. Exported for snapshot tests + for
 *  T21 (shutdownForUpgrade) to layer the marker write on top of the same
 *  drain sequence without re-deriving the ordering. */
export const SHUTDOWN_PLAN: readonly ShutdownPlanStep[] = Object.freeze([
  {
    step: 'mark-draining',
    specRef: 'frag-6-7 §6.6.1 step 1',
    description:
      "set daemonState='draining'; reject new pty.spawn() and ptySubscribe with RESOURCE_EXHAUSTED { reason: 'daemon-shutdown' }",
  },
  {
    step: 'clear-heartbeats',
    specRef: 'frag-6-7 §6.6.1 step 2',
    description: 'clearInterval every per-stream heartbeat timer (frag-3.5.1 §3.5.1.4)',
  },
  {
    step: 'reject-pending',
    specRef: 'frag-6-7 §6.6.1 step 3',
    description:
      'reject pending reconnect-queue / in-flight bridge calls; ONE aggregated log line { event: "daemon-shutdown", droppedCalls: N }',
  },
  {
    step: 'drain-snapshot-semaphore',
    specRef: 'frag-3.5.1 §3.5.1.2 step 5',
    description:
      "drain the snapshot semaphore: queued waiters reject with CANCELLED { reason: 'daemon-shutdown' }; in-flight holders keep their permits",
  },
  {
    step: 'wind-down-sessions',
    specRef: 'frag-6-7 §6.6.1 step 4',
    description:
      "mark running→shutting_down (one txn); SIGTERM each pgroup, 200ms per child; SIGKILL survivors; sweep shutting_down→paused (UPDATE … WHERE state='shutting_down'); PRAGMA wal_checkpoint(TRUNCATE); db.close()",
  },
  {
    step: 'close-subscribers',
    specRef: 'frag-6-7 §6.6.1 step 5',
    description:
      "iterate fan-out subscriber registry once; close each with RESOURCE_EXHAUSTED reason='daemon-shutdown'; ONE aggregated { event: 'subscribers-closed', count: N } line",
  },
  {
    step: 'finalize-logger',
    specRef: 'frag-6-7 §6.6.1 step 6',
    description: 'pino.final flushes destination buffer (last logging act)',
  },
  {
    step: 'exit-process',
    specRef: 'frag-6-7 §6.6.1 step 7',
    description: 'process.exit(0) — clean exit, supervisor sees normal child reap',
  },
]);

// Spec contract: the shutdown deadline is owned by the caller (electron-main
// uses 2 s for uninstall per §11.6.4, 5 s for upgrade per §11.6.5). The
// handler defaults to 5 s if the caller omits a deadline; T25 owns the
// post-deadline force-kill escalation that overlays this handler.
export const SHUTDOWN_DEFAULT_DEADLINE_MS = 5_000 as const;

/**
 * Inbound payload — see §6.6.1 (no formal schema in spec; v0.3 RPCs use
 * TypeBox per §3.4.1.d and the validation lives at the envelope layer). For
 * the handler we only consume the optional `deadlineMs` override.
 */
export interface DaemonShutdownRequest {
  readonly deadlineMs?: number;
  /** Optional human reason recorded on the ack + structured log line.
   *  Examples: 'uninstall', 'manual', 'tray-quit'. NOT 'upgrade' — that
   *  request goes through `daemon.shutdownForUpgrade` (T21). */
  readonly reason?: string;
}

/** The wire reply. Returned BEFORE side-effecting steps run so the ack
 *  reaches the supervisor before the daemon exits. */
export interface DaemonShutdownReply {
  readonly ack: 'ok';
  readonly bootNonce?: string;
  readonly deadlineMs: number;
  /** Plan steps in execution order — readable forensic field, also lets
   *  the supervisor verify the daemon understood the contract. */
  readonly planSteps: readonly ShutdownStep[];
  /** First call returns 'first', subsequent calls return 'replay' so the
   *  caller can distinguish initial ack from idempotent re-ack. */
  readonly idempotency: 'first' | 'replay';
}

/**
 * Side-effect provider — every method is invoked at most once per shutdown.
 * Each method MAY be async; the handler awaits in spec order. Errors thrown
 * from any action are caught, logged via `recordStepError`, and the
 * sequence CONTINUES — partial drain is better than silent abort. After
 * `wind-down-sessions` and `close-subscribers` the handler MUST still call
 * `finalizeLogger` + `exitProcess` so the daemon does not hang.
 *
 * Test doubles construct a `ShutdownActions` with all methods as
 * `vi.fn().mockResolvedValue(undefined)` and assert call order via
 * `toHaveBeenCalledBefore`.
 */
export interface ShutdownActions {
  /** Step 1 — flip module-level `daemonState='draining'`. After this resolves
   *  the producer-side gates MUST reject new sessions/subscribes. */
  markDraining(): Promise<void> | void;
  /** Step 2 — clearInterval over the streamHeartbeats Set. */
  clearHeartbeats(): Promise<void> | void;
  /** Step 3 — reject pending reconnect-queue / in-flight bridge calls;
   *  emit ONE aggregated `{event:"daemon-shutdown",droppedCalls:N}` line. */
  rejectPendingCalls(): Promise<void> | void;
  /** Step 4a (§3.5.1.2 step 5) — drain snapshot semaphore queued waiters. */
  drainSnapshotSemaphore(reason: string): Promise<void> | void;
  /** Step 4b (§6.6.1 step 4) — SIGTERM PG, 200ms wait, SIGKILL survivors,
   *  paused sweep, WAL checkpoint, db.close. Owns the per-child deadline. */
  windDownSessions(opts: { perChildDeadlineMs: number }): Promise<void> | void;
  /** Step 5 (§6.6.1 step 5) — close fan-out subscribers; ONE aggregated
   *  `{event:"subscribers-closed",count:N}` line. */
  closeSubscribers(reason: string): Promise<void> | void;
  /** Step 6 — `pino.final()` flush. After this MUST NOT be followed by
   *  any further `logger.*` calls. */
  finalizeLogger(): Promise<void> | void;
  /** Step 7 — `process.exit(0)`. The handler awaits this; in tests pass a
   *  resolved no-op so the test process doesn't actually exit. */
  exitProcess(code: number): Promise<void> | void;
  /** Telemetry sink — invoked when an action throws. The handler does NOT
   *  re-throw so subsequent steps still run. Implementation should log via
   *  pino with the step name + spec ref. */
  recordStepError(step: ShutdownStep, err: unknown): void;
  /** Optional — record deadline overrun (the wall-clock from
   *  `markDraining` start to `closeSubscribers` end exceeded `deadlineMs`).
   *  T25 owns the actual SIGKILL escalation; this hook lets the handler
   *  surface the timing without entangling its sink. */
  recordDeadlineOverrun?(elapsedMs: number, deadlineMs: number): void;
}

export interface DaemonShutdownContext {
  /** Caller-supplied trace ID — forwarded to `recordStepError` via the
   *  pino logger the action provider closes over. The handler itself does
   *  NOT log — staying out of the I/O business. */
  readonly traceId?: string;
  /** Daemon boot nonce — included in the ack so the supervisor can match
   *  the reply to the daemon instance it asked to shut down. */
  readonly bootNonce?: string;
}

export interface DaemonShutdownHandler {
  /** Wire-facing entry point. Called by T16 dispatcher with the inbound
   *  payload. Resolves with the ack reply. Side-effecting steps execute
   *  asynchronously after the reply resolves (`queueMicrotask`) so the
   *  ack envelope is on the wire before the daemon starts exiting. */
  handle(
    req: DaemonShutdownRequest | undefined,
    ctx: DaemonShutdownContext,
  ): Promise<DaemonShutdownReply>;
  /** Test-facing — wait for the side-effect chain (spawned by handle) to
   *  settle. Production callers do not need this; the daemon process is
   *  about to exit anyway. Resolves with the steps that actually ran. */
  whenDrained(): Promise<readonly ShutdownStep[]>;
  /** Test-facing — current internal idempotency state. */
  readonly state: 'idle' | 'draining' | 'drained';
}

/** Method literal — kept here as a constant so callers do not stringly
 *  spell `'daemon.shutdown'` at the wiring site. */
export const DAEMON_SHUTDOWN_METHOD = 'daemon.shutdown' as const;

// Compile-time guard: the literal MUST be on the supervisor allowlist or
// T16 dispatcher would reject it as NOT_ALLOWED. We surface this as a runtime
// assertion at module load to fail loud during boot rather than at first RPC.
if (!isSupervisorRpc(DAEMON_SHUTDOWN_METHOD)) {
  // c8 ignore next 3 — defensive; the allowlist is constant.
  throw new Error(
    `daemon-shutdown handler boot guard: ${DAEMON_SHUTDOWN_METHOD} missing from SUPERVISOR_RPCS (frag-3.4.1 §3.4.1.h)`,
  );
}

/**
 * Build a handler bound to a concrete `ShutdownActions` provider.
 *
 * Lifecycle / idempotency:
 *   - First call: state idle → draining; return `{ idempotency: 'first', ... }`
 *     and schedule the side-effect chain.
 *   - Concurrent re-call (state draining): return `{ idempotency: 'replay' }`
 *     immediately — NO actions invoked.
 *   - Post-drain re-call (state drained): same as concurrent — replay ack.
 */
export function createDaemonShutdownHandler(
  actions: ShutdownActions,
): DaemonShutdownHandler {
  let state: 'idle' | 'draining' | 'drained' = 'idle';
  let firstReply: DaemonShutdownReply | null = null;
  let drainPromise: Promise<readonly ShutdownStep[]> | null = null;

  function clampDeadline(reqMs: number | undefined): number {
    if (typeof reqMs !== 'number' || !Number.isFinite(reqMs) || reqMs <= 0) {
      return SHUTDOWN_DEFAULT_DEADLINE_MS;
    }
    // Hard floor: a 0/negative deadline is meaningless; hard ceiling avoids
    // a malicious / typo'd 24h hang. 60 s is well above the spec's 5 s
    // upgrade window and the daemon's own 200 ms × 20 sessions = 4 s
    // worst-case wind-down (§6.6.1 step 4).
    return Math.min(Math.max(Math.trunc(reqMs), 50), 60_000);
  }

  async function runDrainSequence(reason: string, deadlineMs: number): Promise<readonly ShutdownStep[]> {
    const ran: ShutdownStep[] = [];
    const startMs = Date.now();
    let overrunReported = false;

    // The 4 "drain" steps run BEFORE we check the deadline-overrun hook.
    // `finalize-logger` + `exit-process` always run, even on overrun, because
    // the daemon must not be left hanging (T25 owns the escalation, but the
    // process MUST still exit).
    type StepDef = readonly [ShutdownStep, () => Promise<void> | void];
    const steps: readonly StepDef[] = [
      ['mark-draining', () => actions.markDraining()],
      ['clear-heartbeats', () => actions.clearHeartbeats()],
      ['reject-pending', () => actions.rejectPendingCalls()],
      ['drain-snapshot-semaphore', () => actions.drainSnapshotSemaphore(reason)],
      ['wind-down-sessions', () => actions.windDownSessions({ perChildDeadlineMs: 200 })],
      ['close-subscribers', () => actions.closeSubscribers(reason)],
      ['finalize-logger', () => actions.finalizeLogger()],
      ['exit-process', () => actions.exitProcess(0)],
    ];

    for (const [step, fn] of steps) {
      try {
        await fn();
        ran.push(step);
      } catch (err) {
        // Spec §6.6.1: partial drain is better than silent abort. Record +
        // continue so subsequent sinks (DB close, logger flush, exit) still
        // get to run.
        actions.recordStepError(step, err);
        ran.push(step); // record attempted — caller can grep recordStepError to see failure.
      }
      // After `close-subscribers` (the LAST runtime act per §6.6.1 step 5)
      // check whether we blew the deadline. `finalize-logger` and
      // `exit-process` are bookkeeping; the deadline applies to the
      // user-observable drain only.
      if (!overrunReported && step === 'close-subscribers') {
        const elapsed = Date.now() - startMs;
        if (elapsed > deadlineMs && actions.recordDeadlineOverrun) {
          actions.recordDeadlineOverrun(elapsed, deadlineMs);
          overrunReported = true;
        }
      }
    }

    state = 'drained';
    return Object.freeze(ran);
  }

  return {
    get state() {
      return state;
    },
    async handle(req, ctx) {
      if (state !== 'idle') {
        // Idempotent replay — same ack shape, idempotency: 'replay'.
        // We DELIBERATELY do not re-run any actions even if the original
        // run failed — re-running step 1 (mark-draining) on a partially
        // drained daemon would be a no-op anyway (state already draining)
        // but re-running step 4 (wind-down) could double-SIGKILL surviving
        // children. Caller observes failure via `recordStepError` log lines.
        return {
          ack: 'ok',
          bootNonce: ctx.bootNonce,
          deadlineMs: firstReply?.deadlineMs ?? SHUTDOWN_DEFAULT_DEADLINE_MS,
          planSteps: SHUTDOWN_PLAN.map((s) => s.step),
          idempotency: 'replay',
        };
      }

      state = 'draining';
      const deadlineMs = clampDeadline(req?.deadlineMs);
      const reason = req?.reason ?? 'daemon-shutdown';
      const reply: DaemonShutdownReply = {
        ack: 'ok',
        bootNonce: ctx.bootNonce,
        deadlineMs,
        planSteps: SHUTDOWN_PLAN.map((s) => s.step),
        idempotency: 'first',
      };
      firstReply = reply;

      // Schedule the drain AFTER the ack resolves so the wire reply is
      // observable to the supervisor before `process.exit` runs. Promise
      // construction is synchronous; the actual chain runs on the next
      // microtask. We capture the promise so `whenDrained()` can await it
      // in tests.
      drainPromise = Promise.resolve().then(() => runDrainSequence(reason, deadlineMs));
      // Surface unexpected rejections to the action provider so they cannot
      // become silent unhandledRejections — every per-step throw is already
      // caught above; this is belt-and-braces for the orchestration itself.
      drainPromise.catch((err) => actions.recordStepError('exit-process', err));

      return reply;
    },
    async whenDrained() {
      if (!drainPromise) return Object.freeze<readonly ShutdownStep[]>([]);
      return drainPromise;
    },
  };
}
