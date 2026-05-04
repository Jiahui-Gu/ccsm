// packages/daemon/src/rpc/draft/register.ts
//
// Wave-3 Task #349 (spec #337 §6.1 step 1) — register the production
// DraftService overlay on top of the T2.2 stub baseline. Mirrors the
// CrashService / SettingsService overlay shape.
//
// Per Connect-ES `ConnectRouter.service` semantics, calling `service`
// once for a descriptor REPLACES any prior registration. Both v0.3
// methods (`GetDraft` + `UpdateDraft`) ship in the single registration
// below.

import type { ConnectRouter } from '@connectrpc/connect';

import { DraftService } from '@ccsm/proto';

import { makeGetDraftHandler, type DraftDeps } from './get.js';
import {
  makeUpdateDraftHandler,
  type UpdateDraftDeps,
} from './update.js';

export interface DraftServiceDeps {
  readonly getDraftDeps: DraftDeps;
  readonly updateDraftDeps: UpdateDraftDeps;
}

export function registerDraftService(
  router: ConnectRouter,
  deps: DraftServiceDeps,
): ConnectRouter {
  router.service(DraftService, {
    getDraft: makeGetDraftHandler(deps.getDraftDeps),
    updateDraft: makeUpdateDraftHandler(deps.updateDraftDeps),
  });
  return router;
}
