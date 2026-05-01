// PTY snapshot semaphore (spec §3.5.1.5 / frag-3.5.1 lines 123-124).
//
// Pure admission-control primitive used by the `getBufferSnapshot` handler
// path. The spec mandates **bounded snapshot concurrency** (size 4, any
// session, any caller) so a v0.5 dashboard cold-open subscribing to N
// sessions does not allocate N × MB transient strings simultaneously
// (res-SHOULD-2).
//
// The primitive is keyed so callers can pick the scope:
//   - frag-3.5.1 §3.5.1.5 default: ONE shared key (e.g. `'global'`) with
//     capacity 4 — the canonical v0.3 wiring.
//   - alternative scope (per-session, per-caller) is available without
//     changing this file; the caller picks the key.
//
// Single Responsibility (per `feedback_single_responsibility`):
//   - producer of admission decisions + queued `waitMs` measurement;
//   - decider for ordering (FIFO per key) and timeout cancellation;
//   - NOT a sink: no PTY I/O, no logging, no metric emission. The caller
//     that wraps the actual `getBufferSnapshot` work is responsible for:
//       * logging `snapshot.semaphore.waitMs` (spec line 124);
//       * surfacing `{ phase: 'queued', queuedMs }` to the bridge client;
//       * starting the 30 s unary deadline AFTER `acquire()` resolves
//         (admission-relative deadline, res-P1-3 / spec line 124);
//       * calling `release()` exactly once (idempotent here so try/finally
//         + cancellation paths are both safe).
//
// On daemon shutdown (spec §3.5.1.2 step 5, line 73), the caller invokes
// `drain()` which rejects every still-queued waiter with a `CANCELLED`
// typed error. In-flight holders keep their permits — the caller aggregates
// the drop-line. `drain()` does NOT close the semaphore for new acquires
// because the spec does not mandate that here; the caller stops dispatching
// new snapshot RPCs at the same point it calls drain.

/**
 * Typed error returned when a queued waiter exceeds its `timeoutMs` budget
 * before being admitted.
 */
export class SnapshotSemaphoreTimeoutError extends Error {
  readonly code = 'SNAPSHOT_SEMAPHORE_TIMEOUT' as const;
  readonly key: string;
  readonly timeoutMs: number;
  readonly waitedMs: number;
  constructor(key: string, timeoutMs: number, waitedMs: number) {
    super(
      `snapshot semaphore acquire timed out after ${waitedMs}ms ` +
        `(budget ${timeoutMs}ms, key=${key})`,
    );
    this.name = 'SnapshotSemaphoreTimeoutError';
    this.key = key;
    this.timeoutMs = timeoutMs;
    this.waitedMs = waitedMs;
  }
}

/**
 * Typed error returned when a queued waiter is rejected by `drain()`
 * (e.g. daemon shutdown — spec §3.5.1.2 step 5).
 */
export class SnapshotSemaphoreCancelledError extends Error {
  readonly code = 'CANCELLED' as const;
  readonly key: string;
  readonly reason: string;
  constructor(key: string, reason: string) {
    super(`snapshot semaphore acquire cancelled: ${reason} (key=${key})`);
    this.name = 'SnapshotSemaphoreCancelledError';
    this.key = key;
    this.reason = reason;
  }
}

/** Result of a successful `acquire()`. */
export interface SnapshotSemaphoreLease {
  /**
   * Idempotent permit release. Second and subsequent calls are no-ops so
   * the caller can safely combine try/finally with cancellation paths.
   */
  readonly release: () => void;
  /**
   * Milliseconds the waiter spent queued before admission, measured against
   * the injected clock. Caller logs this as `snapshot.semaphore.waitMs`.
   * Always `≥ 0`. Equals `0` for a fast-path admission.
   */
  readonly waitMs: number;
}

/** Construction options. */
export interface SnapshotSemaphoreOptions {
  /**
   * Maximum concurrent permits per key. Spec default for the canonical
   * shared key is `4` (frag-3.5.1 line 123). Must be a positive integer.
   */
  readonly capacity: number;
  /**
   * Injected monotonic clock for tests. Defaults to `Date.now`. Production
   * callers can pass `() => performance.now()` if they prefer; the absolute
   * scale is irrelevant — only deltas are observed.
   */
  readonly now?: () => number;
}

interface QueueEntry {
  readonly enqueuedAt: number;
  readonly timeoutMs: number;
  resolve: (lease: SnapshotSemaphoreLease) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

interface KeyState {
  active: number;
  queue: QueueEntry[];
}

export interface SnapshotSemaphore {
  /**
   * Acquire one permit for `key`. Resolves with a lease whose `release()`
   * returns the permit. Rejects with `SnapshotSemaphoreTimeoutError` if the
   * waiter is still queued at `timeoutMs`, or `SnapshotSemaphoreCancelledError`
   * if `drain()` is called first.
   *
   * `timeoutMs` MUST be a positive finite number (the caller is responsible
   * for clamping, mirroring the §3.4.1.f deadline header clamp).
   */
  acquire(key: string, timeoutMs: number): Promise<SnapshotSemaphoreLease>;
  /**
   * Reject every currently-queued waiter with `SnapshotSemaphoreCancelledError`.
   * In-flight holders are NOT touched — they release through their normal
   * `release()` path. Returns the number of waiters rejected so the caller
   * can emit a single aggregated log line per spec §3.5.1.2 step 5.
   */
  drain(reason: string): number;
  /**
   * Test/observability accessors. Return current snapshot of in-flight and
   * queued counts for `key` (or `0/0` if the key has no state yet).
   */
  stats(key: string): { active: number; queued: number };
}

/**
 * Construct a snapshot semaphore. The instance is single-purpose — keep
 * one per daemon (or one per scope) and share it across handlers.
 */
export function createSnapshotSemaphore(
  opts: SnapshotSemaphoreOptions,
): SnapshotSemaphore {
  const capacity = opts.capacity;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError(
      `snapshot semaphore capacity must be a positive integer, got ${capacity}`,
    );
  }
  const now = opts.now ?? Date.now;
  const states = new Map<string, KeyState>();

  function getState(key: string): KeyState {
    let s = states.get(key);
    if (!s) {
      s = { active: 0, queue: [] };
      states.set(key, s);
    }
    return s;
  }

  function pruneEmpty(key: string, s: KeyState): void {
    if (s.active === 0 && s.queue.length === 0) {
      states.delete(key);
    }
  }

  function makeLease(key: string, waitMs: number): SnapshotSemaphoreLease {
    let released = false;
    return {
      waitMs,
      release: () => {
        if (released) return;
        released = true;
        const s = states.get(key);
        if (!s) return; // defensive — should not happen
        s.active = Math.max(0, s.active - 1);
        // Pump the queue: a free permit goes to the head waiter.
        // Loop because `Math.max` admission can satisfy multiple waiters
        // only if a release coincided with a settled-but-not-yet-pruned
        // entry; in practice we admit at most one per release, but the
        // loop is defensive and bounded by `capacity - active`.
        while (s.active < capacity && s.queue.length > 0) {
          const next = s.queue.shift()!;
          if (next.settled) continue; // stale (timed out / cancelled)
          if (next.timer) {
            clearTimeout(next.timer);
            next.timer = null;
          }
          next.settled = true;
          s.active += 1;
          const waitedMs = Math.max(0, now() - next.enqueuedAt);
          next.resolve(makeLease(key, waitedMs));
        }
        pruneEmpty(key, s);
      },
    };
  }

  function acquire(key: string, timeoutMs: number): Promise<SnapshotSemaphoreLease> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new RangeError(
          `snapshot semaphore timeoutMs must be a positive finite number, got ${timeoutMs}`,
        ),
      );
    }
    const s = getState(key);
    // Fast path: capacity available, admit synchronously (waitMs = 0).
    if (s.active < capacity) {
      s.active += 1;
      return Promise.resolve(makeLease(key, 0));
    }
    // Slow path: enqueue with a per-waiter timeout.
    return new Promise<SnapshotSemaphoreLease>((resolve, reject) => {
      const enqueuedAt = now();
      const entry: QueueEntry = {
        enqueuedAt,
        timeoutMs,
        resolve,
        reject,
        timer: null,
        settled: false,
      };
      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        entry.settled = true;
        entry.timer = null;
        // Leave the stale entry in the queue; it will be skipped on the
        // next pump. We cannot splice cheaply without scanning, and the
        // pump loop already handles `settled` entries.
        const waitedMs = Math.max(0, now() - enqueuedAt);
        reject(new SnapshotSemaphoreTimeoutError(key, timeoutMs, waitedMs));
        // Best-effort prune of fully-settled tail to keep the map tidy.
        pruneEmpty(key, s);
      }, timeoutMs);
      // Allow the Node event loop to exit even if a waiter is still queued
      // (relevant for tests; production callers always release or drain).
      if (typeof entry.timer === 'object' && entry.timer && 'unref' in entry.timer) {
        (entry.timer as { unref: () => void }).unref();
      }
      s.queue.push(entry);
    });
  }

  function drain(reason: string): number {
    let rejected = 0;
    for (const [key, s] of states) {
      for (const entry of s.queue) {
        if (entry.settled) continue;
        entry.settled = true;
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
        entry.reject(new SnapshotSemaphoreCancelledError(key, reason));
        rejected += 1;
      }
      s.queue.length = 0;
      pruneEmpty(key, s);
    }
    return rejected;
  }

  function stats(key: string): { active: number; queued: number } {
    const s = states.get(key);
    if (!s) return { active: 0, queued: 0 };
    // Exclude settled-but-not-yet-pruned entries from `queued`.
    let queued = 0;
    for (const e of s.queue) if (!e.settled) queued += 1;
    return { active: s.active, queued };
  }

  return { acquire, drain, stats };
}

/**
 * Spec-default capacity for the canonical shared key (frag-3.5.1 §3.5.1.5
 * line 123: "semaphore of 4 concurrent `getBufferSnapshot` invocations").
 * Re-exported as a named constant so the wiring site reads as
 * `createSnapshotSemaphore({ capacity: SNAPSHOT_SEMAPHORE_DEFAULT_CAPACITY })`.
 */
export const SNAPSHOT_SEMAPHORE_DEFAULT_CAPACITY = 4 as const;

/**
 * Conventional shared key for the global v0.3 wiring. Callers that want
 * the spec's "any session, any caller" pool pass this constant.
 */
export const SNAPSHOT_SEMAPHORE_GLOBAL_KEY = 'global' as const;
