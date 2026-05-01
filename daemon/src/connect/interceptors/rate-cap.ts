// daemon/src/connect/interceptors/rate-cap.ts — Pre-accept rate cap (50/sec)
// at the Connect interceptor layer.
//
// Spec citations:
//   - ch02 §8 row "Pre-accept rate cap (50/sec)": "Re-implemented at the
//     daemon's Http2Server.on('session', ...) handler."
//   - T05.1 brief: per-source-IP if `transport-tag === 'remote-tcp'`, global
//     counter for `local-pipe`. Token bucket sliding 1s window.
//   - ch05 §5: this slot is NOT in the canonical interceptor chain order
//     because the spec places the cap at the HTTP/2 session-accept layer.
//     T05.1 wires it as a Connect interceptor too as a pragmatic
//     belt-and-suspenders: the listener-level cap (data-socket.ts) blocks
//     burst connection floods; this RPC-level cap blocks burst RPC floods on
//     a single accepted connection (e.g. a single browser tab spamming Ping
//     before the JWT slot rejects).
//
// Single Responsibility (decider): consults a sliding-window counter; no I/O.

import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import {
  requestStartKey,
  resolveTransportTag,
  transportTagForLog,
  transportTypeKey,
  traceIdKey,
} from './context-keys.js';
import { logReject, type RejectLogger } from './pino-reject-log.js';

export const RATE_CAP_SLOT_NAME = 'rate-cap';

/** Default per spec ch02 §8 row "Pre-accept rate cap (50/sec)". */
export const DEFAULT_MAX_REQUESTS_PER_SEC = 50;

export interface RateCapInterceptorOptions {
  /** Override for tests. Defaults to {@link DEFAULT_MAX_REQUESTS_PER_SEC}. */
  readonly maxPerSec?: number;
  /** Test injection: override clock. */
  readonly now?: () => number;
  /**
   * Resolves a per-request bucket key. T05.1 default:
   *   - `'remote-tcp'` requests → bucket key = source IP from
   *     `req.header.get('x-forwarded-for')` first hop, or `'__no-ip__'`.
   *   - `'local-pipe'` requests → bucket key = `'__local__'` (single global
   *     counter; same-uid local trust means no need to differentiate).
   *   - untagged → bucket key = `'__untagged__'` (treated like remote-tcp).
   *
   * Tests inject a deterministic resolver.
   */
  readonly resolveBucketKey?: (req: {
    contextValues: { get: <T>(k: { id: symbol; defaultValue: T }) => T };
    header: { get(name: string): string | null };
  }) => string;
  readonly logger?: RejectLogger;
}

function defaultResolveBucketKey(req: {
  contextValues: { get: <T>(k: { id: symbol; defaultValue: T }) => T };
  header: { get(name: string): string | null };
}): string {
  // Cast through unknown because the shared key has a fancy generic shape.
  const tag = resolveTransportTag(
    (req.contextValues as unknown as {
      get: (k: typeof transportTypeKey) => 'local-pipe' | 'remote-tcp' | undefined;
    }).get(transportTypeKey),
  );
  if (tag === 'local-pipe') return '__local__';
  const xff = req.header.get('x-forwarded-for');
  if (xff && xff.length > 0) {
    const firstHop = xff.split(',')[0]!.trim();
    if (firstHop.length > 0) return `ip:${firstHop}`;
  }
  return '__no-ip__';
}

interface BucketEntry {
  /** Monotonic timestamps of recent admits within the 1s window. */
  readonly stamps: number[];
}

export function createRateCapInterceptor(
  opts: RateCapInterceptorOptions = {},
): Interceptor {
  const max = opts.maxPerSec ?? DEFAULT_MAX_REQUESTS_PER_SEC;
  const now = opts.now ?? Date.now;
  const resolveKey = opts.resolveBucketKey ?? defaultResolveBucketKey;
  // Per-bucket sliding window. Map keyed by bucket id; each value is a small
  // array of timestamps. Bounded by `max` per bucket, so memory is `max * |keys|`.
  // Untouched buckets are GC'd periodically (every 1024 admits) to keep the
  // map size from growing under churn (e.g. many short-lived source IPs).
  const buckets = new Map<string, BucketEntry>();
  let admitsSinceSweep = 0;
  const SWEEP_INTERVAL = 1024;

  function sweep(t: number): void {
    const cutoff = t - 1000;
    for (const [k, v] of buckets) {
      while (v.stamps.length > 0 && v.stamps[0]! < cutoff) v.stamps.shift();
      if (v.stamps.length === 0) buckets.delete(k);
    }
  }

  return (next) => async (req) => {
    const t = now();
    const key = resolveKey(req as never);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { stamps: [] };
      buckets.set(key, bucket);
    }
    const cutoff = t - 1000;
    while (bucket.stamps.length > 0 && bucket.stamps[0]! < cutoff) {
      bucket.stamps.shift();
    }
    if (bucket.stamps.length >= max) {
      const start = req.contextValues.get(requestStartKey) || t;
      logReject(opts.logger, {
        interceptor: RATE_CAP_SLOT_NAME,
        method: req.method.name,
        traceId: req.contextValues.get(traceIdKey) || '',
        rejectCode: Code.ResourceExhausted,
        transportTag: transportTagForLog(req.contextValues.get(transportTypeKey)),
        durationMs: t - start,
        reason: `rate cap exceeded (${max}/sec) for bucket ${key}`,
      });
      // Connect surfaces the message + code to the client; T08+ may also
      // attach a Retry-After response header via header-modifying interceptor.
      throw new ConnectError(
        `rate cap exceeded (${max}/sec); retry after ~1s`,
        Code.ResourceExhausted,
      );
    }
    bucket.stamps.push(t);
    admitsSinceSweep += 1;
    if (admitsSinceSweep >= SWEEP_INTERVAL) {
      sweep(t);
      admitsSinceSweep = 0;
    }
    return next(req);
  };
}
