// Task #473 (T8.14b-7b) — sessions/ coverage push.
//
// Unit tests for the unary SessionService Connect handlers:
//   - sessions/read-handlers.ts (ListSessions + GetSession)
//   - sessions/create-handler.ts (CreateSession + decodeCreateRequest)
//   - sessions/destroy-handler.ts (DestroySession)
//
// Posture: invoke each handler function directly with a stub
// HandlerContext (the same `createContextValues()` shape Connect's
// router hands to handlers in production). The SessionManager underneath
// is a real instance over an in-memory sqlite — exercises the full
// row INSERT / SELECT / UPDATE path and the `sessionRowToProto` mapper.

import { create } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Code,
  ConnectError,
  createContextValues,
  type HandlerContext,
} from '@connectrpc/connect';

import {
  CreateSessionRequestSchema,
  DestroySessionRequestSchema,
  ErrorDetailSchema,
  GetSessionRequestSchema,
  ListSessionsRequestSchema,
  RequestMetaSchema,
  type ErrorDetail,
} from '@ccsm/proto';
import { PtyGeometrySchema } from '@ccsm/proto';

import { PRINCIPAL_KEY, principalKey, type Principal } from '../../auth/index.js';
import { runMigrations } from '../../db/migrations/runner.js';
import { openDatabase, type SqliteDatabase } from '../../db/sqlite.js';

import {
  DEFAULT_GEOMETRY_COLS,
  DEFAULT_GEOMETRY_ROWS,
  decodeCreateRequest,
  makeCreateSessionHandler,
} from '../create-handler.js';
import { makeDestroySessionHandler } from '../destroy-handler.js';
import {
  makeGetSessionHandler,
  makeListSessionsHandler,
} from '../read-handlers.js';
import { SessionManager } from '../SessionManager.js';

const ALICE: Principal = { kind: 'local-user', uid: '1000', displayName: 'alice' };
const BOB: Principal = { kind: 'local-user', uid: '1001', displayName: 'bob' };

let db: SqliteDatabase;
let manager: SessionManager;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  db.exec(`INSERT INTO principals (id, kind, display_name, first_seen_ms, last_seen_ms) VALUES
    ('${principalKey(ALICE)}', 'local-user', 'alice', 0, 0),
    ('${principalKey(BOB)}', 'local-user', 'bob', 0, 0);`);
  manager = new SessionManager(db, {
    now: () => 1700000000000,
    newId: ((): (() => string) => {
      let n = 0;
      return () => `01J000000000000000000${String(n++).padStart(5, '0')}`;
    })(),
  });
});

afterEach(() => {
  db.close();
});

function ctxWith(principal: Principal | null): HandlerContext {
  const values = createContextValues();
  values.set(PRINCIPAL_KEY, principal as Principal);
  return { values } as HandlerContext;
}

function expectErrorDetail(err: ConnectError, code: string) {
  const details = err.findDetails(ErrorDetailSchema) as ErrorDetail[];
  expect(details.length).toBeGreaterThanOrEqual(1);
  expect(details[0].code).toBe(code);
}

// ===========================================================================
// decodeCreateRequest (pure)
// ===========================================================================

describe('decodeCreateRequest', () => {
  it('sorts env keys for deterministic JSON', () => {
    const req = create(CreateSessionRequestSchema, {
      cwd: '/tmp',
      env: { ZED: 'z', ALPHA: 'a', mid: 'm' },
      claudeArgs: ['--foo', '--bar'],
      initialGeometry: create(PtyGeometrySchema, { cols: 120, rows: 40 }),
    });
    const out = decodeCreateRequest(req);
    expect(out.env_json).toBe('{"ALPHA":"a","ZED":"z","mid":"m"}');
    // claude_args order PRESERVED (argv positional)
    expect(out.claude_args_json).toBe('["--foo","--bar"]');
    expect(out.geometry_cols).toBe(120);
    expect(out.geometry_rows).toBe(40);
    expect(out.cwd).toBe('/tmp');
  });

  it('applies 80x24 default when initial_geometry omitted', () => {
    const req = create(CreateSessionRequestSchema, {
      cwd: '/x',
      env: {},
      claudeArgs: [],
    });
    const out = decodeCreateRequest(req);
    expect(out.geometry_cols).toBe(DEFAULT_GEOMETRY_COLS);
    expect(out.geometry_rows).toBe(DEFAULT_GEOMETRY_ROWS);
  });

  it('treats geometry cols=0 / rows=0 as default (not zero)', () => {
    const req = create(CreateSessionRequestSchema, {
      cwd: '/x',
      env: {},
      claudeArgs: [],
      initialGeometry: create(PtyGeometrySchema, { cols: 0, rows: 0 }),
    });
    const out = decodeCreateRequest(req);
    expect(out.geometry_cols).toBe(DEFAULT_GEOMETRY_COLS);
    expect(out.geometry_rows).toBe(DEFAULT_GEOMETRY_ROWS);
  });

  it('takes only one explicit dimension and defaults the other', () => {
    const req = create(CreateSessionRequestSchema, {
      cwd: '/x',
      env: {},
      claudeArgs: [],
      initialGeometry: create(PtyGeometrySchema, { cols: 200, rows: 0 }),
    });
    const out = decodeCreateRequest(req);
    expect(out.geometry_cols).toBe(200);
    expect(out.geometry_rows).toBe(DEFAULT_GEOMETRY_ROWS);
  });
});

// ===========================================================================
// CreateSession handler
// ===========================================================================

describe('makeCreateSessionHandler', () => {
  function req() {
    return create(CreateSessionRequestSchema, {
      meta: create(RequestMetaSchema, { requestId: 'req-1' }),
      cwd: '/home/alice',
      env: { K: 'V' },
      claudeArgs: [],
      initialGeometry: create(PtyGeometrySchema, { cols: 100, rows: 30 }),
    });
  }

  it('happy path: INSERTs row, echoes meta, returns proto Session', async () => {
    const handler = makeCreateSessionHandler({ manager });
    const resp = await handler(req(), ctxWith(ALICE));
    expect(resp.meta?.requestId).toBe('req-1');
    expect(resp.session).toBeDefined();
    expect(resp.session?.id).toBe('01J00000000000000000000000');
    expect(resp.session?.cwd).toBe('/home/alice');
    expect(resp.session?.owner?.kind?.case).toBe('localUser');
  });

  it('null principal → Code.Internal (daemon wiring bug)', async () => {
    const handler = makeCreateSessionHandler({ manager });
    let captured: unknown = null;
    try {
      await handler(req(), ctxWith(null));
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.Internal);
  });

  it('attachPtyHost callback fires with the freshly INSERTed row + principal', async () => {
    const calls: Array<{ rowId: string; uid: string }> = [];
    const handler = makeCreateSessionHandler({
      manager,
      attachPtyHost: (row, principal) => {
        calls.push({ rowId: row.id, uid: principal.uid });
      },
    });
    await handler(req(), ctxWith(ALICE));
    expect(calls).toHaveLength(1);
    expect(calls[0].uid).toBe('1000');
    expect(calls[0].rowId).toBeDefined();
  });
});

// ===========================================================================
// DestroySession handler
// ===========================================================================

describe('makeDestroySessionHandler', () => {
  it('happy path: returns echoed meta, flips row to should_be_running=0', async () => {
    const created = manager.create(
      { cwd: '/x', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
      ALICE,
    );
    const handler = makeDestroySessionHandler({ manager });
    const resp = await handler(
      create(DestroySessionRequestSchema, {
        meta: create(RequestMetaSchema, { requestId: 'req-d' }),
        sessionId: created.id,
      }),
      ctxWith(ALICE),
    );
    expect(resp.meta?.requestId).toBe('req-d');

    const row = db.prepare('SELECT should_be_running FROM sessions WHERE id = ?').get(created.id) as {
      should_be_running: number;
    };
    expect(row.should_be_running).toBe(0);
  });

  it('null principal → Code.Internal', async () => {
    const handler = makeDestroySessionHandler({ manager });
    let captured: unknown = null;
    try {
      await handler(
        create(DestroySessionRequestSchema, { sessionId: 'x' }),
        ctxWith(null),
      );
    } catch (e) {
      captured = e;
    }
    expect((captured as ConnectError).code).toBe(Code.Internal);
  });

  it('foreign session_id → session.not_owned (PermissionDenied)', async () => {
    const owned = manager.create(
      { cwd: '/x', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
      ALICE,
    );
    const handler = makeDestroySessionHandler({ manager });
    let captured: unknown = null;
    try {
      await handler(
        create(DestroySessionRequestSchema, { sessionId: owned.id }),
        ctxWith(BOB),
      );
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.PermissionDenied);
    expectErrorDetail(captured as ConnectError, 'session.not_owned');
  });
});

// ===========================================================================
// Read handlers (List / Get)
// ===========================================================================

describe('makeListSessionsHandler', () => {
  it('returns only caller-owned sessions, echoes meta', async () => {
    manager.create(
      { cwd: '/a', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
      ALICE,
    );
    manager.create(
      { cwd: '/b', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
      BOB,
    );
    manager.create(
      { cwd: '/a2', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
      ALICE,
    );

    const handler = makeListSessionsHandler({ manager });
    const resp = await handler(
      create(ListSessionsRequestSchema, {
        meta: create(RequestMetaSchema, { requestId: 'list-1' }),
      }),
      ctxWith(ALICE),
    );
    expect(resp.meta?.requestId).toBe('list-1');
    expect(resp.sessions?.length).toBe(2);
    expect((resp.sessions ?? []).every((s) => s.owner?.kind?.case === 'localUser')).toBe(true);
  });

  it('echoes empty meta defaults when request omits meta', async () => {
    const handler = makeListSessionsHandler({ manager });
    const resp = await handler(
      create(ListSessionsRequestSchema, {}),
      ctxWith(ALICE),
    );
    expect(resp.meta?.requestId).toBe('');
    expect(resp.meta?.clientVersion).toBe('');
  });

  it('null principal → Code.Internal', async () => {
    const handler = makeListSessionsHandler({ manager });
    let captured: unknown = null;
    try {
      await handler(create(ListSessionsRequestSchema, {}), ctxWith(null));
    } catch (e) {
      captured = e;
    }
    expect((captured as ConnectError).code).toBe(Code.Internal);
  });
});

describe('makeGetSessionHandler', () => {
  it('happy path: returns proto Session for owned row', async () => {
    const row = manager.create(
      { cwd: '/here', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
      ALICE,
    );
    const handler = makeGetSessionHandler({ manager });
    const resp = await handler(
      create(GetSessionRequestSchema, {
        meta: create(RequestMetaSchema, { requestId: 'get-1' }),
        sessionId: row.id,
      }),
      ctxWith(ALICE),
    );
    expect(resp.session?.id).toBe(row.id);
    expect(resp.session?.cwd).toBe('/here');
    expect(resp.meta?.requestId).toBe('get-1');
  });

  it('foreign session_id → session.not_owned', async () => {
    const row = manager.create(
      { cwd: '/x', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
      ALICE,
    );
    const handler = makeGetSessionHandler({ manager });
    let captured: unknown = null;
    try {
      await handler(
        create(GetSessionRequestSchema, { sessionId: row.id }),
        ctxWith(BOB),
      );
    } catch (e) {
      captured = e;
    }
    expect((captured as ConnectError).code).toBe(Code.PermissionDenied);
    expectErrorDetail(captured as ConnectError, 'session.not_owned');
  });

  it('unknown session_id → session.not_owned (no NotFound leak)', async () => {
    const handler = makeGetSessionHandler({ manager });
    let captured: unknown = null;
    try {
      await handler(
        create(GetSessionRequestSchema, { sessionId: 'never-existed' }),
        ctxWith(ALICE),
      );
    } catch (e) {
      captured = e;
    }
    expect((captured as ConnectError).code).toBe(Code.PermissionDenied);
    expectErrorDetail(captured as ConnectError, 'session.not_owned');
  });

  it('null principal → Code.Internal', async () => {
    const handler = makeGetSessionHandler({ manager });
    let captured: unknown = null;
    try {
      await handler(create(GetSessionRequestSchema, { sessionId: 'x' }), ctxWith(null));
    } catch (e) {
      captured = e;
    }
    expect((captured as ConnectError).code).toBe(Code.Internal);
  });
});
