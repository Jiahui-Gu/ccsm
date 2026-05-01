// daemon/src/connect/interceptors/read-max.ts — Per-route message size caps.
//
// Spec citations:
//   - ch02 §8 row "16 MiB frame cap": Per-message cap implemented via
//     Connect-Node `readMaxBytes` option on every server route. Per-route caps:
//       - Default: 4 MiB
//       - SendPtyInput: 1 MiB
//       - Db.save: 16 MiB
//       - Importer.scanRecentCwds: 4 MiB
//     "An interceptor logs (and rate-limits) requests within 10% of the cap
//     so attack patterns surface in pino."
//   - ch05 §5 / chain order: this is NOT a numbered slot in the canonical
//     chain — Connect-Node enforces `readMaxBytes` natively on the route
//     registration. T05.1 ships:
//       (a) the per-route cap config table (single source of truth),
//       (b) a `readMaxBytesForRoute(rpcPath)` resolver T06 will pass to
//           `router.service(svc, impl, { readMaxBytes })`,
//       (c) a NEAR-CAP observability interceptor that logs requests within
//           10% of their per-route cap, so attack patterns surface in pino.
//
// The actual hard-cap enforcement remains with Connect-Node's native code
// path (validateReadWriteMaxBytes in @connectrpc/connect-node) — T05.1 does
// NOT re-implement it in JS.
//
// Single Responsibility:
//   - Producer: emits the cap config + the resolver function.
//   - Decider (near-cap interceptor): consults Content-Length, decides if log.
//   - Sink: pino warn via pino-reject-log helper.

import type { Interceptor } from '@connectrpc/connect';
import {
  requestStartKey,
  transportTagForLog,
  transportTypeKey,
  traceIdKey,
} from './context-keys.js';
import { logReject, type RejectLogger } from './pino-reject-log.js';

/** Default per-route cap when an RPC is not in {@link READ_MAX_BYTES_PER_ROUTE}. */
export const DEFAULT_READ_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

/**
 * Per-route message size caps. Keyed by full RPC URL path
 * (`/ccsm.v1.<Service>/<Method>`) so the resolver can look up by what
 * `connectNodeAdapter` puts on the request.
 *
 * T06+ adds the actual route-name keys as services land. T05.1 seeds the
 * table with the spec-listed routes (ch02 §8) so new contributors don't
 * forget the per-route discipline.
 */
export const READ_MAX_BYTES_PER_ROUTE: Readonly<Record<string, number>> = Object.freeze({
  // Spec ch02 §8 explicit caps — keys use the planned Connect URL form.
  '/ccsm.v1.CcsmService/Ping': 1024, // T05.1 seed: tiny message
  '/ccsm.v1.CcsmService/DaemonHello': 4096, // T05.1 seed: handshake message
  '/ccsm.v1.PtyService/SendPtyInput': 1 * 1024 * 1024, // 1 MiB
  '/ccsm.v1.DbService/Save': 16 * 1024 * 1024, // 16 MiB
  '/ccsm.v1.ImporterService/ScanRecentCwds': 4 * 1024 * 1024, // 4 MiB
});

/** Resolve the cap for a given RPC URL path. Falls back to {@link DEFAULT_READ_MAX_BYTES}. */
export function readMaxBytesForRoute(rpcPath: string): number {
  return READ_MAX_BYTES_PER_ROUTE[rpcPath] ?? DEFAULT_READ_MAX_BYTES;
}

/** Threshold ratio at/above which we log "near cap" warnings (spec: 10%). */
export const NEAR_CAP_RATIO = 0.9;

export const READ_MAX_NEAR_CAP_SLOT_NAME = 'read-max-near-cap';

export interface NearCapInterceptorOptions {
  readonly logger?: RejectLogger;
  readonly now?: () => number;
  /**
   * Test injection: override the cap resolver. Production omits and uses
   * {@link readMaxBytesForRoute}.
   */
  readonly capForRoute?: (rpcPath: string) => number;
}

/**
 * Observability-only interceptor. Does NOT reject; the hard cap is enforced
 * by Connect-Node's native readMaxBytes path. This emits a structured log
 * line when the request body is within 10% of the per-route cap so attack
 * patterns surface in pino (per ch02 §8 paragraph after the cap table).
 *
 * Reads `Content-Length` header. Streaming requests without a Content-Length
 * are skipped (Connect-Node's native enforcement still applies).
 */
export function createReadMaxNearCapInterceptor(
  opts: NearCapInterceptorOptions = {},
): Interceptor {
  const now = opts.now ?? Date.now;
  const capFor = opts.capForRoute ?? readMaxBytesForRoute;
  return (next) => async (req) => {
    const cl = req.header.get('content-length');
    if (cl) {
      const size = Number.parseInt(cl, 10);
      if (Number.isFinite(size) && size > 0) {
        const path = typeof req.url === 'string' ? new URL(req.url).pathname : '';
        const cap = capFor(path);
        if (size >= cap * NEAR_CAP_RATIO) {
          const start = req.contextValues.get(requestStartKey) || now();
          // Note: this is "near-cap observability", NOT a reject. Reusing
          // logReject because the field shape matches; the rejectCode field
          // is set to 0 to indicate "not rejected, observability only".
          logReject(opts.logger, {
            interceptor: READ_MAX_NEAR_CAP_SLOT_NAME,
            method: req.method.name,
            traceId: req.contextValues.get(traceIdKey) || '',
            rejectCode: 0,
            transportTag: transportTagForLog(req.contextValues.get(transportTypeKey)),
            durationMs: now() - start,
            reason: `request body ${size}B within 10% of per-route cap ${cap}B`,
            rpcPath: path || undefined,
          });
        }
      }
    }
    return next(req);
  };
}
