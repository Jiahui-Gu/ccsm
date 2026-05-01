// daemon/src/connect/interceptors/migration-gate.ts — Slot #2.
//
// Spec citations:
//   - ch02 §8 row "Migration-gate interceptor": re-implemented as Connect
//     interceptor on the data socket, mirrors v0.3 envelope semantics
//     (`isMigrationGated()` predicate, `MIGRATION_PENDING`/`failed_precondition`).
//   - ch05 §5 (line 3144): chain slot #2.
//
// Single Responsibility (decider): consults the caller-injected predicate.
// Owns ZERO state; the daemon shell owns the migration flag.

import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import {
  requestStartKey,
  transportTagForLog,
  transportTypeKey,
  traceIdKey,
} from './context-keys.js';
import { logReject, type RejectLogger } from './pino-reject-log.js';

export const MIGRATION_GATE_SLOT_NAME = 'migration-gate';

export interface MigrationGateInterceptorOptions {
  readonly isMigrationPending: () => boolean;
  readonly logger?: RejectLogger;
  readonly now?: () => number;
}

export function createMigrationGateInterceptor(
  opts: MigrationGateInterceptorOptions,
): Interceptor {
  const now = opts.now ?? Date.now;
  return (next) => async (req) => {
    if (!opts.isMigrationPending()) {
      return next(req);
    }
    const start = req.contextValues.get(requestStartKey) || now();
    logReject(opts.logger, {
      interceptor: MIGRATION_GATE_SLOT_NAME,
      method: req.method.name,
      traceId: req.contextValues.get(traceIdKey) || '',
      rejectCode: Code.FailedPrecondition,
      transportTag: transportTagForLog(req.contextValues.get(transportTypeKey)),
      durationMs: now() - start,
      reason: 'SQLite migration in progress',
    });
    throw new ConnectError(
      `RPC ${req.method.name} rejected: SQLite migration in progress`,
      Code.FailedPrecondition,
    );
  };
}
