import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Mirror db.test.ts: redirect electron's userData to a per-test tmp dir so
// (a) we never touch the real app data and (b) each test gets a clean slate.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-db-hardening-'));
let tmpDir = tmpRoot;

vi.mock('electron', () => ({
  app: { getPath: () => tmpDir }
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
    const v = handle.pragma('user_version', { simple: true }) as number;
    expect(v).toBe(1);
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
    // Replicate the wrapper in isolation — importing electron/preload.ts
    // pulls in `contextBridge`/`ipcRenderer` which aren't available
    // outside a renderer process, so we rebuild the same shape here.
    async function saveStateWrapper(
      invoke: () => Promise<{ ok: true } | { ok: false; error: string }>
    ): Promise<void> {
      const result = await invoke();
      if (!result.ok) {
        throw new Error(result.error);
      }
    }

    await expect(
      saveStateWrapper(async () => ({ ok: false, error: 'value_too_large' }))
    ).rejects.toThrow('value_too_large');

    await expect(saveStateWrapper(async () => ({ ok: true }))).resolves.toBeUndefined();
  });
});
