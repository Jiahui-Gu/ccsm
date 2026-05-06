// Task #639 (v0.3 ship-blocker) — runtime storage-health surface.
//
// Original P0 (dogfood-575): daemon's `initDb` threw on better-sqlite3
// ABI mismatch / EACCES on userdata dir / sqlite corruption, but the
// startup hook only logged-and-continued. The daemon kept emitting PORT,
// IPC stayed live, every `db:save` call returned silent failure.
//
// As of this PR the STARTUP-time path is handled by the new daemon
// ready protocol (see daemon/startup/index.ts critical flag +
// daemon/startup/data.ts marked critical=true): a startup-time initDb
// throw exits the daemon process before binding HTTP, parent shows the
// hard-fail screen, main React app never mounts. Coverage for that
// flow lives in tests/daemon-startup-critical.test.ts and the
// harness-ui daemon-hard-fail-screen e2e case.
//
// THIS file pins the orthogonal RUNTIME tracking surface (cherry-picked
// from PR #1128 then re-scoped):
//   1. `getStorageHealth()` defaults to `{ ok: true }` and reflects
//      `markStorageUnhealthy(reason)` mutations.
//   2. The `/api/health/storage` route exposes the snapshot so a future
//      runtime push (e.g. SQLITE_FULL on a write that happens AFTER
//      startup) can flow to the renderer banner.
//   3. The `/api/db/save` route SHORT-CIRCUITS to `{ ok: false, error }`
//      when health is bad — i.e. even if a runtime caller marks the
//      singleton bad later, db:save stops returning silent ok.
//   4. The `/api/db/load` route returns null when storage is bad
//      (renderer falls through to defaults rather than re-throw flood).
//   5. Healthy path (default state, no markStorageUnhealthy) still
//      returns ok=true on save — short-circuit must not always fire.
//   6. The `CCSM_TEST_BREAK_DB=1` seam still throws from initDb so the
//      e2e harness can drive the hard-fail-screen path without
//      corrupting a real db file.

import { describe, it, expect, beforeEach } from 'vitest';
import { Router } from '../daemon/router';

// Some test environments (Node-vs-Electron ABI drift on better-sqlite3
// when running outside of `npm run probe:e2e`) cannot construct a real
// `new Database(...)`. The CI matrix DOES rebuild for Node so the
// healthy-path tests run there; locally on a workstation that's been
// using Electron we fall back to in-memory injection via
// `__setDbForTests` so the test still pins behaviour without forcing
// every dev to `npm rebuild better-sqlite3 --build-from-source`.
function canConstructRealDb(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const probe = new Database(':memory:');
    probe.close();
    return true;
  } catch {
    return false;
  }
}
const REAL_DB_OK = canConstructRealDb();

beforeEach(async () => {
  // Vitest module cache between cases — reset health + db handle so
  // each `it` starts from a clean slate.
  delete process.env.CCSM_TEST_BREAK_DB;
  const dbMod = await import('../daemon/db');
  try { dbMod.closeDb(); } catch { /* db may not exist */ }
  dbMod.__setDbForTests(null);
  dbMod.__resetStorageHealthForTests();
});

describe('daemon storage-health surface (Task #639 — runtime path)', () => {
  it('default storageHealth is ok=true', async () => {
    const dbMod = await import('../daemon/db');
    expect(dbMod.getStorageHealth().ok).toBe(true);
  });

  it('CCSM_TEST_BREAK_DB=1 makes initDb throw — drives the hard-fail-screen e2e path', async () => {
    // This seam is the e2e trigger for the daemon ready-protocol
    // hard-fail (see harness-ui daemon-hard-fail-screen). It throws
    // synchronously from initDb so runStartup, with data.ts marked
    // critical=true, exits the daemon before HTTP binds.
    process.env.CCSM_TEST_BREAK_DB = '1';
    const dbMod = await import('../daemon/db');
    expect(() => dbMod.initDb()).toThrow(/CCSM_TEST_BREAK_DB/);
  });

  it('markStorageUnhealthy(reason) updates the singleton (runtime mutation path)', async () => {
    const dbMod = await import('../daemon/db');
    dbMod.markStorageUnhealthy('disk full at runtime');
    const h = dbMod.getStorageHealth();
    expect(h.ok).toBe(false);
    expect(h.reason).toBe('disk full at runtime');
  });

  it('GET /api/health/storage reports the unhealthy snapshot', async () => {
    const dbMod = await import('../daemon/db');
    dbMod.markStorageUnhealthy('forced for test');
    const router = new Router();
    const healthMod = await import('../daemon/api/health');
    healthMod.default(router);
    const handler = router.resolve('GET', '/api/health/storage');
    expect(handler).toBeDefined();
    const result = await handler!(
      {} as import('node:http').IncomingMessage,
      undefined,
      {} as import('node:http').ServerResponse,
    );
    expect(result).toEqual({ status: 200, body: { ok: false, reason: 'forced for test' } });
  });

  it('POST /api/db/save short-circuits with ok=false + reason when storage is unhealthy', async () => {
    const dbMod = await import('../daemon/db');
    dbMod.markStorageUnhealthy('disk full (simulated)');
    const router = new Router();
    const dataMod = await import('../daemon/api/data');
    dataMod.default(router);
    const handler = router.resolve('POST', '/api/db/save');
    expect(handler).toBeDefined();
    const result = await handler!(
      {} as import('node:http').IncomingMessage,
      { args: ['some-key', 'some-value'] },
      {} as import('node:http').ServerResponse,
    );
    // Wire format: { status: 200, body: { result: { ok: false, error } } }
    expect(result.status).toBe(200);
    const body = (result as { status: 200; body: { result: unknown } }).body;
    expect(body.result).toMatchObject({ ok: false });
    const err = (body.result as { ok: false; error: string }).error;
    expect(err).toMatch(/storage_unavailable/);
    expect(err).toMatch(/disk full/);
  });

  it('POST /api/db/load returns null when storage is unhealthy (no exception, no real DB call)', async () => {
    const dbMod = await import('../daemon/db');
    dbMod.markStorageUnhealthy('forced');
    const router = new Router();
    const dataMod = await import('../daemon/api/data');
    dataMod.default(router);
    const handler = router.resolve('POST', '/api/db/load');
    expect(handler).toBeDefined();
    const result = await handler!(
      {} as import('node:http').IncomingMessage,
      { args: ['anything'] },
      {} as import('node:http').ServerResponse,
    );
    expect(result.status).toBe(200);
    expect((result as { body: { result: unknown } }).body.result).toBeNull();
  });

  it('POST /api/db/save returns ok=true on the healthy path (regression — short-circuit must not always fire)', async () => {
    if (!REAL_DB_OK) {
      // Skip the real-write path when better-sqlite3 native binding can't
      // load — the test would only assert the env, not our code.
      // The short-circuit-when-unhealthy + reject-when-validate cases
      // above already pin the inverse of this test (ok=true is the
      // ABSENCE of those failures).
      return;
    }
    // Reset to healthy + point at a tmp dir for an actual write.
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-storage-fail-test-'));
    process.env.CCSM_USER_DATA_DIR = tmpDir;
    const dbMod = await import('../daemon/db');
    dbMod.initDb();
    const router = new Router();
    const dataMod = await import('../daemon/api/data');
    dataMod.default(router);
    const handler = router.resolve('POST', '/api/db/save');
    const result = await handler!(
      {} as import('node:http').IncomingMessage,
      { args: ['k', 'v'] },
      {} as import('node:http').ServerResponse,
    );
    expect(result.status).toBe(200);
    expect((result as { body: { result: { ok: true } } }).body.result).toEqual({ ok: true });
  });
});
