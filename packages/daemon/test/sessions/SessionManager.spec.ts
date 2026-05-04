// Unit tests for SessionManager (T3.2 / Task #38).
//
// Spec refs:
//   - ch05 §5 (per-RPC enforcement matrix: principal-scoped Get / List /
//     Destroy; SQL filter for List; assertOwnership for Get / Destroy).
//   - ch05 §6 (Create flow: ULID id, owner_id = principalKey, INSERT,
//     emit `SessionEvent.created`).
//   - ch07 §3 (sessions table schema).
//
// Tests use:
//   - the real `openDatabase(':memory:')` wrapper (T5.1) and the real
//     migration runner (T5.4) — anything else would diverge from the
//     production schema and let a future column rename slip through.
//   - the daemon's real Principal model from `src/auth/principal.ts`
//     (T3.1) and the canonical `session.not_owned` ConnectError shape
//     from `src/rpc/errors.ts` (T2.5).
//
// We deliberately do NOT mock the SQLite layer. The manager is so thin
// that a pure-JS double would test the double, not the manager.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import { ErrorDetailSchema } from '@ccsm/proto';

import type { Principal } from '../../src/auth/principal.js';
import { openDatabase, type SqliteDatabase } from '../../src/db/sqlite.js';
import { runMigrations } from '../../src/db/migrations/runner.js';
import { SessionEventBus } from '../../src/sessions/event-bus.js';
import {
  SessionManager,
  buildSessionRow,
  newSessionId,
} from '../../src/sessions/SessionManager.js';
import { SessionState, type SessionEvent } from '../../src/sessions/types.js';

const ALICE: Principal = { kind: 'local-user', uid: '1000', displayName: 'alice' };
const BOB: Principal = { kind: 'local-user', uid: '1001', displayName: 'bob' };

function freshDb(): SqliteDatabase {
  const db = openDatabase(':memory:');
  runMigrations(db);
  // sessions.owner_id has an FK to principals(id); insert both before any
  // CreateSession call so the FK check passes. v0.3 daemon manages this
  // table outside the SessionManager (peer-cred middleware upserts on
  // connect — T1.3); for unit tests we synthesize the rows directly.
  const insertPrincipal = db.prepare(
    `INSERT INTO principals (id, kind, display_name, first_seen_ms, last_seen_ms)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insertPrincipal.run('local-user:1000', 'local-user', 'alice', 1, 1);
  insertPrincipal.run('local-user:1001', 'local-user', 'bob', 1, 1);
  return db;
}

function createInput(overrides: Partial<{ cwd: string; cols: number; rows: number }> = {}) {
  return {
    cwd: overrides.cwd ?? '/home/alice',
    env_json: '{"FOO":"bar"}',
    claude_args_json: '["--no-color"]',
    geometry_cols: overrides.cols ?? 80,
    geometry_rows: overrides.rows ?? 24,
  };
}

describe('newSessionId', () => {
  it('produces a 26-char Crockford-base32 string', () => {
    const id = newSessionId(() => 1700000000000);
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is lexicographically ordered by time', () => {
    const idEarly = newSessionId(() => 1000);
    const idLate = newSessionId(() => 2000);
    expect(idEarly < idLate).toBe(true);
  });

  it('rejects negative or out-of-48-bit timestamps', () => {
    expect(() => newSessionId(() => -1)).toThrow(RangeError);
    expect(() => newSessionId(() => 0xffff_ffff_ffff + 1)).toThrow(RangeError);
  });
});

describe('buildSessionRow (producer)', () => {
  it('sets owner_id to principalKey(principal)', () => {
    const row = buildSessionRow(createInput(), ALICE, 'ID00000000000000000000000A', 5);
    expect(row.owner_id).toBe('local-user:1000');
  });

  it('defaults match spec ch05 §6 + ch07 §3 (state=STARTING, exit_code=-1, should_be_running=1)', () => {
    const row = buildSessionRow(createInput(), ALICE, 'ID00000000000000000000000A', 7);
    expect(row.state).toBe(SessionState.STARTING);
    expect(row.exit_code).toBe(-1);
    expect(row.should_be_running).toBe(1);
    expect(row.created_ms).toBe(7);
    expect(row.last_active_ms).toBe(7);
  });
});

describe('SessionManager.create', () => {
  let db: SqliteDatabase;
  beforeEach(() => {
    db = freshDb();
  });

  it('persists the row and returns it', () => {
    let counter = 0;
    const mgr = new SessionManager(db, {
      now: () => 100,
      newId: () => `ID${String(counter++).padStart(24, '0')}`,
    });
    const row = mgr.create(createInput(), ALICE);
    expect(row.id).toBe('ID000000000000000000000000');
    expect(row.owner_id).toBe('local-user:1000');

    const persisted = db.prepare('SELECT * FROM sessions WHERE id = ?').get(row.id);
    expect(persisted).toMatchObject({
      id: row.id,
      owner_id: 'local-user:1000',
      state: SessionState.STARTING,
      cwd: '/home/alice',
      env_json: '{"FOO":"bar"}',
      claude_args_json: '["--no-color"]',
      geometry_cols: 80,
      geometry_rows: 24,
      exit_code: -1,
      should_be_running: 1,
    });
  });

  it('emits a SessionEvent.created on the bus, scoped to the owner principal', () => {
    const bus = new SessionEventBus();
    const events: SessionEvent[] = [];
    bus.subscribe('local-user:1000', (e) => events.push(e));
    const otherEvents: SessionEvent[] = [];
    bus.subscribe('local-user:1001', (e) => otherEvents.push(e));

    const mgr = new SessionManager(db, { eventBus: bus, now: () => 1, newId: () => 'X' });
    const row = mgr.create(createInput(), ALICE);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'created', session: row });
    expect(otherEvents).toHaveLength(0);
  });
});

describe('SessionManager.get', () => {
  it('returns the row when caller owns it', () => {
    const db = freshDb();
    const mgr = new SessionManager(db, { now: () => 1, newId: () => 'OWNED' });
    const row = mgr.create(createInput(), ALICE);
    expect(mgr.get(row.id, ALICE)).toEqual(row);
  });

  it('throws session.not_owned (PermissionDenied) when caller is a different principal', () => {
    const db = freshDb();
    const mgr = new SessionManager(db, { now: () => 1, newId: () => 'CROSS' });
    const row = mgr.create(createInput(), ALICE);
    try {
      mgr.get(row.id, BOB);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      const ce = err as ConnectError;
      expect(ce.code).toBe(Code.PermissionDenied);
      const detail = ce.findDetails(ErrorDetailSchema)[0];
      expect(detail?.code).toBe('session.not_owned');
      expect(detail?.extra.session_id).toBe(row.id);
    }
  });

  it('throws session.not_owned (not NotFound) when the row does not exist — prevents id enumeration', () => {
    const db = freshDb();
    const mgr = new SessionManager(db);
    try {
      mgr.get('does-not-exist', ALICE);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(Code.PermissionDenied);
      const detail = (err as ConnectError).findDetails(ErrorDetailSchema)[0];
      expect(detail?.code).toBe('session.not_owned');
    }
  });
});

describe('SessionManager.list', () => {
  it("returns only the caller's sessions, ordered by created_ms then id", () => {
    const db = freshDb();
    let t = 100;
    let n = 0;
    const mgr = new SessionManager(db, {
      now: () => t,
      newId: () => `ID${String(n++).padStart(24, '0')}`,
    });
    t = 100; mgr.create(createInput({ cwd: '/a' }), ALICE);
    t = 200; mgr.create(createInput({ cwd: '/b' }), BOB);
    t = 300; mgr.create(createInput({ cwd: '/c' }), ALICE);

    const aliceList = mgr.list(ALICE);
    expect(aliceList.map((r) => r.cwd)).toEqual(['/a', '/c']);
    expect(aliceList.every((r) => r.owner_id === 'local-user:1000')).toBe(true);

    const bobList = mgr.list(BOB);
    expect(bobList.map((r) => r.cwd)).toEqual(['/b']);
  });

  it('returns an empty array for a principal with no sessions', () => {
    const db = freshDb();
    const mgr = new SessionManager(db);
    expect(mgr.list(ALICE)).toEqual([]);
  });
});

describe('SessionManager.destroy', () => {
  it('marks the row EXITED + should_be_running=0 and emits SessionEvent.destroyed', () => {
    const db = freshDb();
    const events: SessionEvent[] = [];
    const bus = new SessionEventBus();
    bus.subscribe('local-user:1000', (e) => events.push(e));

    let t = 100;
    const mgr = new SessionManager(db, {
      now: () => t,
      newId: () => 'TODESTROY',
      eventBus: bus,
    });
    const row = mgr.create(createInput(), ALICE);
    expect(events.at(-1)?.kind).toBe('created');

    t = 500;
    const destroyed = mgr.destroy(row.id, ALICE);
    expect(destroyed.state).toBe(SessionState.EXITED);
    expect(destroyed.should_be_running).toBe(0);
    expect(destroyed.last_active_ms).toBe(500);

    const persisted = db
      .prepare('SELECT state, should_be_running, last_active_ms FROM sessions WHERE id = ?')
      .get(row.id) as { state: number; should_be_running: number; last_active_ms: number };
    expect(persisted).toEqual({
      state: SessionState.EXITED,
      should_be_running: 0,
      last_active_ms: 500,
    });

    expect(events.at(-1)?.kind).toBe('destroyed');
    expect(events.at(-1)?.session.id).toBe(row.id);
  });

  it('refuses cross-principal destroy with session.not_owned and leaves the row untouched', () => {
    const db = freshDb();
    const mgr = new SessionManager(db, { now: () => 1, newId: () => 'PROTECT' });
    const row = mgr.create(createInput(), ALICE);

    expect(() => mgr.destroy(row.id, BOB)).toThrow(ConnectError);

    const persisted = db
      .prepare('SELECT state, should_be_running FROM sessions WHERE id = ?')
      .get(row.id) as { state: number; should_be_running: number };
    expect(persisted).toEqual({ state: SessionState.STARTING, should_be_running: 1 });
  });
});

describe('SessionManager.subscribe', () => {
  it('delivers create + destroy events for the caller, scoped by principalKey', () => {
    const db = freshDb();
    const mgr = new SessionManager(db, { now: () => 1, newId: () => 'SUB1' });
    const aliceSeen: SessionEvent[] = [];
    const bobSeen: SessionEvent[] = [];
    const unsub = mgr.subscribe(ALICE, (e) => aliceSeen.push(e));
    mgr.subscribe(BOB, (e) => bobSeen.push(e));

    const row = mgr.create(createInput(), ALICE);
    mgr.destroy(row.id, ALICE);

    expect(aliceSeen.map((e) => e.kind)).toEqual(['created', 'destroyed']);
    expect(bobSeen).toEqual([]);

    unsub();
    expect(mgr.eventBus.listenerCount('local-user:1000')).toBe(0);
  });

  it("uses the caller's principalKey for filtering — a Bob subscriber sees nothing for Alice's session", () => {
    const db = freshDb();
    const mgr = new SessionManager(db, { now: () => 1, newId: () => 'SUB2' });
    const seen = vi.fn();
    mgr.subscribe(BOB, seen);

    mgr.create(createInput(), ALICE);

    expect(seen).not.toHaveBeenCalled();
  });
});

describe('SessionManager.markEnded (T4.4 — pty-host child crash semantics)', () => {
  it('flips state=CRASHED + should_be_running=0 + writes exit_code, and emits SessionEvent.ended', () => {
    const db = freshDb();
    const events: SessionEvent[] = [];
    const bus = new SessionEventBus();
    bus.subscribe('local-user:1000', (e) => events.push(e));

    let t = 100;
    const mgr = new SessionManager(db, {
      now: () => t,
      newId: () => 'CRASHED1',
      eventBus: bus,
    });
    const row = mgr.create(createInput(), ALICE);
    expect(events.at(-1)?.kind).toBe('created');

    t = 700;
    const ended = mgr.markEnded(row.id, { reason: 'crashed', exit_code: 137 });
    expect(ended.state).toBe(SessionState.CRASHED);
    expect(ended.should_be_running).toBe(0);
    expect(ended.exit_code).toBe(137);
    expect(ended.last_active_ms).toBe(700);

    const persisted = db
      .prepare(
        'SELECT state, should_be_running, exit_code, last_active_ms FROM sessions WHERE id = ?',
      )
      .get(row.id) as {
      state: number;
      should_be_running: number;
      exit_code: number;
      last_active_ms: number;
    };
    expect(persisted).toEqual({
      state: SessionState.CRASHED,
      should_be_running: 0,
      exit_code: 137,
      last_active_ms: 700,
    });

    const lastEvt = events.at(-1);
    expect(lastEvt?.kind).toBe('ended');
    if (lastEvt?.kind === 'ended') {
      expect(lastEvt.reason).toBe('crashed');
      expect(lastEvt.session.id).toBe(row.id);
      expect(lastEvt.session.state).toBe(SessionState.CRASHED);
      expect(lastEvt.session.exit_code).toBe(137);
      expect(lastEvt.session.should_be_running).toBe(0);
    }
  });

  it('graceful reason transitions to state=EXITED (matches DestroySession terminal state)', () => {
    const db = freshDb();
    const mgr = new SessionManager(db, { now: () => 10, newId: () => 'GRACE1' });
    const row = mgr.create(createInput(), ALICE);

    const ended = mgr.markEnded(row.id, { reason: 'graceful', exit_code: 0 });
    expect(ended.state).toBe(SessionState.EXITED);
    expect(ended.should_be_running).toBe(0);
    expect(ended.exit_code).toBe(0);
  });

  it('null exit_code is persisted as -1 sentinel (signal-killed children)', () => {
    const db = freshDb();
    const mgr = new SessionManager(db, { now: () => 1, newId: () => 'SIGKILL1' });
    const row = mgr.create(createInput(), ALICE);

    const ended = mgr.markEnded(row.id, { reason: 'crashed', exit_code: null });
    expect(ended.exit_code).toBe(-1);

    const persisted = db
      .prepare('SELECT exit_code FROM sessions WHERE id = ?')
      .get(row.id) as { exit_code: number };
    expect(persisted.exit_code).toBe(-1);
  });

  it('is idempotent — a second markEnded with the same (state, exit_code) does not double-publish', () => {
    const db = freshDb();
    const events: SessionEvent[] = [];
    const bus = new SessionEventBus();
    bus.subscribe('local-user:1000', (e) => events.push(e));

    const mgr = new SessionManager(db, {
      now: () => 1,
      newId: () => 'IDEMP1',
      eventBus: bus,
    });
    const row = mgr.create(createInput(), ALICE);

    mgr.markEnded(row.id, { reason: 'crashed', exit_code: 1 });
    mgr.markEnded(row.id, { reason: 'crashed', exit_code: 1 });

    const endedEvents = events.filter((e) => e.kind === 'ended');
    expect(endedEvents).toHaveLength(1);
  });

  it('throws (not a ConnectError) when the row does not exist — daemon-internal contract', () => {
    const db = freshDb();
    const mgr = new SessionManager(db);
    expect(() =>
      mgr.markEnded('does-not-exist', { reason: 'crashed', exit_code: 1 }),
    ).toThrow(/no row for session id/);
  });

  it('does not require a Principal (caller-agnostic; bus still scopes by row owner)', () => {
    const db = freshDb();
    const aliceSeen: SessionEvent[] = [];
    const bobSeen: SessionEvent[] = [];
    const bus = new SessionEventBus();
    bus.subscribe('local-user:1000', (e) => aliceSeen.push(e));
    bus.subscribe('local-user:1001', (e) => bobSeen.push(e));

    const mgr = new SessionManager(db, {
      now: () => 1,
      newId: () => 'SCOPE1',
      eventBus: bus,
    });
    const row = mgr.create(createInput(), ALICE);

    mgr.markEnded(row.id, { reason: 'crashed', exit_code: 9 });

    expect(aliceSeen.some((e) => e.kind === 'ended')).toBe(true);
    expect(bobSeen.some((e) => e.kind === 'ended')).toBe(false);
  });
});
