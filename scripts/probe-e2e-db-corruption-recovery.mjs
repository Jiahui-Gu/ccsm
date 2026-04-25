// E2E: pre-corrupt the on-disk SQLite file before launch and verify
// CCSM boots without crashing, the corrupt file is moved aside to
// `ccsm.db.corrupt-*`, and a brand-new empty database takes its place.
//
// Strategy:
//   1. Create an isolated userData dir with `--user-data-dir=…` (matches
//      the pattern used by probe-e2e-connection-pane and friends).
//   2. Write 256 bytes of random garbage to `ccsm.db` inside that dir
//      BEFORE launching electron. SQLite will accept the open() — it's
//      lazy — and the first read pragma inside initDb() will trip
//      `quick_check`, which is our corruption gate.
//   3. Launch electron and wait for the renderer to mount (sidebar visible
//      = main process didn't crash on db init).
//   4. Inspect the userData dir: assert (a) at least one file matching
//      `ccsm.db.corrupt-*` exists (the backup) and (b) the new
//      `ccsm.db` is a valid SQLite header (starts with "SQLite format 3\0").
//
// Pre-fix verification: if `ensureHealthyDb` is removed from electron/db.ts,
// `new Database(file)` succeeds but the first `pragma('journal_mode = WAL')`
// throws SqliteError "file is not a database", crashing the main process
// before the renderer ever loads — playwright's appWindow() then times out.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-db-corruption-recovery] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'agentory-probe-db-corrupt-')
);
console.log(`[probe-e2e-db-corruption-recovery] userData = ${userDataDir}`);

// Pre-seed the userData dir with garbage at the canonical db path. 256 bytes
// is enough to defeat SQLite's header check while staying small enough that
// the test suite stays snappy.
const dbFile = path.join(userDataDir, 'ccsm.db');
fs.writeFileSync(dbFile, crypto.randomBytes(256));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  // CCSM_PROD_BUNDLE=1 forces main to loadFile() the bundled renderer
  // instead of trying to loadURL(http://localhost:4100). This probe is
  // about main-process db init, not renderer hot reload — we don't want to
  // require a webpack-dev-server side-process.
  env: { ...process.env, CCSM_PROD_BUNDLE: '1' }
});

try { // ccsm-probe-cleanup-wrap

// Surface main-process stderr so a crash inside initDb shows up here
// instead of silently timing out the renderer wait below.
app.process().stderr?.on('data', (b) => {
  process.stderr.write(`[main-stderr] ${b.toString()}`);
});

let win;
try {
  win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  // Renderer mounted = main process survived db init. We don't care which
  // pane shows because the DB is empty anyway; checking for ANY top-level
  // app shell (sidebar OR main empty-state CTA) is the loosest "alive"
  // signal we can use without coupling to current copy.
  await win.waitForFunction(
    () =>
      document.querySelector('aside') !== null ||
      document.querySelector('main button') !== null,
    null,
    { timeout: 15_000 }
  );
} catch (err) {
  await app.close().catch(() => {});
  fail(`app failed to boot after pre-corrupted db: ${err?.message ?? err}`);
}

// Give initDb a beat to flush the rename + recreate. The pragma + rename
// are synchronous inside initDb so this is paranoia, but cheap.
await win.waitForTimeout(250);

const siblings = fs.readdirSync(userDataDir);
const backups = siblings.filter((n) => n.startsWith('ccsm.db.corrupt-'));
if (backups.length === 0) {
  await app.close();
  fail(
    `expected at least one ccsm.db.corrupt-* backup; saw ${JSON.stringify(siblings)}`
  );
}

// New db must be a real SQLite file. The magic header is the literal ASCII
// "SQLite format 3\0" — 16 bytes at offset 0.
if (!fs.existsSync(dbFile)) {
  await app.close();
  fail('expected a fresh ccsm.db to exist after recovery');
}
const header = fs.readFileSync(dbFile).subarray(0, 16);
const expected = Buffer.concat([Buffer.from('SQLite format 3'), Buffer.from([0])]);
if (!header.equals(expected)) {
  await app.close();
  fail(`new ccsm.db is not a SQLite file; header=${header.toString('hex')}`);
}

await app.close();
try {
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

console.log('\n[probe-e2e-db-corruption-recovery] OK');
console.log(`  pre-corrupted ${dbFile} (256 random bytes)`);
console.log(`  app booted, backup created (${backups.join(', ')}), fresh db is valid SQLite`);
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
