// packages/daemon/src/rpc/crash/register.ts
//
// Wave-3 Task #229 (sub-task 2 of audit #228) — register the v0.3
// CrashService Connect handlers that have landed so far on top of the
// T2.2 stub baseline.
//
// Mirrors the `registerSessionService` pattern in
// `packages/daemon/src/rpc/router.ts:registerSessionService` (Wave-3
// #290): the Connect router's `service(desc, impl)` REPLACES any prior
// registration for the same descriptor (path-keyed map under the hood).
// Calling `service` once for `getCrashLog` and again later for, say,
// `watchCrashLog` would silently drop `getCrashLog`. So every CrashService
// handler that ships in v0.3 lives in this single overlay registration —
// downstream sub-tasks extend the deps interface and the partial impl
// below; the wiring topology in `router.ts` and `index.ts` does not
// change.
//
// With Tasks #229 (GetCrashLog), #335 (WatchCrashLog), and #334
// (GetRawCrashLog) all landed, the entire v0.3 CrashService surface is
// wired here — no method falls through to the router's "absent method ->
// Unimplemented" fallback.

import type { ConnectRouter } from '@connectrpc/connect';

import { CrashService } from '@ccsm/proto';

import {
  makeGetCrashLogHandler,
  type GetCrashLogDeps,
} from './get-crash-log.js';
import {
  makeWatchCrashLogHandler,
  type WatchCrashLogDeps,
} from './watch-crash-log.js';
import {
  makeGetRawCrashLogHandler,
  type GetRawCrashLogDeps,
} from './get-raw-crash-log.js';

/**
 * Aggregate deps for every CrashService handler that ships in v0.3.
 * `GetCrashLog` (Task #229), `WatchCrashLog` (Task #335) and
 * `GetRawCrashLog` (Task #334) are all wired; future overlays append
 * fields here without changing the router-level signature in
 * `router.ts:makeDaemonRoutes`.
 */
export interface CrashServiceDeps {
  readonly getCrashLogDeps: GetCrashLogDeps;
  readonly watchCrashLogDeps: WatchCrashLogDeps;
  readonly getRawCrashLogDeps: GetRawCrashLogDeps;
}

/**
 * Install the v0.3 CrashService handler overlay on top of the stub
 * baseline (`registerStubServices` in `router.ts`). Returns the same
 * router so callers may chain.
 *
 * Per Connect-ES `ConnectRouter.service` semantics, this REPLACES the
 * prior `{}` stub registration for `CrashService` — the partial impl
 * below installs `getCrashLog`, `watchCrashLog` and `getRawCrashLog` in
 * a SINGLE `service()` call (calling `service` twice for the same
 * descriptor silently drops the earlier registration; see `router.ts`
 * `registerSessionService` for the same caveat).
 */
export function registerCrashService(
  router: ConnectRouter,
  deps: CrashServiceDeps,
): ConnectRouter {
  router.service(CrashService, {
    getCrashLog: makeGetCrashLogHandler(deps.getCrashLogDeps),
    watchCrashLog: makeWatchCrashLogHandler(deps.watchCrashLogDeps),
    getRawCrashLog: makeGetRawCrashLogHandler(deps.getRawCrashLogDeps),
  });
  return router;
}
