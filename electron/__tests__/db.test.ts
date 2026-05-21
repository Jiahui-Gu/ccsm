import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

// Wrap fs so the corruption-recovery test can pin that `electron/db.ts`
// actually calls `unlinkSync` on the `-wal` / `-shm` sidecar paths.
//
// `vi.spyOn(fs, 'unlinkSync')` fails — the ESM namespace is frozen. The
// `Module._cache` hack doesn't work either, because Vitest runs modules
// inside its own loader (no shared CJS cache). The robust path is
// `vi.mock('fs', …)` with `importActual`: every importer (test + production)
// gets the same wrapper, which by default delegates to the real impl so
// other tests' `mkdtempSync` / `writeFileSync` / etc. keep working. Tests
// that need to assert the call shape override the wrapper.
const unlinkSpy = vi.hoisted(() => ({ fn: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock('fs', async () => {
  const actual = (await vi.importActual('fs')) as typeof import('fs');
  const wrapped = vi.fn(actual.unlinkSync);
  unlinkSpy.fn = wrapped;
  return { ...actual, default: actual, unlinkSync: wrapped };
});

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
  it('calls fs.unlinkSync on the -wal and -shm sidecars during corruption recovery', async () => {
    const mod = await freshDb();
    mod.closeDb();

    const file = path.join(tmpDir, 'ccsm.db');
    // Garbage main file — quick_check will report corruption inside
    // ensureHealthyDb and trigger the sidecar-cleanup branch.
    fs.writeFileSync(file, Buffer.from('not a sqlite database'));

    // The vi.mock('fs') wrapper above delegates to the real unlinkSync by
    // default (vi.fn(actual.unlinkSync)). Just clear the call log before
    // initDb so we only capture calls made during corruption recovery.
    unlinkSpy.fn.mockClear();

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => mod.initDb()).not.toThrow();
    } finally {
      err.mockRestore();
    }

    const paths = unlinkSpy.fn.mock.calls.map((c) => String(c[0]));
    // Pinning the syscall, not the on-disk after-state. Reverse-verifies
    // against deletion of the `for (const ext of ['-wal','-shm'])` cleanup
    // loop in electron/db.ts.
    expect(paths).toContain(file + '-wal');
    expect(paths).toContain(file + '-shm');
  });

  it('swallows ENOENT from sidecar unlinkSync (sidecars may not exist)', async () => {
    // Common case: corrupt main file with no leftover sidecars. The unlink
    // loop must tolerate ENOENT silently — otherwise corruption recovery
    // would crash on the most common shape of the bug it's supposed to fix.
    const mod = await freshDb();
    mod.closeDb();

    const file = path.join(tmpDir, 'ccsm.db');
    fs.writeFileSync(file, Buffer.from('not a sqlite database'));

    // Override the wrapper to throw ENOENT for sidecar paths; let other
    // unlink calls (e.g. the unlink fallback in the backup-rename branch)
    // proceed via the real implementation.
    const realFs = (await vi.importActual('fs')) as typeof import('fs');
    unlinkSpy.fn.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.endsWith('-wal') || s.endsWith('-shm')) {
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      }
      return realFs.unlinkSync(p);
    });

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => mod.initDb()).not.toThrow();
    } finally {
      err.mockRestore();
    }

    const attempted = unlinkSpy.fn.mock.calls.map((c) => String(c[0]));
    expect(attempted).toContain(file + '-wal');
    expect(attempted).toContain(file + '-shm');
  });
});

afterEach(async () => {
  // Restore the default delegate-to-real-fs behaviour after any test that
  // overrode it via mockImplementation. mockReset would clear the default,
  // breaking the first test in this describe; mockClear keeps the impl but
  // wipes the call log.
  const realFs = (await vi.importActual('fs')) as typeof import('fs');
  unlinkSpy.fn.mockImplementation(realFs.unlinkSync);
  unlinkSpy.fn.mockClear();
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
