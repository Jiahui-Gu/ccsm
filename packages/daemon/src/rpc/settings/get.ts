// packages/daemon/src/rpc/settings/get.ts
//
// Wave-3 Task #349 (spec #337 §4.1) — production
// `SettingsService.GetSettings` Connect handler.
//
// SRP layering (dev.md §2):
//   * decider:  `decideGetSettings(req)` — validate scope; on
//     PRINCIPAL → reject with InvalidArgument (settings.proto line 36 +
//     spec §4.1 last paragraph).
//   * producer: `readSettingsRows` (in `./store.ts`).
//   * sink:     `makeGetSettingsHandler(deps)` — Connect handler that
//     glues decider + producer + decoder, then echoes
//     `effective_scope = SETTINGS_SCOPE_GLOBAL` per spec §9 q5.
//
// Pre-#349 the service was a stub on the wire — every method returned
// `Code.Unimplemented` despite the `settings` table existing in
// `001_initial.sql`. This handler closes that gap.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  GetSettingsResponseSchema,
  type GetSettingsRequest,
  type SettingsService,
  SettingsScope,
} from '@ccsm/proto';

import type { SqliteDatabase } from '../../db/sqlite.js';
import { readSettingsRows, rowsToSettings } from './store.js';

export interface GetSettingsDeps {
  /** Same `SqliteDatabase` handle the rest of the daemon uses (single
   *  owner of the DB; see `index.ts` `runStartup`). */
  readonly db: SqliteDatabase;
  /** Optional debug-level logger for unknown row keys (spec §2.4 forward
   *  tolerance). Defaults to a no-op so unit tests need not inject one. */
  readonly onUnknownKey?: (key: string) => void;
}

/**
 * Validate the request scope. Spec §4.1: UNSPECIFIED + GLOBAL proceed;
 * PRINCIPAL rejects with `Code.InvalidArgument` (matches
 * settings.proto line 36 + acceptance §7 #4).
 *
 * Pure decider — no DB access. Returning a discriminated union rather
 * than throwing keeps the function unit-testable without a Connect
 * harness.
 */
export type GetSettingsDecision =
  | { readonly kind: 'ok' }
  | { readonly kind: 'reject_scope'; readonly scope: SettingsScope };

export function decideGetSettings(req: GetSettingsRequest): GetSettingsDecision {
  if (
    req.scope !== SettingsScope.UNSPECIFIED &&
    req.scope !== SettingsScope.GLOBAL
  ) {
    return { kind: 'reject_scope', scope: req.scope };
  }
  return { kind: 'ok' };
}

export function makeGetSettingsHandler(
  deps: GetSettingsDeps,
): ServiceImpl<typeof SettingsService>['getSettings'] {
  return async function getSettings(req) {
    const decision = decideGetSettings(req);
    if (decision.kind === 'reject_scope') {
      throw new ConnectError(
        `SettingsScope ${SettingsScope[decision.scope] ?? String(decision.scope)} ` +
          'is not supported in v0.3 (only GLOBAL / UNSPECIFIED).',
        Code.InvalidArgument,
      );
    }
    const rows = readSettingsRows(deps.db);
    const settings = rowsToSettings(rows, { onUnknown: deps.onUnknownKey });
    return create(GetSettingsResponseSchema, {
      meta: req.meta,
      settings,
      effectiveScope: SettingsScope.GLOBAL,
    });
  };
}
