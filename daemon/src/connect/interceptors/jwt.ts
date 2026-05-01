// daemon/src/connect/interceptors/jwt.ts — Slot #1 (T05 placeholder; T08 lands real verify).
//
// Spec citations:
//   - ch05 §4 (line 1174): local-pipe bypass; untagged or remote-tcp without
//     valid JWT → fail-closed `Code.Unauthenticated`.
//   - ch05 §5 (line 3144): chain slot #1.
//
// Behavior in T05.1:
//   - `transport === 'local-pipe'` → bypass (peer-cred trusted).
//   - Anything else → reject `Unauthenticated` with structured pino log.
//
// TODO(T08): replace with `jose.jwtVerify` against pre-warmed Cloudflare
// Access JWKS, per ch05 §4 + §4.1 policy locks. The interceptor surface
// (input/output) does not change — only the internal verify body.
//
// Single Responsibility (decider): pass or reject; no I/O beyond the log sink.

import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import {
  requestStartKey,
  resolveTransportTag,
  transportTagForLog,
  transportTypeKey,
  traceIdKey,
} from './context-keys.js';
import { logReject, type RejectLogger } from './pino-reject-log.js';

export const JWT_SLOT_NAME = 'jwt';

export interface JwtInterceptorOptions {
  readonly logger?: RejectLogger;
  readonly now?: () => number;
}

export function createJwtInterceptor(opts: JwtInterceptorOptions = {}): Interceptor {
  const now = opts.now ?? Date.now;
  return (next) => async (req) => {
    const rawTag = req.contextValues.get(transportTypeKey);
    const tag = resolveTransportTag(rawTag);
    if (tag === 'local-pipe') {
      return next(req);
    }
    // Fail-closed: untagged or remote-tcp without real JWT verification.
    const start = req.contextValues.get(requestStartKey) || now();
    logReject(opts.logger, {
      interceptor: JWT_SLOT_NAME,
      method: req.method.name,
      traceId: req.contextValues.get(traceIdKey) || '',
      rejectCode: Code.Unauthenticated,
      transportTag: transportTagForLog(rawTag),
      durationMs: now() - start,
      reason: 'remote-ingress JWT verification not yet wired (T08); fail-closed',
      rpcPath: typeof req.url === 'string' ? req.url : undefined,
    });
    throw new ConnectError(
      'remote-ingress JWT verification not yet implemented (T08); reject fail-closed',
      Code.Unauthenticated,
    );
  };
}
