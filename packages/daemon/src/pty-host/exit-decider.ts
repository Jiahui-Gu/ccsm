// Pure decider: map a pty-host `ChildExit` observation to the
// `(SessionEndedReason, exit_code)` pair the SessionManager needs.
//
// Spec ch06 §1 — child-exit semantics:
//   - graceful close: child sent `{kind:'exiting', reason:'graceful'}`
//     before its `exit` event fired with `code === 0`. Surfaced here as
//     `reason='graceful'` so the SessionManager records `state=EXITED`.
//     This matches the user-initiated DestroySession terminal state but
//     is reached via the child-exit observation rather than the RPC
//     (the daemon may DestroySession the child first; the child then
//     exits cleanly; both paths converge on `state=EXITED`).
//   - everything else: any non-zero exit code, any signal (SIGKILL /
//     SIGTERM / SIGSEGV), or an IPC disconnect that arrived before a
//     graceful `exiting` notice. All map to `reason='crashed'` so the
//     SessionManager records `state=CRASHED`. v0.3 ship rule per spec
//     ch06 §1: "no respawn" — the daemon does not auto-restart a
//     crashed pty-host. The user re-launches via a fresh
//     `CreateSession` RPC.
//
// SRP (dev.md §3): this module is a *decider* — pure function over the
// `ChildExit` input record + the daemon's internal vocabulary. NO I/O,
// NO logging, NO database access. The sink that calls it (the lifecycle
// watcher) handles all side effects. Keeping the decision pure means
// the same logic is unit-testable without forking a real child.
//
// Layer 1: this is 5 lines of branching that could live inline at the
// watcher, but extraction earns three things: (a) the spec invariant
// "graceful iff `exiting` notice AND code === 0" lives in one place
// instead of being inlined at every call site that grows over T4.x; (b)
// unit tests pin the truth-table independently of the watcher's IPC
// plumbing; (c) a future T9.x crash-source classifier can reuse this
// to label crash_log rows from the same vocabulary the SessionManager
// terminal-state uses.

import type { ChildExit } from './types.js';

import type { SessionEndedReason } from '../sessions/types.js';

/**
 * Result type — exactly the shape `SessionManager.markEnded` expects in
 * its `MarkEndedParams`. Re-exported as a fresh interface (not aliased
 * to `MarkEndedParams`) so `pty-host/` does not depend on the
 * SessionManager's exported parameter types — the watcher does the
 * import-and-forward.
 */
export interface SessionEndDecision {
  readonly reason: SessionEndedReason;
  readonly exit_code: number | null;
}

/**
 * Decide the terminal `(reason, exit_code)` for a pty-host child exit
 * record. Pure function; safe to call from anywhere.
 *
 * Truth table (spec ch06 §1):
 *
 *   exit.reason | exit.code  | exit.signal | decision.reason | decision.exit_code
 *   ------------+------------+-------------+-----------------+--------------------
 *   graceful    | 0          | null        | graceful        | 0
 *   crashed     | <non-zero> | null        | crashed         | <code>
 *   crashed     | null       | <signal>    | crashed         | null
 *   crashed     | 0          | null        | crashed         | 0       (a)
 *   graceful    | <non-zero> | …           | crashed         | <code>  (b)
 *
 * Notes:
 *   (a) The host surface only labels an exit `graceful` when both the
 *       `exiting` notice arrived AND `code === 0`. So `crashed + code 0`
 *       at the decider input is already "the child sent no graceful
 *       notice but happened to exit 0" — still a crash by spec.
 *   (b) Symmetrically, the host clamps `graceful` to require `code 0`,
 *       so this row is unreachable in practice — included for
 *       defense-in-depth: if a future host change relaxes the gate, the
 *       decider still classifies anything with a non-zero code as a
 *       crash.
 */
export function decideSessionEnd(exit: ChildExit): SessionEndDecision {
  if (exit.reason === 'graceful' && exit.code === 0 && exit.signal === null) {
    return { reason: 'graceful', exit_code: 0 };
  }
  return { reason: 'crashed', exit_code: exit.code };
}
