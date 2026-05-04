// Unit tests for SessionService.DestroySession Connect handler
// (Wave 3 §6.9 sub-task 7 / Task #338).
//
// Covers (mirrors `read-handlers.spec.ts` layout):
//   - Sink (handler) over the in-process Connect router transport:
//       * DestroySession: returns meta-only ack and echoes
//         RequestMeta.request_id; the destroyed row is NOT in the
//         response (proto contract: `DestroySessionResponse { meta }`),
//         it is delivered via the WatchSessions stream's `destroyed`
//         event (asserted here through the SessionManager event bus).
//       * DestroySession: actually flips the row's `should_be_running`
//         to 0 and transitions state to EXITED — proves the handler
//         calls into the production `SessionManager.destroy()` (not a
//         no-op stub).
//       * DestroySession: peer's id collapses to
//         `Code.PermissionDenied + ErrorDetail.code = "session.not_owned"`
//         (single source of truth in `SessionManager.loadRow`; no
//         cross-principal id enumeration leak).
//       * DestroySession: unknown id ALSO collapses to PermissionDenied
//         (same security boundary the GetSession handler relies on).
//       * DestroySession: missing PRINCIPAL_KEY → ConnectError(Internal)
//         (defensive — proves the handler refuses to run if the auth
//         interceptor was not wired).
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
  DestroySessionRequestSchema,
  ErrorDetailSchema,
  RequestMetaSchema,
  SessionService,
  type ErrorDetail,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../../src/auth/index.js';
import { runMigrations } from '../../src/db/migrations/runner.js';
import { openDatabase, type SqliteDatabase } from '../../src/db/sqlite.js';
import { makeDestroySessionHandler } from '../../src/sessions/destroy-handler.js';
import { SessionManager } from '../../src/sessions/SessionManager.js';
import { SessionState } from '../../src/sessions/types.js';

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
        destroySession: makeDestroySessionHandler({ manager }),
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
// DestroySession
// ---------------------------------------------------------------------------

describe('SessionService.DestroySession — handler', () => {
  it('returns meta-only ack and echoes RequestMeta.request_id', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const created = manager.create(createInput(), ALICE);
    const client = createClient(SessionService, makeBoundTransport(manager, ALICE));

    const reqId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const resp = await client.destroySession(
      create(DestroySessionRequestSchema, {
        meta: newMeta(reqId),
        sessionId: created.id,
      }),
    );
    expect(resp.meta?.requestId).toBe(reqId);
    // Proto contract: DestroySessionResponse { meta } — no `session`
    // field. The destroyed row is delivered via the WatchSessions
    // stream's `destroyed` event (asserted in the next case).
    expect(Object.keys(resp).sort()).toEqual(['$typeName', 'meta']);
  });

  it('flips should_be_running=0, transitions state to EXITED, and emits destroyed bus event', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const created = manager.create(createInput(), ALICE);
    expect(created.should_be_running).toBe(1);
    expect(created.state).toBe(SessionState.STARTING);

    // Subscribe BEFORE the destroy so the bus event is observable here
    // (the handler calls `manager.destroy()` which publishes
    // `SessionEvent.destroyed` synchronously).
    const events: Array<{ kind: string; sessionId: string }> = [];
    const unsubscribe = manager.subscribe(ALICE, (ev) => {
      events.push({ kind: ev.kind, sessionId: ev.session.id });
    });

    const client = createClient(SessionService, makeBoundTransport(manager, ALICE));
    await client.destroySession(
      create(DestroySessionRequestSchema, {
        meta: newMeta(),
        sessionId: created.id,
      }),
    );
    unsubscribe();

    // Row state actually transitioned (proves the handler is wired to the
    // real manager, not a stub).
    const after = manager.get(created.id, ALICE);
    expect(after.should_be_running).toBe(0);
    expect(after.state).toBe(SessionState.EXITED);

    // The WatchSessions stream's `destroyed` event payload is the source
    // of truth for the post-destroy row (the unary response intentionally
    // omits it per the proto contract).
    const destroyed = events.find((e) => e.kind === 'destroyed');
    expect(destroyed).toBeDefined();
    expect(destroyed!.sessionId).toBe(created.id);
  });

  it('rejects a peer-owned id with PermissionDenied + session.not_owned', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const bobRow = manager.create(createInput('/home/bob'), BOB);

    const client = createClient(SessionService, makeBoundTransport(manager, ALICE));
    let raised: ConnectError | null = null;
    try {
      await client.destroySession(
        create(DestroySessionRequestSchema, {
          meta: newMeta(),
          sessionId: bobRow.id,
        }),
      );
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(raised).not.toBeNull();
    expect(raised!.code).toBe(Code.PermissionDenied);
    const detail = raised!.findDetails(ErrorDetailSchema)[0] as ErrorDetail | undefined;
    expect(detail?.code).toBe('session.not_owned');

    // Bob's row MUST be untouched — Alice's failed destroy attempt
    // cannot mutate it.
    const stillThere = manager.get(bobRow.id, BOB);
    expect(stillThere.should_be_running).toBe(1);
    expect(stillThere.state).toBe(SessionState.STARTING);
  });

  it('collapses unknown session id into PermissionDenied (no enumeration leak)', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const client = createClient(SessionService, makeBoundTransport(manager, ALICE));

    let raised: ConnectError | null = null;
    try {
      await client.destroySession(
        create(DestroySessionRequestSchema, {
          meta: newMeta(),
          sessionId: 'no-such-id',
        }),
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
      await client.destroySession(
        create(DestroySessionRequestSchema, {
          meta: newMeta(),
          sessionId: 'whatever',
        }),
      );
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(raised).not.toBeNull();
    expect(raised!.code).toBe(Code.Internal);
  });
});
