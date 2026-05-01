// daemon/src/connect/interceptors/transport-tag.ts — Slot #0 of the chain.
//
// Spec citations:
//   - ch05 §4 (line 1174): transport tag is a positive enum set by the listener.
//   - ch05 §5 (line 3144): chain order — transport-tag is FIRST.
//   - ch02 §8: untagged requests fail-closed (treated as remote-tcp).
//
// In T05.1 the listener stamps the tag via the adapter's contextValues factory
// (see server.ts createConnectDataServer); this interceptor's job is:
//   1. Stamp `requestStartKey` with Date.now() so downstream slots can compute
//      `durationMs` for reject logs.
//   2. Be observable in the chain (named slot #0 makes order tests sharp and
//      future dev-mode assertions can hook here).
//
// Single Responsibility (decider — pure pass-through):
//   - No fail/reject path. Decision-free in T05.1.

import type { Interceptor } from '@connectrpc/connect';
import { requestStartKey } from './context-keys.js';

export const TRANSPORT_TAG_SLOT_NAME = 'transport-tag';

export interface TransportTagInterceptorOptions {
  /** Test injection: override clock. Production omits and uses `Date.now`. */
  readonly now?: () => number;
}

export function createTransportTagInterceptor(
  opts: TransportTagInterceptorOptions = {},
): Interceptor {
  const now = opts.now ?? Date.now;
  return (next) => async (req) => {
    if (!req.contextValues.get(requestStartKey)) {
      req.contextValues.set(requestStartKey, now());
    }
    return next(req);
  };
}
