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

describe('db: claudeBinPath', () => {
  it('returns null when unset', async () => {
    const { loadClaudeBinPath } = await freshDb();
    expect(loadClaudeBinPath()).toBeNull();
  });

  it('roundtrips a saved path', async () => {
    const { loadClaudeBinPath, saveClaudeBinPath } = await freshDb();
    saveClaudeBinPath('/opt/claude/bin/claude');
    expect(loadClaudeBinPath()).toBe('/opt/claude/bin/claude');
  });

  it('clears when passed null / empty string', async () => {
    const { loadClaudeBinPath, saveClaudeBinPath } = await freshDb();
    saveClaudeBinPath('/tmp/claude');
    saveClaudeBinPath(null);
    expect(loadClaudeBinPath()).toBeNull();
    saveClaudeBinPath('/tmp/claude');
    saveClaudeBinPath('');
    expect(loadClaudeBinPath()).toBeNull();
  });
});
