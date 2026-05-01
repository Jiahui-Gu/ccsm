// daemon/src/connect/interceptors/deadline.ts — Slot #4 (T05.1 stub).
//
// Spec citations:
//   - ch02 §8 row "Per-frame deadline (`x-ccsm-deadline-ms`)": Connect
//     interceptor on both client + server reading the same header. Default
//     30s; clamp at 120s per v0.3 §3.4.1.f.
//   - ch05 §5 (line 3144): chain slot #4.
//
// T05.1 ships the chain slot only — pass-through. T08+ will read the header
// and compose `req.signal` with `AbortSignal.timeout(deadline)`.
//
// Single Responsibility (decider — pass-through stub).

import type { Interceptor } from '@connectrpc/connect';

export const DEADLINE_SLOT_NAME = 'deadline';

export function createDeadlineInterceptor(): Interceptor {
  return (next) => async (req) => next(req);
}
