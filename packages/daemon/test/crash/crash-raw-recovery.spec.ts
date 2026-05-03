// packages/daemon/test/crash/crash-raw-recovery.spec.ts
//
// Boot-replay recovery for crash-raw.ndjson — covers the silent-loss
// failure modes called out by spec ch09 §6.2:
//   (a) partial line at end of file (producer killed mid-write)
//   (b) file missing (first-ever boot)
//   (c) file present but empty (steady-state)
//   (d) malformed entries (non-JSON, missing fields)
//   (e) truncation race (daemon killed during truncate, i.e. between
//       INSERT and TRUNCATE — replay must be idempotent)
//
// Plus the headline acceptance test from the task description:
//   "append 100 entries → kill before flush → boot → all 100 appear in
//    crash table once."
// We exercise this by spawning a child that synchronously appends 100
// entries and SIGKILLs itself before the process exit hooks run, then
// calling replayCrashRawOnBoot in the parent and asserting 100 distinct
// rows in `crash_log`.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/db/sqlite.js';
import {
  appendCrashRaw,
  replayCrashRawOnBoot,
  type CrashRawEntry,
} from '../../src/crash/raw-appender.js';

// ---------------------------------------------------------------------------
// Test fixtures: a fresh tmp dir per test holding the NDJSON file + a
// :memory: SQLite DB seeded with the `crash_log` table from the v0.3
// baseline schema (columns mirrored from migrations/001_initial.sql §87).
// We don't run the migration runner here — that's a separate task's
// concern; we just need the table shape to match production.
// ---------------------------------------------------------------------------

const CRASH_LOG_DDL = `
  CREATE TABLE crash_log (
    id          TEXT PRIMARY KEY,
    ts_ms       INTEGER NOT NULL,
    source      TEXT NOT NULL,
    summary     TEXT NOT NULL,
    detail      TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '{}',
    owner_id    TEXT NOT NULL DEFAULT 'daemon-self'
  );
`;

interface Fixture {
  dir: string;
  ndjsonPath: string;
  dbPath: string;
  db: SqliteDatabase;
}

function setup(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccsm-crashraw-'));
  const ndjsonPath = path.join(dir, 'crash-raw.ndjson');
  const dbPath = path.join(dir, 'ccsm.db');
  const db = openDatabase(dbPath);
  db.exec(CRASH_LOG_DDL);
  return { dir, ndjsonPath, dbPath, db };
}

function teardown(fx: Fixture): void {
  try {
    fx.db.close();
  } catch {
    // ignore — tests may have closed already
  }
  rmSync(fx.dir, { recursive: true, force: true });
}

let fx: Fixture;
beforeEach(() => {
  fx = setup();
});
afterEach(() => {
  teardown(fx);
});

function makeEntry(i: number, overrides: Partial<CrashRawEntry> = {}): CrashRawEntry {
  return {
    id: `01H000000000000000000000${String(i).padStart(2, '0')}`,
    ts_ms: 1_714_600_000_000 + i,
    source: 'sqlite_open',
    summary: `crash #${i}`,
    detail: `stack trace lines for #${i}\nframe1\nframe2`,
    labels: { iter: String(i) },
    owner_id: 'daemon-self',
    ...overrides,
  };
}

function rowCount(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM crash_log').get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Headline acceptance: 100 entries → child SIGKILL → replay → 100 rows.
// ---------------------------------------------------------------------------

describe('crash-raw appender + replay', () => {
  it('100 entries appended in a child SIGKILLed before normal exit replay into crash_log exactly once', () => {
    // The child writes 100 entries via the same `appendCrashRaw` we ship.
    // After write 100 it raises SIGKILL on itself — no `process.exit`,
    // no atexit, no fs.close beyond what each appendCrashRaw call already
    // did. This exercises the "kill before flush" property: every entry
    // fsynced inside the appender must survive.
    //
    // We invoke the child by piping a small JS program into `node --input-type=module`.
    // No build step needed; the program inlines `fs` calls equivalent to
    // appendCrashRaw so we don't depend on the daemon's TS being compiled
    // for the test host. We also assert the byte-for-byte line shape
    // matches `appendCrashRaw` by additionally writing one entry from the
    // parent and diffing.

    const child = `
      import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
      const ndjsonPath = ${JSON.stringify(fx.ndjsonPath)};
      function append(entry) {
        const line = JSON.stringify(entry) + '\\n';
        const fd = openSync(ndjsonPath, 'a', 0o600);
        try { writeSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
      }
      for (let i = 0; i < 100; i++) {
        append({
          id: '01H000000000000000000000' + String(i).padStart(2, '0'),
          ts_ms: 1714600000000 + i,
          source: 'sqlite_open',
          summary: 'crash #' + i,
          detail: 'stack trace lines for #' + i + '\\nframe1\\nframe2',
          labels: { iter: String(i) },
          owner_id: 'daemon-self',
        });
      }
      process.kill(process.pid, 'SIGKILL');
    `;

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', child],
      { stdio: 'pipe' },
    );
    // SIGKILL: signal field is 'SIGKILL' on POSIX; on Windows, signals are
    // emulated and the child exits with a nonzero status. Either way the
    // file should already hold 100 fsynced lines.
    expect(result.status === null || result.status !== 0).toBe(true);

    // Verify file holds 100 newline-terminated lines.
    const fileBytes = readFileSync(fx.ndjsonPath, 'utf8');
    const lines = fileBytes.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(100);

    // Boot replay.
    const r = replayCrashRawOnBoot({ path: fx.ndjsonPath, db: fx.db });
    expect(r.linesRead).toBe(100);
    expect(r.inserted).toBe(100);
    expect(r.malformed).toBe(0);
    expect(r.fileMissing).toBe(false);
    expect(rowCount(fx.db)).toBe(100);

    // File truncated to 0 bytes after successful import.
    expect(statSync(fx.ndjsonPath).size).toBe(0);

    // Idempotence: re-running replay on the now-empty file changes nothing.
    const r2 = replayCrashRawOnBoot({ path: fx.ndjsonPath, db: fx.db });
    expect(r2.inserted).toBe(0);
    expect(rowCount(fx.db)).toBe(100);
  });

  // -------------------------------------------------------------------------
  // ch09 §6.2 case (a): partial line at EOF.
  // -------------------------------------------------------------------------
  it('drops a trailing partial line and imports the complete prefix', () => {
    appendCrashRaw(fx.ndjsonPath, makeEntry(1));
    appendCrashRaw(fx.ndjsonPath, makeEntry(2));
    // Simulate a producer killed mid-write: append a partial JSON object
    // with no trailing newline. This must NOT crash the replay and must
    // NOT be inserted.
    writeFileSync(fx.ndjsonPath, '{"id":"partial","ts_ms":1', { flag: 'a' });

    const r = replayCrashRawOnBoot({ path: fx.ndjsonPath, db: fx.db });
    expect(r.linesRead).toBe(2);
    expect(r.inserted).toBe(2);
    expect(r.malformed).toBe(0);
    expect(rowCount(fx.db)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // ch09 §6.2 case (b): file missing.
  // -------------------------------------------------------------------------
  it('returns fileMissing=true and inserts nothing when the file does not exist', () => {
    const r = replayCrashRawOnBoot({ path: fx.ndjsonPath, db: fx.db });
    expect(r.fileMissing).toBe(true);
    expect(r.inserted).toBe(0);
    expect(rowCount(fx.db)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // ch09 §6.2 case (c): file present but empty.
  // -------------------------------------------------------------------------
  it('returns 0/0 and does not error on an empty file', () => {
    writeFileSync(fx.ndjsonPath, '');
    const r = replayCrashRawOnBoot({ path: fx.ndjsonPath, db: fx.db });
    expect(r.fileMissing).toBe(false);
    expect(r.linesRead).toBe(0);
    expect(r.inserted).toBe(0);
    expect(r.malformed).toBe(0);
    expect(rowCount(fx.db)).toBe(0);
    // Truncate is a no-op on already-empty file; must remain empty.
    expect(statSync(fx.ndjsonPath).size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // ch09 §6.2 case (d): malformed entries (non-JSON, missing fields).
  // -------------------------------------------------------------------------
  it('skips malformed lines (non-JSON, missing fields) without blocking valid ones', () => {
    appendCrashRaw(fx.ndjsonPath, makeEntry(1));
    // Non-JSON garbage line.
    writeFileSync(fx.ndjsonPath, 'not even json\n', { flag: 'a' });
    // JSON but missing required fields.
    writeFileSync(fx.ndjsonPath, '{"id":"x"}\n', { flag: 'a' });
    // JSON with wrong type for a required field.
    writeFileSync(
      fx.ndjsonPath,
      '{"id":"y","ts_ms":"not a number","source":"s","summary":"","detail":"","owner_id":"daemon-self"}\n',
      { flag: 'a' },
    );
    appendCrashRaw(fx.ndjsonPath, makeEntry(2));

    const r = replayCrashRawOnBoot({ path: fx.ndjsonPath, db: fx.db });
    expect(r.malformed).toBe(3);
    expect(r.inserted).toBe(2);
    expect(rowCount(fx.db)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // ch09 §6.2 case (e): truncation race. Daemon killed AFTER inserting
  // some rows but BEFORE truncating. Re-replay must dedup and not double-
  // import; should still inserted=0 the second time around because the
  // first call's INSERT OR IGNORE already landed those rows.
  // -------------------------------------------------------------------------
  it('idempotent across crash-after-insert-before-truncate (PRIMARY KEY dedup)', () => {
    for (let i = 1; i <= 5; i++) appendCrashRaw(fx.ndjsonPath, makeEntry(i));

    // Simulate the first replay's INSERT pass landing but the truncate
    // never happening: insert all rows directly into crash_log, then run
    // replayCrashRawOnBoot (file is still full). The replay should
    // INSERT-OR-IGNORE → 0 new inserts → then truncate the file.
    const insertStmt = fx.db.prepare(
      `INSERT INTO crash_log (id, ts_ms, source, summary, detail, labels_json, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 1; i <= 5; i++) {
      const e = makeEntry(i);
      insertStmt.run(
        e.id,
        e.ts_ms,
        e.source,
        e.summary,
        e.detail,
        JSON.stringify(e.labels),
        e.owner_id,
      );
    }
    expect(rowCount(fx.db)).toBe(5);
    // Sanity: file still has 5 lines waiting to be replayed.
    expect(readFileSync(fx.ndjsonPath, 'utf8').split('\n').filter(Boolean)).toHaveLength(5);

    const r = replayCrashRawOnBoot({ path: fx.ndjsonPath, db: fx.db });
    expect(r.linesRead).toBe(5);
    expect(r.inserted).toBe(0); // all dedup'd by PRIMARY KEY
    expect(r.malformed).toBe(0);
    expect(rowCount(fx.db)).toBe(5); // still exactly 5
    // File truncated this time around.
    expect(statSync(fx.ndjsonPath).size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // owner_id required + carried through unchanged (ch09 §1 attribution).
  // -------------------------------------------------------------------------
  it('carries owner_id verbatim — daemon-self sentinel and principalKey both round-trip', () => {
    appendCrashRaw(
      fx.ndjsonPath,
      makeEntry(1, { owner_id: 'daemon-self', source: 'sqlite_open' }),
    );
    appendCrashRaw(
      fx.ndjsonPath,
      makeEntry(2, { owner_id: 'unix-user:1000', source: 'claude_exit' }),
    );
    appendCrashRaw(
      fx.ndjsonPath,
      makeEntry(3, {
        owner_id: 'win-sid:S-1-5-21-1234567890-1234567890-1234567890-1001',
        source: 'pty_eof',
      }),
    );

    const r = replayCrashRawOnBoot({ path: fx.ndjsonPath, db: fx.db });
    expect(r.inserted).toBe(3);

    const rows = fx.db
      .prepare('SELECT id, source, owner_id FROM crash_log ORDER BY id')
      .all() as Array<{ id: string; source: string; owner_id: string }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]?.owner_id).toBe('daemon-self');
    expect(rows[1]?.owner_id).toBe('unix-user:1000');
    expect(rows[2]?.owner_id).toBe(
      'win-sid:S-1-5-21-1234567890-1234567890-1234567890-1001',
    );
  });

  // -------------------------------------------------------------------------
  // Line shape locked: the wire JSON for an appended entry parses to the
  // exact field set in spec ch09 §2 example, no extras.
  // -------------------------------------------------------------------------
  it('emits exactly the spec ch09 §2 line shape (no extra fields, all required present)', () => {
    appendCrashRaw(fx.ndjsonPath, makeEntry(7));
    const text = readFileSync(fx.ndjsonPath, 'utf8').trim();
    const obj = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(obj).sort()).toEqual(
      ['detail', 'id', 'labels', 'owner_id', 'source', 'summary', 'ts_ms'].sort(),
    );
    expect(obj.owner_id).toBe('daemon-self');
  });

  // -------------------------------------------------------------------------
  // Sanity: appendCrashRaw + node child line shape are byte-identical.
  // Locks the wire so a future refactor of `serialiseEntry` cannot drift
  // away from JSON.stringify of the literal field-ordered object.
  // -------------------------------------------------------------------------
  it('parent-process append line is byte-identical to a child node script', () => {
    const entry = makeEntry(42);
    appendCrashRaw(fx.ndjsonPath, entry);
    const parentLine = readFileSync(fx.ndjsonPath, 'utf8');

    const childPath = path.join(fx.dir, 'child-out.ndjson');
    const childScript = `
      import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
      const e = ${JSON.stringify(entry)};
      const line = JSON.stringify({
        id: e.id, ts_ms: e.ts_ms, source: e.source, summary: e.summary,
        detail: e.detail, labels: e.labels, owner_id: e.owner_id,
      }) + '\\n';
      const fd = openSync(${JSON.stringify(childPath)}, 'a', 0o600);
      try { writeSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', childScript]);
    const childLine = readFileSync(childPath, 'utf8');
    expect(parentLine).toBe(childLine);
  });
});
