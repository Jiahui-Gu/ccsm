// packages/daemon/src/rpc/draft/__tests__/update-handler.spec.ts
//
// Task #437 (T8.14b-5) — rpc/ coverage push for the production
// `DraftService.UpdateDraft` handler. The Wave-3 settings-roundtrip
// integration spec exercises end-to-end UPSERT round-trips but the
// per-branch behaviour (DELETE-on-empty-text vs UPSERT-on-non-empty,
// clock injection for `updated_unix_ms`) was never pinned at the unit
// level. These specs lock the spec §4.4 + draft.proto:31 contract so a
// future refactor of the row vocabulary can't silently drift.
//
// Scope (one branch per `it`):
//   1. empty `text` ⇒ DELETE row; response carries updated_unix_ms = 0
//   2. non-empty `text` ⇒ UPSERT row; response carries the injected ts
//   3. clock injection: the `now` dep controls `updated_unix_ms`
//
// Re-uses the same in-memory sqlite + seed pattern as the GetDraft
// spec; see comments there for the rationale.

import { create } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContextValues, type HandlerContext } from '@connectrpc/connect';

import {
  RequestMetaSchema,
  UpdateDraftRequestSchema,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, principalKey, type Principal } from '../../../auth/index.js';
import { openDatabase, type SqliteDatabase } from '../../../db/sqlite.js';
import { runMigrations } from '../../../db/migrations/runner.js';
import { applySettingsWrites, readOneSettingsRow } from '../../settings/store.js';
import { draftKey } from '../../settings/keys.js';
import { makeUpdateDraftHandler } from '../update.js';

const VALID_ULID_A = '01J0000000000000000000ABCD';
const PRINCIPAL_ALICE: Principal = {
  kind: 'local-user',
  uid: '1000',
  displayName: 'alice',
};

let db: SqliteDatabase;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  db.exec(`INSERT INTO principals (id, kind, display_name, first_seen_ms, last_seen_ms) VALUES
    ('${principalKey(PRINCIPAL_ALICE)}', 'local-user', 'alice', 0, 0);`);
  db.prepare(
    `INSERT INTO sessions (id, owner_id, state, cwd, env_json, claude_args_json,
      geometry_cols, geometry_rows, created_ms, last_active_ms)
     VALUES (?, ?, 1, '/tmp', '{}', '[]', 80, 24, 0, 0)`,
  ).run(VALID_ULID_A, principalKey(PRINCIPAL_ALICE));
});

afterEach(() => {
  db.close();
});

function ctxWith(principal: Principal | null): HandlerContext {
  const values = createContextValues();
  values.set(PRINCIPAL_KEY, principal);
  return { values } as HandlerContext;
}

function makeReq(sessionId: string, text: string) {
  return create(UpdateDraftRequestSchema, {
    meta: create(RequestMetaSchema, { requestId: 'rid-update' }),
    sessionId,
    text,
  });
}

describe('DraftService.UpdateDraft — DELETE/UPSERT branches + clock (Task #437)', () => {
  it('empty text ⇒ DELETE row + response.updated_unix_ms = 0 (update.ts:42-49)', async () => {
    // Pre-seed a draft so the DELETE branch has something to remove.
    applySettingsWrites(db, [
      {
        kind: 'upsert',
        key: draftKey(VALID_ULID_A),
        value: JSON.stringify({ text: 'old', updated_unix_ms: 100 }),
      },
    ]);
    expect(readOneSettingsRow(db, draftKey(VALID_ULID_A))).not.toBeNull();

    const handler = makeUpdateDraftHandler({
      db,
      now: () => 12345, // injected, but DELETE branch must NOT call it
    });
    const resp = await handler(makeReq(VALID_ULID_A, ''), ctxWith(PRINCIPAL_ALICE));

    expect(resp.updatedUnixMs).toBe(0n);
    expect(resp.meta?.requestId).toBe('rid-update');
    // Row gone — DELETE took effect.
    expect(readOneSettingsRow(db, draftKey(VALID_ULID_A))).toBeNull();
  });

  it('non-empty text ⇒ UPSERT row + response.updated_unix_ms reflects the injected clock (update.ts:50-61)', async () => {
    const handler = makeUpdateDraftHandler({
      db,
      now: () => 999_888_777,
    });
    const resp = await handler(
      makeReq(VALID_ULID_A, 'hello world'),
      ctxWith(PRINCIPAL_ALICE),
    );

    expect(resp.updatedUnixMs).toBe(999_888_777n);

    // Row is JSON-encoded { text, updated_unix_ms } per draft storage shape.
    const row = readOneSettingsRow(db, draftKey(VALID_ULID_A));
    expect(row).not.toBeNull();
    const parsed = JSON.parse(row!.value) as {
      text: string;
      updated_unix_ms: number;
    };
    expect(parsed.text).toBe('hello world');
    expect(parsed.updated_unix_ms).toBe(999_888_777);
  });

  it('clock dep defaults to Date.now when omitted (update.ts:38)', async () => {
    // No `now` override — handler MUST call `Date.now` and surface a
    // plausible epoch-millis value (positive, within a few seconds of
    // wallclock around the call).
    const handler = makeUpdateDraftHandler({ db });
    const before = Date.now();
    const resp = await handler(
      makeReq(VALID_ULID_A, 'use default clock'),
      ctxWith(PRINCIPAL_ALICE),
    );
    const after = Date.now();

    // Response timestamp is BigInt; widen for comparison.
    const ts = Number(resp.updatedUnixMs);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
