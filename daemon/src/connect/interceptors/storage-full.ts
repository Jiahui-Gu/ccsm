// daemon/src/connect/interceptors/storage-full.ts — Slot #3 (T05.1 stub).
//
// Spec citations:
//   - ch05 §5 (line 3144): chain slot #3 — `storage-full` between
//     `migration-gate` and `deadline`.
//   - ch07 §1 paragraphs 1711-1713: SQLite SQLITE_FULL → daemon's
//     `storage.full` flag → write RPCs short-circuited locally with
//     `resource_exhausted`. Read RPCs continue normally.
//   - T15 (spec ch09 §2 line 2965): the FULL implementation (write-vs-read
//     classification, `__test_setStorageFull`, healthz side-channel) lands
//     later. T05.1 pins the slot only.
//
// Behavior in T05.1:
//   - `isStorageFull()` predicate is caller-injected; defaults to `false`
//     when omitted (slot is wired but inert until the daemon shell hooks up
//     the SQLITE_FULL handler).
//   - When the predicate returns true → reject with `Code.ResourceExhausted`.
//   - Read-vs-write classification is OUT OF SCOPE for T05.1 (T15 owns it);
//     the rejection is unconditional when the flag is set. This is more
//     conservative than spec's read-allow rule but is safe (read RPCs aren't
//     registered yet either) and the comment below tells T15 where to extend.
//
// Single Responsibility (decider): consults the predicate; no state.

import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import {
  requestStartKey,
  transportTagForLog,
  transportTypeKey,
  traceIdKey,
} from './context-keys.js';
import { logReject, type RejectLogger } from './pino-reject-log.js';

export const STORAGE_FULL_SLOT_NAME = 'storage-full';

export interface StorageFullInterceptorOptions {
  /**
   * Caller-injected predicate. Returns `true` when the daemon's storage-full
   * marker is set (SQLite returned SQLITE_FULL). Defaults to `() => false`
   * when omitted — the slot is wired but inert.
   *
   * TODO(T15): the daemon shell will inject a real predicate that reads from
   * the SQLITE_FULL handler's flag. T15 will also extend this interceptor
   * with read-vs-write RPC classification (per ch07 §1).
   */
  readonly isStorageFull?: () => boolean;
  readonly logger?: RejectLogger;
  readonly now?: () => number;
}

export function createStorageFullInterceptor(
  opts: StorageFullInterceptorOptions = {},
): Interceptor {
  const isFull = opts.isStorageFull ?? (() => false);
  const now = opts.now ?? Date.now;
  return (next) => async (req) => {
    if (!isFull()) {
      return next(req);
    }
    const start = req.contextValues.get(requestStartKey) || now();
    logReject(opts.logger, {
      interceptor: STORAGE_FULL_SLOT_NAME,
      method: req.method.name,
      traceId: req.contextValues.get(traceIdKey) || '',
      rejectCode: Code.ResourceExhausted,
      transportTag: transportTagForLog(req.contextValues.get(transportTypeKey)),
      durationMs: now() - start,
      reason: 'storage.full marker set (SQLITE_FULL); reject until clear',
    });
    throw new ConnectError(
      `RPC ${req.method.name} rejected: storage full`,
      Code.ResourceExhausted,
    );
  };
}
