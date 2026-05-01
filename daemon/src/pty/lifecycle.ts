// T37 — PTY lifecycle FSM (pure decider).
//
// Per feedback_single_responsibility: this module is the DECIDER. It maps
// (state, event) → next state via a static transition table. It performs no
// I/O, no waitpid, no DB writes, no fan-out, no logging. Producers (PTY
// SIGCHLD handler, supervisor) feed events in; sinks (DB UPDATE, fan-out
// emits) consume the resulting state.
//
// State enum is the source-of-truth from T28 schema:
//   sessions.state CHECK IN ('running', 'paused', 'exited', 'shutting_down', 'crashed')
// (see daemon/src/db/schema/v0.3.sql line 27).
//
// Transition table is derived from frag-3.5.1 §3.5.1.2:
//   - running → shutting_down (daemonShutdown begins, step 2)
//   - shutting_down → exited  (clean SIGCHLD reap during drain, step 6)
//   - shutting_down → paused  (final sweep, survivors past SIGKILL, step 8)
//   - running → exited        (clean exit outside shutdown — graceful path)
//   - running → crashed       (unclean exit / signal kill)
//   - paused  → running       (next-boot resume per frag-6-7 §6.3)
//
// Spec invariants enforced:
//   - exited / crashed are TERMINAL. `crashed → start` is rejected: a fresh
//     session row is required (matches frag-6-7 §6.3 — only `paused` is
//     resumable on next-boot recovery).
//   - Idempotency: `exited.exit(code)` is illegal (already exited).
//   - `shutting_down → shutting_down` via repeated shutdown_request or
//     force_kill is allowed as a no-op (drain is already in progress); the
//     FSM does not double-fire side effects since the state is unchanged.

/** Canonical state set — matches sessions.state CHECK constraint (T28). */
export const PTY_LIFECYCLE_STATES = [
  'running',
  'paused',
  'exited',
  'shutting_down',
  'crashed',
] as const;

export type PtyLifecycleState = (typeof PTY_LIFECYCLE_STATES)[number];

/** Initial pseudo-state: a session row before `start` has been observed. */
export type PtyLifecycleStateOrInitial = PtyLifecycleState | 'initial';

/**
 * Events consumed by the FSM. Names locked by Task #994 spec.
 *
 * - `start`              — child spawn succeeded (initial → running).
 * - `pause`              — daemon-shutdown final sweep marks a surviving
 *                          child as paused (frag-3.5.1 §3.5.1.2 step 8).
 * - `resume`             — next-boot recovery respawns a paused session
 *                          (frag-6-7 §6.3).
 * - `exit(exitCode)`     — child exited (clean or with code). Decider maps
 *                          to `exited` (code === 0) or `crashed` (non-zero).
 * - `shutdown_request`   — daemonShutdown RPC entered draining
 *                          (frag-3.5.1 §3.5.1.2 step 2 — running →
 *                          shutting_down).
 * - `crash(reason)`      — out-of-band crash signal not delivering exit
 *                          code via the normal `exit` path (e.g. native
 *                          binding crash, JobObject termination on Win).
 * - `force_kill`         — supervisor escalated to SIGKILL / TerminateProcess
 *                          (frag-3.5.1 §3.5.1.2 step 7). Does not change
 *                          state by itself; the resulting reap arrives via
 *                          `exit` or `crash`. Allowed in `running` and
 *                          `shutting_down` as a no-op state-wise.
 */
export type PtyLifecycleEvent =
  | { kind: 'start' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'exit'; exitCode: number; signal?: string | null }
  | { kind: 'shutdown_request' }
  | { kind: 'crash'; reason: string }
  | { kind: 'force_kill' };

export type PtyLifecycleEventKind = PtyLifecycleEvent['kind'];

/** Optional structured side-output for callers (no I/O performed here). */
export interface PtyLifecycleOutput {
  /** Set on transitions caused by `exit`. */
  exitCode?: number;
  /** Set on transitions caused by `exit` if a signal was reported. */
  signal?: string | null;
  /** Set on transitions caused by `crash`. */
  reason?: string;
}

export interface PtyLifecycleTransition {
  state: PtyLifecycleStateOrInitial;
  output?: PtyLifecycleOutput;
}

/** Typed error returned for any rejected (illegal) transition. */
export interface PtyLifecycleIllegalTransition {
  kind: 'illegal_transition';
  from: PtyLifecycleStateOrInitial;
  event: PtyLifecycleEventKind;
}

export type PtyLifecycleResult =
  | { ok: true; transition: PtyLifecycleTransition }
  | { ok: false; error: PtyLifecycleIllegalTransition };

/**
 * Pure transition function. Caller decides what to do with the new state
 * (DB UPDATE, fan-out emit, supervisor metric, etc.).
 */
export function transition(
  from: PtyLifecycleStateOrInitial,
  event: PtyLifecycleEvent,
): PtyLifecycleResult {
  switch (from) {
    case 'initial':
      if (event.kind === 'start') {
        return ok('running');
      }
      return illegal(from, event.kind);

    case 'running':
      switch (event.kind) {
        case 'pause':
          // Direct pause from running is allowed (e.g. test harness or
          // future v0.4 user-initiated pause). The shutdown path uses
          // running → shutting_down → paused; both terminate at paused.
          return ok('paused');
        case 'shutdown_request':
          return ok('shutting_down');
        case 'exit':
          return ok(exitCodeToState(event.exitCode), {
            exitCode: event.exitCode,
            signal: event.signal ?? null,
          });
        case 'crash':
          return ok('crashed', { reason: event.reason });
        case 'force_kill':
          // Signal-only; reap arrives later via `exit` / `crash`. State
          // unchanged so the FSM does not invent a row update.
          return ok('running');
        case 'start':
        case 'resume':
          return illegal(from, event.kind);
      }
      return illegal(from, (event as PtyLifecycleEvent).kind);

    case 'shutting_down':
      switch (event.kind) {
        case 'exit':
          return ok(exitCodeToState(event.exitCode), {
            exitCode: event.exitCode,
            signal: event.signal ?? null,
          });
        case 'pause':
          // Final sweep: survivors past SIGKILL deadline marked paused
          // (frag-3.5.1 §3.5.1.2 step 8).
          return ok('paused');
        case 'crash':
          return ok('crashed', { reason: event.reason });
        case 'shutdown_request':
        case 'force_kill':
          // Drain already in progress / supervisor escalation. No state
          // change — the resulting reap will deliver exit/crash.
          return ok('shutting_down');
        case 'start':
        case 'resume':
          return illegal(from, event.kind);
      }
      return illegal(from, (event as PtyLifecycleEvent).kind);

    case 'paused':
      switch (event.kind) {
        case 'resume':
          // Next-boot recovery respawn (frag-6-7 §6.3). Caller is
          // responsible for clearing pid/pgid columns BEFORE calling.
          return ok('running');
        case 'start':
        case 'pause':
        case 'exit':
        case 'shutdown_request':
        case 'crash':
        case 'force_kill':
          return illegal(from, event.kind);
      }
      return illegal(from, (event as PtyLifecycleEvent).kind);

    case 'exited':
    case 'crashed':
      // Terminal states. `crashed → start` is explicitly rejected — a
      // fresh session row is required (frag-6-7 §6.3 only resumes
      // `paused`). Same for `exited`.
      return illegal(from, event.kind);
  }

  // Exhaustiveness: TypeScript should make this unreachable.
  const _exhaustive: never = from;
  void _exhaustive;
  return illegal(from, event.kind);
}

function ok(
  state: PtyLifecycleStateOrInitial,
  output?: PtyLifecycleOutput,
): PtyLifecycleResult {
  return output === undefined
    ? { ok: true, transition: { state } }
    : { ok: true, transition: { state, output } };
}

function illegal(
  from: PtyLifecycleStateOrInitial,
  event: PtyLifecycleEventKind,
): PtyLifecycleResult {
  return { ok: false, error: { kind: 'illegal_transition', from, event } };
}

function exitCodeToState(code: number): PtyLifecycleState {
  // Convention (frag-3.5.1 §3.5.1.2): a clean exit (code === 0, no fatal
  // signal) → `exited`; non-zero → `crashed`. Caller may pass signal info
  // through `output.signal` but the state mapping is purely on exitCode
  // to keep the decider table testable.
  return code === 0 ? 'exited' : 'crashed';
}
