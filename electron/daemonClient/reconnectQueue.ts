// electron/daemonClient/reconnectQueue.ts
//
// Bounded FIFO queue of unary RPC envelopes that the Electron-side Connect
// client buffers while the daemon socket is dropped (Task #103, frag-3.7
// §3.7.4 lock).
//
// Behavior contract (frag-3.7 §3.7.4):
//   - Accepts ONE entry per `enqueue(...)` call until the cap is reached.
//   - Cap defaults: prod = 100, dev = 1000 (env: `CCSM_DAEMON_DEV=1`).
//     Closes round-2 reliability P1-R1 (rapid-fire dev save can briefly
//     exceed 100 in nodemon storms; RAM cost ~200 KB).
//   - On overflow: the OLDEST entry is rejected with
//     `Error('daemon-reconnect-queue-overflow')` (the spec's wording);
//     the new entry is appended.
//   - Stream subscriptions are NEVER queued — they go through §3.7.5
//     resubscription, NOT this queue. The bridge enforces that policy at
//     the call site (this module just stores opaque thunks).
//   - On `drain(...)`: each entry's thunk is invoked in FIFO order; the
//     thunk's promise is bridged into the entry's `resolve` / `reject`.
//
// Single Responsibility:
//   - PRODUCER: `enqueue` + `drain` are the public surface.
//   - DECIDER: cap + FIFO ordering are policy decisions; no I/O lives
//     here.
//   - SINK: the registered drain callback is the sink (the bridge's
//     "issue this Connect call now" closure).
//
// What this module DOESN'T own:
//   - Reconnect schedule / backoff (lives in `connectClient.ts`).
//   - Stream resubscription (lives in `connectClient.ts` per §3.7.5).
//   - Surface-registry publishing (lives in `connectClient.ts`; the
//     queue overflow is LOG ONLY per §6.8 r7 trim — no toast).

/**
 * Default queue caps from frag-3.7 §3.7.4. The dev cap is 10x the prod
 * cap because nodemon storms can briefly enqueue hundreds of pending
 * calls during a fast-restart cycle (each unary envelope is ~200 B JSON
 * so 1000 entries = ~200 KB worst-case RAM).
 */
export const MAX_QUEUED_PROD = 100 as const;
export const MAX_QUEUED_DEV = 1000 as const;

/**
 * Sentinel error message thrown when the queue overflows. Pinned as a
 * const so the renderer's existing per-bridge error path (frag-3.7
 * §3.7.4) can match on the exact string without a fragile substring
 * compare.
 */
export const QUEUE_OVERFLOW_MESSAGE = 'daemon-reconnect-queue-overflow' as const;

export interface QueuedCall<T = unknown> {
  /** Opaque method name for log lines. NOT used for routing — the thunk
   *  carries the real method binding. */
  readonly method: string;
  /** Optional ULID for trace correlation. */
  readonly traceId: string | undefined;
  /** Issue the call against the live Connect transport. The thunk is
   *  bound to a SPECIFIC transport snapshot at enqueue time iff the
   *  caller wants snapshot semantics; otherwise it should re-resolve
   *  the transport on each invocation. The queue does not care. */
  readonly thunk: () => Promise<T>;
  /** Resolves with the thunk's resolution value. */
  readonly resolve: (value: T) => void;
  /** Rejects with the thunk's rejection or with overflow / abort. */
  readonly reject: (err: Error) => void;
  /** Wall-clock ms at enqueue time. Used for the `queued ≥4s` build-error
   *  log gate in dev mode (§3.7.4 toast UX — log only after the §6.8 r7
   *  trim). */
  readonly enqueuedAt: number;
}

export interface ReconnectQueueOptions {
  /** Cap before overflow rejection kicks in. Defaults to
   *  {@link MAX_QUEUED_PROD} unless `CCSM_DAEMON_DEV=1` is set in the
   *  environment, in which case {@link MAX_QUEUED_DEV} is used. */
  readonly maxQueued?: number;
  /** Test seam for `Date.now()`. */
  readonly now?: () => number;
  /** Optional structured log sink for overflow / drain events. Defaults
   *  to a silent stub (the bridge wires its own pino). The frag-6-7
   *  §6.6.2 canonical name is `daemon_queue_overflow`; we pass that
   *  string as the message field so log greps work cross-process. */
  readonly log?: (line: string, extras?: Record<string, unknown>) => void;
}

export interface ReconnectQueue {
  /** Append a call to the queue. If full, the OLDEST entry is rejected
   *  with `Error(QUEUE_OVERFLOW_MESSAGE)` and the new entry is added.
   *  Returns a promise that resolves/rejects when `drain(...)` fires
   *  the entry (or when overflow evicts it). */
  enqueue<T>(opts: {
    readonly method: string;
    readonly traceId?: string | undefined;
    readonly thunk: () => Promise<T>;
  }): Promise<T>;
  /** Drain the queue in FIFO order. Each entry's thunk is invoked; the
   *  returned promise resolves once ALL entries have settled (resolve OR
   *  reject). Resolves to the count of entries drained.
   *
   *  IMPORTANT: this method does NOT serialize the thunks — it issues
   *  them all in one synchronous pass and awaits with `Promise.allSettled`.
   *  The bridge can rely on FIFO *issue order* on the wire (Connect
   *  serializes per-stream). */
  drain(): Promise<number>;
  /** Reject every entry with the given error and clear. Used when the
   *  bridge gives up (e.g. user-initiated quit). Idempotent. */
  rejectAll(err: Error): void;
  /** Snapshot for tests / debug. */
  size(): number;
  /** Snapshot for tests / debug. */
  peek(): readonly QueuedCall[];
}

const NOOP_LOG = (_line: string, _extras?: Record<string, unknown>): void => {
  /* silent default */
};

function defaultMaxQueued(): number {
  // Read env at construction time — tests that flip this must
  // construct a fresh queue. We don't memoize across constructions
  // because dev/prod can swap during a single Electron lifecycle
  // (e.g. a test harness toggles `CCSM_DAEMON_DEV`).
  return process.env['CCSM_DAEMON_DEV'] === '1' ? MAX_QUEUED_DEV : MAX_QUEUED_PROD;
}

/**
 * Build a fresh reconnect queue. The bridge owns one per Connect client;
 * tests construct their own with deterministic clock + small caps.
 */
export function createReconnectQueue(opts: ReconnectQueueOptions = {}): ReconnectQueue {
  const maxQueued = opts.maxQueued ?? defaultMaxQueued();
  if (!Number.isInteger(maxQueued) || maxQueued <= 0) {
    throw new Error(
      `createReconnectQueue: maxQueued must be a positive integer, got ${maxQueued}`,
    );
  }
  const now = opts.now ?? Date.now;
  const log = opts.log ?? NOOP_LOG;

  // Plain array as ring-less FIFO. We accept O(N) shift on overflow
  // because (a) the cap is at most 1000 (~1µs in V8), (b) overflow is
  // an exceptional path, not a hot loop. A LinkedList would buy us
  // O(1) shift but cost 2 pointers/entry — not worth it at this scale.
  const q: QueuedCall[] = [];

  return {
    enqueue<T>({
      method,
      traceId,
      thunk,
    }: {
      readonly method: string;
      readonly traceId?: string | undefined;
      readonly thunk: () => Promise<T>;
    }): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const entry: QueuedCall<T> = {
          method,
          traceId,
          thunk,
          resolve,
          reject,
          enqueuedAt: now(),
        };
        if (q.length >= maxQueued) {
          // Evict the oldest — it has waited the longest, so its caller
          // is the most likely to have already given up. (The spec
          // explicitly says "oldest call is rejected".)
          const oldest = q.shift();
          if (oldest) {
            log('daemon_queue_overflow', {
              method: oldest.method,
              traceId: oldest.traceId,
              waitedMs: now() - oldest.enqueuedAt,
              cap: maxQueued,
            });
            try {
              oldest.reject(new Error(QUEUE_OVERFLOW_MESSAGE));
            } catch {
              // Reject handlers should not throw; if they do, swallow.
              // The new entry must still be enqueued — that's the spec.
            }
          }
        }
        q.push(entry as QueuedCall<unknown>);
      });
    },

    async drain(): Promise<number> {
      // Take a snapshot + clear so a concurrent enqueue (e.g. a thunk
      // that schedules a follow-up call) lands in the next batch, not
      // the in-flight one. This avoids unbounded recursion if a thunk
      // immediately re-queues itself on transient failure.
      const batch = q.splice(0, q.length);
      if (batch.length === 0) return 0;
      const settles = batch.map(async (entry) => {
        try {
          const v = await entry.thunk();
          entry.resolve(v);
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      await Promise.allSettled(settles);
      return batch.length;
    },

    rejectAll(err): void {
      const batch = q.splice(0, q.length);
      for (const entry of batch) {
        try {
          entry.reject(err);
        } catch {
          /* swallow — see overflow path */
        }
      }
    },

    size(): number {
      return q.length;
    },
    peek(): readonly QueuedCall[] {
      return q.slice();
    },
  };
}
