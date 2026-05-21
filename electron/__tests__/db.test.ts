import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

// `initDb` asks electron for the userData dir. Point it at a per-test tmp dir
// so real app data isn't touched and each test gets a fresh database.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-db-test-'));
let tmpDir = tmpRoot;

vi.mock('electron', () => ({
  app: { getPath: () => tmpDir }
}));

async function freshDb() {
  // Reset the module-local singleton between tests.
  const mod = await import('../db');
  mod.closeDb();
  tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  return mod;
}

beforeEach(async () => {
  await freshDb();
});

// Complements `db-hardening.test.ts` (which covers corruption recovery, fresh
// user_version stamp, prepared-statement cache reuse, db:save validator, and
// preload re-throw). The tests below pick up the remaining branches: load
// misses, upsert semantics, close+reopen, schema downgrade warning, legacy-
// table drop, WAL/SHM sidecar cleanup, getDb passthrough, and the
// `__setDbForTests` injection seam.

describe('db: loadState / saveState round-trips', () => {
  it('loadState returns null for an unknown key on a fresh db', async () => {
    const { initDb, loadState } = await freshDb();
    initDb();
    expect(loadState('never-written')).toBeNull();
  });

  it('saveState upserts: second write replaces the value rather than colliding on PRIMARY KEY', async () => {
    const { initDb, saveState, loadState } = await freshDb();
    initDb();
    saveState('k', 'v1');
    saveState('k', 'v2');
    saveState('k', 'v3');
    expect(loadState('k')).toBe('v3');
  });

  it('preserves data across closeDb() + initDb() reopen of the same file', async () => {
    const mod = await freshDb();
    mod.initDb();
    mod.saveState('persisted', 'hello');
    mod.closeDb();
    // The on-disk file under tmpDir is unchanged; reopening yields the same
    // app_state row.
    mod.initDb();
    expect(mod.loadState('persisted')).toBe('hello');
  });

  it('initDb is idempotent — repeated calls return the same handle', async () => {
    const { initDb } = await freshDb();
    const h1 = initDb();
    const h2 = initDb();
    expect(h1).toBe(h2);
  });

  it('getDb returns the same instance as initDb()', async () => {
    const { initDb, getDb } = await freshDb();
    const a = initDb();
    const b = getDb();
    expect(a).toBe(b);
  });
});

describe('db: schema versioning branches', () => {
  it('logs a warning and proceeds when on-disk user_version > app SCHEMA_VERSION (downgrade)', async () => {
    const mod = await freshDb();
    // Pre-seed the canonical db file with a future-version user_version stamp.
    const file = path.join(tmpDir, 'ccsm.db');
    const seed = new Database(file);
    seed.pragma('user_version = 99');
    seed.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = mod.initDb();
    // Boot must not refuse — we proceed and log a breadcrumb.
    expect(handle).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls[0]?.[0] ?? '';
    expect(String(msg)).toMatch(/newer than app/);
    warn.mockRestore();
  });

  it('keeps an existing matching user_version untouched (no migrate, no warn)', async () => {
    const mod = await freshDb();
    const file = path.join(tmpDir, 'ccsm.db');
    const seed = new Database(file);
    seed.pragma('user_version = 1'); // matches SCHEMA_VERSION
    seed.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = mod.initDb();
    const v = handle.pragma('user_version', { simple: true }) as number;
    expect(v).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('db: legacy-table cleanup', () => {
  it('drops endpoints / endpoint_models / messages tables on init when present', async () => {
    const mod = await freshDb();
    // Pre-seed a db with the legacy tables AND content. initDb() must drop
    // them silently — they're tables the current app no longer reads.
    const file = path.join(tmpDir, 'ccsm.db');
    const seed = new Database(file);
    seed.exec(`
      CREATE TABLE endpoints (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE endpoint_models (id INTEGER PRIMARY KEY, endpoint_id INTEGER);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT);
      INSERT INTO endpoints (name) VALUES ('legacy');
      INSERT INTO messages (body) VALUES ('old message');
    `);
    seed.close();

    const handle = mod.initDb();
    const remaining = handle
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('endpoints','endpoint_models','messages')"
      )
      .all() as { name: string }[];
    expect(remaining).toEqual([]);
    // The app_state table created by SCHEMA_SQL must still be there.
    const appState = handle
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_state'")
      .all();
    expect(appState.length).toBe(1);
  });
});

describe('db: corruption recovery sidecar cleanup', () => {
  it('removes leftover -wal / -shm sidecar files when backing up a corrupt main db', async () => {
    const mod = await freshDb();
    mod.closeDb();

    const file = path.join(tmpDir, 'ccsm.db');
    // Garbage main file — quick_check will report corruption inside
    // ensureHealthyDb.
    fs.writeFileSync(file, Buffer.from('not a sqlite database'));
    // Stale WAL / SHM left over from a previous crashed process. If they
    // survived into the rebuilt db, SQLite could try to replay a journal
    // pointing at the renamed main file.
    fs.writeFileSync(file + '-wal', Buffer.from('stale-wal-bytes-marker'));
    fs.writeFileSync(file + '-shm', Buffer.from('stale-shm-bytes-marker'));

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => mod.initDb()).not.toThrow();
    err.mockRestore();

    // Assert the stale bytes are no longer present on disk — the rebuilt
    // db's own WAL/SHM may exist after WAL-mode init, but they won't carry
    // our stale marker text.
    if (fs.existsSync(file + '-wal')) {
      const walBytes = fs.readFileSync(file + '-wal');
      expect(walBytes.includes(Buffer.from('stale-wal-bytes-marker'))).toBe(false);
    }
    if (fs.existsSync(file + '-shm')) {
      const shmBytes = fs.readFileSync(file + '-shm');
      expect(shmBytes.includes(Buffer.from('stale-shm-bytes-marker'))).toBe(false);
    }
  });
});

describe('db: __setDbForTests injection', () => {
  it('swaps in an in-memory handle and re-runs the schema bootstrap', async () => {
    const mod = await freshDb();
    const mem = new Database(':memory:');
    mod.__setDbForTests(mem);

    // app_state must be created by __setDbForTests's SCHEMA_SQL execution.
    const row = mem
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_state'")
      .get();
    expect(row).toBeTruthy();

    // saveState / loadState route through the injected handle.
    mod.saveState('mem-key', 'mem-val');
    expect(mod.loadState('mem-key')).toBe('mem-val');

    // Resetting to null releases the override — next init opens a real file.
    mod.__setDbForTests(null);
    const real = mod.initDb();
    expect(real).not.toBe(mem);
    // Persistent file is empty — the in-memory write didn't leak across.
    expect(mod.loadState('mem-key')).toBeNull();
  });

  it('resets the prepared-statement cache on injection so the new handle compiles its own', async () => {
    const mod = await freshDb();
    // Warm the cache against the real db.
    mod.initDb();
    mod.saveState('warm', 'a');
    expect(mod.loadState('warm')).toBe('a');

    // Swap to a fresh in-memory db. If the cache wasn't reset, the next
    // saveState() would call .run() on a Statement bound to the now-closed
    // file handle and throw.
    mod.closeDb();
    const mem = new Database(':memory:');
    mod.__setDbForTests(mem);
    expect(() => mod.saveState('warm', 'b')).not.toThrow();
    expect(mod.loadState('warm')).toBe('b');
  });
});

describe('db: closeDb hygiene', () => {
  it('closeDb is safe to call when db was never opened', async () => {
    const mod = await freshDb();
    mod.closeDb();
    expect(() => mod.closeDb()).not.toThrow();
  });

  it('forces a re-init on the next initDb call after close', async () => {
    const mod = await freshDb();
    const a = mod.initDb();
    mod.closeDb();
    const b = mod.initDb();
    expect(a).not.toBe(b);
  });
});
