// T6.8 — Cold-start trigger decider for the daemon-not-running modal.
//
// Spec ref: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// chapter 08 §6.1.
//
// Concern: decide WHEN to surface `<DaemonNotRunningModal>` as
// `open={true}`, given the connection state surfaced by T6.7's
// `useConnection()`. The spec rule (line 2323) is:
//
//   "If the renderer's first `Hello` does not succeed within 8 seconds
//    (cold-start budget; covers daemon-still-starting on a slow VM), the
//    renderer renders a blocking modal."
//
// Mapping onto T6.7's state machine (`use-connection.tsx` :: ConnectionState):
//
//   - `connecting` / `reconnecting` for >= 8000 ms after the cold-start
//     timer was armed → open the modal.
//   - `connected` → close the modal AND clear the timer (spec line 2333:
//     "The modal is dismissible only by a successful `Hello`."). Once
//     closed, a SUBSEQUENT drop is a steady-state reconnect and the §6
//     "Reconnecting..." banner takes over — NOT this modal again. The
//     modal is the cold-start UX, not a connection-loss UX.
//   - `version-mismatch` → never open this modal. Version mismatch has
//     its own dedicated UX (T6.7 surfaces the state; a separate component
//     out of scope here renders it). Showing the cold-start modal there
//     would mislead — the daemon IS running, just incompatible.
//
// SRP: pure decider with one timer side-effect. Producer = T6.7's
// `useConnection().state`. Sink = the boolean returned to the modal
// component. No DOM, no Connect, no fetch.
//
// Test seam: `nowMs` + `setTimeoutFn` + `clearTimeoutFn` are injectable
// so unit tests can drive the 8s budget deterministically with vitest's
// fake timers OR a hand-rolled clock. Production callers omit; defaults
// resolve to `Date.now` + globals.

import * as React from 'react';

import {
  useConnection,
  type ConnectionState,
} from '../connection/use-connection.js';

/** Cold-start budget in milliseconds. Locked by spec §6.1. */
export const COLD_START_BUDGET_MS = 8000 as const;

/**
 * Decide if the modal should be open RIGHT NOW given the wall-clock
 * elapsed since the cold-start timer was armed and the current state.
 *
 * Pure function; exported for unit testing alongside the hook.
 *
 * - `connected` → never open (spec line 2333).
 * - `version-mismatch` → never open (different UX, see file header).
 * - `connecting` / `reconnecting` AND no successful Hello yet AND
 *   `elapsedMs >= 8000` → open.
 *
 * `everConnected` is the latch that distinguishes the cold-start path
 * from the steady-state reconnect path. Once we have seen `connected`
 * even once, future `reconnecting` states are NOT cold-start — they get
 * the §6 banner instead of the §6.1 modal.
 */
export function shouldShowColdStartModal(args: {
  readonly state: ConnectionState;
  readonly everConnected: boolean;
  readonly elapsedMs: number;
}): boolean {
  if (args.everConnected) return false;
  if (args.state.kind === 'connected') return false;
  if (args.state.kind === 'version-mismatch') return false;
  return args.elapsedMs >= COLD_START_BUDGET_MS;
}

/** Injectable timer surface for tests. */
export interface ColdStartTimerDeps {
  readonly nowMs?: () => number;
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

/** Public hook return. */
export interface UseDaemonColdStartModalResult {
  /** Whether the modal should be rendered with `open={true}`. */
  readonly open: boolean;
  /** Re-arm the connection (T6.7's `retryNow`). Pass to modal `onRetry`. */
  readonly onRetry: () => void;
}

/**
 * React hook that bridges T6.7's `useConnection()` state to the modal's
 * `open` boolean. Arms an 8s timer on mount; flips `open` to true when
 * the timer fires AND we have not yet observed a successful Hello.
 *
 * Once we have observed `connected` even once, the modal stays closed
 * for the rest of the renderer's lifetime — subsequent drops are
 * surfaced by the §6 reconnect banner (rendered by a sibling component
 * not owned by this hook).
 *
 * Why a timer instead of a `nextDelayMs * attempt >= 8000` accumulator:
 *   - The spec wording is wall-clock ("within 8 seconds"), not
 *     attempt-based.
 *   - A flaky transport that resolves Hello slowly (e.g., 7s on attempt
 *     0) would skip the modal under an attempt-based rule but should
 *     still be flagged under wall-clock.
 *   - Single timer = one piece of state to abort on connect / unmount,
 *     trivially testable with fake timers.
 */
export function useDaemonColdStartModal(
  deps?: ColdStartTimerDeps,
): UseDaemonColdStartModalResult {
  const { state, retryNow } = useConnection();

  const nowMs = deps?.nowMs ?? Date.now;
  const setTimeoutFn =
    deps?.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
  const clearTimeoutFn =
    deps?.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const armedAtRef = React.useRef<number | null>(null);
  const [budgetExpired, setBudgetExpired] = React.useState<boolean>(false);
  const [everConnected, setEverConnected] = React.useState<boolean>(false);

  // Arm the cold-start timer once on mount. We do NOT re-arm on retry —
  // the spec rule is "first Hello does not succeed within 8 s of boot",
  // and a manual retry from inside the modal does not buy back that
  // budget. The timer also does not fire if we have already connected.
  React.useEffect(() => {
    if (armedAtRef.current !== null) return undefined;
    armedAtRef.current = nowMs();
    const handle = setTimeoutFn(() => {
      setBudgetExpired(true);
    }, COLD_START_BUDGET_MS);
    return () => {
      clearTimeoutFn(handle);
    };
    // Mount-only: we capture the initial timer surface and never re-bind.
    // Tests that want a different clock pass it on first render; passing
    // a different clock later would break the cold-start semantics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Latch `everConnected` so a mid-session daemon restart doesn't
  // re-trigger the cold-start modal.
  React.useEffect(() => {
    if (state.kind === 'connected' && !everConnected) {
      setEverConnected(true);
    }
  }, [state.kind, everConnected]);

  const open = shouldShowColdStartModal({
    state,
    everConnected,
    elapsedMs: budgetExpired ? COLD_START_BUDGET_MS : 0,
  });

  return { open, onRetry: retryNow };
}
