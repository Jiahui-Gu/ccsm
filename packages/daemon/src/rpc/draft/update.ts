// packages/daemon/src/rpc/draft/update.ts
//
// Wave-3 Task #349 (spec #337 §4.4) — production
// `DraftService.UpdateDraft` Connect handler.
//
// Behaviour (spec §4.4 + draft.proto line 31):
//   - empty `text` ⇒ DELETE the row.
//   - non-empty `text` ⇒ UPSERT with `updated_unix_ms = Date.now()`.
//   - Same peer-cred ownership gate as GetDraft (spec §4.3).
//   - One IMMEDIATE transaction (`applySettingsWrites`).
// Response carries the post-write `updated_unix_ms` so the renderer can
// detect "newer write won" without an extra GetDraft.

import { create } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';

import {
  type DraftService,
  type UpdateDraftRequest,
  UpdateDraftResponseSchema,
} from '@ccsm/proto';

import { draftKey } from '../settings/keys.js';
import { applySettingsWrites } from '../settings/store.js';
import { assertOwnsSession, type DraftDeps } from './get.js';

/** Injectable clock so unit tests can pin `updated_unix_ms`. */
export type ClockFn = () => number;

export interface UpdateDraftDeps extends DraftDeps {
  /** Defaults to `Date.now`. */
  readonly now?: ClockFn;
}

export function makeUpdateDraftHandler(
  deps: UpdateDraftDeps,
): ServiceImpl<typeof DraftService>['updateDraft'] {
  const now = deps.now ?? (() => Date.now());
  return async function updateDraft(req: UpdateDraftRequest, ctx) {
    assertOwnsSession(deps.db, ctx, req.sessionId);
    const key = draftKey(req.sessionId);
    if (req.text === '') {
      // DELETE branch — empty text wipes the draft (draft.proto line 31).
      applySettingsWrites(deps.db, [{ kind: 'delete', key }]);
      return create(UpdateDraftResponseSchema, {
        meta: req.meta,
        updatedUnixMs: BigInt(0),
      });
    }
    const ts = now();
    applySettingsWrites(deps.db, [
      {
        kind: 'upsert',
        key,
        value: JSON.stringify({ text: req.text, updated_unix_ms: ts }),
      },
    ]);
    return create(UpdateDraftResponseSchema, {
      meta: req.meta,
      updatedUnixMs: BigInt(ts),
    });
  };
}
