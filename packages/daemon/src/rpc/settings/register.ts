// packages/daemon/src/rpc/settings/register.ts
//
// Wave-3 Task #349 (spec #337 §6.1 step 1) — register the production
// SettingsService overlay on top of the T2.2 stub baseline. Mirrors the
// CrashService overlay shape (PR #996, #229).
//
// Per Connect-ES `ConnectRouter.service` semantics, calling `service`
// once for a descriptor REPLACES any prior registration (the router is
// a path-keyed map). All v0.3 SettingsService methods (`GetSettings` +
// `UpdateSettings`) ship in this single overlay registration; if a
// future v0.4 method joins, extend the impl object below — DO NOT add
// a second `router.service(SettingsService, ...)` call (that would
// silently drop the prior).

import type { ConnectRouter } from '@connectrpc/connect';

import { SettingsService } from '@ccsm/proto';

import { makeGetSettingsHandler, type GetSettingsDeps } from './get.js';
import {
  makeUpdateSettingsHandler,
  type UpdateSettingsDeps,
} from './update.js';

/**
 * Aggregate deps for every SettingsService handler that ships in v0.3.
 * Get + Update share the same `db` handle today, so the deps interface
 * is collapsed; future overlays (v0.4 admin-gated keys, etc.) extend
 * here without changing the router-level signature in `router.ts`.
 */
export interface SettingsServiceDeps {
  readonly getSettingsDeps: GetSettingsDeps;
  readonly updateSettingsDeps: UpdateSettingsDeps;
}

export function registerSettingsService(
  router: ConnectRouter,
  deps: SettingsServiceDeps,
): ConnectRouter {
  router.service(SettingsService, {
    getSettings: makeGetSettingsHandler(deps.getSettingsDeps),
    updateSettings: makeUpdateSettingsHandler(deps.updateSettingsDeps),
  });
  return router;
}
