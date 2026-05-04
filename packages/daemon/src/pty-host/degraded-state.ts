// Per-session DEGRADED state machine — pure decider for the snapshot
// 3-strike + 60 s cooldown gate (spec ch06 §4 / ch07 §5).
//
// Task #385 — wire-up sub-task #2 of the original T4.11. The coalescer
// (packages/daemon/src/sqlite/coalescer.ts) already counts consecutive
// snapshot/delta write failures and emits `'session-degraded'` when the
// 3-strike threshold (`DEGRADED_FAILURE_THRESHOLD = 3`) is hit. This
// module owns the *next* layer: given the current failure bookkeeping
// and the wall-clock, decide
//   (a) the SessionState (RUNNING vs DEGRADED), and
//   (b) whether the snapshot write gate is OPEN (caller may attempt the
//       next enqueueSnapshot) or CLOSED (caller MUST drop / skip).
//
// SRP (dev.md §2 → §1 step 2 tier 5): this is a (b) DECIDER. Pure
// `(input, context) → decision`. No I/O, no events, no time access
// except through the explicitly-passed `now` parameter (so tests are
// deterministic without fake timers). The producer is the coalescer's
// `'session-degraded'` event handler in host.ts; the sink is host.ts
// gating `coalescer.enqueueSnapshot(...)` on `decideDegraded(...).gateOpen`.
//
// 5-tier "no wheel reinvention" judgement:
//   1. No existing decider in the repo combines 3-strike + cooldown
//      (greppable: this is the only `decideDegraded`). The coalescer's
//      `recordFailure` does the *counting* but does NOT own the
//      cooldown-window gate (spec ch06 §4 explicitly puts the
//      "stops attempting snapshot writes for the next 60 seconds"
//      behavior at the host wire-up layer, not the SQLite layer).
//   2/3. Standard library has no purpose-built state machine for this;
//      `node:timers` would be the wrong tier (a pure decider lets the
//      caller drive the wall-clock from any source — IPC tick, real
//      timer, fake timer in tests).
//   4. No OSS analogue with the right shape (3-strike + time-window
//      gate keyed by per-session counter). The forever-stable threshold
//      and window come from the spec; copying a generic circuit-breaker
//      lib would be more code + more abstraction than the ~30 LOC here.
//   5. Self-written. Justified by the spec-specific contract.

/**
 * Cooldown window after which the gate reopens for a retry attempt.
 * Spec ch06 §4: "stops attempting snapshot writes for this session for
 * the next 60 seconds". Forever-stable; v0.4 may tune downstream knobs
 * but the wire-visible enum value (`SESSION_STATE_DEGRADED`) and the
 * cooldown semantic are set by the spec.
 *
 * Exported so the host.ts wire-up can plumb it through to log lines /
 * test fixtures without duplicating the literal.
 */
export const DEGRADED_COOLDOWN_MS = 60_000;

/**
 * Strike count at which a session enters DEGRADED. Mirrors the
 * coalescer's `DEGRADED_FAILURE_THRESHOLD = 3` — re-declared here so
 * the decider stays self-contained (callers that already have the
 * coalescer's count just pass it in; callers that only have a boolean
 * "did the coalescer emit `'session-degraded'`?" can compare to this
 * constant directly). The two constants MUST stay in sync; a unit
 * test could be added to assert that, but the coupling is so tight
 * (one event handler, one decider call) that the spec-driven value
 * is duplicated knowingly.
 */
export const DEGRADED_STRIKE_THRESHOLD = 3;

/**
 * Inputs to the decider. All fields are immutable per call; the host
 * wire-up owns the mutable state and re-derives the snapshot for every
 * snapshot enqueue attempt.
 */
export interface DegradedStateInput {
  /**
   * Consecutive snapshot write failures observed on this session since
   * the last successful write. Sourced from the coalescer's per-session
   * `consecutiveFailures` counter (or computed locally by counting
   * `'session-degraded'` events — equivalent for this decider's purposes).
   */
  readonly consecutiveFailures: number;
  /**
   * Wall-clock millis at which the most recent snapshot write failure
   * was observed (Date.now() at the time of the throw / event). `null`
   * if no failure has ever been observed (first call after session
   * start). Drives the cooldown-window math.
   */
  readonly lastFailureAtMs: number | null;
  /**
   * Wall-clock millis at decision time. Passed in (NOT read via
   * `Date.now()`) so unit tests can assert exact cooldown boundaries
   * without any timer mocking.
   */
  readonly nowMs: number;
}

/**
 * Per-session SessionState as observed by this decider. Mirrors the
 * proto enum's two variants relevant to this state machine; the other
 * SessionState values (STARTING / EXITED / CRASHED / UNSPECIFIED) are
 * driven by other deciders (lifecycle-watcher, exit-decider) and are
 * NOT this module's concern.
 */
export type DegradedSessionState = 'RUNNING' | 'DEGRADED';

/**
 * Decision returned by {@link decideDegraded}.
 *
 * - `state`: which proto SessionState the session should be reported as.
 *   `'RUNNING'` if the strike count is below threshold OR if the
 *   cooldown window has elapsed and the gate is now reopened
 *   (semantically: "ready to retry"). `'DEGRADED'` otherwise.
 *
 * - `gateOpen`: whether the host wire-up MAY call
 *   `coalescer.enqueueSnapshot(...)`. `false` while the cooldown is
 *   active (spec ch06 §4: daemon stops attempting writes for 60 s);
 *   `true` otherwise.
 *
 * The two fields are NOT redundant. A session can be in
 * `state='DEGRADED'` with `gateOpen=true` momentarily — that's the
 * "cooldown elapsed, retry pending" state where the next enqueue will
 * fire and either reset the counter (success → state flips back to
 * RUNNING on the *next* decide call after the coalescer's
 * `consecutiveFailures` is reset) or re-arm the cooldown
 * (failure → lastFailureAtMs is updated, gate closes again).
 *
 * Notation note: we report `state='DEGRADED'` precisely while the
 * cooldown window is active. Once the cooldown elapses we promote back
 * to `state='RUNNING'` *speculatively* — even if the next retry hasn't
 * happened yet — because the spec defines DEGRADED as "stops attempting
 * snapshot writes for the next 60 seconds": once that window is over,
 * the session is no longer in the "stops attempting" mode. If the next
 * retry fails, the next decide call will re-enter DEGRADED.
 */
export interface DegradedStateDecision {
  readonly state: DegradedSessionState;
  readonly gateOpen: boolean;
}

/**
 * Decide the per-session DEGRADED state + snapshot-write gate.
 *
 * Decision table:
 *
 *   consecutiveFailures < THRESHOLD:
 *     → state=RUNNING, gateOpen=true                 (normal happy path)
 *
 *   consecutiveFailures >= THRESHOLD AND lastFailureAtMs == null:
 *     → state=RUNNING, gateOpen=true                 (defensive: callers
 *       must always pass lastFailureAtMs alongside a non-zero
 *       failure count; a null with count>=3 is a programmer error
 *       that we treat as "no cooldown to honor")
 *
 *   consecutiveFailures >= THRESHOLD AND nowMs - lastFailureAtMs < COOLDOWN_MS:
 *     → state=DEGRADED, gateOpen=false               (cooldown active)
 *
 *   consecutiveFailures >= THRESHOLD AND nowMs - lastFailureAtMs >= COOLDOWN_MS:
 *     → state=RUNNING, gateOpen=true                 (cooldown elapsed,
 *       retry permitted; the next failure or success will redrive
 *       state through this decider on the following call)
 *
 * Boundary semantics: "cooldown elapsed" uses `>=` (inclusive) on the
 * 60 s mark, matching the spec's "for the next 60 seconds" reading
 * (i.e. the gate reopens at exactly t+60000ms, not t+60001ms).
 */
export function decideDegraded(
  input: DegradedStateInput,
): DegradedStateDecision {
  if (input.consecutiveFailures < DEGRADED_STRIKE_THRESHOLD) {
    return { state: 'RUNNING', gateOpen: true };
  }
  if (input.lastFailureAtMs === null) {
    // Programmer error path; see jsdoc table comment 2.
    return { state: 'RUNNING', gateOpen: true };
  }
  const elapsed = input.nowMs - input.lastFailureAtMs;
  if (elapsed < DEGRADED_COOLDOWN_MS) {
    return { state: 'DEGRADED', gateOpen: false };
  }
  return { state: 'RUNNING', gateOpen: true };
}
