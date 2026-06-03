// Writer fixture for the WAL-durability regression test
// (`db-hardening.test.ts` → "db hardening: WAL durability …").
//
// This runs in a SEPARATE process so the parent test can SIGKILL it — the
// only faithful way to reproduce a non-graceful shutdown (OS restart / power
// loss / force-kill). An in-process test cannot reproduce the bug: as long as
// the test process is alive, db.ts's connection is alive, and an independent
// reader still sees the WAL contents. The data is only "lost" once the owning
// process dies AND the WAL is discarded.
//
// It mirrors the EXACT pragma sequence of `electron/db.ts`'s `initDb` +
// `saveState` for the `app_state` table. The two behaviours under test are
// gated by env so one fixture drives both the RED and GREEN arms:
//   SYNC_FULL=1  -> `synchronous = FULL` at open   (db.ts edit #1)
//   CHECKPOINT=1 -> `wal_checkpoint(PASSIVE)` per write (db.ts edit #2)
// With neither set, this is byte-for-byte the *current* (buggy) db.ts path.
//
// Keep this in sync with electron/db.ts if that pragma sequence ever changes.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

const file = process.env.DBFILE;
const key = process.env.STATE_KEY || 'main';
const value = process.env.STATE_VALUE || 'written';

const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
if (process.env.SYNC_FULL === '1') db.exec('PRAGMA synchronous = FULL');
db.exec(
  'CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
);
const upsert = db.prepare(
  'INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
);

// A handful of writes, like a real session of edits. None of these come close
// to the default wal_autocheckpoint threshold (~4 MB), so on the buggy path
// they all live only in the -wal sidecar.
for (let i = 0; i < 50; i++) {
  upsert.run(key, 'v' + i, Date.now());
  if (process.env.CHECKPOINT === '1') db.exec('PRAGMA wal_checkpoint(PASSIVE)');
}
upsert.run(key, value, Date.now());
if (process.env.CHECKPOINT === '1') db.exec('PRAGMA wal_checkpoint(PASSIVE)');

// Signal the parent that the write is committed, then hang. We deliberately
// never call db.close() — the parent SIGKILLs us, which is what a forced
// shutdown looks like (no `before-quit` → `closeDb` checkpoint).
fs.writeFileSync(file + '.ready', '1');
setInterval(() => {}, 1 << 30);
