// Unit tests for SessionService read-only handlers — ListSessions and
// GetSession (Wave 3 §6.9 sub-task 5 / Task #336).
//
// Covers (mirrors `watch-sessions.spec.ts` layout):
//   - Sink (handlers) over the in-process Connect router transport:
//       * ListSessions: empty when no rows; returns only the caller's
//         rows even when a peer principal also has rows (security
//         boundary — `SessionManager.list` filters by owner_id).
//       * ListSessions: echoes RequestMeta.request_id.
//       * ListSessions: missing PRINCIPAL_KEY → ConnectError(Internal)
//         (defensive — proves the handler refuses to run if the auth
//         interceptor was not wired).
//       * GetSession: returns the proto Session for an owned id.
//       * GetSession: peer's id collapses to `Code.PermissionDenied +
//         ErrorDetail.code = "session.not_owned"` (T2.5 single source
//         of truth; the SessionManager prevents cross-principal id
//         enumeration by mapping NotFound → not_owned).
//       * GetSession: unknown id ALSO collapses to PermissionDenied
//         (same security boundary).
//
// Spec refs: ch04 §3, ch05 §5; T2.5 / PR #926; T3.2 / PR #933.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
} from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';

import {
  ErrorDetailSchema,
  GetSessionRequestSchema,
  ListSessionsRequestSchema,
  RequestMetaSchema,
  SessionService,
  type ErrorDetail,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../../src/auth/index.js';
import { runMigrations } from '../../src/db/migrations/runner.js';
import { openDatabase, type SqliteDatabase } from '../../src/db/sqlite.js';
import {
  makeGetSessionHandler,
  makeListSessionsHandler,
} from '../../src/sessions/read-handlers.js';
import { SessionManager } from '../../src/sessions/SessionManager.js';

const ALICE: AuthPrincipal = { kind: 'local-user', uid: '1000', displayName: 'alice' };
const BOB: AuthPrincipal = { kind: 'local-user', uid: '1001', displayName: 'bob' };

function freshDb(): SqliteDatabase {
  const db = openDatabase(':memory:');
  runMigrations(db);
  // sessions.owner_id has an FK to principals(id) — see SessionManager.spec.ts.
  const insertPrincipal = db.prepare(
    `INSERT INTO principals (id, kind, display_name, first_seen_ms, last_seen_ms)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insertPrincipal.run('local-user:1000', 'local-user', 'alice', 1, 1);
  insertPrincipal.run('local-user:1001', 'local-user', 'bob', 1, 1);
  return db;
}

function createInput(cwd = '/home/alice') {
  return {
    cwd,
    env_json: '{}',
    claude_args_json: '[]',
    geometry_cols: 80,
    geometry_rows: 24,
  };
}

function makeBoundTransport(
  manager: SessionManager,
  principal: AuthPrincipal | null = ALICE,
) {
  return createRouterTransport(
    (router) => {
      router.service(SessionService, {
        listSessions: makeListSessionsHandler({ manager }),
        getSession: makeGetSessionHandler({ manager }),
      });
    },
    {
      router: {
        interceptors: [
          (next) => async (req) => {
            req.contextValues.set(PRINCIPAL_KEY, principal);
            return next(req);
          },
        ],
      },
    },
  );
}

function newMeta(requestId = '11111111-2222-3333-4444-555555555555') {
  return create(RequestMetaSchema, {
    requestId,
    clientVersion: '0.3.0-test',
    clientSendUnixMs: 0n,
  });
}

// ---------------------------------------------------------------------------
// ListSessions
// ---------------------------------------------------------------------------

describe('SessionService.ListSessions — handler', () => {
  it('returns empty sessions array when the caller has no rows', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const client = createClient(SessionService, makeBoundTransport(manager));

    const resp = await client.listSessions(
      create(ListSessionsRequestSchema, { meta: newMeta() }),
    );
    expect(resp.sessions).toHaveLength(0);
  });

  it('echoes RequestMeta.request_id on the response', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const client = createClient(SessionService, makeBoundTransport(manager));

    const reqId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const resp = await client.listSessions(
      create(ListSessionsRequestSchema, { meta: newMeta(reqId) }),
    );
    expect(resp.meta?.requestId).toBe(reqId);
  });

  it('returns only the caller-owned rows; peer rows are filtered out', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);

    const aliceRow = manager.create(createInput('/home/alice'), ALICE);
    manager.create(createInput('/home/bob'), BOB);

    const client = createClient(SessionService, makeBoundTransport(manager, ALICE));
    const resp = await client.listSessions(
      create(ListSessionsRequestSchema, { meta: newMeta() }),
    );
    expect(resp.sessions).toHaveLength(1);
    expect(resp.sessions[0].id).toBe(aliceRow.id);
    expect(resp.sessions[0].cwd).toBe('/home/alice');
    expect(resp.sessions[0].owner?.kind?.case).toBe('localUser');
  });

  it('throws Code.Internal when PRINCIPAL_KEY was never deposited (wiring bug)', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const client = createClient(SessionService, makeBoundTransport(manager, null));

    let raised: ConnectError | null = null;
    try {
      await client.listSessions(
        create(ListSessionsRequestSchema, { meta: newMeta() }),
      );
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(raised).not.toBeNull();
    expect(raised!.code).toBe(Code.Internal);
  });
});

// ---------------------------------------------------------------------------
// GetSession
// ---------------------------------------------------------------------------

describe('SessionService.GetSession — handler', () => {
  it('returns the proto Session for an owned id', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const created = manager.create(createInput(), ALICE);
    const client = createClient(SessionService, makeBoundTransport(manager, ALICE));

    const resp = await client.getSession(
      create(GetSessionRequestSchema, { meta: newMeta(), sessionId: created.id }),
    );
    expect(resp.session?.id).toBe(created.id);
    expect(resp.session?.cwd).toBe('/home/alice');
    expect(resp.meta?.requestId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('rejects a peer-owned id with PermissionDenied + session.not_owned', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const bobRow = manager.create(createInput('/home/bob'), BOB);

    const client = createClient(SessionService, makeBoundTransport(manager, ALICE));
    let raised: ConnectError | null = null;
    try {
      await client.getSession(
        create(GetSessionRequestSchema, { meta: newMeta(), sessionId: bobRow.id }),
      );
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(raised).not.toBeNull();
    expect(raised!.code).toBe(Code.PermissionDenied);
    const detail = raised!.findDetails(ErrorDetailSchema)[0] as ErrorDetail | undefined;
    expect(detail?.code).toBe('session.not_owned');
  });

  it('collapses unknown session id into PermissionDenied (no enumeration leak)', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const client = createClient(SessionService, makeBoundTransport(manager, ALICE));

    let raised: ConnectError | null = null;
    try {
      await client.getSession(
        create(GetSessionRequestSchema, { meta: newMeta(), sessionId: 'no-such-id' }),
      );
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(raised).not.toBeNull();
    // Critical: NOT NotFound — the SessionManager's loadRow maps the
    // missing-row case to `session.not_owned` so a malicious caller
    // cannot probe other principals' ids by branching on the code.
    expect(raised!.code).toBe(Code.PermissionDenied);
    expect(raised!.code).not.toBe(Code.NotFound);
  });

  it('throws Code.Internal when PRINCIPAL_KEY was never deposited (wiring bug)', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const client = createClient(SessionService, makeBoundTransport(manager, null));

    let raised: ConnectError | null = null;
    try {
      await client.getSession(
        create(GetSessionRequestSchema, { meta: newMeta(), sessionId: 'whatever' }),
      );
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(raised).not.toBeNull();
    expect(raised!.code).toBe(Code.Internal);
  });
});
