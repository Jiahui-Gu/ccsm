// Daemon lifecycle state machine — spec ch02 §3 (startup steps 1–5) and
// ch03 §7 (Supervisor `/healthz` flips to 200 only when phase = READY).
//
// T1.1 scope: just the state machine + `currentPhase()` getter. The actual
// step bodies (DB open, session restore, listener bind) are stubbed by
// later tasks — see TODO markers in `index.ts`.

/**
 * Daemon startup phases. Linear, monotonic — never goes backwards within
 * a single boot. `/healthz` (T1.7) returns 503 for every phase except
 * READY, then 200.
 */
export const Phase = {
  /** Process started; nothing initialized yet. */
  PRE_START: 'PRE_START',
  /** Reading env, building DaemonEnv (ch02 §3 step ~implicit before 1). */
  LOADING_CONFIG: 'LOADING_CONFIG',
  /** Opening SQLite + running migrations (ch02 §3 step 2). T5.1 fills body. */
  OPENING_DB: 'OPENING_DB',
  /** Re-spawning `should-be-running` sessions (ch02 §3 step 4). T3.4 fills body. */
  RESTORING_SESSIONS: 'RESTORING_SESSIONS',
  /** Binding Listener A + writing descriptor (ch02 §3 step 5). T1.4 fills body. */
  STARTING_LISTENERS: 'STARTING_LISTENERS',
  /** All steps green; Supervisor `/healthz` flips to 200. */
  READY: 'READY',
} as const;

/* eslint-disable-next-line @typescript-eslint/no-redeclare -- mirror Phase
   const-object as a type alias so callers can write `Phase.READY` (value)
   AND `Phase` (type). Standard TS const-as-enum pattern. */
export type Phase = (typeof Phase)[keyof typeof Phase];

/**
 * Allowed forward transitions. Used by `Lifecycle.advanceTo` to refuse
 * out-of-order phase moves (a programming error, not a runtime condition).
 */
const PHASE_ORDER: readonly Phase[] = [
  Phase.PRE_START,
  Phase.LOADING_CONFIG,
  Phase.OPENING_DB,
  Phase.RESTORING_SESSIONS,
  Phase.STARTING_LISTENERS,
  Phase.READY,
];

function phaseIndex(p: Phase): number {
  const i = PHASE_ORDER.indexOf(p);
  if (i < 0) {
    throw new Error(`unknown phase: ${String(p)}`);
  }
  return i;
}

export class PhaseTransitionError extends Error {
  constructor(
    public readonly from: Phase,
    public readonly to: Phase,
  ) {
    super(`invalid phase transition: ${from} -> ${to}`);
    this.name = 'PhaseTransitionError';
  }
}

/**
 * Lifecycle state machine. Single instance per daemon process; built in
 * `index.ts` at boot and passed by reference into the supervisor (T1.7)
 * so `/healthz` can read `currentPhase()` without a global.
 */
export class Lifecycle {
  private _phase: Phase = Phase.PRE_START;
  private _failure: { phase: Phase; error: Error } | null = null;
  private readonly listeners = new Set<(p: Phase) => void>();

  /** Read-only getter for downstream `/healthz` (T1.7). */
  currentPhase(): Phase {
    return this._phase;
  }

  /** Returns true once the daemon has reached READY without a failure. */
  isReady(): boolean {
    return this._phase === Phase.READY && this._failure === null;
  }

  /** Returns the recorded failure (if any) — surfaced by `/healthz` for ops. */
  failure(): { phase: Phase; error: Error } | null {
    return this._failure;
  }

  /**
   * Advance to `next`. Forward-only and exactly one step at a time
   * (matches spec's linear startup order). Anything else throws.
   */
  advanceTo(next: Phase): void {
    if (this._failure !== null) {
      throw new PhaseTransitionError(this._phase, next);
    }
    const cur = phaseIndex(this._phase);
    const nxt = phaseIndex(next);
    if (nxt !== cur + 1) {
      throw new PhaseTransitionError(this._phase, next);
    }
    this._phase = next;
    for (const fn of this.listeners) {
      fn(next);
    }
  }

  /**
   * Record a phase failure. The phase pointer is left where it was — ops
   * tools see "we failed entering phase X" via `failure()`. The entrypoint
   * is expected to log + exit 1 after calling this.
   */
  fail(error: Error): void {
    if (this._failure !== null) {
      return;
    }
    this._failure = { phase: this._phase, error };
  }

  /** Subscribe to phase transitions (used by the smoke logger in index.ts). */
  onTransition(fn: (p: Phase) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
