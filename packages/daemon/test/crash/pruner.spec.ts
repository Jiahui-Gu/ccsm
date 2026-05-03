// packages/daemon/test/crash/pruner.spec.ts
//
// Sink tests for the crash retention pruner (Task #64 / T5.12).
//
// Uses an in-memory DB seeded with the real `001_initial.sql` migration
// so the `crash_log` schema matches production. Cadence + warmup tests
// use `vi.useFakeTimers` — we do NOT actually wait 30s / 6h.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/db/sqlite.js';
import { runMigrations } from '../../src/db/migrations/runner.js';
import {
  CrashPruner,
  PRUNE_INTERVAL_MS,
  STARTUP_WARMUP_MS,
  type PrunerLogger,
} from '../../src/crash/pruner.js';

function makeDb(): SqliteDatabase {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

interface CapturedLog {
  info: string[];
  warn: string[];
}

function makeLogger(): { log: PrunerLogger; captured: CapturedLog } {
  const captured: CapturedLog = { info: [], warn: [] };
  const log: PrunerLogger = {
    info: (line) => captured.info.push(line),
    warn: (line) => captured.warn.push(line),
  };
  return { log, captured };
}

interface SeedRow {
  id: string;
  tsMs: number;
  source?: string;
}

function seedCrashes(db: SqliteDatabase, rows: ReadonlyArray<SeedRow>): void {
  const stmt = db.prepare(
    "INSERT INTO crash_log (id, ts_ms, source, summary, detail, labels_json, owner_id) " +
      "VALUES (?, ?, ?, '', '', '{}', 'daemon-self')",
  );
  for (const r of rows) stmt.run(r.id, r.tsMs, r.source ?? 'test');
}

function countCrashes(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM crash_log').get() as {
    n: number;
  };
  return row.n;
}

describe('CrashPruner.runOnce — age cap (T5.12 — ch09 §3)', () => {
  let db: SqliteDatabase;
  afterEach(() => db?.close());

  it('deletes rows with ts_ms < (now - max_age_days*86400000)', () => {
    db = makeDb();
    const NOW = 1_714_600_000_000;
    const MS_PER_DAY = 86_400_000;
    seedCrashes(db, [
      { id: '01-old', tsMs: NOW - 100 * MS_PER_DAY }, // older than 90d
      { id: '02-old', tsMs: NOW - 91 * MS_PER_DAY }, // older than 90d
      { id: '03-edge', tsMs: NOW - 90 * MS_PER_DAY }, // exactly at 90d boundary — kept (ts_ms < cutoff is strict)
      { id: '04-recent', tsMs: NOW - 1 * MS_PER_DAY },
      { id: '05-now', tsMs: NOW },
    ]);
    const { log, captured } = makeLogger();
    const pruner = new CrashPruner({ db, log, now: () => NOW });
    const r = pruner.runOnce();
    expect(r).not.toBeNull();
    expect(r!.rowsDeletedAge).toBe(2);
    expect(r!.rowsDeletedCount).toBe(0);
    // The boundary row (= cutoff) survives because the cap is strict (<).
    expect(countCrashes(db)).toBe(3);
    // Log line shape — operators grep for both fields.
    expect(captured.info.some((l) => /rows_deleted_age=2/.test(l))).toBe(true);
    expect(captured.info.some((l) => /rows_deleted_count=0/.test(l))).toBe(true);
  });

  it('honours a user-supplied max_age_days within the hard cap', () => {
    db = makeDb();
    const NOW = 2_000_000_000_000;
    const MS_PER_DAY = 86_400_000;
    seedCrashes(db, [
      { id: 'a', tsMs: NOW - 8 * MS_PER_DAY }, // older than 7d
      { id: 'b', tsMs: NOW - 1 * MS_PER_DAY },
    ]);
    const { log } = makeLogger();
    const pruner = new CrashPruner({
      db,
      log,
      now: () => NOW,
      readSettings: () => ({ max_age_days: 7 }),
    });
    const r = pruner.runOnce()!;
    expect(r.rowsDeletedAge).toBe(1);
    expect(countCrashes(db)).toBe(1);
  });
});

describe('CrashPruner.runOnce — count cap (T5.12 — ch09 §3)', () => {
  let db: SqliteDatabase;
  afterEach(() => db?.close());

  it('deletes oldest rows beyond max_entries (after age pass)', () => {
    db = makeDb();
    const NOW = 1_700_000_000_000;
    // Seed 5 recent rows; cap to 3 → expect oldest 2 deleted.
    seedCrashes(db, [
      { id: 'r1', tsMs: NOW - 5 },
      { id: 'r2', tsMs: NOW - 4 },
      { id: 'r3', tsMs: NOW - 3 },
      { id: 'r4', tsMs: NOW - 2 },
      { id: 'r5', tsMs: NOW - 1 },
    ]);
    const { log, captured } = makeLogger();
    const pruner = new CrashPruner({
      db,
      log,
      now: () => NOW,
      readSettings: () => ({ max_entries: 3 }),
    });
    const r = pruner.runOnce()!;
    expect(r.rowsDeletedAge).toBe(0);
    expect(r.rowsDeletedCount).toBe(2);
    expect(countCrashes(db)).toBe(3);
    // The newest 3 survive.
    const ids = (
      db
        .prepare('SELECT id FROM crash_log ORDER BY ts_ms DESC')
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).toEqual(['r5', 'r4', 'r3']);
    expect(captured.info.some((l) => /rows_deleted_count=2/.test(l))).toBe(true);
  });

  it('runs both passes in a single transaction (count pass sees post-age state)', () => {
    db = makeDb();
    const NOW = 1_700_000_000_000;
    const MS_PER_DAY = 86_400_000;
    // 2 ancient rows + 4 recent; max_age=90d cuts the ancient; max_entries=3
    // then trims 1 of the recent — count pass MUST operate on post-age count.
    seedCrashes(db, [
      { id: 'old1', tsMs: NOW - 200 * MS_PER_DAY },
      { id: 'old2', tsMs: NOW - 100 * MS_PER_DAY },
      { id: 'r1', tsMs: NOW - 4 },
      { id: 'r2', tsMs: NOW - 3 },
      { id: 'r3', tsMs: NOW - 2 },
      { id: 'r4', tsMs: NOW - 1 },
    ]);
    const { log } = makeLogger();
    const pruner = new CrashPruner({
      db,
      log,
      now: () => NOW,
      readSettings: () => ({ max_entries: 3 }),
    });
    const r = pruner.runOnce()!;
    expect(r.rowsDeletedAge).toBe(2);
    expect(r.rowsDeletedCount).toBe(1); // r1 trimmed; r2/r3/r4 survive
    expect(countCrashes(db)).toBe(3);
  });

  it('is a no-op when crash_log is empty', () => {
    db = makeDb();
    const { log } = makeLogger();
    const pruner = new CrashPruner({ db, log, now: () => 1_700_000_000_000 });
    const r = pruner.runOnce()!;
    expect(r.rowsDeletedAge).toBe(0);
    expect(r.rowsDeletedCount).toBe(0);
  });
});

describe('CrashPruner.runOnce — clamp warnings (T5.12)', () => {
  let db: SqliteDatabase;
  afterEach(() => db?.close());

  it('warns once per cycle when settings clamp', () => {
    db = makeDb();
    const { log, captured } = makeLogger();
    const pruner = new CrashPruner({
      db,
      log,
      now: () => 1_700_000_000_000,
      readSettings: () => ({ max_entries: 99_999, max_age_days: 365 }),
    });
    pruner.runOnce();
    expect(captured.warn.some((l) => /max_entries clamped/.test(l))).toBe(true);
    expect(captured.warn.some((l) => /max_age_days clamped/.test(l))).toBe(true);
  });

  it('does not warn when settings are at-or-below the hard cap', () => {
    db = makeDb();
    const { log, captured } = makeLogger();
    const pruner = new CrashPruner({
      db,
      log,
      now: () => 1_700_000_000_000,
      readSettings: () => ({ max_entries: 5000, max_age_days: 30 }),
    });
    pruner.runOnce();
    expect(captured.warn).toEqual([]);
  });
});

describe('CrashPruner.start/stop — cadence (T5.12 — 30s warmup + 6h cycle)', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    vi.useFakeTimers();
    db = makeDb();
  });
  afterEach(() => {
    db?.close();
    vi.useRealTimers();
  });

  it('runs the first cycle after the 30s warmup, then every 6h', () => {
    const NOW = 1_700_000_000_000;
    vi.setSystemTime(NOW);
    const { log } = makeLogger();
    const pruner = new CrashPruner({ db, log });
    const spy = vi.spyOn(pruner, 'runOnce');

    pruner.start();
    // No run during the warmup.
    vi.advanceTimersByTime(STARTUP_WARMUP_MS - 1);
    expect(spy).not.toHaveBeenCalled();
    // First run lands at warmup boundary.
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);

    // 6h later → second run.
    vi.advanceTimersByTime(PRUNE_INTERVAL_MS);
    expect(spy).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PRUNE_INTERVAL_MS);
    expect(spy).toHaveBeenCalledTimes(3);

    pruner.stop();
  });

  it('stop() before warmup cancels the first run', () => {
    const { log } = makeLogger();
    const pruner = new CrashPruner({ db, log });
    const spy = vi.spyOn(pruner, 'runOnce');
    pruner.start();
    pruner.stop();
    vi.advanceTimersByTime(STARTUP_WARMUP_MS * 10);
    expect(spy).not.toHaveBeenCalled();
  });

  it('stop() after warmup cancels the steady-state cadence', () => {
    const { log } = makeLogger();
    const pruner = new CrashPruner({ db, log });
    const spy = vi.spyOn(pruner, 'runOnce');
    pruner.start();
    vi.advanceTimersByTime(STARTUP_WARMUP_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    pruner.stop();
    vi.advanceTimersByTime(PRUNE_INTERVAL_MS * 5);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('start() twice warns and is a no-op', () => {
    const { log, captured } = makeLogger();
    const pruner = new CrashPruner({ db, log });
    const spy = vi.spyOn(pruner, 'runOnce');
    pruner.start();
    pruner.start();
    expect(captured.warn.some((l) => /start\(\) called twice/.test(l))).toBe(
      true,
    );
    vi.advanceTimersByTime(STARTUP_WARMUP_MS);
    // Only one warmup timer fired.
    expect(spy).toHaveBeenCalledTimes(1);
    pruner.stop();
  });

  it('stop() is idempotent', () => {
    const { log } = makeLogger();
    const pruner = new CrashPruner({ db, log });
    pruner.start();
    pruner.stop();
    expect(() => pruner.stop()).not.toThrow();
  });
});

describe('CrashPruner.runOnce — error handling (T5.12)', () => {
  it('captures and logs SQL errors without throwing', () => {
    const db = makeDb();
    db.exec('DROP TABLE crash_log');
    const { log, captured } = makeLogger();
    const pruner = new CrashPruner({ db, log });
    expect(() => pruner.runOnce()).not.toThrow();
    expect(captured.warn.some((l) => /cycle failed/.test(l))).toBe(true);
    db.close();
  });
});
