// Unit tests for SessionService.CreateSession Connect handler
// (Task #438 — sessions/ coverage push, wave 2 / restore-persistence-hooks).
//
// Wave-2 scope per task #438:
//   - target the only sessions/*.ts source file still missing a co-located
//     spec at the time of writing (`create-handler.ts`); siblings already
//     covered by `destroy-handler.spec.ts` (#338), `read-handlers.spec.ts`
//     (#337), `event-bus.spec.ts` + `watch-sessions.spec.ts` (T3.2/T3.3),
//     and `SessionManager.spec.ts` (#38).
//   - SessionManager core itself is intentionally OUT OF SCOPE (Task #439).
//
// Layout mirrors `destroy-handler.spec.ts` so the suite reads as a uniform
// CRUD story across all four handlers (Create/Get/List/Destroy + Watch).
//
// Coverage goals:
//   - Decider (`decodeCreateRequest`): pure proto -> CreateSessionInput
//     mapping. Exercised without a Connect transport so the encoding
//     contract (sorted env keys, deterministic JSON, geometry defaults
//     for missing AND zero-dimension) is pinned independently of the
//     handler wiring.
//   - Sink (`makeCreateSessionHandler`): the in-process Connect router
//     transport with a stubbed `peerCredAuthInterceptor` (deposits a
//     synthetic principal). Asserts:
//       * happy path INSERTs a row (proves wired to real SessionManager,
//         not a stub) AND echoes RequestMeta.request_id.
//       * a `created` SessionEvent is published on the in-memory bus
//         (the WatchSessions stream's source for parallel watchers).
//       * the optional Task #359 `attachPtyHost` hook is called AFTER
//         the row INSERT (the row argument carries the freshly-INSERTed
//         id so the pty-host child has something to markEnded against).
//       * missing PRINCIPAL_KEY → ConnectError(Internal) — defensive
//         posture matching destroy-handler's wiring check.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
} from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';

import {
  CreateSessionRequestSchema,
  RequestMetaSchema,
  SessionService,
} from '@ccsm/proto';
import { PtyGeometrySchema } from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../../src/auth/index.js';
import { runMigrations } from '../../src/db/migrations/runner.js';
import { openDatabase, type SqliteDatabase } from '../../src/db/sqlite.js';
import {
  DEFAULT_GEOMETRY_COLS,
  DEFAULT_GEOMETRY_ROWS,
  decodeCreateRequest,
  makeCreateSessionHandler,
} from '../../src/sessions/create-handler.js';
import { SessionManager } from '../../src/sessions/SessionManager.js';
import { SessionState, type SessionRow } from '../../src/sessions/types.js';

const ALICE: AuthPrincipal = { kind: 'local-user', uid: '1000', displayName: 'alice' };

function freshDb(): SqliteDatabase {
  const db = openDatabase(':memory:');
  runMigrations(db);
  // sessions.owner_id has an FK to principals(id) — see sibling specs.
  db.prepare(
    `INSERT INTO principals (id, kind, display_name, first_seen_ms, last_seen_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('local-user:1000', 'local-user', 'alice', 1, 1);
  return db;
}

function newMeta(requestId = '11111111-2222-3333-4444-555555555555') {
  return create(RequestMetaSchema, {
    requestId,
    clientVersion: '0.3.0-test',
    clientSendUnixMs: 0n,
  });
}

function makeBoundTransport(
  manager: SessionManager,
  principal: AuthPrincipal | null = ALICE,
  attachPtyHost?: (row: SessionRow, p: AuthPrincipal) => void,
) {
  return createRouterTransport(
    (router) => {
      router.service(SessionService, {
        createSession: makeCreateSessionHandler({ manager, attachPtyHost }),
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

// ---------------------------------------------------------------------------
// Decider — decodeCreateRequest
// ---------------------------------------------------------------------------

describe('decodeCreateRequest — pure decider', () => {
  it('sorts env keys deterministically and renders JSON arrays for claude_args', () => {
    // Insertion order intentionally NOT sorted — proto3 map<> iteration
    // order is unspecified, so the decoder MUST sort before stringify so
    // the SQLite TEXT column round-trips to byte-identical bytes across
    // boots (helpful for crash/reboot row-equality checks per source comment).
    const req = create(CreateSessionRequestSchema, {
      cwd: '/home/alice',
      env: { ZED: 'z', ALPHA: 'a', MIDDLE: 'm' },
      claudeArgs: ['--model', 'claude-3-opus', '--print'],
      initialGeometry: create(PtyGeometrySchema, { cols: 120, rows: 40 }),
    });

    const input = decodeCreateRequest(req);

    expect(input.cwd).toBe('/home/alice');
    // Sorted keys; the JSON output is stable across re-encodes.
    expect(input.env_json).toBe('{"ALPHA":"a","MIDDLE":"m","ZED":"z"}');
    // Order of claude_args is preserved (argv positional semantics).
    expect(input.claude_args_json).toBe('["--model","claude-3-opus","--print"]');
    expect(input.geometry_cols).toBe(120);
    expect(input.geometry_rows).toBe(40);
  });

  it('falls back to the 80x24 default when initial_geometry is omitted', () => {
    const req = create(CreateSessionRequestSchema, {
      cwd: '/tmp',
      env: {},
      claudeArgs: [],
      // initialGeometry intentionally unset.
    });

    const input = decodeCreateRequest(req);
    expect(input.geometry_cols).toBe(DEFAULT_GEOMETRY_COLS);
    expect(input.geometry_rows).toBe(DEFAULT_GEOMETRY_ROWS);
    expect(DEFAULT_GEOMETRY_COLS).toBe(80);
    expect(DEFAULT_GEOMETRY_ROWS).toBe(24);
    // Empty maps/arrays serialise to the canonical empty literals.
    expect(input.env_json).toBe('{}');
    expect(input.claude_args_json).toBe('[]');
  });

  it('treats zero-dimension geometry as "use a sane default" (per source comment)', () => {
    // Source: a 0-dimension PTY would crash xterm-headless on first paint,
    // so the decoder treats `0` as "I don't care, use default" rather than
    // forwarding the zero. Pin BOTH dimensions independently so a future
    // refactor cannot regress one without the other.
    const colsZero = decodeCreateRequest(
      create(CreateSessionRequestSchema, {
        cwd: '/tmp',
        env: {},
        claudeArgs: [],
        initialGeometry: create(PtyGeometrySchema, { cols: 0, rows: 50 }),
      }),
    );
    expect(colsZero.geometry_cols).toBe(DEFAULT_GEOMETRY_COLS);
    expect(colsZero.geometry_rows).toBe(50);

    const rowsZero = decodeCreateRequest(
      create(CreateSessionRequestSchema, {
        cwd: '/tmp',
        env: {},
        claudeArgs: [],
        initialGeometry: create(PtyGeometrySchema, { cols: 200, rows: 0 }),
      }),
    );
    expect(rowsZero.geometry_cols).toBe(200);
    expect(rowsZero.geometry_rows).toBe(DEFAULT_GEOMETRY_ROWS);
  });
});

// ---------------------------------------------------------------------------
// Sink — makeCreateSessionHandler over the in-process router transport
// ---------------------------------------------------------------------------

describe('SessionService.CreateSession — handler', () => {
  it('INSERTs a row in STARTING state and echoes RequestMeta.request_id', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const client = createClient(SessionService, makeBoundTransport(manager, ALICE));

    const reqId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const resp = await client.createSession(
      create(CreateSessionRequestSchema, {
        meta: newMeta(reqId),
        cwd: '/home/alice',
        env: { FOO: 'bar' },
        claudeArgs: ['--print'],
        initialGeometry: create(PtyGeometrySchema, { cols: 100, rows: 30 }),
      }),
    );

    expect(resp.meta?.requestId).toBe(reqId);
    expect(resp.session).toBeDefined();
    expect(resp.session!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID shape
    expect(resp.session!.cwd).toBe('/home/alice');
    // proto Session.state mirrors the int enum value (STARTING = 1).
    expect(resp.session!.state as unknown as number).toBe(SessionState.STARTING);

    // Row was actually persisted (proves wired to real SessionManager).
    const persisted = manager.get(resp.session!.id, ALICE);
    expect(persisted.cwd).toBe('/home/alice');
    expect(persisted.state).toBe(SessionState.STARTING);
    expect(persisted.should_be_running).toBe(1);
  });

  it('publishes a SessionEvent.created on the in-memory bus (WatchSessions source)', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);

    // Subscribe BEFORE Create so the event is observable here. The
    // SessionManager publishes synchronously inside `create`.
    const events: Array<{ kind: string; sessionId: string }> = [];
    const unsubscribe = manager.subscribe(ALICE, (ev) => {
      events.push({ kind: ev.kind, sessionId: ev.session.id });
    });

    const client = createClient(SessionService, makeBoundTransport(manager, ALICE));
    const resp = await client.createSession(
      create(CreateSessionRequestSchema, {
        meta: newMeta(),
        cwd: '/home/alice',
        env: {},
        claudeArgs: [],
      }),
    );
    unsubscribe();

    const created = events.find((e) => e.kind === 'created');
    expect(created).toBeDefined();
    expect(created!.sessionId).toBe(resp.session!.id);
  });

  it('invokes the optional attachPtyHost hook AFTER the row INSERT (Task #359 wiring)', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    // Capture the row argument the hook receives + whether the row is
    // already queryable through the manager (i.e. INSERT happened first).
    const hookCalls: Array<{
      rowId: string;
      principalUid: string;
      rowFoundInManager: boolean;
    }> = [];
    const attachPtyHost = (row: SessionRow, p: AuthPrincipal): void => {
      let found = false;
      try {
        manager.get(row.id, p);
        found = true;
      } catch {
        // INSERT hadn't happened yet — would be a wiring bug.
      }
      hookCalls.push({
        rowId: row.id,
        principalUid: p.uid,
        rowFoundInManager: found,
      });
    };

    const client = createClient(
      SessionService,
      makeBoundTransport(manager, ALICE, attachPtyHost),
    );
    const resp = await client.createSession(
      create(CreateSessionRequestSchema, {
        meta: newMeta(),
        cwd: '/home/alice',
        env: {},
        claudeArgs: [],
      }),
    );

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0].rowId).toBe(resp.session!.id);
    expect(hookCalls[0].principalUid).toBe(ALICE.uid);
    // Critical: the hook fires AFTER INSERT so the per-session pty-host
    // child has a row to markEnded against on exit (source jsdoc).
    expect(hookCalls[0].rowFoundInManager).toBe(true);
  });

  it('keeps pre-#359 row-only behavior when attachPtyHost is omitted', async () => {
    // No `attachPtyHost` dep — the handler must still complete the
    // CRUD path without calling any pty-host code (existing test
    // fixtures and unit-test workflows depend on this).
    const db = freshDb();
    const manager = new SessionManager(db);
    const client = createClient(SessionService, makeBoundTransport(manager, ALICE));

    const resp = await client.createSession(
      create(CreateSessionRequestSchema, {
        meta: newMeta(),
        cwd: '/home/alice',
        env: {},
        claudeArgs: [],
      }),
    );

    expect(resp.session?.id).toBeDefined();
    // Row is persisted regardless of pty-host hook absence.
    const persisted = manager.get(resp.session!.id, ALICE);
    expect(persisted.id).toBe(resp.session!.id);
  });

  it('throws Code.Internal when PRINCIPAL_KEY was never deposited (wiring bug)', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const client = createClient(SessionService, makeBoundTransport(manager, null));

    let raised: ConnectError | null = null;
    try {
      await client.createSession(
        create(CreateSessionRequestSchema, {
          meta: newMeta(),
          cwd: '/tmp',
          env: {},
          claudeArgs: [],
        }),
      );
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(raised).not.toBeNull();
    // Defensive posture mirrors destroy-handler / read-handlers: a
    // missing principal is a daemon wiring bug, NOT a client error.
    expect(raised!.code).toBe(Code.Internal);
  });
});
