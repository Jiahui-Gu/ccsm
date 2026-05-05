// Task #473 (T8.14b-7b) — sessions/ coverage push.
//
// Unit tests for `sessions/watch-sessions.ts`:
//   - decideWatchScope (pure decider over WatchScope enum)
//   - sessionRowToProto / sessionEventToProto (mappers)
//   - subscribeAsAsyncIterable (push→pull adapter, abort, overflow,
//     return/throw iterator hooks)
//   - makeWatchSessionsHandler (Connect server-streaming handler):
//     happy path, ALL→PermissionDenied, null principal→Internal,
//     abort signal cleanup
//
// All tests run against a real SessionManager over an in-memory sqlite
// so the bus + manager interactions exercise production code paths.

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
  WatchScope,
  WatchSessionsRequestSchema,
  type ErrorDetail,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, principalKey, type Principal } from '../../auth/index.js';
import { runMigrations } from '../../db/migrations/runner.js';
import { openDatabase, type SqliteDatabase } from '../../db/sqlite.js';

import { SessionManager } from '../SessionManager.js';
import {
  DEFAULT_WATCH_BUFFER_SIZE,
  decideWatchScope,
  makeWatchSessionsHandler,
  sessionEventToProto,
  sessionRowToProto,
  subscribeAsAsyncIterable,
} from '../watch-sessions.js';
import { SessionState, type SessionEvent, type SessionRow } from '../types.js';
import type { ISessionManager } from '../SessionManager.js';
import type { Unsubscribe } from '../event-bus.js';

const ALICE: Principal = { kind: 'local-user', uid: '1000', displayName: 'Alice' };
const BOB: Principal = { kind: 'local-user', uid: '1001', displayName: 'Bob' };

let db: SqliteDatabase;
let manager: SessionManager;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  db.exec(`INSERT INTO principals (id, kind, display_name, first_seen_ms, last_seen_ms) VALUES
    ('${principalKey(ALICE)}', 'local-user', 'alice', 0, 0),
    ('${principalKey(BOB)}', 'local-user', 'bob', 0, 0);`);
  let n = 0;
  manager = new SessionManager(db, {
    now: () => 1700000000000,
    newId: () => `01J000000000000000000${String(n++).padStart(5, '0')}`,
  });
});

afterEach(() => {
  db.close();
});

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: '01J0000000000000000000XXXX',
    owner_id: 'local-user:1000',
    state: SessionState.STARTING,
    cwd: '/tmp',
    env_json: '{}',
    claude_args_json: '[]',
    geometry_cols: 80,
    geometry_rows: 24,
    exit_code: -1,
    created_ms: 100,
    last_active_ms: 100,
    should_be_running: 1,
    ...overrides,
  };
}

// ===========================================================================
// decideWatchScope
// ===========================================================================

describe('decideWatchScope', () => {
  it('UNSPECIFIED → accept', () => {
    expect(decideWatchScope(WatchScope.UNSPECIFIED)).toEqual({ kind: 'accept' });
  });

  it('OWN → accept', () => {
    expect(decideWatchScope(WatchScope.OWN)).toEqual({ kind: 'accept' });
  });

  it('ALL → reject_permission_denied', () => {
    expect(decideWatchScope(WatchScope.ALL)).toEqual({
      kind: 'reject_permission_denied',
    });
  });

  it('unknown enum value → reject_permission_denied (forward-compat default-deny)', () => {
    expect(decideWatchScope(99 as WatchScope)).toEqual({
      kind: 'reject_permission_denied',
    });
  });
});

// ===========================================================================
// sessionRowToProto / sessionEventToProto
// ===========================================================================

describe('sessionRowToProto', () => {
  it('maps row fields onto proto Session', () => {
    const proto = sessionRowToProto(
      makeRow({ id: 'PROTO-1', cwd: '/x', state: SessionState.RUNNING, created_ms: 5, last_active_ms: 10 }),
      ALICE,
    );
    expect(proto.id).toBe('PROTO-1');
    expect(proto.cwd).toBe('/x');
    expect(proto.state).toBe(SessionState.RUNNING);
    expect(proto.createdUnixMs).toBe(5n);
    expect(proto.lastActiveUnixMs).toBe(10n);
    expect(proto.owner?.kind.case).toBe('localUser');
    if (proto.owner?.kind.case === 'localUser') {
      expect(proto.owner.kind.value.uid).toBe('1000');
      expect(proto.owner.kind.value.displayName).toBe('Alice');
    }
  });

  it('exit_code = -1 sentinel → unset on the wire', () => {
    const proto = sessionRowToProto(makeRow({ exit_code: -1 }), ALICE);
    expect(proto.exitCode).toBeUndefined();
  });

  it('exit_code = 0 (graceful exit) → preserved through sentinel guard', () => {
    const proto = sessionRowToProto(makeRow({ exit_code: 0 }), ALICE);
    expect(proto.exitCode).toBe(0);
  });

  it('non-zero exit_code preserved', () => {
    const proto = sessionRowToProto(makeRow({ exit_code: 137 }), ALICE);
    expect(proto.exitCode).toBe(137);
  });
});

describe('sessionEventToProto', () => {
  it('created → proto.kind.case = "created" carrying full Session', () => {
    const ev: SessionEvent = { kind: 'created', session: makeRow({ id: 'C-1' }) };
    const proto = sessionEventToProto(ev, ALICE);
    expect(proto.kind.case).toBe('created');
    if (proto.kind.case === 'created') {
      expect(proto.kind.value.id).toBe('C-1');
    }
  });

  it('destroyed → proto.kind.case = "destroyed" carrying session_id only', () => {
    const ev: SessionEvent = { kind: 'destroyed', session: makeRow({ id: 'D-1' }) };
    const proto = sessionEventToProto(ev, ALICE);
    expect(proto.kind.case).toBe('destroyed');
    if (proto.kind.case === 'destroyed') {
      expect(proto.kind.value).toBe('D-1');
    }
  });

  it('ended (graceful) → proto.kind.case = "updated" carrying full Session', () => {
    const ev: SessionEvent = {
      kind: 'ended',
      reason: 'graceful',
      session: makeRow({ id: 'U-1', state: SessionState.EXITED, exit_code: 0 }),
    };
    const proto = sessionEventToProto(ev, ALICE);
    expect(proto.kind.case).toBe('updated');
    if (proto.kind.case === 'updated') {
      expect(proto.kind.value.id).toBe('U-1');
      expect(proto.kind.value.state).toBe(SessionState.EXITED);
    }
  });

  it('ended (crashed) → proto.kind.case = "updated"', () => {
    const ev: SessionEvent = {
      kind: 'ended',
      reason: 'crashed',
      session: makeRow({ id: 'U-2', state: SessionState.CRASHED, exit_code: 139 }),
    };
    const proto = sessionEventToProto(ev, ALICE);
    expect(proto.kind.case).toBe('updated');
  });

  it('unknown kind → throws (exhaustive check)', () => {
    expect(() =>
      sessionEventToProto({ kind: 'mystery' } as unknown as SessionEvent, ALICE),
    ).toThrow(/unhandled SessionEvent kind/);
  });
});

// ===========================================================================
// subscribeAsAsyncIterable
// ===========================================================================

describe('subscribeAsAsyncIterable', () => {
  it('exports DEFAULT_WATCH_BUFFER_SIZE = 1024', () => {
    expect(DEFAULT_WATCH_BUFFER_SIZE).toBe(1024);
  });

  it('next() resolves immediately when an event is buffered', async () => {
    const iter = subscribeAsAsyncIterable(manager, ALICE)[Symbol.asyncIterator]();
    manager.create(
      { cwd: '/x', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
      ALICE,
    );
    const r = await iter.next();
    expect(r.done).toBe(false);
    expect(r.value.kind).toBe('created');
    await iter.return?.();
  });

  it('next() awaits and resolves when an event is published later', async () => {
    const iter = subscribeAsAsyncIterable(manager, ALICE)[Symbol.asyncIterator]();
    const pending = iter.next();
    // Defer publish so the resolver is installed first.
    setImmediate(() => {
      manager.create(
        { cwd: '/y', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
        ALICE,
      );
    });
    const r = await pending;
    expect(r.done).toBe(false);
    expect(r.value.kind).toBe('created');
    await iter.return?.();
  });

  it('only delivers events for the caller principal (bus filter)', async () => {
    const iter = subscribeAsAsyncIterable(manager, ALICE)[Symbol.asyncIterator]();
    // Publish to BOB first — should NOT be observed by Alice's iterator.
    manager.create(
      { cwd: '/b', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
      BOB,
    );
    manager.create(
      { cwd: '/a', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
      ALICE,
    );
    const r = await iter.next();
    expect(r.value.session.cwd).toBe('/a'); // not '/b'
    await iter.return?.();
  });

  it('signal abort: pre-aborted signal yields done immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const iter = subscribeAsAsyncIterable(manager, ALICE, { signal: ac.signal })[
      Symbol.asyncIterator
    ]();
    const r = await iter.next();
    expect(r.done).toBe(true);
  });

  it('signal abort while awaiting next() resolves with done', async () => {
    const ac = new AbortController();
    const iter = subscribeAsAsyncIterable(manager, ALICE, { signal: ac.signal })[
      Symbol.asyncIterator
    ]();
    const pending = iter.next();
    ac.abort();
    const r = await pending;
    expect(r.done).toBe(true);
  });

  it('return() detaches subscription and resolves done', async () => {
    const iter = subscribeAsAsyncIterable(manager, ALICE)[Symbol.asyncIterator]();
    // Install a pending next() so return() can resolve it.
    const pending = iter.next();
    const r = await iter.return?.();
    expect(r?.done).toBe(true);
    // pending should also resolve done
    const p = await pending;
    expect(p.done).toBe(true);
  });

  it('return() called without a pending next() still resolves done', async () => {
    const iter = subscribeAsAsyncIterable(manager, ALICE)[Symbol.asyncIterator]();
    const r = await iter.return?.();
    expect(r?.done).toBe(true);
  });

  it('throw() rejects pending next() and detaches subscription', async () => {
    const iter = subscribeAsAsyncIterable(manager, ALICE)[Symbol.asyncIterator]();
    const pending = iter.next();
    const err = new Error('explicit-throw');
    await expect(iter.throw?.(err)).rejects.toBe(err);
    await expect(pending).rejects.toBe(err);
  });

  it('throw() with no pending next() still rethrows', async () => {
    const iter = subscribeAsAsyncIterable(manager, ALICE)[Symbol.asyncIterator]();
    const err = new Error('no-pending');
    await expect(iter.throw?.(err)).rejects.toBe(err);
  });

  it('buffer overflow → ResourceExhausted on next()', async () => {
    // Use a stub manager that gives us synchronous handle on the listener.
    let capturedListener: ((ev: SessionEvent) => void) | null = null;
    const stubManager: ISessionManager = {
      create: (() => {
        throw new Error('not used');
      }) as never,
      get: (() => {
        throw new Error('not used');
      }) as never,
      list: (() => []) as never,
      destroy: (() => {
        throw new Error('not used');
      }) as never,
      markEnded: (() => {
        throw new Error('not used');
      }) as never,
      subscribe: ((_caller: Principal, listener: (ev: SessionEvent) => void) => {
        capturedListener = listener;
        const off: Unsubscribe = () => {};
        return off;
      }) as never,
    };

    const iter = subscribeAsAsyncIterable(stubManager, ALICE, { bufferSize: 2 })[
      Symbol.asyncIterator
    ]();
    // Push 3 events synchronously without any consumer → exceeds size 2.
    const ev = { kind: 'created' as const, session: makeRow() };
    capturedListener!(ev);
    capturedListener!(ev);
    capturedListener!(ev); // overflow

    // Drain buffered events first (2 of them) then the overflow error fires.
    const r1 = await iter.next();
    expect(r1.done).toBe(false);
    const r2 = await iter.next();
    expect(r2.done).toBe(false);
    let captured: unknown = null;
    try {
      await iter.next();
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.ResourceExhausted);
  });

  it('after done=true, listener is a no-op (additional publishes ignored)', async () => {
    let capturedListener: ((ev: SessionEvent) => void) | null = null;
    const stubManager: ISessionManager = {
      create: (() => {
        throw new Error();
      }) as never,
      get: (() => {
        throw new Error();
      }) as never,
      list: (() => []) as never,
      destroy: (() => {
        throw new Error();
      }) as never,
      markEnded: (() => {
        throw new Error();
      }) as never,
      subscribe: ((_caller: Principal, listener: (ev: SessionEvent) => void) => {
        capturedListener = listener;
        return () => {};
      }) as never,
    };
    const iter = subscribeAsAsyncIterable(stubManager, ALICE)[Symbol.asyncIterator]();
    await iter.return?.();
    // Listener should ignore the publish without error.
    expect(() => capturedListener!({ kind: 'created', session: makeRow() })).not.toThrow();
  });

  it('done branch in next() returns done after return() then drained buffer', async () => {
    // Set up: subscribe → publish → drain → return → next must return done.
    const iter = subscribeAsAsyncIterable(manager, ALICE)[Symbol.asyncIterator]();
    manager.create(
      { cwd: '/x', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
      ALICE,
    );
    await iter.next(); // drain
    // Don't call return(); instead use abort to set done=true with empty buffer.
    const ac = new AbortController();
    const iter2 = subscribeAsAsyncIterable(manager, ALICE, { signal: ac.signal })[
      Symbol.asyncIterator
    ]();
    ac.abort();
    const r = await iter2.next();
    expect(r.done).toBe(true);
  });
});

// ===========================================================================
// makeWatchSessionsHandler — the Connect server-streaming handler
// ===========================================================================

function ctxWith(principal: Principal | null, signal?: AbortSignal): HandlerContext {
  const values = createContextValues();
  values.set(PRINCIPAL_KEY, principal as Principal);
  return { values, signal: signal ?? new AbortController().signal } as HandlerContext;
}

describe('makeWatchSessionsHandler', () => {
  it('null principal → ConnectError(Internal)', async () => {
    const handler = makeWatchSessionsHandler({ manager });
    const gen = handler(
      create(WatchSessionsRequestSchema, { scope: WatchScope.OWN }),
      ctxWith(null),
    )[Symbol.asyncIterator]();
    let captured: unknown = null;
    try {
      await gen.next();
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.Internal);
  });

  it('WATCH_SCOPE_ALL → ConnectError(PermissionDenied) + session.not_owned', async () => {
    const handler = makeWatchSessionsHandler({ manager });
    const gen = handler(
      create(WatchSessionsRequestSchema, { scope: WatchScope.ALL }),
      ctxWith(ALICE),
    )[Symbol.asyncIterator]();
    let captured: unknown = null;
    try {
      await gen.next();
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.PermissionDenied);
    const details = (captured as ConnectError).findDetails(ErrorDetailSchema) as ErrorDetail[];
    expect(details[0].code).toBe('session.not_owned');
  });

  it('OWN scope: yields proto SessionEvent for created session', async () => {
    const ac = new AbortController();
    const handler = makeWatchSessionsHandler({ manager });
    const gen = handler(
      create(WatchSessionsRequestSchema, { scope: WatchScope.OWN }),
      ctxWith(ALICE, ac.signal),
    )[Symbol.asyncIterator]();
    const pending = gen.next();
    setImmediate(() => {
      manager.create(
        { cwd: '/x', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
        ALICE,
      );
    });
    const r = await pending;
    expect(r.done).toBe(false);
    expect(r.value?.kind.case).toBe('created');
    ac.abort();
    // Drain to clean exit
    await gen.next().catch(() => {});
    await gen.return?.(undefined);
  });

  it('UNSPECIFIED scope is also accepted (treated as OWN)', async () => {
    const ac = new AbortController();
    const handler = makeWatchSessionsHandler({ manager });
    const gen = handler(
      create(WatchSessionsRequestSchema, { scope: WatchScope.UNSPECIFIED }),
      ctxWith(ALICE, ac.signal),
    )[Symbol.asyncIterator]();
    const pending = gen.next();
    setImmediate(() => {
      manager.create(
        { cwd: '/y', env_json: '{}', claude_args_json: '[]', geometry_cols: 80, geometry_rows: 24 },
        ALICE,
      );
    });
    const r = await pending;
    expect(r.done).toBe(false);
    ac.abort();
    await gen.return?.(undefined);
  });

  it('signal abort → handler exits cleanly', async () => {
    const ac = new AbortController();
    ac.abort(); // pre-abort
    const handler = makeWatchSessionsHandler({ manager });
    const gen = handler(
      create(WatchSessionsRequestSchema, { scope: WatchScope.OWN }),
      ctxWith(ALICE, ac.signal),
    )[Symbol.asyncIterator]();
    const r = await gen.next();
    expect(r.done).toBe(true);
  });
});
