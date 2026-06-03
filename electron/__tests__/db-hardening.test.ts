import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

// Mirror db.test.ts: redirect electron's userData to a per-test tmp dir so
// (a) we never touch the real app data and (b) each test gets a clean slate.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-db-hardening-'));
let tmpDir = tmpRoot;

// `contextBridge`/`ipcRenderer` are present so this same mock can serve the
// preload bridge import below (Bug B real-import fix) — db tests only touch
// `app.getPath`, so the extra surface is inert here.
const { exposeSpy, invokeSpy, sendSpy, onSpy, removeListenerSpy } = vi.hoisted(() => ({
  exposeSpy: vi.fn(),
  invokeSpy: vi.fn(),
  sendSpy: vi.fn(),
  onSpy: vi.fn(),
  removeListenerSpy: vi.fn()
}));

vi.mock('electron', () => ({
  app: { getPath: () => tmpDir },
  contextBridge: { exposeInMainWorld: exposeSpy },
  ipcRenderer: {
    invoke: invokeSpy,
    send: sendSpy,
    on: onSpy,
    removeListener: removeListenerSpy
  }
}));

async function freshDb() {
  const mod = await import('../db');
  mod.closeDb();
  tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  return mod;
}

beforeEach(async () => {
  await freshDb();
});

describe('db hardening: startup integrity check', () => {
  it('initDb backs up a corrupt file and opens a fresh empty database', async () => {
    const mod = await freshDb();
    mod.closeDb();

    // Pre-seed the userData dir with a garbage file under the canonical
    // name. SQLite will accept the open() (it's lazy) but the first pragma
    // call inside ensureHealthyDb() will report corruption.
    const file = path.join(tmpDir, 'ccsm.db');
    fs.writeFileSync(file, Buffer.from('not a sqlite database, just bytes'));

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { initDb, saveState, loadState } = mod;
    expect(() => initDb()).not.toThrow();

    // Original file got renamed aside.
    const siblings = fs.readdirSync(tmpDir);
    const backup = siblings.find((n) => n.startsWith('ccsm.db.corrupt-'));
    expect(backup, `expected a *.corrupt-* backup, saw ${siblings.join(', ')}`).toBeTruthy();

    // Fresh DB is usable end-to-end via the surviving app_state surface.
    saveState('hello', 'world');
    expect(loadState('hello')).toBe('world');

    // Loud log so a real-world incident leaves a breadcrumb.
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('db hardening: schema versioning', () => {
  it('stamps user_version=1 on a freshly-created database', async () => {
    const { initDb } = await freshDb();
    const handle = initDb();
    const v = (handle.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(v).toBe(1);
  });

  it('preserves a future-newer on-disk schema and proceeds read-as-is', async () => {
    // Pre-seed a DB file stamped with user_version=99 (a hypothetical future
    // release). Current policy (see comment in db.ts ~ stored > SCHEMA_VERSION
    // branch) is: warn loudly but do NOT refuse to boot, do NOT silently
    // re-stamp the version backwards (that would lose the breadcrumb a
    // post-mortem needs). Pin both behaviors here so a future "refuse on
    // downgrade" change is a deliberate, reviewed swap.
    const mod = await freshDb();
    mod.closeDb();

    const file = path.join(tmpDir, 'ccsm.db');
    // Manually create a healthy SQLite file with a far-future user_version.
    const { DatabaseSync } = await import('node:sqlite');
    const seed = new DatabaseSync(file);
    seed.exec(`
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO app_state (key, value, updated_at) VALUES ('preExisting', 'keepme', 0);
    `);
    seed.exec('PRAGMA user_version = 99');
    seed.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { initDb, loadState, saveState } = mod;
    const handle = initDb();

    // The stored version must NOT be rewritten — the breadcrumb has to
    // survive across boots so a bug report can include it.
    expect(
      (handle.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    ).toBe(99);

    // Existing user rows must not be wiped (no silent data loss on
    // perceived-newer files).
    expect(loadState('preExisting')).toBe('keepme');

    // App stays writable: future schemas are assumed to be additive, and
    // refusing to boot is worse than a stale read per the in-tree comment.
    saveState('hello', 'world');
    expect(loadState('hello')).toBe('world');

    // Loud log so the incident is discoverable post-hoc.
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toMatch(/newer than/);
    warn.mockRestore();
  });

  it('stamps SCHEMA_VERSION onto a fresh DB that already has legacy rows', async () => {
    // Coverage scope: this test ONLY exercises the "fresh DB" branch in
    // initDb (stored user_version === 0) where pre-existing rows happen to
    // be on disk. It locks the policy that the first stamp-up does NOT
    // wipe legacy rows.
    //
    // What is NOT covered: the real migrate-from-older path (stored>0 and
    // stored<SCHEMA_VERSION). That branch is unreachable while
    // SCHEMA_VERSION===1 because the only stored values that satisfy
    // stored<1 collapse into the fresh-DB branch. See the it.todo below —
    // a real migration test must be added when SCHEMA_VERSION bumps to ≥2.
    const mod = await freshDb();
    mod.closeDb();

    const file = path.join(tmpDir, 'ccsm.db');
    const { DatabaseSync } = await import('node:sqlite');
    const seed = new DatabaseSync(file);
    seed.exec(`
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO app_state (key, value, updated_at) VALUES ('legacy', 'survives', 0);
    `);
    // user_version is 0 here (sqlite default). initDb's "fresh DB" branch
    // will stamp it to SCHEMA_VERSION on first open.
    seed.close();

    const { initDb, loadState } = mod;
    const handle = initDb();

    expect(
      (handle.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    ).toBe(1);
    expect(loadState('legacy')).toBe('survives');
  });

  // EXPLICIT COVERAGE GAP: the migrate-from-older path
  // (0 < stored < SCHEMA_VERSION) is unreachable while SCHEMA_VERSION===1.
  // When SCHEMA_VERSION bumps to ≥2, replace this it.todo with a real test
  // that pre-stamps user_version to an in-between value and asserts the
  // migration runs (data preserved + user_version stamped up to current).
  it.todo(
    'migrates an older on-disk schema (stored < current) — add when SCHEMA_VERSION ≥ 2'
  );
});

describe('db hardening: WAL durability across a non-graceful shutdown', () => {
  // Regression for the OS-restart data-loss bug. CCSM persists its whole
  // renderer snapshot as ONE tiny ~1 KB `app_state` row. In WAL mode that row
  // never approaches the default `wal_autocheckpoint` threshold (~4 MB), so
  // without an explicit checkpoint every write lives ONLY in the `-wal`
  // sidecar. A graceful quit (`before-quit` → `closeDb`) folds the WAL into the
  // main DB, but an OS restart / power loss / force-kill skips that path — the
  // unflushed WAL is discarded and the main DB serves a stale/empty snapshot.
  // All sessions/groups since the last graceful quit vanish.
  //
  // This can ONLY be reproduced across a process boundary: while any process
  // holds the connection open the WAL is still readable, so an in-process test
  // is a false green. We spawn `fixtures/wal-writer.cjs` (which mirrors db.ts's
  // initDb+saveState pragma sequence), SIGKILL it after the write commits,
  // delete the `-wal`/`-shm` sidecars (the OS dropping the unflushed journal),
  // then read the main DB from a fresh connection. The `CHECKPOINT` env arm is
  // the only difference between data loss and survival — pinning that the
  // `wal_checkpoint(PASSIVE)` added to `saveState` is load-bearing.
  const writer = path.join(__dirname, 'fixtures', 'wal-writer.cjs');

  async function runForcedShutdown(env: Record<string, string>): Promise<string | null> {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'wal-'));
    const file = path.join(dir, 'ccsm.db');
    const ready = file + '.ready';
    const child = spawn(process.execPath, [writer], {
      env: { ...process.env, DBFILE: file, STATE_VALUE: 'survive-the-restart', ...env },
      stdio: 'inherit',
    });
    try {
      const start = Date.now();
      while (!fs.existsSync(ready)) {
        if (Date.now() - start > 10000) throw new Error('writer never signalled ready');
        await new Promise((r) => setTimeout(r, 20));
      }
      // Forced shutdown: no graceful close, no checkpoint-on-exit.
      child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
    // The OS discards the unflushed WAL on restart. We model that by deleting
    // the -wal/-shm sidecars. On Windows the SIGKILL'd child's file handles
    // can linger briefly after the process is reaped (EBUSY/EPERM on unlink),
    // so a naive try/catch would silently leave the sidecars in place — the
    // reader would then still see the WAL contents and the durability test
    // would FALSELY pass ("data survived") on the buggy path. Retry with
    // backoff until each sidecar is provably gone, and fail loudly if it
    // cannot be removed so the durability assertion stays truthful.
    for (const ext of ['-wal', '-shm']) {
      const sidecar = file + ext;
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          fs.unlinkSync(sidecar);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') break; // never existed / already gone
          if (Date.now() > deadline) {
            throw new Error(
              `failed to remove sidecar ${sidecar} after 5s (last error: ${code}) — ` +
                'durability test cannot run truthfully while the WAL is still present'
            );
          }
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        if (!fs.existsSync(sidecar)) break;
      }
    }
    // A fresh launch opens the main DB from scratch.
    const { DatabaseSync } = await import('node:sqlite');
    const reader = new DatabaseSync(file, { readOnly: true });
    try {
      const row = reader
        .prepare('SELECT value FROM app_state WHERE key = ?')
        .get('main') as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      // Table absent because the main DB was never written — the bug.
      return null;
    } finally {
      reader.close();
    }
  }

  it('LOSES data on the current (no-checkpoint) path — documents the bug', async () => {
    // Neither SYNC_FULL nor CHECKPOINT: byte-for-byte the buggy db.ts path.
    const value = await runForcedShutdown({});
    expect(value).not.toBe('survive-the-restart');
  });

  it('synchronous=FULL alone is NOT enough — data still lost', async () => {
    // Proves FULL is necessary-but-insufficient: durability of WAL frames
    // doesn't help when the WAL itself is discarded un-checkpointed.
    const value = await runForcedShutdown({ SYNC_FULL: '1' });
    expect(value).not.toBe('survive-the-restart');
  });

  it('survives when saveState checkpoints the WAL into the main DB', async () => {
    // The actual fix: fold the WAL into the main file on every write.
    const value = await runForcedShutdown({ SYNC_FULL: '1', CHECKPOINT: '1' });
    expect(value).toBe('survive-the-restart');
  });
});

describe('db hardening: saveState/initDb wire up WAL durability', () => {
  // The forced-shutdown suite above proves the MECHANISM (no checkpoint → loss;
  // checkpoint → survival) across a real process kill, using a fixture that
  // mirrors db.ts. These two tests pin that db.ts ITSELF actually issues those
  // pragmas, so the fixture and production can't silently drift apart.
  it('initDb sets synchronous = FULL', async () => {
    const { initDb } = await freshDb();
    const handle = initDb();
    // synchronous: 0=OFF 1=NORMAL 2=FULL 3=EXTRA
    expect(
      (handle.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous
    ).toBe(2);
  });

  it('saveState issues a passive WAL checkpoint', async () => {
    const mod = await freshDb();
    const { getDb, saveState } = mod;
    const spy = vi.spyOn(getDb(), 'exec');
    saveState('main', 'x');
    const checkpointed = spy.mock.calls.some((c) => String(c[0]).includes('wal_checkpoint'));
    expect(checkpointed).toBe(true);
    spy.mockRestore();
  });
});

describe('db hardening: prepared statement cache', () => {
  it('reuses the same Statement across repeated calls', async () => {
    const mod = await freshDb();
    const { getDb, saveState, loadState } = mod;

    const realPrepare = getDb().prepare.bind(getDb());
    const spy = vi.spyOn(getDb(), 'prepare').mockImplementation((sql: string) => realPrepare(sql));

    // First touch compiles the prepared statements for the only surviving
    // user-side surface (app_state).
    saveState('k', 'v');
    loadState('k');
    const callsAfterFirst = spy.mock.calls.length;

    // Subsequent touches must NOT recompile — the cache should serve them.
    for (let i = 0; i < 5; i++) {
      saveState('k', `v${i}`);
      loadState('k');
    }
    expect(spy.mock.calls.length).toBe(callsAfterFirst);

    spy.mockRestore();
  });
});

describe('db hardening: db:save size cap validation', () => {
  // We test the validator directly rather than booting the IPC handler:
  // the handler in main.ts is registered inside `app.whenReady` and gated
  // by `fromMainFrame(e)`, neither of which is reachable from a Vitest
  // process. The validator is the entire decision surface — once it
  // returns `{ok:true}`, the handler unconditionally writes via
  // `saveState`, which already has end-to-end coverage in db.test.ts.
  it('rejects values larger than 1 MB with value_too_large', async () => {
    const { validateSaveStateInput, MAX_STATE_VALUE_BYTES } = await import('../db-validate');
    // One byte past the cap — boundary should be exclusive of the cap.
    const oversize = 'x'.repeat(MAX_STATE_VALUE_BYTES + 1);
    expect(validateSaveStateInput('appPersist', oversize)).toEqual({
      ok: false,
      error: 'value_too_large'
    });
  });

  it('rejects keys longer than 128 chars with invalid_key', async () => {
    const { validateSaveStateInput, MAX_STATE_KEY_LEN } = await import('../db-validate');
    const tooLong = 'k'.repeat(MAX_STATE_KEY_LEN + 1);
    expect(validateSaveStateInput(tooLong, 'value')).toEqual({
      ok: false,
      error: 'invalid_key'
    });
    // Empty string also rejected — the row's PRIMARY KEY can't be ''.
    expect(validateSaveStateInput('', 'value')).toEqual({
      ok: false,
      error: 'invalid_key'
    });
  });

  it('accepts a valid key/value pair', async () => {
    const { validateSaveStateInput, MAX_STATE_VALUE_BYTES, MAX_STATE_KEY_LEN } = await import(
      '../db-validate'
    );
    expect(validateSaveStateInput('appPersist', JSON.stringify({ a: 1 }))).toEqual({ ok: true });
    // Exactly at the cap is allowed (cap is inclusive on accept side).
    const atCap = 'x'.repeat(MAX_STATE_VALUE_BYTES);
    expect(validateSaveStateInput('k', atCap)).toEqual({ ok: true });
    const maxKey = 'k'.repeat(MAX_STATE_KEY_LEN);
    expect(validateSaveStateInput(maxKey, 'v')).toEqual({ ok: true });
  });
});

describe('db hardening: preload re-throws on {ok:false}', () => {
  // Regression for the silent-data-loss bug: the IPC handler returns a
  // resolved `{ok:false}` on oversize, but the renderer-side persister
  // uses `.catch(onPersistError)`, which only fires on Promise REJECTION.
  // The preload wrapper must convert `{ok:false}` into a thrown Error so
  // the existing `.catch` handlers fire and the user actually sees the
  // failure (instead of silently losing the snapshot).
  it('preload saveState wrapper throws when handler returns {ok:false}', async () => {
    // Drive the REAL preload bridge from electron/preload/bridges/ccsmCore.ts
    // — no inline reimplementation. The file-level `electron` mock above
    // provides the `contextBridge`/`ipcRenderer` surfaces it needs.
    const { installCcsmCoreBridge } = await import('../preload/bridges/ccsmCore');
    exposeSpy.mockClear();
    installCcsmCoreBridge();
    const exposeCall = exposeSpy.mock.calls[exposeSpy.mock.calls.length - 1];
    expect(exposeCall[0]).toBe('ccsm');
    const api = exposeCall[1] as { saveState: (k: string, v: string) => Promise<void> };

    invokeSpy.mockReset();
    invokeSpy.mockResolvedValueOnce({ ok: false, error: 'value_too_large' });
    await expect(api.saveState('k', 'v')).rejects.toThrow('value_too_large');

    invokeSpy.mockResolvedValueOnce({ ok: true });
    await expect(api.saveState('k', 'v')).resolves.toBeUndefined();
  });
});
