// Wave 3 polish (#252) — single retry for ask-question Adaptive Toasts.
//
// Windows toast banners auto-dismiss into the Action Center after a few
// seconds. If the user wasn't at their machine when the toast first fired,
// the question request is silently buried — even though the agent is still
// blocked waiting for an answer. To narrow that gap we re-emit the toast
// once, ~30s after the original, IF the question hasn't been answered yet.
//
// Design notes:
//
//   * Cap is hardcoded to 1 retry. More than that crosses into spam: the
//     user has had a banner + an Action Center entry + another banner; if
//     they still haven't engaged, the OS notification surface is no longer
//     the right channel and we should leave it to the in-app pulse.
//   * "Still waiting" is approximated by "the retry hasn't been cancelled".
//     Cancellation is wired to `agent:resolvePermission` (called by the
//     in-app QuestionBlock onSubmit and the toast focus action follow-up),
//     which is the only path that ends a question's pending state.
//   * Timer state lives in the main process — same lifetime as the
//     `@ccsm/notify` notifier — so a renderer reload doesn't orphan it.
//   * Re-emission re-runs `notifyQuestion` with the SAME toastId so the
//     SDK's dedupe / activation routing stays coherent (the action router
//     in main.ts looks up by toastId).
//
// Reverse-verifiable: stash `scheduleQuestionRetry` in `notifications.ts`
// and the retry e2e probe case must FAIL (only one notifyQuestion call
// instead of two).

import { notifyQuestion, type QuestionPayload } from './notify';

const DEFAULT_RETRY_DELAY_MS = 30_000;
const MAX_RETRIES = 1;

interface PendingRetry {
  remaining: number;
  timer: ReturnType<typeof setTimeout>;
  payload: QuestionPayload;
}

const pending = new Map<string, PendingRetry>();

// Test seam: vitest can substitute fake timers via this hook so retry
// behaviour is asserted without sleeping for 30 seconds.
let scheduler: (cb: () => void, delayMs: number) => ReturnType<typeof setTimeout> =
  (cb, delayMs) => setTimeout(cb, delayMs);
let canceller: (timer: ReturnType<typeof setTimeout>) => void = (t) => clearTimeout(t);

/**
 * Test-only seam — swap the scheduler/canceller with stubs that operate on a
 * virtual clock. Pass `null` to restore the real `setTimeout` / `clearTimeout`.
 */
export function __setRetrySchedulerForTests(
  s: ((cb: () => void, delayMs: number) => ReturnType<typeof setTimeout>) | null,
  c: ((timer: ReturnType<typeof setTimeout>) => void) | null,
): void {
  scheduler = s ?? ((cb, delayMs) => setTimeout(cb, delayMs));
  canceller = c ?? ((t) => clearTimeout(t));
}

/**
 * Schedule a single retry of `notifyQuestion` for `payload` after
 * `delayMs` (default 30s). Idempotent per `payload.toastId`: a second call
 * for the same id while a retry is still pending is a no-op (the original
 * scheduling stands; we don't want overlapping timers).
 */
export function scheduleQuestionRetry(
  payload: QuestionPayload,
  delayMs: number = DEFAULT_RETRY_DELAY_MS,
): void {
  const id = payload.toastId;
  if (!id) return;
  if (pending.has(id)) return;
  const entry: PendingRetry = {
    remaining: MAX_RETRIES,
    payload,
    // The timer body is set after entry-creation so the cleanup path
    // (`pending.delete(id)`) runs unconditionally even if `notifyQuestion`
    // throws synchronously (it shouldn't — wrapper is async-no-throw — but
    // we don't want to leak Map entries).
    timer: scheduler(() => fireRetry(id), delayMs),
  };
  pending.set(id, entry);
}

function fireRetry(id: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  // Decrement first so a re-schedule attempt during the await wouldn't
  // try to schedule yet another (it won't anyway because we still hold
  // the entry while the wrapper runs, but be explicit).
  entry.remaining -= 1;
  pending.delete(id);
  void notifyQuestion(entry.payload).catch(() => {
    /* wrapper logs internally */
  });
}

/**
 * Cancel any pending retry for `toastId`. Safe to call when no retry is
 * scheduled (no-op). Wired into `agent:resolvePermission` so an in-app
 * answer (the only way to end a pending question) clears the timer.
 */
export function cancelQuestionRetry(toastId: string): void {
  const entry = pending.get(toastId);
  if (!entry) return;
  canceller(entry.timer);
  pending.delete(toastId);
}

/**
 * Test-only inspector — returns the current size of the pending map so
 * tests can assert state transitions without exposing internals.
 */
export function __pendingRetryCountForTests(): number {
  return pending.size;
}

/** Test-only reset — clears all pending entries (timers leaked intentionally
 * since unit tests use the fake scheduler that never actually queues real
 * timers). */
export function __resetRetryStateForTests(): void {
  pending.clear();
}
