import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

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

describe('db: messages table', () => {
  it('returns [] for an unknown session', async () => {
    const { loadMessages } = await freshDb();
    expect(loadMessages('s-none')).toEqual([]);
  });

  it('roundtrips blocks in insertion order', async () => {
    const { loadMessages, saveMessages } = await freshDb();
    const blocks = [
      { id: 'b1', kind: 'user', text: 'hello' },
      { id: 'b2', kind: 'assistant', text: 'hi' },
      { id: 'b3', kind: 'tool', name: 'Bash', brief: 'ls' }
    ];
    saveMessages('s-1', blocks);
    expect(loadMessages('s-1')).toEqual(blocks);
  });

  it('bulk-save replaces prior rows for that session', async () => {
    const { loadMessages, saveMessages } = await freshDb();
    saveMessages('s-1', [{ id: 'a', kind: 'user', text: 'first' }]);
    saveMessages('s-1', [
      { id: 'b', kind: 'user', text: 'second' },
      { id: 'c', kind: 'assistant', text: 'reply' }
    ]);
    const rows = loadMessages('s-1') as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('isolates rows by sessionId', async () => {
    const { loadMessages, saveMessages } = await freshDb();
    saveMessages('s-A', [{ id: 'x', kind: 'user', text: 'A' }]);
    saveMessages('s-B', [{ id: 'y', kind: 'user', text: 'B' }]);
    expect((loadMessages('s-A') as Array<{ id: string }>).map((r) => r.id)).toEqual(['x']);
    expect((loadMessages('s-B') as Array<{ id: string }>).map((r) => r.id)).toEqual(['y']);
  });

  it('saving [] clears existing rows (used on delete)', async () => {
    const { loadMessages, saveMessages } = await freshDb();
    saveMessages('s-1', [{ id: 'a', kind: 'user', text: 'hi' }]);
    saveMessages('s-1', []);
    expect(loadMessages('s-1')).toEqual([]);
  });
});
