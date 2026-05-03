import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Wave 0d.3 (#249): db.ts no longer imports `electron`. Tests inject the
// data dir directly via `initDb(dataDir)` instead of mocking `app.getPath`.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-db-test-'));
let tmpDir = tmpRoot;

async function freshDb() {
  // Reset the module-local singleton AND the cached dataDir between tests
  // so the next initDb() call binds to a brand-new tmp directory.
  const mod = await import('../db');
  mod.closeDb();
  mod.__resetDataDirForTests();
  tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  mod.initDb(tmpDir);
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
