// Task #473 (T8.14b-7b) — sessions/ coverage push.
//
// Unit tests for `sessions/SessionManager.ts`. Uses a real in-memory
// better-sqlite3 instance (`openDatabase(':memory:')` + runMigrations)
// so the manager runs against the actual `sessions` table schema —
// faster than mocking the prepared-statement surface and exercises the
// real FK + NOT NULL constraints.
//
// Coverage:
//   - newSessionId(): 26-char Crockford-base32 shape, time-encoded
//     prefix is lexicographically sortable, range guard (negative /
//     >2^48-1) throws RangeError
//   - encodeBase32 (via newSessionId / buildSessionRow round-trips)
//   - buildSessionRow(): pure shape; defaults per spec ch05 §6
//   - SessionManager.create: INSERTs row, publishes 'created' event
//   - SessionManager.get: returns row when owned; throws session.not_owned
//     when missing; throws session.not_owned when foreign-owned
//   - SessionManager.list: filters by owner_id, ORDER BY created_ms ASC
//   - SessionManager.destroy: flips state→EXITED + should_be_running=0;
//     emits 'destroyed' event
//   - SessionManager.markEnded: graceful→EXITED, crashed→CRASHED;
//     null exit_code → -1; idempotent on repeat call (no event); throws
//     for unknown id
//   - SessionManager.subscribe: scoped via principalKey(caller)
//   - eventBus getter: returns the underlying bus

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';

import { ErrorDetailSchema, type ErrorDetail } from '@ccsm/proto';

import { principalKey, type Principal } from '../../auth/principal.js';
import { runMigrations } from '../../db/migrations/runner.js';
import { openDatabase, type SqliteDatabase } from '../../db/sqlite.js';

import { SessionEventBus } from '../event-bus.js';
import {
  SessionManager,
  buildSessionRow,
  newSessionId,
} from '../SessionManager.js';
import { SessionState, type SessionEvent } from '../types.js';

const ALICE: Principal = { kind: 'local-user', uid: '1000', displayName: 'alice' };
const BOB: Principal = { kind: 'local-user', uid: '1001', displayName: 'bob' };

let db: SqliteDatabase;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  db.exec(`INSERT INTO principals (id, kind, display_name, first_seen_ms, last_seen_ms) VALUES
    ('${principalKey(ALICE)}', 'local-user', 'alice', 0, 0),
    ('${principalKey(BOB)}', 'local-user', 'bob', 0, 0);`);
});

afterEach(() => {
  db.close();
});

function makeManager(opts: { now?: () => number; ids?: string[] } = {}) {
  const ids = opts.ids ? [...opts.ids] : null;
  return new SessionManager(db, {
    now: opts.now,
    newId: ids ? () => ids.shift() ?? newSessionId(opts.now ?? Date.now) : undefined,
  });
}

const INPUT = {
  cwd: '/tmp',
  env_json: '{}',
  claude_args_json: '[]',
  geometry_cols: 80,
  geometry_rows: 24,
} as const;

// ---------------------------------------------------------------------------
// id generator
// ---------------------------------------------------------------------------

describe('newSessionId', () => {
  it('produces 26 Crockford-base32 chars', () => {
    const id = newSessionId(() => 1700000000000);
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('time-prefix is lexicographically sortable', () => {
    const a = newSessionId(() => 1000);
    const b = newSessionId(() => 2000);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  it('throws on negative ms (encodeTime range guard)', () => {
    expect(() => newSessionId(() => -1)).toThrow(RangeError);
  });

  it('throws on > 2^48-1 ms (encodeTime range guard)', () => {
    expect(() => newSessionId(() => 0x1_0000_0000_0000)).toThrow(RangeError);
  });

  it('throws on non-integer ms', () => {
    expect(() => newSessionId(() => 1.5)).toThrow(RangeError);
  });

  it('default now uses Date.now', () => {
    // Just confirm the no-arg form returns a parseable id; do not pin
    // the actual timestamp because it depends on real wall clock.
    const id = newSessionId();
    expect(id).toHaveLength(26);
  });
});

// ---------------------------------------------------------------------------
// buildSessionRow — pure
// ---------------------------------------------------------------------------

describe('buildSessionRow', () => {
  it('produces row with spec defaults (state=STARTING, exit_code=-1, should_be_running=1)', () => {
    const row = buildSessionRow(INPUT, ALICE, 'id-1', 1234);
    expect(row).toEqual({
      id: 'id-1',
      owner_id: 'local-user:1000',
      state: SessionState.STARTING,
      cwd: '/tmp',
      env_json: '{}',
      claude_args_json: '[]',
      geometry_cols: 80,
      geometry_rows: 24,
      exit_code: -1,
      created_ms: 1234,
      last_active_ms: 1234,
      should_be_running: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

describe('SessionManager.create', () => {
  it('INSERTs row and emits created event', () => {
    const m = makeManager({ now: () => 100, ids: ['ID-A'] });
    const events: SessionEvent[] = [];
    m.subscribe(ALICE, (ev) => events.push(ev));

    const row = m.create(INPUT, ALICE);
    expect(row.id).toBe('ID-A');
    expect(row.owner_id).toBe('local-user:1000');
    expect(row.state).toBe(SessionState.STARTING);
    expect(row.created_ms).toBe(100);

    // Persisted in SQLite
    const persisted = db.prepare('SELECT id, owner_id, state FROM sessions WHERE id = ?').get('ID-A');
    expect(persisted).toEqual({ id: 'ID-A', owner_id: 'local-user:1000', state: SessionState.STARTING });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'created', session: row });
  });

  it('uses default now/newId when options omitted', () => {
    const m = new SessionManager(db);
    const row = m.create(INPUT, ALICE);
    expect(row.id).toHaveLength(26);
    expect(row.created_ms).toBeGreaterThan(0);
  });

  it('accepts an injected eventBus and publishes through it', () => {
    const bus = new SessionEventBus();
    const fn = vi.fn();
    bus.subscribe('local-user:1000', fn);
    const m = new SessionManager(db, { eventBus: bus, ids: ['X'] } as never);
    // The above options shape isn't typed for `ids`; use the explicit
    // newId override path instead.
    const m2 = new SessionManager(db, {
      eventBus: bus,
      newId: () => 'EVTBUS-1',
      now: () => 1,
    });
    m2.create(INPUT, ALICE);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(m.eventBus).toBe(bus); // getter exposes the same instance
  });
});

describe('SessionManager.get', () => {
  it('returns row when caller owns it', () => {
    const m = makeManager({ now: () => 100, ids: ['G-1'] });
    m.create(INPUT, ALICE);
    const row = m.get('G-1', ALICE);
    expect(row.id).toBe('G-1');
  });

  it('throws session.not_owned (PermissionDenied) when row missing', () => {
    const m = makeManager();
    let captured: unknown = null;
    try {
      m.get('does-not-exist', ALICE);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.PermissionDenied);
    const details = (captured as ConnectError).findDetails(ErrorDetailSchema) as ErrorDetail[];
    expect(details[0].code).toBe('session.not_owned');
  });

  it('throws session.not_owned when row owned by another principal', () => {
    const m = makeManager({ ids: ['ALICE-OWNED'] });
    m.create(INPUT, ALICE);
    let captured: unknown = null;
    try {
      m.get('ALICE-OWNED', BOB);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.PermissionDenied);
  });
});

describe('SessionManager.list', () => {
  it('returns only the caller-owned rows, ordered by created_ms ASC', () => {
    let t = 100;
    const m = makeManager({ now: () => t, ids: ['A1', 'B1', 'A2'] });
    m.create(INPUT, ALICE);
    t = 200;
    m.create(INPUT, BOB);
    t = 300;
    m.create(INPUT, ALICE);

    const aliceRows = m.list(ALICE);
    expect(aliceRows.map((r) => r.id)).toEqual(['A1', 'A2']);
    const bobRows = m.list(BOB);
    expect(bobRows.map((r) => r.id)).toEqual(['B1']);
  });

  it('returns empty array for principal with no rows', () => {
    const m = makeManager();
    expect(m.list(ALICE)).toEqual([]);
  });
});

describe('SessionManager.destroy', () => {
  it('flips state→EXITED + should_be_running=0 and emits destroyed event', () => {
    const m = makeManager({ now: () => 500, ids: ['D-1'] });
    m.create(INPUT, ALICE);

    const events: SessionEvent[] = [];
    m.subscribe(ALICE, (ev) => events.push(ev));

    const destroyed = m.destroy('D-1', ALICE);
    expect(destroyed.state).toBe(SessionState.EXITED);
    expect(destroyed.should_be_running).toBe(0);
    expect(destroyed.last_active_ms).toBe(500);

    const persisted = db.prepare('SELECT state, should_be_running FROM sessions WHERE id = ?').get('D-1');
    expect(persisted).toEqual({ state: SessionState.EXITED, should_be_running: 0 });

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('destroyed');
  });

  it('throws session.not_owned if caller does not own the row', () => {
    const m = makeManager({ ids: ['DOWNED'] });
    m.create(INPUT, ALICE);
    expect(() => m.destroy('DOWNED', BOB)).toThrow(ConnectError);
  });
});

describe('SessionManager.markEnded', () => {
  it('graceful → state EXITED, exit_code preserved, should_be_running=0', () => {
    const m = makeManager({ now: () => 700, ids: ['E-G'] });
    m.create(INPUT, ALICE);

    const events: SessionEvent[] = [];
    m.subscribe(ALICE, (ev) => events.push(ev));

    const ended = m.markEnded('E-G', { reason: 'graceful', exit_code: 0 });
    expect(ended.state).toBe(SessionState.EXITED);
    expect(ended.exit_code).toBe(0);
    expect(ended.should_be_running).toBe(0);
    expect(ended.last_active_ms).toBe(700);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('ended');
    if (events[0].kind === 'ended') {
      expect(events[0].reason).toBe('graceful');
    }
  });

  it('crashed → state CRASHED', () => {
    const m = makeManager({ ids: ['E-C'] });
    m.create(INPUT, ALICE);
    const ended = m.markEnded('E-C', { reason: 'crashed', exit_code: 137 });
    expect(ended.state).toBe(SessionState.CRASHED);
    expect(ended.exit_code).toBe(137);
  });

  it('null exit_code → persisted as -1 sentinel', () => {
    const m = makeManager({ ids: ['E-N'] });
    m.create(INPUT, ALICE);
    const ended = m.markEnded('E-N', { reason: 'graceful', exit_code: null });
    expect(ended.exit_code).toBe(-1);
  });

  it('idempotent: second call with same terminal state returns without re-emitting', () => {
    const m = makeManager({ ids: ['E-IDEMP'] });
    m.create(INPUT, ALICE);

    m.markEnded('E-IDEMP', { reason: 'graceful', exit_code: 0 });

    const events: SessionEvent[] = [];
    m.subscribe(ALICE, (ev) => events.push(ev));

    const second = m.markEnded('E-IDEMP', { reason: 'graceful', exit_code: 0 });
    expect(second.state).toBe(SessionState.EXITED);
    expect(events).toHaveLength(0); // no re-emit
  });

  it('throws Error (NOT ConnectError) for unknown id', () => {
    const m = makeManager();
    expect(() => m.markEnded('nope', { reason: 'graceful', exit_code: 0 })).toThrow(/no row/);
  });
});

describe('SessionManager.subscribe', () => {
  it('only delivers events for the caller principal', () => {
    const m = makeManager({ ids: ['S-1', 'S-2'] });
    const aliceEvents: SessionEvent[] = [];
    const bobEvents: SessionEvent[] = [];
    m.subscribe(ALICE, (e) => aliceEvents.push(e));
    m.subscribe(BOB, (e) => bobEvents.push(e));

    m.create(INPUT, ALICE);
    m.create(INPUT, BOB);

    expect(aliceEvents).toHaveLength(1);
    expect(bobEvents).toHaveLength(1);
    expect(aliceEvents[0].session.owner_id).toBe('local-user:1000');
    expect(bobEvents[0].session.owner_id).toBe('local-user:1001');
  });

  it('returns unsubscribe handle that detaches the listener', () => {
    const m = makeManager({ ids: ['U-1', 'U-2'] });
    const fn = vi.fn();
    const off = m.subscribe(ALICE, fn);
    m.create(INPUT, ALICE);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    m.create(INPUT, ALICE);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('SessionManager.eventBus getter', () => {
  it('exposes the underlying bus instance', () => {
    const bus = new SessionEventBus();
    const m = new SessionManager(db, { eventBus: bus });
    expect(m.eventBus).toBe(bus);
  });
});
