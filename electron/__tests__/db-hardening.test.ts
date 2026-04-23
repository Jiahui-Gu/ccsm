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

describe('db hardening: corrupt JSON in messages', () => {
  it('loadMessages skips a row whose content is not valid JSON', async () => {
    const mod = await freshDb();
    const { saveMessages, loadMessages, getDb } = mod;

    saveMessages('s-1', [
      { id: 'b1', kind: 'user', text: 'good before' },
      { id: 'b2', kind: 'user', text: 'good after' }
    ]);

    // Inject corruption directly into the row that already exists. Bypasses
    // the cached prepared statements so we know loadMessages re-reads the
    // raw column on each call.
    getDb().prepare('UPDATE messages SET content = ? WHERE id = ?').run('{not valid json', 'b1');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rows: unknown[] = [];
    expect(() => {
      rows = loadMessages('s-1');
    }).not.toThrow();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { id: string }).id).toBe('b2');
    expect(warn).toHaveBeenCalledWith(
      '[db] corrupt message row sessionId=%s id=%s',
      's-1',
      'b1'
    );
    warn.mockRestore();
  });
});

describe('db hardening: startup integrity check', () => {
  it('initDb backs up a corrupt file and opens a fresh empty database', async () => {
    const mod = await freshDb();
    mod.closeDb();

    // Pre-seed the userData dir with a garbage file under the canonical
    // name. SQLite will accept the open() (it's lazy) but the first pragma
    // call inside ensureHealthyDb() will report corruption.
    const file = path.join(tmpDir, 'agentory.db');
    fs.writeFileSync(file, Buffer.from('not a sqlite database, just bytes'));

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { initDb, loadMessages, saveState, loadState } = mod;
    expect(() => initDb()).not.toThrow();

    // Original file got renamed aside.
    const siblings = fs.readdirSync(tmpDir);
    const backup = siblings.find((n) => n.startsWith('agentory.db.corrupt-'));
    expect(backup, `expected a *.corrupt-* backup, saw ${siblings.join(', ')}`).toBeTruthy();

    // Fresh DB is usable end-to-end.
    expect(loadMessages('any')).toEqual([]);
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
    const { getDb, loadMessages, saveState } = mod;

    const realPrepare = getDb().prepare.bind(getDb());
    const spy = vi.spyOn(getDb(), 'prepare').mockImplementation((sql: string) => realPrepare(sql));

    // First touch compiles.
    loadMessages('s-x');
    saveState('k', 'v');
    const callsAfterFirst = spy.mock.calls.length;

    // Subsequent touches must NOT recompile — the cache should serve them.
    for (let i = 0; i < 5; i++) {
      loadMessages('s-x');
      saveState('k', `v${i}`);
    }
    expect(spy.mock.calls.length).toBe(callsAfterFirst);

    spy.mockRestore();
  });
});
