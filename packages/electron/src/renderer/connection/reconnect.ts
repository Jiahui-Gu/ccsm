// T6.7 — Reconnect backoff schedule + driver.
//
// Spec ref: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// chapter 08 §6 (renderer error-handling contract). The locked policy this
// task ships is the *renderer-boot* schedule, distinct from the per-stream
// backoff in ch08 §6 (`min(30s, 500ms * 2^attempt + jitter)`).
//
// This file owns the boot-side schedule the manager prompt locks:
//   100ms → 200 → 400 → 800 → 1.6s → 3.2s → 5s (cap)
//
// Cap = 5000ms. Reset = on every successful Hello (the call site clears
// `attempt` to 0). This schedule is bursty-friendly (catches a daemon that
// finished restarting in the first second) without becoming a tight loop.
//
// SRP: pure decider (`nextDelayMs`) + a thin driver (`runWithReconnect`)
// that performs a single attempt, sleeps via injected `sleep`, and retries.
// No I/O besides whatever the caller's `attempt` does. No React, no Connect
// imports — those live in `hello.ts` / `use-connection.tsx`.

/**
 * Locked schedule per the T6.7 manager brief. Index 0 = first reconnect
 * delay. Anything past the table is capped at the last entry.
 *
 * Frozen so a future regression is loud at unit-test time
 * (`backoff.spec.ts` asserts the exact values).
 */
export const RECONNECT_SCHEDULE_MS: readonly number[] = [
  100, 200, 400, 800, 1600, 3200, 5000,
] as const;

/** Cap (last entry of the schedule). Exposed so callers can sanity-check. */
export const RECONNECT_CAP_MS = 5000 as const;

/**
 * Pure decider: given an `attempt` index (0 = the first reconnect, NOT the
 * initial connect), return the delay in milliseconds before that attempt.
 *
 * `attempt < 0` is treated as 0; large `attempt` values clamp to the cap.
 */
export function nextDelayMs(attempt: number): number {
  if (attempt <= 0) return RECONNECT_SCHEDULE_MS[0] ?? RECONNECT_CAP_MS;
  if (attempt >= RECONNECT_SCHEDULE_MS.length) return RECONNECT_CAP_MS;
  return RECONNECT_SCHEDULE_MS[attempt] ?? RECONNECT_CAP_MS;
}

/** Promise-based sleep. Honors AbortSignal so callers can cancel cleanly. */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Options for `runWithReconnect`. */
export interface RunWithReconnectOpts<T> {
  /**
   * Single-attempt operation (typically `performHello`). MUST throw on
   * disconnect / transport error so the driver knows to back off; MUST
   * resolve on success.
   */
  readonly attempt: (attemptIndex: number) => Promise<T>;
  /**
   * Decide whether a thrown error should trigger a retry. Default: every
   * thrown error retries (matches the spec — boot path waits forever for a
   * daemon to come up, surfacing the §6.1 cold-start modal at 8 s).
   *
   * Return `false` for fatal errors (e.g., version mismatch) so the driver
   * surfaces them to the caller instead of looping silently.
   */
  readonly shouldRetry?: (err: unknown, attemptIndex: number) => boolean;
  /**
   * Notification hook fired before each sleep — the call site uses this to
   * surface "Reconnecting..." UI. Receives the upcoming delay in ms.
   */
  readonly onBackoff?: (delayMs: number, attemptIndex: number) => void;
  /** AbortSignal cancels both pending sleep and inflight attempt callbacks. */
  readonly signal?: AbortSignal;
  /**
   * Sleep override — defaults to `sleepMs`. Tests inject a fake-timer-aware
   * sleep so vitest can advance timers deterministically.
   */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Delay-schedule override — defaults to `nextDelayMs`. Tests use this to
   * assert the exact schedule emitted; production callers leave it default.
   */
  readonly delayFor?: (attemptIndex: number) => number;
}

/**
 * Drive the reconnect loop. Calls `attempt(0)`; on fatal-not-retried error
 * rejects; on retried error sleeps `nextDelayMs(0)` and calls `attempt(1)`;
 * etc., until success or aborted. Returns whatever the successful attempt
 * resolves to.
 */
export async function runWithReconnect<T>(
  opts: RunWithReconnectOpts<T>,
): Promise<T> {
  const sleep = opts.sleep ?? sleepMs;
  const delayFor = opts.delayFor ?? nextDelayMs;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  let attemptIdx = 0;
  // Loop until success or aborted; rethrow non-retried errors immediately.
  // No upper bound on attempts — the spec's behaviour is "retry forever; a
  // user-facing modal appears after 8 s of unsuccessful Hello attempts" (ch08
  // §6.1). Aborting the signal is the only way to exit the loop without a
  // success.
  for (;;) {
    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      return await opts.attempt(attemptIdx);
    } catch (err) {
      if (!shouldRetry(err, attemptIdx)) throw err;
      const delay = delayFor(attemptIdx);
      opts.onBackoff?.(delay, attemptIdx);
      await sleep(delay, opts.signal);
      attemptIdx += 1;
    }
  }
}
