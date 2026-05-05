import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Wave-2 A: db.ts now reads `CCSM_USER_DATA_DIR` from env (no more electron
// `app.getPath`). Point it at a per-test tmp dir so real app data isn't
// touched and each test gets a fresh database.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-db-test-'));
let tmpDir = tmpRoot;

async function freshDb() {
  // Reset the module-local singleton between tests.
  const mod = await import('../db');
  mod.closeDb();
  tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  process.env.CCSM_USER_DATA_DIR = tmpDir;
  return mod;
}

beforeEach(async () => {
  await freshDb();
});

describe('db: surface', () => {
  // Both the `messages` table (PR-H, replaced by JSONL loader) and the
  // `claudeBinPath` helpers (PR-I, the wizard that wrote them is gone)
  // were deleted, taking their bespoke test suites with them. The
  // remaining `loadState` / `saveState` + integrity-check + schema
  // versioning are exercised by `db-hardening.test.ts`. We keep a
  // placeholder here so the test runner still discovers the file and
  // future db features have an obvious place to land.
  it('placeholder', () => {
    expect(true).toBe(true);
  });
});
