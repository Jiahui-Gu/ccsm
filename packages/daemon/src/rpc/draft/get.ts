// packages/daemon/src/rpc/draft/get.ts
//
// Wave-3 Task #349 (spec #337 §4.3) — production
// `DraftService.GetDraft` Connect handler.
//
// Storage shape: drafts ride on the same `settings` table under key
// `draft:<session_id>` (spec #337 §2.2 + draft.proto line 8). Row
// `value` is JSON `{ "text": "...", "updated_unix_ms": N }`.
//
// SRP layering (dev.md §2):
//   * decider:  `decideDraftAccess(req, ctx, sessionLookup)` — pure
//     function over the wire request + the session ownership row;
//     either OK or PermissionDenied / InvalidArgument.
//   * producer: `readOneSettingsRow(db, draftKey(sid))` (in
//     `../settings/store.ts`).
//   * sink:     `makeGetDraftHandler(deps)` — Connect handler wiring
//     the decider to the producer + JSON decoding the row.
//
// Peer-cred check (spec §4.3, draft.proto line 14-16): the handler
// MUST verify the calling principal owns the session. v0.3 has only
// one principal so the check is "trivially true" today, but landing it
// now closes the TOCTOU window before v0.4 introduces multiple
// principals (acceptance §7 #8 pins the check is wired).

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  type DraftService,
  type GetDraftRequest,
  GetDraftResponseSchema,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, principalKey, type Principal } from '../../auth/index.js';
import type { SqliteDatabase } from '../../db/sqlite.js';
import { throwError } from '../errors.js';
import {
  draftKey,
  ULID_RE,
} from '../settings/keys.js';
import { readOneSettingsRow } from '../settings/store.js';

export interface DraftDeps {
  readonly db: SqliteDatabase;
}

interface DraftValue {
  readonly text: string;
  readonly updated_unix_ms: number;
}

/**
 * Resolve `sessions.owner_id` for the supplied session_id. Returns
 * `null` if the row does not exist (the handler treats absent-session
 * as `PermissionDenied` rather than `NotFound` — spec §4.3 mandates
 * peer-cred ownership and we deliberately do not leak existence).
 */
function lookupSessionOwner(
  db: SqliteDatabase,
  sessionId: string,
): string | null {
  const row = db
    .prepare<[string], { owner_id: string }>(
      'SELECT owner_id FROM sessions WHERE id = ?',
    )
    .get(sessionId);
  return row?.owner_id ?? null;
}

/**
 * Common ownership/format gate used by both Get and Update. Throws on
 * malformed session_id or non-owning caller. Centralised so the two
 * handlers cannot drift on the rejection shape.
 */
export function assertOwnsSession(
  db: SqliteDatabase,
  ctx: HandlerContext,
  sessionId: string,
): void {
  if (!ULID_RE.test(sessionId)) {
    throw new ConnectError(
      'session_id must be a 26-char Crockford ULID.',
      Code.InvalidArgument,
    );
  }
  const principal: Principal | null = ctx.values.get(PRINCIPAL_KEY);
  if (principal === null) {
    // Auth interceptor should have rejected before we got here; if it
    // didn't, that's a daemon wiring bug — surface as Internal so the
    // boot-time wiring assertion (§7 #6 implicitly via "not Unimplemented")
    // catches it the next time the boot e2e runs.
    throw new ConnectError(
      'GetDraft/UpdateDraft handler invoked without peerCredAuthInterceptor in chain ' +
        '(PRINCIPAL_KEY=null) — daemon wiring bug',
      Code.Internal,
    );
  }
  const owner = lookupSessionOwner(db, sessionId);
  if (owner === null) {
    // Do not leak session existence to non-owners — return the same
    // PermissionDenied a real owner-mismatch would yield.
    throwError(
      'session.not_owned',
      'session does not exist or is owned by a different principal',
      { session_id: sessionId },
    );
  }
  const callerKey = principalKey(principal);
  if (owner !== callerKey) {
    throwError('session.not_owned', undefined, {
      session_id: sessionId,
      principal: callerKey,
    });
  }
}

/**
 * Decode the JSON `value` blob stored under `draft:<sid>`. Defensive
 * — a corrupt row surfaces as the empty-draft response rather than
 * crashing the handler (forward-tolerant per spec §2.4).
 */
function decodeDraftValue(raw: string): DraftValue {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'text' in parsed &&
      'updated_unix_ms' in parsed
    ) {
      const obj = parsed as Record<string, unknown>;
      const text = typeof obj.text === 'string' ? obj.text : '';
      const ts =
        typeof obj.updated_unix_ms === 'number' ? obj.updated_unix_ms : 0;
      return { text, updated_unix_ms: ts };
    }
  } catch {
    // fall through
  }
  return { text: '', updated_unix_ms: 0 };
}

export function makeGetDraftHandler(
  deps: DraftDeps,
): ServiceImpl<typeof DraftService>['getDraft'] {
  return async function getDraft(req: GetDraftRequest, ctx) {
    assertOwnsSession(deps.db, ctx, req.sessionId);
    const row = readOneSettingsRow(deps.db, draftKey(req.sessionId));
    if (row === null) {
      // Empty-draft response (draft.proto comments line 18-19).
      return create(GetDraftResponseSchema, {
        meta: req.meta,
        text: '',
        updatedUnixMs: BigInt(0),
      });
    }
    const decoded = decodeDraftValue(row.value);
    return create(GetDraftResponseSchema, {
      meta: req.meta,
      text: decoded.text,
      updatedUnixMs: BigInt(decoded.updated_unix_ms),
    });
  };
}
