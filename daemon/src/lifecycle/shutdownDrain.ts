// Task #145 — 9-step shutdown drain orchestrator.
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md
//     §6.6.1 ordered shutdown sequence (the authoritative drain ordering).
//   - docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
//     §3.5.1.2 step 5 (snapshot semaphore + PTY children wind-down).
//   - docs/superpowers/specs/v0.3-design.md final-arch shutdown ordering
//     (Connect server stop → in-flight drain → PTY → DB → fan-out → log
//      flush → lockfile release → exit).
//
// What this module owns (Decider):
//   - Strict ordering of the 9 shutdown steps. Reorder is a spec change.
//   - Per-step timeout + force progress (step 2: 5 s in-flight envelope
//     drain, all others: bounded best-effort).
//   - Idempotency: a second run() returns the same recorded outcome.
//   - Telemetry sink for step start/finish/timeout/error.
//
// What it does NOT own (Sinks — injected via `ShutdownDriver`):
//   - Per-subsystem close/checkpoint primitives. Each driver field is a
//     swap-friendly handle the daemon entry-point wires up at boot.
//   - Logger. The orchestrator emits structured events through an
//     injected `onEvent` so the entry-point can route to pino without
//     coupling the orchestrator to a logger instance.
//   - process.exit. Step 9 calls `driver.exitProcess(code)`; tests pass
//     a no-op so the test process doesn't actually exit.
//
// Subsystem swap notes (per task brief — zero-rework rule):
//   - Step 4 (PTY children wind-down): currently calls
//     `driver.windDownPtyChildren()`. The default wiring (in
//     daemon/src/index.ts) routes this through `ccsm_native.sigchld` to
//     wait on surviving PIDs. When #108 lands the real PTY lifecycle
//     FSM, only the index.ts wiring changes — this orchestrator stays.
//   - Step 5 (DB checkpoint): currently a no-op stub because #105 has
//     not exposed a daemon-wide DB handle yet. When the schema/migration
//     slice exposes the per-process Database, the index.ts wiring will
//     supply a real `driver.checkpointAndCloseDb()`.
//   - Step 8 (lockfile release): wraps `proper-lockfile.unlock` if
//     present; falls back to `fs.unlink` of the lock path. #123
//     lockfile slice will replace the wiring in index.ts only.

import { performance } from 'node:perf_hooks';

/** The nine shutdown steps, in strict execution order (final-arch). */
export const SHUTDOWN_DRAIN_STEPS = [
  'stop-accepting',           // 1. Connect server + envelope dispatcher refuse new requests.
  'drain-in-flight-envelope', // 2. Wait for pending envelope handlers (timeout 5 s).
  'drain-connect-streams',    // 3. Close fan-out registry / Connect streams (going_away).
  'wind-down-pty-children',   // 4. SIGTERM/SIGCHLD wait on PTY children (T37).
  'checkpoint-db',            // 5. SQLite WAL checkpoint + close (T28).
  'close-fanout-registry',    // 6. Final sweep of fan-out subscribers.
  'flush-logs',               // 7. pino flush (best-effort; #147 will pino.final).
  'release-lockfile',         // 8. unlock daemon.lock (#123).
  'exit-process',             // 9. process.exit(0).
] as const;

export type ShutdownDrainStep = (typeof SHUTDOWN_DRAIN_STEPS)[number];

export interface ShutdownDrainPlanStep {
  readonly step: ShutdownDrainStep;
  readonly description: string;
  /** Per-step soft timeout (ms). Step 2 is the only step that *waits* —
   *  the others are best-effort fire-and-forget with a tiny ceiling so a
   *  hung subsystem cannot freeze the daemon. */
  readonly timeoutMs: number;
}

export const SHUTDOWN_DRAIN_PLAN: readonly ShutdownDrainPlanStep[] = Object.freeze([
  {
    step: 'stop-accepting',
    description:
      'flip dispatcher state to draining; reject new envelope/Connect requests with UNAVAILABLE',
    timeoutMs: 200,
  },
  {
    step: 'drain-in-flight-envelope',
    description:
      'wait for in-flight envelope handlers to settle; force progress after 5 s',
    timeoutMs: 5_000,
  },
  {
    step: 'drain-connect-streams',
    description:
      'emit going_away on Connect/fan-out subscribers so renderers reconnect cleanly',
    timeoutMs: 1_000,
  },
  {
    step: 'wind-down-pty-children',
    description:
      'await SIGCHLD on surviving PTY children via ccsm_native.sigchld (T37 placeholder until #108 lands real FSM)',
    timeoutMs: 2_000,
  },
  {
    step: 'checkpoint-db',
    description:
      'PRAGMA wal_checkpoint(TRUNCATE); db.close() (T28 placeholder until #105 exposes shared DB handle)',
    timeoutMs: 1_000,
  },
  {
    step: 'close-fanout-registry',
    description:
      'final sweep of fan-out subscriber registry; one aggregated subscribers-closed line',
    timeoutMs: 500,
  },
  {
    step: 'flush-logs',
    description: 'best-effort logger.flush(); #147 will swap for pino.final',
    timeoutMs: 200,
  },
  {
    step: 'release-lockfile',
    description: 'release proper-lockfile (or fs.unlink fallback) on daemon.lock (#123)',
    timeoutMs: 500,
  },
  {
    step: 'exit-process',
    description: 'process.exit(0) — supervisor sees normal child reap',
    timeoutMs: 100,
  },
]);

/** Side-effect provider — every method is invoked at most once per drain.
 *  Methods MAY be async; the orchestrator awaits in spec order with a
 *  per-step timeout. Errors thrown / rejections are routed through
 *  `onEvent({kind:'error', ...})` and the sequence CONTINUES — partial
 *  drain is better than silent abort. */
export interface ShutdownDriver {
  /** Step 1. Flip dispatcher / Connect server into draining mode so new
   *  inbound requests are answered with UNAVAILABLE. */
  stopAcceptingNewRequests(): Promise<void> | void;
  /** Step 2. Resolve when every in-flight envelope handler has settled.
   *  The orchestrator races this against a 5 s timeout and force-
   *  progresses on overrun. */
  drainInFlightEnvelope(): Promise<void> | void;
  /** Step 3. Close Connect streams / emit going_away on fan-out. The
   *  registry close in step 6 is the final sweep; this step is the
   *  graceful goodbye. */
  drainConnectStreams(reason: string): Promise<void> | void;
  /** Step 4. Wait for PTY children to exit (or SIGKILL survivors). */
  windDownPtyChildren(opts: { perChildDeadlineMs: number }): Promise<void> | void;
  /** Step 5. WAL checkpoint + db.close. */
  checkpointAndCloseDb(): Promise<void> | void;
  /** Step 6. Final sweep of fan-out registry. */
  closeFanoutRegistry(reason: string): Promise<void> | void;
  /** Step 7. Best-effort logger flush. */
  flushLogs(): Promise<void> | void;
  /** Step 8. Release the daemon lockfile. */
  releaseLockfile(): Promise<void> | void;
  /** Step 9. Terminate the process. Tests pass a no-op. */
  exitProcess(code: number): Promise<void> | void;
}

export type ShutdownDrainEvent =
  | { kind: 'step-start'; step: ShutdownDrainStep }
  | { kind: 'step-finish'; step: ShutdownDrainStep; elapsedMs: number }
  | { kind: 'step-timeout'; step: ShutdownDrainStep; timeoutMs: number }
  | { kind: 'step-error'; step: ShutdownDrainStep; err: unknown }
  | { kind: 'drain-complete'; ran: readonly ShutdownDrainStep[]; elapsedMs: number };

export interface ShutdownDrainOptions {
  readonly driver: ShutdownDriver;
  /** Telemetry sink — receives ordered events for every step. */
  readonly onEvent?: (e: ShutdownDrainEvent) => void;
  /** Free-form reason recorded in step args (e.g. 'SIGTERM', 'uninstall'). */
  readonly reason?: string;
  /** Per-child deadline forwarded to step 4. Default 200 ms (frag-6-7). */
  readonly perChildDeadlineMs?: number;
  /** Override step timeouts (for tests). Keys are step names; values
   *  override the default in `SHUTDOWN_DRAIN_PLAN`. */
  readonly timeoutOverrides?: Partial<Record<ShutdownDrainStep, number>>;
}

export interface ShutdownDrainResult {
  readonly ran: readonly ShutdownDrainStep[];
  readonly elapsedMs: number;
  readonly timedOut: readonly ShutdownDrainStep[];
  readonly errored: readonly ShutdownDrainStep[];
}

/** Race a value against a timeout. Returns `'timeout'` sentinel if the
 *  timer fires first; otherwise the awaited value (or rejects with the
 *  underlying error). */
async function withTimeout<T>(
  fn: () => Promise<T> | T,
  timeoutMs: number,
): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T | 'timeout'>([
      Promise.resolve().then(fn),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        // unref so the timer doesn't keep the event loop alive past
        // process.exit on platforms where unref is supported.
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run the 9-step shutdown drain. Idempotent across calls — a second
 *  invocation returns the same recorded result without re-running any
 *  step (avoid double-SIGKILL of children, double-close of DB, etc.). */
export function createShutdownDrain(opts: ShutdownDrainOptions): {
  run(): Promise<ShutdownDrainResult>;
  readonly state: 'idle' | 'draining' | 'drained';
} {
  let state: 'idle' | 'draining' | 'drained' = 'idle';
  let pending: Promise<ShutdownDrainResult> | null = null;
  let cached: ShutdownDrainResult | null = null;

  const reason = opts.reason ?? 'daemon-shutdown';
  const perChildDeadlineMs = opts.perChildDeadlineMs ?? 200;
  const onEvent = opts.onEvent ?? (() => undefined);

  function timeoutFor(step: ShutdownDrainStep): number {
    const override = opts.timeoutOverrides?.[step];
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
      return override;
    }
    const planStep = SHUTDOWN_DRAIN_PLAN.find((p) => p.step === step);
    return planStep?.timeoutMs ?? 1_000;
  }

  async function execute(): Promise<ShutdownDrainResult> {
    const ran: ShutdownDrainStep[] = [];
    const timedOut: ShutdownDrainStep[] = [];
    const errored: ShutdownDrainStep[] = [];
    const startMs = performance.now();

    type StepDef = readonly [ShutdownDrainStep, () => Promise<unknown> | unknown];
    const { driver } = opts;
    const steps: readonly StepDef[] = [
      ['stop-accepting', () => driver.stopAcceptingNewRequests()],
      ['drain-in-flight-envelope', () => driver.drainInFlightEnvelope()],
      ['drain-connect-streams', () => driver.drainConnectStreams(reason)],
      ['wind-down-pty-children', () => driver.windDownPtyChildren({ perChildDeadlineMs })],
      ['checkpoint-db', () => driver.checkpointAndCloseDb()],
      ['close-fanout-registry', () => driver.closeFanoutRegistry(reason)],
      ['flush-logs', () => driver.flushLogs()],
      ['release-lockfile', () => driver.releaseLockfile()],
      ['exit-process', () => driver.exitProcess(0)],
    ];

    for (const [step, fn] of steps) {
      const stepStartMs = performance.now();
      onEvent({ kind: 'step-start', step });
      try {
        const result = await withTimeout(fn, timeoutFor(step));
        if (result === 'timeout') {
          timedOut.push(step);
          onEvent({ kind: 'step-timeout', step, timeoutMs: timeoutFor(step) });
        }
      } catch (err) {
        errored.push(step);
        onEvent({ kind: 'step-error', step, err });
      }
      ran.push(step);
      onEvent({
        kind: 'step-finish',
        step,
        elapsedMs: performance.now() - stepStartMs,
      });
    }

    const result: ShutdownDrainResult = Object.freeze({
      ran: Object.freeze(ran),
      elapsedMs: performance.now() - startMs,
      timedOut: Object.freeze(timedOut),
      errored: Object.freeze(errored),
    });
    onEvent({ kind: 'drain-complete', ran: result.ran, elapsedMs: result.elapsedMs });
    state = 'drained';
    cached = result;
    return result;
  }

  return {
    get state() {
      return state;
    },
    async run() {
      if (cached) return cached;
      if (pending) return pending;
      state = 'draining';
      pending = execute();
      return pending;
    },
  };
}
