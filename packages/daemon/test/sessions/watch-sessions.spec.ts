// Unit tests for SessionService.WatchSessions handler (T3.3 / Task #34).
//
// Covers:
//   - Decider (`decideWatchScope`): UNSPECIFIED / OWN → accept;
//     ALL → reject_permission_denied; unknown enum value → reject (forward
//     compat conservative default).
//   - Producer (`subscribeAsAsyncIterable`): bus events arrive via the
//     iterator; abort signal terminates cleanly; buffer overflow surfaces
//     as ConnectError(ResourceExhausted).
//   - Sink (handler) over the in-process Connect router transport:
//       * happy path — OWN scope yields proto SessionEvent for created
//         + destroyed events, scoped to the caller's principal (peer
//         principal cannot see them);
//       * permission denied — ALL scope throws
//         ConnectError(PermissionDenied) with ErrorDetail.code =
//         "session.not_owned" (T2.5 single source of truth);
//       * UNSPECIFIED defaults to OWN.
//
// Spec refs:
//   - ch04 §3 (WatchScope enum); ch05 §5 (per-RPC enforcement matrix).
//   - T2.5 / PR #926 (`throwError('session.not_owned', ...)`).
//   - T3.2 / PR #933 (SessionManager + SessionEventBus).
//
// SRP layering mirrored in the spec layout: separate describe blocks for
// the decider (pure), producer (no Connect plumbing), and sink (full
// in-process router transport).

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
  RequestMetaSchema,
  SessionService,
  SessionState as ProtoSessionState,
  WatchScope,
  WatchSessionsRequestSchema,
  type ErrorDetail,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../../src/auth/index.js';
import { openDatabase, type SqliteDatabase } from '../../src/db/sqlite.js';
import { runMigrations } from '../../src/db/migrations/runner.js';
import { SessionManager } from '../../src/sessions/SessionManager.js';
import { SessionState, type SessionRow } from '../../src/sessions/types.js';
import {
  DEFAULT_WATCH_BUFFER_SIZE,
  decideWatchScope,
  makeWatchSessionsHandler,
  sessionEventToProto,
  sessionRowToProto,
  subscribeAsAsyncIterable,
} from '../../src/sessions/watch-sessions.js';

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

function createInput() {
  return {
    cwd: '/home/alice',
    env_json: '{}',
    claude_args_json: '[]',
    geometry_cols: 80,
    geometry_rows: 24,
  };
}

// ---------------------------------------------------------------------------
// Decider
// ---------------------------------------------------------------------------

describe('decideWatchScope — pure decider', () => {
  it('accepts WATCH_SCOPE_UNSPECIFIED (treated as OWN per session.proto)', () => {
    expect(decideWatchScope(WatchScope.UNSPECIFIED)).toEqual({ kind: 'accept' });
  });

  it('accepts WATCH_SCOPE_OWN', () => {
    expect(decideWatchScope(WatchScope.OWN)).toEqual({ kind: 'accept' });
  });

  it('rejects WATCH_SCOPE_ALL with reject_permission_denied', () => {
    expect(decideWatchScope(WatchScope.ALL)).toEqual({
      kind: 'reject_permission_denied',
    });
  });

  it('rejects unknown enum values (forward-compat conservative default)', () => {
    // Cast a numeric value the v0.3 enum does not know about — simulates
    // a v0.4+ client speaking a higher proto_version that adds enum
    // entries the v0.3 daemon has not seen.
    expect(decideWatchScope(99 as WatchScope)).toEqual({
      kind: 'reject_permission_denied',
    });
  });
});

// ---------------------------------------------------------------------------
// Row → proto mapper
// ---------------------------------------------------------------------------

describe('sessionRowToProto / sessionEventToProto', () => {
  function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
    return {
      id: 'sess-001',
      owner_id: 'local-user:1000',
      state: SessionState.STARTING,
      cwd: '/home/alice',
      env_json: '{}',
      claude_args_json: '[]',
      geometry_cols: 80,
      geometry_rows: 24,
      exit_code: -1,
      created_ms: 1_700_000_000_000,
      last_active_ms: 1_700_000_000_500,
      should_be_running: 1,
      ...overrides,
    };
  }

  it('renders the LocalUser owner from the watching principal', () => {
    const proto = sessionRowToProto(makeRow(), ALICE);
    expect(proto.id).toBe('sess-001');
    expect(proto.cwd).toBe('/home/alice');
    expect(proto.state).toBe(ProtoSessionState.STARTING);
    expect(proto.createdUnixMs).toBe(1_700_000_000_000n);
    expect(proto.lastActiveUnixMs).toBe(1_700_000_000_500n);
    expect(proto.owner?.kind?.case).toBe('localUser');
    if (proto.owner?.kind?.case !== 'localUser') return;
    expect(proto.owner.kind.value.uid).toBe('1000');
    expect(proto.owner.kind.value.displayName).toBe('alice');
  });

  it('omits exit_code when the row carries the -1 sentinel', () => {
    const proto = sessionRowToProto(makeRow({ exit_code: -1 }), ALICE);
    expect(proto.exitCode).toBeUndefined();
  });

  it('preserves a real exit_code (including 0) through the mapper', () => {
    const proto = sessionRowToProto(
      makeRow({ exit_code: 0, state: SessionState.EXITED }),
      ALICE,
    );
    expect(proto.exitCode).toBe(0);
    expect(proto.state).toBe(ProtoSessionState.EXITED);
  });

  it('renders a "created" SessionEvent with the full proto Session', () => {
    const ev = sessionEventToProto({ kind: 'created', session: makeRow() }, ALICE);
    expect(ev.kind.case).toBe('created');
    if (ev.kind.case !== 'created') return;
    expect(ev.kind.value.id).toBe('sess-001');
  });

  it('renders a "destroyed" SessionEvent carrying just the id string', () => {
    const ev = sessionEventToProto(
      { kind: 'destroyed', session: makeRow({ state: SessionState.EXITED }) },
      ALICE,
    );
    expect(ev.kind.case).toBe('destroyed');
    if (ev.kind.case !== 'destroyed') return;
    expect(ev.kind.value).toBe('sess-001');
  });

  it('renders an "ended" SessionEvent as the proto "updated" oneof case carrying the full row (T4.4)', () => {
    const row = makeRow({
      state: SessionState.CRASHED,
      should_be_running: 0,
      exit_code: 137,
    });
    const ev = sessionEventToProto({ kind: 'ended', session: row, reason: 'crashed' }, ALICE);
    expect(ev.kind.case).toBe('updated');
    if (ev.kind.case !== 'updated') return;
    expect(ev.kind.value.id).toBe('sess-001');
    expect(ev.kind.value.state).toBe(ProtoSessionState.CRASHED);
    expect(ev.kind.value.exitCode).toBe(137);
  });
});

// ---------------------------------------------------------------------------
// Producer — bus → AsyncIterable adapter
// ---------------------------------------------------------------------------

describe('subscribeAsAsyncIterable — producer adapter', () => {
  it('delivers events published after subscribe to the iterator', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);

    const iter = subscribeAsAsyncIterable(manager, ALICE);
    const it = iter[Symbol.asyncIterator]();

    const created = manager.create(createInput(), ALICE);
    const next = await it.next();
    expect(next.done).toBe(false);
    expect(next.value.kind).toBe('created');
    expect(next.value.session.id).toBe(created.id);

    // Cleanly tear down so the unsubscribe path runs (otherwise the
    // SessionManager retains the listener).
    await it.return?.(undefined);
  });

  it('does NOT deliver events for sessions owned by a different principal', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);

    const iter = subscribeAsAsyncIterable(manager, ALICE);
    const it = iter[Symbol.asyncIterator]();

    // Bob creates — alice is subscribed and MUST NOT see it (the bus's
    // principalKey filter is the security boundary).
    manager.create(createInput(), BOB);

    // Race the iterator against a short timeout: if alice received bob's
    // event, `it.next()` resolves first; otherwise the timeout wins.
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 30),
    );
    const winner = await Promise.race([it.next().then(() => 'next' as const), timeout]);
    expect(winner).toBe('timeout');

    await it.return?.(undefined);
  });

  it('terminates the iterator when the AbortSignal fires', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const ctrl = new AbortController();

    const iter = subscribeAsAsyncIterable(manager, ALICE, { signal: ctrl.signal });
    const it = iter[Symbol.asyncIterator]();

    const pending = it.next();
    ctrl.abort();
    const result = await pending;
    expect(result.done).toBe(true);
    // Bus should have removed the listener.
    expect(manager.eventBus.listenerCount('local-user:1000')).toBe(0);
  });

  it('exposes a reasonable default buffer size', () => {
    expect(DEFAULT_WATCH_BUFFER_SIZE).toBeGreaterThanOrEqual(64);
  });

  it('throws ConnectError(ResourceExhausted) when the buffer overflows', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);

    // Tiny buffer to exercise overflow without queuing 1024+ events.
    const iter = subscribeAsAsyncIterable(manager, ALICE, { bufferSize: 2 });
    const it = iter[Symbol.asyncIterator]();

    // Publish 3 events (buffer holds 2) WITHOUT a pending consumer — the
    // 3rd push records the overflow error.
    manager.create(createInput(), ALICE);
    manager.create(createInput(), ALICE);
    manager.create(createInput(), ALICE);

    // First two events drain normally...
    expect((await it.next()).value.kind).toBe('created');
    expect((await it.next()).value.kind).toBe('created');
    // ...the third surfaces the overflow as a terminal ConnectError.
    let captured: unknown = null;
    try {
      await it.next();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.ResourceExhausted);
  });
});

// ---------------------------------------------------------------------------
// Sink — Connect handler over the in-process router transport
// ---------------------------------------------------------------------------

function makeBoundTransport(
  manager: SessionManager,
  principal: AuthPrincipal | null = ALICE,
) {
  return createRouterTransport(
    (router) => {
      router.service(SessionService, {
        watchSessions: makeWatchSessionsHandler({ manager }),
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

function newRequest(scope: WatchScope) {
  return create(WatchSessionsRequestSchema, {
    meta: create(RequestMetaSchema, {
      requestId: '11111111-2222-3333-4444-555555555555',
      clientVersion: '0.3.0-test',
      clientSendUnixMs: 0n,
    }),
    scope,
  });
}

describe('SessionService.WatchSessions — in-process router transport', () => {
  it('OWN scope: yields proto SessionEvent for created + destroyed events', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const transport = makeBoundTransport(manager);
    const client = createClient(SessionService, transport);

    const stream = client.watchSessions(newRequest(WatchScope.OWN));

    // Drive the manager AFTER the stream subscription is in place.
    // setTimeout(0) gives the Connect router enough event-loop turns to
    // construct the handler's async generator and reach its first
    // `next()` (which is when subscribeAsAsyncIterable installs the bus
    // listener). A pure microtask (Promise.resolve().then) is too eager
    // — it fires before the handler runs.
    setTimeout(() => {
      const created = manager.create(createInput(), ALICE);
      manager.destroy(created.id, ALICE);
    }, 10);

    const collected: string[] = [];
    for await (const ev of stream) {
      collected.push(ev.kind.case ?? '');
      if (collected.length === 2) break; // close the iterator (calls return())
    }

    expect(collected).toEqual(['created', 'destroyed']);
  });

  it('UNSPECIFIED scope defaults to OWN', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const transport = makeBoundTransport(manager);
    const client = createClient(SessionService, transport);

    const stream = client.watchSessions(newRequest(WatchScope.UNSPECIFIED));
    setTimeout(() => {
      manager.create(createInput(), ALICE);
    }, 10);

    let firstKind: string | undefined;
    for await (const ev of stream) {
      firstKind = ev.kind.case;
      break;
    }
    expect(firstKind).toBe('created');
  });

  it('does NOT leak events from a different principal (security boundary)', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const transport = makeBoundTransport(manager, ALICE);
    const client = createClient(SessionService, transport);

    const stream = client.watchSessions(newRequest(WatchScope.OWN));

    // Bob creates; alice's stream MUST stay silent.
    setTimeout(() => {
      manager.create(createInput(), BOB);
    }, 10);

    const it = stream[Symbol.asyncIterator]();
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 30),
    );
    const winner = await Promise.race([
      it.next().then(() => 'event' as const),
      timeout,
    ]);
    expect(winner).toBe('timeout');
    await it.return?.(undefined);
  });

  it('ALL scope: throws ConnectError(PermissionDenied) + ErrorDetail "session.not_owned"', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const transport = makeBoundTransport(manager);
    const client = createClient(SessionService, transport);

    const stream = client.watchSessions(newRequest(WatchScope.ALL));
    let captured: unknown = null;
    try {
      for await (const _ev of stream) {
        void _ev;
      }
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(ConnectError);
    const ce = captured as ConnectError;
    expect(ce.code).toBe(Code.PermissionDenied);

    const details = ce.findDetails(ErrorDetailSchema) as ErrorDetail[];
    expect(details.length).toBeGreaterThanOrEqual(1);
    expect(details[0].code).toBe('session.not_owned');
    expect(details[0].extra.requested_scope).toBe('ALL');
  });

  it('returns Internal when PRINCIPAL_KEY is null (defensive wiring check)', async () => {
    const db = freshDb();
    const manager = new SessionManager(db);
    const transport = makeBoundTransport(manager, null);
    const client = createClient(SessionService, transport);

    const stream = client.watchSessions(newRequest(WatchScope.OWN));
    let captured: unknown = null;
    try {
      for await (const _ev of stream) {
        void _ev;
      }
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.Internal);
  });
});
