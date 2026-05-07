// Persist controller + sessions Map round-trip tests (Task #667).
//
// These tests deliberately use an in-memory KvDb impl (not better-sqlite3) so
// they exercise *only* the load/serialize/debounce/flush logic. The real
// SQLite layer has its own tests under #666.

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  CreateSessionResponse,
  ListSessionsResponse,
} from '@ccsm/shared';

import type { KvDb } from '../src/db.mjs';
import { createDaemonHttp, type DaemonHttp } from '../src/http.mjs';
import {
  createPersistController,
  loadSessionsFromDb,
  type PersistController,
} from '../src/persist.mjs';
import type { StubSession } from '../src/http.mjs';

const TOKEN = 'test-token-do-not-use-in-prod-0123456789abcdef';
const GOOD_ORIGIN = 'http://localhost:1234';

function authedHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Origin: GOOD_ORIGIN,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/**
 * Minimal in-memory KvDb. The persist module never reaches outside the get/
 * set/close surface, so this is a faithful stand-in. close() is intentionally
 * idempotent and harmless — we re-open the "same" db across restarts by
 * sharing the underlying record between two adapter instances (mimics
 * "process restarts but the file on disk is the same").
 */
function makeMemDb(initial?: Record<string, string>): KvDb & {
  store: Record<string, string>;
  closed: boolean;
} {
  const store: Record<string, string> = { ...(initial ?? {}) };
  let closed = false;
  return {
    store,
    get closed() {
      return closed;
    },
    get(key: string): string | null {
      if (closed) throw new Error('db closed');
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key]! : null;
    },
    set(key: string, value: string): void {
      if (closed) throw new Error('db closed');
      store[key] = value;
    },
    close(): void {
      closed = true;
    },
  };
}

/** Bring up a daemon HTTP, listen on ephemeral port, return base URL. */
async function bootHttp(db: KvDb, debounceMs = 50): Promise<{
  http: DaemonHttp;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const http = createDaemonHttp({ token: TOKEN, db, persistDebounceMs: debounceMs });
  await new Promise<void>((res, rej) => {
    http.server.once('error', rej);
    http.server.listen(0, '127.0.0.1', () => {
      http.server.removeListener('error', rej);
      res();
    });
  });
  const addr = http.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    http,
    baseUrl,
    close: () =>
      new Promise<void>((res) => {
        http.server.close(() => res());
      }),
  };
}

async function postSession(baseUrl: string, cwd: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: authedHeaders(),
    body: JSON.stringify({ cwd }),
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as CreateSessionResponse;
  return body.sid;
}

async function listSessions(baseUrl: string): Promise<ListSessionsResponse['sessions']> {
  const r = await fetch(`${baseUrl}/api/sessions`, {
    method: 'GET',
    headers: authedHeaders(),
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as ListSessionsResponse;
  return body.sessions;
}

async function deleteSession(baseUrl: string, sid: string): Promise<void> {
  const r = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sid)}`, {
    method: 'DELETE',
    headers: authedHeaders(),
  });
  expect(r.status).toBe(200);
}

// ---- Pure-unit tests of persist.mts ---------------------------------------

describe('persist module (#667 unit)', () => {
  it('serializes and round-trips StubSession including cwd', () => {
    const db = makeMemDb();
    const sessions = new Map<string, StubSession>();
    sessions.set('a', { sid: 'a', createdAt: 1000, alive: true, cwd: '/foo/bar' });
    sessions.set('b', { sid: 'b', createdAt: 2000, alive: false });
    const ctl = createPersistController({ db, sessions, debounceMs: 5 });
    ctl.flushNow();

    const restored = new Map<string, StubSession>();
    loadSessionsFromDb(db, restored);
    expect(restored.size).toBe(2);
    const a = restored.get('a');
    expect(a?.cwd).toBe('/foo/bar'); // cwd preservation — load-bearing per spike #665
    expect(a?.createdAt).toBe(1000);
    expect(a?.alive).toBe(true);
    const b = restored.get('b');
    expect(b?.cwd).toBeUndefined();
    expect(b?.alive).toBe(false);
  });

  it('debounce: scheduleFlush coalesces multiple calls into one write', async () => {
    const db = makeMemDb();
    let writes = 0;
    const wrapped: KvDb = {
      get: (k) => db.get(k),
      set: (k, v) => {
        writes++;
        db.set(k, v);
      },
      close: () => db.close(),
    };
    const sessions = new Map<string, StubSession>();
    const ctl = createPersistController({ db: wrapped, sessions, debounceMs: 30 });
    sessions.set('x', { sid: 'x', createdAt: 1, alive: true });
    ctl.scheduleFlush();
    sessions.set('y', { sid: 'y', createdAt: 2, alive: true });
    ctl.scheduleFlush();
    sessions.set('z', { sid: 'z', createdAt: 3, alive: true });
    ctl.scheduleFlush();
    expect(ctl.hasPending()).toBe(true);
    expect(writes).toBe(0);
    await new Promise<void>((r) => setTimeout(r, 80));
    expect(ctl.hasPending()).toBe(false);
    expect(writes).toBe(1);
    // And the final state is what got written.
    const blob = db.get('sessions');
    expect(blob).not.toBeNull();
    const arr = JSON.parse(blob!) as StubSession[];
    expect(arr.map((s) => s.sid).sort()).toEqual(['x', 'y', 'z']);
  });

  it('flushNow cancels pending timer and writes synchronously', () => {
    const db = makeMemDb();
    const sessions = new Map<string, StubSession>();
    const ctl = createPersistController({ db, sessions, debounceMs: 1000 });
    sessions.set('s', { sid: 's', createdAt: 42, alive: true, cwd: '/tmp' });
    ctl.scheduleFlush();
    expect(ctl.hasPending()).toBe(true);
    expect(db.get('sessions')).toBeNull(); // hasn't fired yet
    ctl.flushNow();
    expect(ctl.hasPending()).toBe(false);
    const arr = JSON.parse(db.get('sessions')!) as StubSession[];
    expect(arr).toHaveLength(1);
    expect(arr[0]!.cwd).toBe('/tmp');
  });

  it('loadSessionsFromDb tolerates null / unparseable / wrong-shape blob', () => {
    // null: empty map, no error
    {
      const db = makeMemDb();
      const m = new Map<string, StubSession>();
      loadSessionsFromDb(db, m);
      expect(m.size).toBe(0);
    }
    // unparseable: empty map, no throw
    {
      const db = makeMemDb({ sessions: '{not json' });
      const m = new Map<string, StubSession>();
      loadSessionsFromDb(db, m);
      expect(m.size).toBe(0);
    }
    // not array: empty map, no throw
    {
      const db = makeMemDb({ sessions: '{"foo":1}' });
      const m = new Map<string, StubSession>();
      loadSessionsFromDb(db, m);
      expect(m.size).toBe(0);
    }
    // mixed: good entries kept, bad ones skipped
    {
      const db = makeMemDb({
        sessions: JSON.stringify([
          { sid: 'good', createdAt: 1, alive: true, cwd: '/x' },
          { sid: '', createdAt: 2, alive: true }, // bad: empty sid
          { sid: 'no-created-at', alive: true }, // bad: missing field
          { sid: 'also-good', createdAt: 3, alive: false },
        ]),
      });
      const m = new Map<string, StubSession>();
      loadSessionsFromDb(db, m);
      expect([...m.keys()].sort()).toEqual(['also-good', 'good']);
    }
  });
});

// ---- HTTP-driven round-trip ("daemon restart" simulation) -----------------

describe('http <-> kv-db round-trip (#667 integration)', () => {
  let active: { close: () => Promise<void> } | null = null;
  afterEach(async () => {
    if (active) {
      await active.close();
      active = null;
    }
  });
  beforeEach(() => {
    active = null;
  });

  it('POST -> flushNow -> restart: session is restored with cwd', async () => {
    const db = makeMemDb();
    // Boot 1: create a session
    {
      const boot = await bootHttp(db);
      active = boot;
      const sid = await postSession(boot.baseUrl, '/foo');
      // Force synchronous write before "powering off".
      boot.http.persist!.flushNow();
      await boot.close();
      active = null;

      // Sanity: blob is present
      expect(db.get('sessions')).not.toBeNull();

      // Boot 2 with same db: GET should see the session.
      const boot2 = await bootHttp(db);
      active = boot2;
      const list = await listSessions(boot2.baseUrl);
      expect(list).toHaveLength(1);
      expect(list[0]!.sid).toBe(sid);
      // cwd is internal — assert it survived by checking the in-memory map.
      const restored = boot2.http.sessions.get(sid);
      expect(restored?.cwd).toBe('/foo');
    }
  });

  it('POST -> DELETE -> flushNow -> restart: empty', async () => {
    const db = makeMemDb();
    const boot = await bootHttp(db);
    active = boot;
    const sid = await postSession(boot.baseUrl, '/bar');
    await deleteSession(boot.baseUrl, sid);
    boot.http.persist!.flushNow();
    await boot.close();
    active = null;

    const boot2 = await bootHttp(db);
    active = boot2;
    const list = await listSessions(boot2.baseUrl);
    expect(list).toHaveLength(0);
  });

  it('POST then immediate "power off" without flushNow: restart misses the write (debounce did not fire)', async () => {
    const db = makeMemDb();
    // Long debounce so the timer can NOT fire before we close.
    const boot = await bootHttp(db, 5_000);
    active = boot;
    await postSession(boot.baseUrl, '/baz');
    // Deliberately do NOT call flushNow. Just close the server (mimics
    // a yanked power cord — no graceful SIGINT path).
    await boot.close();
    active = null;

    // The 'sessions' blob must be untouched (still null). This proves the
    // debounce really is async and that flushNow is required for durability.
    expect(db.get('sessions')).toBeNull();

    const boot2 = await bootHttp(db);
    active = boot2;
    const list = await listSessions(boot2.baseUrl);
    expect(list).toHaveLength(0);
  });
});
