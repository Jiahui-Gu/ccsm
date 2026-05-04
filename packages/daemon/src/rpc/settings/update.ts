// packages/daemon/src/rpc/settings/update.ts
//
// Wave-3 Task #349 (spec #337 §4.2) — production
// `SettingsService.UpdateSettings` Connect handler.
//
// Behaviour summary (spec §4.2):
//   - Reject PRINCIPAL scope with InvalidArgument (same as Get).
//   - Reject any non-empty `user_home_path` / `detected_claude_default_model`
//     write with InvalidArgument (those fields are daemon-derived; spec
//     §5 + acceptance §7 #5).
//   - Cap-and-clamp `crash_retention.{max_entries,max_age_days}` BEFORE
//     write (spec §4.2 + settings.proto line 121-123).
//   - Apply every UPSERT/DELETE in ONE IMMEDIATE transaction so a
//     partial failure rolls back (spec §4.2 + §4.5).
//   - Round-trip the post-merge `Settings` in the response so the
//     client sees the authoritative resolved view (settings.proto F7
//     mandate).

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  SettingsScope,
  type SettingsService,
  UpdateSettingsResponseSchema,
} from '@ccsm/proto';

import type { SqliteDatabase } from '../../db/sqlite.js';
import { decideGetSettings } from './get.js';
import {
  applySettingsWrites,
  encodeUpdatePatch,
  readSettingsRows,
  rowsToSettings,
} from './store.js';

export interface UpdateSettingsDeps {
  readonly db: SqliteDatabase;
  readonly onUnknownKey?: (key: string) => void;
}

export function makeUpdateSettingsHandler(
  deps: UpdateSettingsDeps,
): ServiceImpl<typeof SettingsService>['updateSettings'] {
  return async function updateSettings(req) {
    // Scope validation reuses the GetSettings decider — same rule, same
    // error shape (acceptance §7 #4 covers Get; the Update path keeps
    // it symmetric).
    const decision = decideGetSettings(
      // The decider only reads `scope` from the request; the field
      // sits on UpdateSettingsRequest under the same name.
      { scope: req.scope } as Parameters<typeof decideGetSettings>[0],
    );
    if (decision.kind === 'reject_scope') {
      throw new ConnectError(
        `SettingsScope ${SettingsScope[decision.scope] ?? String(decision.scope)} ` +
          'is not supported in v0.3 (only GLOBAL / UNSPECIFIED).',
        Code.InvalidArgument,
      );
    }

    const incoming = req.settings;
    if (!incoming) {
      throw new ConnectError(
        'UpdateSettingsRequest.settings is required.',
        Code.InvalidArgument,
      );
    }

    const encoded = encodeUpdatePatch(incoming);
    if (encoded.kind === 'reject_daemon_derived') {
      throw new ConnectError(
        `${encoded.key} is daemon-derived and cannot be set via UpdateSettings.`,
        Code.InvalidArgument,
      );
    }

    applySettingsWrites(deps.db, encoded.ops);

    // Round-trip the post-merge view (spec §4.2 + settings.proto F7).
    const rows = readSettingsRows(deps.db);
    const merged = rowsToSettings(rows, { onUnknown: deps.onUnknownKey });
    return create(UpdateSettingsResponseSchema, {
      meta: req.meta,
      settings: merged,
      effectiveScope: SettingsScope.GLOBAL,
    });
  };
}
