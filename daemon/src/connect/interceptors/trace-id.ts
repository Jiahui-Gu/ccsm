// daemon/src/connect/interceptors/trace-id.ts — Slot #5 (live).
//
// Spec citations:
//   - ch02 §8 row "Trace-id ULID per envelope": Connect interceptor generates
//     ULID per request, propagates via `x-ccsm-trace-id` header. Pino logs
//     include it.
//   - ch05 §5 (line 3144): chain slot #5 (last before handler).
//
// Generates a ULID on entry and stores it on `traceIdKey` for downstream
// handlers + log lines. Mirrors the v0.3 envelope x-ccsm-trace-id propagation.
//
// Single Responsibility (producer — stamps a per-request id).

import type { Interceptor } from '@connectrpc/connect';
import { ulid } from 'ulid';
import { traceIdKey } from './context-keys.js';

export const TRACE_ID_SLOT_NAME = 'trace-id';

export interface TraceIdInterceptorOptions {
  /** Test injection: override the id generator. Production omits and uses `ulid`. */
  readonly generate?: () => string;
}

export function createTraceIdInterceptor(
  opts: TraceIdInterceptorOptions = {},
): Interceptor {
  const gen = opts.generate ?? ulid;
  return (next) => async (req) => {
    if (!req.contextValues.get(traceIdKey)) {
      req.contextValues.set(traceIdKey, gen());
    }
    return next(req);
  };
}
