// packages/daemon/src/rpc/draft/__tests__/get-handler.spec.ts
//
// Task #437 (T8.14b-5) — rpc/ coverage push for the production
// `DraftService.GetDraft` handler. The Wave-3 settings-roundtrip
// integration spec exercises the happy path of GetDraft over the wire
// (settings overlay end-to-end) but the per-branch error mapping for
// `assertOwnsSession` (the shared ownership gate at the top of every
// draft handler) and the `decodeDraftValue` JSON-tolerance branch never
// got direct unit coverage. These specs pin the error mapping so a
// future change to `errors.ts` STANDARD_ERROR_MAP or `assertOwnsSession`
// rejection ordering surfaces here, not as a remote-host symptom.
//
// Scope (one branch per `it`):
//   1. invalid ULID session_id            → Code.InvalidArgument
//   2. unknown session_id (no row)         → Code.PermissionDenied + session.not_owned
//      (deliberately no NotFound — spec §4.3 + get.ts:104-106 prevents
//      session-existence leak to non-owners)
//   3. owner mismatch                      → Code.PermissionDenied + session.not_owned
//   4. row absent in settings table        → empty-draft response
//   5. row present + corrupt JSON          → fallback empty-draft (forward-tolerant)
//
// SCOPE: pure unit — uses an in-memory sqlite (`openDatabase(':memory:')
// + runMigrations`) so the handler runs against a real schema; no
// Connect transport plumbing needed because we exercise the handler
// function directly with a stub HandlerContext.

import { create } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Code,
  ConnectError,
  createContextValues,
  type HandlerContext,
} from '@connectrpc/connect';

import {
  ErrorDetailSchema,
  GetDraftRequestSchema,
  RequestMetaSchema,
  type ErrorDetail,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, principalKey, type Principal } from '../../../auth/index.js';
import { openDatabase, type SqliteDatabase } from '../../../db/sqlite.js';
import { runMigrations } from '../../../db/migrations/runner.js';
import { applySettingsWrites } from '../../settings/store.js';
import { draftKey } from '../../settings/keys.js';
import { makeGetDraftHandler } from '../get.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ULID_A = '01J0000000000000000000ABCD';
const VALID_ULID_B = '01J000000000000000000WXYZ0';
const PRINCIPAL_ALICE: Principal = {
  kind: 'local-user',
  uid: '1000',
  displayName: 'alice',
};
const PRINCIPAL_BOB: Principal = {
  kind: 'local-user',
  uid: '1001',
  displayName: 'bob',
};

let db: SqliteDatabase;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  // Seed principals + sessions rows the gate needs. The session is owned
  // by Alice; Bob is the foreign principal used in the owner-mismatch case.
  db.exec(`INSERT INTO principals (id, kind, display_name, first_seen_ms, last_seen_ms) VALUES
    ('${principalKey(PRINCIPAL_ALICE)}', 'local-user', 'alice', 0, 0),
    ('${principalKey(PRINCIPAL_BOB)}', 'local-user', 'bob', 0, 0);`);
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
  // Minimal HandlerContext stub — the handler only reads `.values.get`.
  // createContextValues() returns the same shape Connect's router
  // constructs; pre-seed it with the principal under PRINCIPAL_KEY.
  const values = createContextValues();
  if (principal !== null) {
    values.set(PRINCIPAL_KEY, principal);
  } else {
    values.set(PRINCIPAL_KEY, null);
  }
  return { values } as HandlerContext;
}

function makeReq(sessionId: string) {
  return create(GetDraftRequestSchema, {
    meta: create(RequestMetaSchema, { requestId: 'rid-1' }),
    sessionId,
  });
}

function expectErrorDetailCode(err: ConnectError, expected: string): void {
  const details = err.findDetails(ErrorDetailSchema) as ErrorDetail[];
  expect(details.length).toBeGreaterThanOrEqual(1);
  expect(details[0].code).toBe(expected);
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('DraftService.GetDraft — assertOwnsSession + decodeDraftValue (Task #437)', () => {
  it('rejects malformed session_id with Code.InvalidArgument (get.ts:85-90)', async () => {
    const handler = makeGetDraftHandler({ db });
    const ctx = ctxWith(PRINCIPAL_ALICE);

    let captured: unknown = null;
    try {
      await handler(makeReq('not-a-ulid'), ctx);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.InvalidArgument);
  });

  it('hides existence of unknown session: returns session.not_owned (PermissionDenied) per spec §4.3', async () => {
    // Spec §4.3 + get.ts:104-106 — the handler MUST NOT distinguish
    // "session does not exist" from "session is owned by another
    // principal" to a non-owner. Both surface as PermissionDenied with
    // ErrorDetail.code = "session.not_owned".
    const handler = makeGetDraftHandler({ db });
    const ctx = ctxWith(PRINCIPAL_ALICE);

    let captured: unknown = null;
    try {
      await handler(makeReq(VALID_ULID_B), ctx); // VALID_ULID_B has no row
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    const err = captured as ConnectError;
    expect(err.code).toBe(Code.PermissionDenied);
    expectErrorDetailCode(err, 'session.not_owned');
  });

  it('rejects non-owner with Code.PermissionDenied + session.not_owned (get.ts:113-118)', async () => {
    const handler = makeGetDraftHandler({ db });
    // Alice owns VALID_ULID_A; Bob is calling.
    const ctx = ctxWith(PRINCIPAL_BOB);

    let captured: unknown = null;
    try {
      await handler(makeReq(VALID_ULID_A), ctx);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    const err = captured as ConnectError;
    expect(err.code).toBe(Code.PermissionDenied);
    expectErrorDetailCode(err, 'session.not_owned');
    // Extra carries session_id + caller's principal key per get.ts:115-118.
    const detail = (err.findDetails(ErrorDetailSchema) as ErrorDetail[])[0];
    expect(detail.extra.session_id).toBe(VALID_ULID_A);
    expect(detail.extra.principal).toBe(principalKey(PRINCIPAL_BOB));
  });

  it('returns empty-draft response when no draft row exists (get.ts:154-160)', async () => {
    // Owner gate passes; settings table has no `draft:<sid>` row.
    const handler = makeGetDraftHandler({ db });
    const ctx = ctxWith(PRINCIPAL_ALICE);
    const resp = await handler(makeReq(VALID_ULID_A), ctx);

    expect(resp.text).toBe('');
    expect(resp.updatedUnixMs).toBe(0n);
    expect(resp.meta?.requestId).toBe('rid-1');
  });

  it('falls back to empty-draft when row value is corrupt JSON (forward-tolerant per §2.4)', async () => {
    // Seed a draft row whose value is NOT valid JSON. decodeDraftValue
    // (get.ts:127-145) must NOT crash — it returns the empty-draft
    // shape so the handler ships a wire response rather than throwing.
    applySettingsWrites(db, [
      { kind: 'upsert', key: draftKey(VALID_ULID_A), value: '{not json' },
    ]);

    const handler = makeGetDraftHandler({ db });
    const ctx = ctxWith(PRINCIPAL_ALICE);
    const resp = await handler(makeReq(VALID_ULID_A), ctx);

    expect(resp.text).toBe('');
    expect(resp.updatedUnixMs).toBe(0n);
  });
});
