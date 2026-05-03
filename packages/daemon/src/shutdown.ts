// Daemon graceful shutdown — spec ch02 §4 (shutdown order).
//
// T1.8 scope: orchestrate the shutdown sequence triggered by SIGTERM /
// SIGINT (POSIX), Windows `SERVICE_CONTROL_STOP`, OR an authorized
// `/shutdown` RPC on the Supervisor UDS (see ch03 §7 + supervisor.ts
// `onShutdown` callback).
//
// Spec ch02 §4 ordering — all steps below execute in this exact order;
// each step is best-effort (a failure logs + continues so the process
// still exits within the budget):
//
//   1. **Stop accepting** — close every Listener (data-plane). New
//      Connect-RPC connects fail with ECONNREFUSED; in-flight calls
//      keep their socket and continue. Supervisor server is closed
//      LAST (after the data plane drains) so a stuck shutdown can
//      still be diagnosed via `/healthz` if a third party (e.g. the
//      installer's wait loop) is polling.
//   2. **Drain RPC** — wait for in-flight unary RPCs up to
//      `inFlightBudgetMs = 5000`. Streaming RPCs are signalled to abort
//      at step 1's listener close; we do NOT wait for client-side
//      cleanup of bidi streams (the spec phrases this as "send `aborted`
//      and close" — Listener close already closes the http2 sessions).
//   3. **SIGTERM claude children** — for every running pty-host child,
//      ask it to forward `SIGTERM` to its `claude` CLI grandchild.
//      The pty-host child receives a `{kind:'close'}` IPC message which
//      it already knows how to handle (see pty-host/host.ts
//      `closeAndWait` — which is the "send close, escalate to SIGKILL
//      after timeout" primitive we re-use here).
//   4. **SIGKILL after 3s** — `closeAndWait(3000)` already escalates to
//      SIGKILL when the pty-host child does not exit; that covers both
//      the child AND its `claude` grandchild because killing the child
//      reaps `claude` automatically (pty-host/host.ts header comment).
//   5. **Close pty-host children** — `closeAndWait` resolves with the
//      exit outcome regardless; we just await all of them.
//   6. **Checkpoint WAL** — `walCheckpointTruncate(db)` flushes the
//      WAL frames into the main DB and truncates the `-wal` file to
//      zero bytes so the next boot starts from a clean state
//      (db/sqlite.ts header comment + ch07 §5).
//   7. **Close DB** — `db.close()`. better-sqlite3 is synchronous so
//      this is a single call.
//   8. **Exit** — the caller (entrypoint) decides exit code 0/1; the
//      orchestrator returns a result describing what happened so the
//      entrypoint can pick.
//
// SRP layering:
//   - **decider** — `Shutdown.run()` orchestrates the ordered sequence
//     of awaits. It calls injected callables for every side effect; it
//     does NOT itself open / close / kill anything.
//   - **sinks** — every step's actual side effect is supplied by the
//     caller as an injected dependency: `listenerStop()`, `supervisorStop()`,
//     `closeAndKillPty(handle)`, `walCheckpoint(db)`, `dbClose(db)`.
//     This keeps the shutdown module pure (testable without real
//     sockets/sqlite/forks) and matches the spec's "structural
//     containment" theme: each subsystem owns its own teardown
//     primitive; the orchestrator only sequences them.
//   - **producers** — none in this module.
//
// Layer 1 — alternatives checked:
//   - `npm:graceful-shutdown` / `terminus` / `lightship` — generic
//     web-server shutdown helpers; none model our ordered staircase
//     (RPC drain → claude SIGTERM/KILL → WAL → DB) and none expose a
//     hook between "stop listeners" and "kill child processes". A
//     wrapper around them would invert control such that we'd still
//     write all our hooks; net cost: same code + a dep.
//   - Re-using `closeAndWait` from `pty-host/host.ts` — yes, we re-use
//     it. The existing helper already implements steps 3+4 (send close
//     + escalate to SIGKILL after timeout) for a single child; we just
//     fan it out across all running children with `Promise.all`.
//   - Building a per-RPC tracker here — no. The Connect-RPC handler
//     wiring is T2.x's surface; we accept an `inFlightTracker` shape
//     so when T2.x lands its handler interceptor it can register here
//     without us re-shaping the orchestrator. The tracker shape is
//     intentionally minimal (one method: `waitForInFlight(timeoutMs)`)
//     to keep the seam narrow.
//
// What this file is NOT:
//   - Signal-handler installation — `installShutdownHandlers(...)` is
//     a thin convenience but the daemon entrypoint owns the decision
//     of *which* signals trigger shutdown. Tests bypass it entirely.
//   - The `/shutdown` RPC handler — that lives in supervisor/server.ts
//     `onShutdown` callback; the entrypoint wires the callback to call
//     `Shutdown.run()`.
//   - Crash-time fast exit — uncaught exceptions / OOM go through
//     crash collector (T5.10), NOT through this module. Graceful
//     shutdown assumes the lifecycle is healthy enough to drain.

import type { SqliteDatabase } from './db/sqlite.js';
import { walCheckpointTruncate } from './db/sqlite.js';
import type { Listener } from './listeners/types.js';
import type { PtyHostChildHandle } from './pty-host/index.js';
import type { SupervisorServer } from './supervisor/server.js';

// ---------------------------------------------------------------------------
// Spec-locked timing budgets (ch02 §4)
// ---------------------------------------------------------------------------

/** In-flight unary RPC drain budget (ms). Spec ch02 §4 "≤5s budget". */
export const DEFAULT_INFLIGHT_BUDGET_MS = 5_000;
/** SIGTERM → SIGKILL escalation window for `claude` grandchildren (ms). Spec ch02 §4 "SIGKILL after 3s". */
export const DEFAULT_CLAUDE_SIGKILL_MS = 3_000;

// ---------------------------------------------------------------------------
// In-flight RPC tracker — shape only (T2.x wires the impl)
// ---------------------------------------------------------------------------

/**
 * Tracks the count of in-flight unary RPCs. The Connect-RPC handler
 * interceptor (T2.x) increments on each request entry and decrements on
 * response completion; the orchestrator awaits `waitForInFlight()` to
 * know when the drain budget can be released early.
 *
 * v0.3 ships the shape so T1.8's orchestrator surface is stable; T2.x's
 * interceptor populates the impl. Until then the entrypoint can pass
 * `noopInFlightTracker` and the budget acts as a fixed-time pause.
 */
export interface InFlightTracker {
  /**
   * Resolve when the in-flight count reaches zero, OR when `timeoutMs`
   * elapses (whichever is first). Returns the observed count at the
   * moment the promise settled — `0` if drained, `>0` if budget exceeded.
   * MUST NOT throw under normal operation.
   */
  waitForInFlight(timeoutMs: number): Promise<number>;
}

/**
 * No-op tracker for callers that have not yet wired RPC counting (and
 * for unit tests of unrelated paths). Resolves with `0` immediately,
 * regardless of `timeoutMs`. Spec ch02 §4 still requires the budget
 * pause when in-flight is unknown; the entrypoint achieves that by
 * either passing a real tracker OR by *not* using this no-op for
 * production paths. Documented loud here so a careless T2.x grep
 * doesn't ship the no-op into production.
 */
export const noopInFlightTracker: InFlightTracker = {
  waitForInFlight(): Promise<number> {
    return Promise.resolve(0);
  },
};

// ---------------------------------------------------------------------------
// Shutdown context + result
// ---------------------------------------------------------------------------

/**
 * Caller-supplied dependencies. Every field is a pure function /
 * already-constructed handle so the orchestrator can be unit-tested by
 * passing mocks for each.
 */
export interface ShutdownContext {
  /** Data-plane listeners (Listener A; future Listener B in v0.4). Closed in step 1. */
  readonly listeners: ReadonlyArray<Listener>;
  /** Supervisor UDS server. Closed AFTER data-plane (so `/healthz` survives the drain window). */
  readonly supervisor: SupervisorServer | null;
  /**
   * Snapshot of currently running pty-host children. The orchestrator
   * does not own the registry — caller passes an array so mid-shutdown
   * spawn races are the caller's concern (v0.3 entrypoint will freeze
   * the session manager BEFORE calling `run()`).
   */
  readonly ptyHostChildren: ReadonlyArray<PtyHostChildHandle>;
  /** SQLite handle. `null` if the daemon failed before phase OPENING_DB. */
  readonly db: SqliteDatabase | null;
  /** RPC in-flight tracker. Pass `noopInFlightTracker` if RPC layer is not wired. */
  readonly inFlightTracker: InFlightTracker;
  /** Optional structured logger. Defaults to the no-op logger; entrypoint passes a real one. */
  readonly log?: ShutdownLogger;
  /** Override the in-flight RPC drain budget (ms). Defaults to 5000. */
  readonly inFlightBudgetMs?: number;
  /** Override the SIGTERM→SIGKILL claude grandchild window (ms). Defaults to 3000. */
  readonly claudeSigkillMs?: number;
}

/** Per-step log surface. Lets T9 (structured logger) plug in without
 *  this module knowing about log levels / json shapes. */
export interface ShutdownLogger {
  step(name: ShutdownStepName, detail?: Record<string, unknown>): void;
  warn(name: ShutdownStepName, err: unknown, detail?: Record<string, unknown>): void;
}

const noopLogger: ShutdownLogger = {
  step(): void {},
  warn(): void {},
};

/** Names of the ordered steps; useful for logs and tests. */
export type ShutdownStepName =
  | 'stop-accepting'
  | 'drain-rpc'
  | 'close-pty-children'
  | 'wal-checkpoint'
  | 'db-close'
  | 'supervisor-close'
  | 'done';

/**
 * Result returned from `Shutdown.run()`. Surfaces enough to let the
 * entrypoint decide between exit 0 (clean drain) and exit 1 (budget
 * exceeded or step error) without re-deriving anything from logs.
 */
export interface ShutdownResult {
  /**
   * Number of unary RPCs still in flight when the drain budget elapsed.
   * `0` means clean drain; `>0` means the budget was exceeded (the
   * orchestrator continues anyway so the process exits within the
   * total ch02 §4 budget).
   */
  readonly inFlightAtBudgetExpiry: number;
  /** Pty-host child exit outcomes (one per handle in `ctx.ptyHostChildren`). */
  readonly ptyExits: ReadonlyArray<{
    readonly sessionId: string;
    readonly reason: 'graceful' | 'crashed' | 'sigkill';
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  /** Whether the WAL TRUNCATE checkpoint reported `busy === 0`. `null` if no DB was open. */
  readonly walCheckpointBusy: boolean | null;
  /**
   * Per-step errors caught by the orchestrator. Empty array on a fully
   * clean shutdown. Each entry is `[stepName, error]`. Spec ch02 §4
   * does not stop the sequence on a single step failure — the daemon
   * MUST exit, even messily.
   */
  readonly errors: ReadonlyArray<readonly [ShutdownStepName, Error]>;
  /** Total elapsed milliseconds from `run()` entry to return. */
  readonly elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full shutdown sequence per spec ch02 §4. Returns a structured
 * result; never throws (every step's failure is captured into
 * `result.errors` so the caller's exit decision is data-driven).
 *
 * Idempotent: `run()` may be called multiple times concurrently; the
 * second + later calls return a `done`-shaped result without repeating
 * any side effect. The internal latch is per-`Shutdown` instance, NOT
 * a module-level singleton — tests construct their own instance per case.
 */
export class Shutdown {
  private done: ShutdownResult | null = null;
  private inProgress: Promise<ShutdownResult> | null = null;

  async run(ctx: ShutdownContext): Promise<ShutdownResult> {
    if (this.done !== null) return this.done;
    if (this.inProgress !== null) return this.inProgress;
    this.inProgress = this.runOnce(ctx).then((r) => {
      this.done = r;
      this.inProgress = null;
      return r;
    });
    return this.inProgress;
  }

  /** Reports whether `run()` has completed. Useful for `/healthz` sentinel. */
  isDone(): boolean {
    return this.done !== null;
  }

  private async runOnce(ctx: ShutdownContext): Promise<ShutdownResult> {
    const log = ctx.log ?? noopLogger;
    const startedAt = Date.now();
    const errors: Array<readonly [ShutdownStepName, Error]> = [];
    const inFlightBudget = ctx.inFlightBudgetMs ?? DEFAULT_INFLIGHT_BUDGET_MS;
    const claudeSigkill = ctx.claudeSigkillMs ?? DEFAULT_CLAUDE_SIGKILL_MS;

    // ---- Step 1: stop accepting new connects on every data-plane listener.
    log.step('stop-accepting', { count: ctx.listeners.length });
    for (const l of ctx.listeners) {
      try {
        await l.stop();
      } catch (err) {
        errors.push(['stop-accepting', toError(err)]);
        log.warn('stop-accepting', err, { id: l.id });
      }
    }

    // ---- Step 2: drain in-flight unary RPCs (≤ budget).
    log.step('drain-rpc', { budgetMs: inFlightBudget });
    let inFlightAtBudgetExpiry = 0;
    try {
      inFlightAtBudgetExpiry = await ctx.inFlightTracker.waitForInFlight(inFlightBudget);
    } catch (err) {
      // Tracker promised never to throw, but if a buggy impl does we
      // log + treat as "budget exceeded with unknown count".
      errors.push(['drain-rpc', toError(err)]);
      inFlightAtBudgetExpiry = -1;
    }

    // ---- Steps 3+4+5: SIGTERM claude children, escalate to SIGKILL after 3s,
    //                   await all exits.
    log.step('close-pty-children', {
      count: ctx.ptyHostChildren.length,
      sigkillAfterMs: claudeSigkill,
    });
    const ptyExits: ShutdownResult['ptyExits'] = await Promise.all(
      ctx.ptyHostChildren.map(async (h) => {
        try {
          const exit = await h.closeAndWait(claudeSigkill);
          return {
            sessionId: h.sessionId,
            // `closeAndWait` returns `{reason: 'graceful' | 'crashed', ...}`;
            // when it had to SIGKILL the signal will be 'SIGKILL' so we
            // re-classify here for the orchestrator's external surface.
            reason:
              exit.signal === 'SIGKILL'
                ? ('sigkill' as const)
                : (exit.reason as 'graceful' | 'crashed'),
            code: exit.code,
            signal: exit.signal,
          };
        } catch (err) {
          errors.push(['close-pty-children', toError(err)]);
          return {
            sessionId: h.sessionId,
            reason: 'crashed' as const,
            code: null,
            signal: null,
          };
        }
      }),
    );

    // ---- Step 6: WAL checkpoint TRUNCATE.
    let walCheckpointBusy: boolean | null = null;
    if (ctx.db !== null) {
      log.step('wal-checkpoint');
      try {
        const r = walCheckpointTruncate(ctx.db);
        walCheckpointBusy = r.busy === 1;
      } catch (err) {
        errors.push(['wal-checkpoint', toError(err)]);
        log.warn('wal-checkpoint', err);
      }
    }

    // ---- Step 7: close DB.
    if (ctx.db !== null) {
      log.step('db-close');
      try {
        ctx.db.close();
      } catch (err) {
        errors.push(['db-close', toError(err)]);
        log.warn('db-close', err);
      }
    }

    // ---- Last: close the supervisor (so external `/healthz` polling
    //            survives the drain window).
    if (ctx.supervisor !== null) {
      log.step('supervisor-close');
      try {
        await ctx.supervisor.stop();
      } catch (err) {
        errors.push(['supervisor-close', toError(err)]);
        log.warn('supervisor-close', err);
      }
    }

    log.step('done', { elapsedMs: Date.now() - startedAt, errorCount: errors.length });

    return {
      inFlightAtBudgetExpiry,
      ptyExits,
      walCheckpointBusy,
      errors,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Signal-handler convenience (entrypoint plumbing)
// ---------------------------------------------------------------------------

/** Signals that should trigger graceful shutdown on POSIX (Windows uses
 *  SERVICE_CONTROL_STOP which Node surfaces as SIGINT under most service
 *  managers; SIGTERM is included for parity with `kill <pid>`). */
export const SHUTDOWN_SIGNALS: ReadonlyArray<NodeJS.Signals> = ['SIGTERM', 'SIGINT'];

/**
 * Install one-shot signal handlers that invoke `trigger()` exactly once,
 * regardless of how many signals fire. Returns a disposer that removes
 * the handlers (used by tests to avoid leaking listeners across cases).
 *
 * The handler is one-shot because spec ch02 §4 requires ordered cleanup;
 * a second SIGTERM mid-shutdown should NOT restart the sequence (it
 * would double-close listeners). A second SIGINT from an impatient
 * operator does, however, trigger `process.exit(1)` to bypass any
 * stuck step — see `forceExitOnSecondSignal` below.
 *
 * @param trigger    Called once on first signal; should return the
 *                   `Shutdown.run()` promise so the second-signal
 *                   force-exit can race it.
 * @param onSignal   Optional notification (signal name) for logging
 *                   layers. Fires on EVERY signal (including the second).
 */
export function installShutdownHandlers(
  trigger: () => Promise<unknown>,
  onSignal?: (sig: NodeJS.Signals, kind: 'first' | 'second') => void,
  signals: ReadonlyArray<NodeJS.Signals> = SHUTDOWN_SIGNALS,
): () => void {
  let fired = false;
  let runPromise: Promise<unknown> | null = null;
  let forceExitTimer: NodeJS.Timeout | null = null;

  const handler = (sig: NodeJS.Signals): void => {
    if (!fired) {
      fired = true;
      onSignal?.(sig, 'first');
      try {
        runPromise = trigger();
      } catch (err) {
        // `trigger` should never throw synchronously (it awaits run());
        // if it does, log via stderr so the operator sees the failure.
        process.stderr.write(`[ccsm-daemon] shutdown trigger threw: ${String(err)}\n`);
      }
      return;
    }
    onSignal?.(sig, 'second');
    forceExitTimer = forceExitOnSecondSignal(runPromise);
  };

  for (const sig of signals) {
    process.on(sig, handler);
  }
  return () => {
    for (const sig of signals) {
      process.removeListener(sig, handler);
    }
    // Cancel any pending force-exit timer so tests + clean disposers
    // don't leave a 50ms `process.exit` landmine in the event loop.
    if (forceExitTimer !== null) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
  };
}

/**
 * Second-signal escape hatch — if a step is stuck (e.g. a misbehaving
 * pty-host child that won't even die on SIGKILL because it's blocked
 * in an uninterruptable syscall), the operator's second Ctrl-C should
 * exit the process within ~50ms. We give the in-progress run one final
 * 50ms tick to finish gracefully, then `process.exit(1)`.
 *
 * Returns the scheduled timer (if any) so the caller can clearTimeout
 * it during disposer cleanup.
 */
function forceExitOnSecondSignal(runPromise: Promise<unknown> | null): NodeJS.Timeout | null {
  if (runPromise === null) {
    process.exit(1);
    return null;
  }
  const grace = setTimeout(() => process.exit(1), 50);
  void runPromise.finally(() => {
    clearTimeout(grace);
    process.exit(1);
  });
  return grace;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toError(x: unknown): Error {
  return x instanceof Error ? x : new Error(String(x));
}
