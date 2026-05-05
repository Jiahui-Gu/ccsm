// packages/daemon/src/rpc/crash/__tests__/get-crash-log-handler.spec.ts
//
// Task #472 (T8.14b-7c) — daemon src/rpc/ coverage push for the
// production CrashService.GetCrashLog handler. PR #1061 (Task #437)
// audited rpc/ and explicitly excluded `crash/get-crash-log.ts` because
// `#435 owns crash/`. PR #1060 (Task #435) shipped `crash/sources.ts`
// fileSink coverage but did NOT add direct unit specs for the rpc/crash
// handler — only the over-the-wire integration spec (crash-getlog.spec.ts)
// hits these branches end-to-end. This file pins the per-branch error
// mapping + decider semantics directly so a future change to STANDARD_ERROR_MAP
// or the OwnerFilter switch surfaces here, not as a remote-host symptom.
//
// Scope (one branch per `it`):
//   1. SERVER_LIMIT_CAP constant pinned (forever-stable spec ch04 §5)
//   2. decideGetCrashLogQuery — limit normalisation
//      a. limit=0 (proto3 default)        → cap (1000)
//      b. limit=500 (in range)            → 500
//      c. limit=2000 (over cap)           → cap
//   3. decideGetCrashLogQuery — sinceUnixMs coercion
//      a. negative since                  → 0
//      b. positive since                  → kept
//   4. handler — missing PRINCIPAL_KEY    → Code.Internal (wiring bug)
//   5. handler — OwnerFilter.ALL          → Code.PermissionDenied + session.not_owned
//   6. handler — unknown OwnerFilter enum → Code.PermissionDenied + session.not_owned
//   7. handler — OWN happy path returns rows + echoes meta (covers
//      readCrashLog OWN branch + rowToProto labels JSON parse)
//   8. handler — labels_json corrupt JSON → empty labels (defensive)

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
  GetCrashLogRequestSchema,
  OwnerFilter,
  RequestMetaSchema,
  type ErrorDetail,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, principalKey, type Principal } from '../../../auth/index.js';
import { DAEMON_SELF } from '../../../crash/sources.js';
import { openDatabase, type SqliteDatabase } from '../../../db/sqlite.js';
import { runMigrations } from '../../../db/migrations/runner.js';
import {
  decideGetCrashLogQuery,
  makeGetCrashLogHandler,
  SERVER_LIMIT_CAP,
} from '../get-crash-log.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
});

afterEach(() => {
  db.close();
});

function ctxWith(principal: Principal | null): HandlerContext {
  const values = createContextValues();
  values.set(PRINCIPAL_KEY, principal);
  return { values } as HandlerContext;
}

function makeReq(opts: {
  limit?: number;
  sinceUnixMs?: bigint;
  ownerFilter?: OwnerFilter;
  requestId?: string;
} = {}) {
  return create(GetCrashLogRequestSchema, {
    meta: create(RequestMetaSchema, { requestId: opts.requestId ?? 'rid-1' }),
    sinceUnixMs: opts.sinceUnixMs ?? 0n,
    limit: opts.limit ?? 0,
    ownerFilter: opts.ownerFilter ?? OwnerFilter.UNSPECIFIED,
  });
}

function insertCrashRow(opts: {
  id: string;
  ts_ms: number;
  source: string;
  summary: string;
  detail: string;
  labels_json: string;
  owner_id: string;
}): void {
  db.prepare(
    `INSERT INTO crash_log (id, ts_ms, source, summary, detail, labels_json, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.ts_ms,
    opts.source,
    opts.summary,
    opts.detail,
    opts.labels_json,
    opts.owner_id,
  );
}

function expectErrorDetailCode(err: ConnectError, expected: string): void {
  const details = err.findDetails(ErrorDetailSchema) as ErrorDetail[];
  expect(details.length).toBeGreaterThanOrEqual(1);
  expect(details[0].code).toBe(expected);
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('CrashService.GetCrashLog — constants (Task #472)', () => {
  it('SERVER_LIMIT_CAP is 1000 (forever-stable per spec ch04 §5)', () => {
    expect(SERVER_LIMIT_CAP).toBe(1000);
  });
});

describe('CrashService.GetCrashLog — decideGetCrashLogQuery (Task #472)', () => {
  it('normalises limit=0 (proto3 default) to SERVER_LIMIT_CAP', () => {
    const plan = decideGetCrashLogQuery(makeReq({ limit: 0 }));
    expect(plan.effectiveLimit).toBe(SERVER_LIMIT_CAP);
  });

  it('keeps limit in range [1, cap-1] verbatim', () => {
    const plan = decideGetCrashLogQuery(makeReq({ limit: 500 }));
    expect(plan.effectiveLimit).toBe(500);
  });

  it('caps oversized limit at SERVER_LIMIT_CAP', () => {
    const plan = decideGetCrashLogQuery(makeReq({ limit: 2000 }));
    expect(plan.effectiveLimit).toBe(SERVER_LIMIT_CAP);
  });

  it('coerces negative since_unix_ms to 0 (defensive — column never holds negatives)', () => {
    const plan = decideGetCrashLogQuery(makeReq({ sinceUnixMs: -1234n }));
    expect(plan.sinceUnixMs).toBe(0);
  });

  it('keeps positive since_unix_ms (round-tripped through Number)', () => {
    const plan = decideGetCrashLogQuery(makeReq({ sinceUnixMs: 1_700_000_000_000n }));
    expect(plan.sinceUnixMs).toBe(1_700_000_000_000);
  });

  it('passes ownerFilter through unchanged (decider does not enforce policy)', () => {
    const plan = decideGetCrashLogQuery(makeReq({ ownerFilter: OwnerFilter.ALL }));
    expect(plan.ownerFilter).toBe(OwnerFilter.ALL);
  });
});

describe('CrashService.GetCrashLog — handler error mapping (Task #472)', () => {
  it('throws Code.Internal when PRINCIPAL_KEY is missing (daemon wiring bug)', async () => {
    const handler = makeGetCrashLogHandler({ db });
    let captured: unknown = null;
    try {
      await handler(makeReq(), ctxWith(null));
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.Internal);
  });

  it('rejects OwnerFilter.ALL with Code.PermissionDenied + session.not_owned (spec ch15 §3 #14)', async () => {
    const handler = makeGetCrashLogHandler({ db });
    let captured: unknown = null;
    try {
      await handler(
        makeReq({ ownerFilter: OwnerFilter.ALL }),
        ctxWith(PRINCIPAL_ALICE),
      );
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    const err = captured as ConnectError;
    expect(err.code).toBe(Code.PermissionDenied);
    expectErrorDetailCode(err, 'session.not_owned');
    const detail = (err.findDetails(ErrorDetailSchema) as ErrorDetail[])[0];
    expect(detail.extra.requested_owner_filter).toBe('ALL');
  });

  it('rejects unknown OwnerFilter enum (forward-compat conservative deny)', async () => {
    const handler = makeGetCrashLogHandler({ db });
    let captured: unknown = null;
    try {
      // 99 is not a known OwnerFilter value; cast to drive the unknown-enum branch.
      await handler(
        makeReq({ ownerFilter: 99 as unknown as OwnerFilter }),
        ctxWith(PRINCIPAL_ALICE),
      );
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    const err = captured as ConnectError;
    expect(err.code).toBe(Code.PermissionDenied);
    expectErrorDetailCode(err, 'session.not_owned');
    const detail = (err.findDetails(ErrorDetailSchema) as ErrorDetail[])[0];
    expect(detail.extra.requested_owner_filter).toBe('99');
  });
});

describe('CrashService.GetCrashLog — OWN happy path + rowToProto (Task #472)', () => {
  it('OWN returns caller rows + DAEMON_SELF rows in ts-DESC order, echoes meta', async () => {
    insertCrashRow({
      id: 'A',
      ts_ms: 100,
      source: 'sqlite_open',
      summary: 'old',
      detail: 'd',
      labels_json: '{}',
      owner_id: principalKey(PRINCIPAL_ALICE),
    });
    insertCrashRow({
      id: 'B',
      ts_ms: 300,
      source: 'claude_exit',
      summary: 'newest',
      detail: 'd',
      labels_json: '{"k":"v","drop":42,"k2":"v2"}',
      owner_id: DAEMON_SELF,
    });
    insertCrashRow({
      id: 'C',
      ts_ms: 200,
      source: 'foreign',
      summary: 'hidden',
      detail: 'd',
      labels_json: '{}',
      owner_id: principalKey(PRINCIPAL_BOB),
    });

    const handler = makeGetCrashLogHandler({ db });
    const resp = await handler(
      makeReq({ ownerFilter: OwnerFilter.OWN, requestId: 'rid-2' }),
      ctxWith(PRINCIPAL_ALICE),
    );

    expect(resp.meta?.requestId).toBe('rid-2');
    // Bob's row C is filtered out by SQL (owner_id IN (alice, daemon-self)).
    // Order: ts DESC -> B(300), A(100).
    const entries = resp.entries ?? [];
    const ids = entries.map((e) => e.id);
    expect(ids).toEqual(['B', 'A']);
    // rowToProto: only string-valued labels survive the filter.
    const bLabels = entries[0].labels;
    expect(bLabels).toEqual({ k: 'v', k2: 'v2' });
    expect(entries[0].tsUnixMs).toBe(300n);
    expect(entries[0].ownerId).toBe(DAEMON_SELF);
  });

  it('rowToProto falls back to empty labels on corrupt JSON (defensive)', async () => {
    insertCrashRow({
      id: 'X',
      ts_ms: 1,
      source: 's',
      summary: 'sum',
      detail: 'det',
      labels_json: '{not json',
      owner_id: principalKey(PRINCIPAL_ALICE),
    });
    const handler = makeGetCrashLogHandler({ db });
    const resp = await handler(
      makeReq({ ownerFilter: OwnerFilter.OWN }),
      ctxWith(PRINCIPAL_ALICE),
    );
    const entries = resp.entries ?? [];
    expect(entries.length).toBe(1);
    expect(entries[0].labels).toEqual({});
    expect(entries[0].summary).toBe('sum');
  });
});
