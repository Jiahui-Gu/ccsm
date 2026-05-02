// packages/daemon/src/db/__tests__/sqlite.spec.ts
//
// Verifies that `openDatabase()` applies every PRAGMA spec'd in
// docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md ch07 §3
// at boot time, by reading each value back via `db.pragma()` after the
// wrapper returns.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BOOT_PRAGMAS, openDatabase, type SqliteDatabase } from '../sqlite.js';

describe('openDatabase (T5.1 — ch07 §1/§3)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: SqliteDatabase | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-daemon-sqlite-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        // best-effort
      }
      db = null;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('opens the database file', () => {
    db = openDatabase(dbPath);
    expect(db.open).toBe(true);
    expect(db.name).toBe(dbPath);
  });

  it('applies journal_mode = WAL', () => {
    db = openDatabase(dbPath);
    // `pragma('journal_mode', { simple: true })` returns the bare value.
    const mode = db.pragma('journal_mode', { simple: true });
    expect(String(mode).toLowerCase()).toBe(BOOT_PRAGMAS.journal_mode);
  });

  it('applies synchronous = NORMAL (1)', () => {
    db = openDatabase(dbPath);
    // SQLite reports synchronous as an integer: OFF=0, NORMAL=1, FULL=2, EXTRA=3.
    const sync = db.pragma('synchronous', { simple: true });
    expect(sync).toBe(1);
  });

  it('applies foreign_keys = ON (1)', () => {
    db = openDatabase(dbPath);
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('applies busy_timeout = 5000', () => {
    db = openDatabase(dbPath);
    const bt = db.pragma('busy_timeout', { simple: true });
    expect(bt).toBe(BOOT_PRAGMAS.busy_timeout);
  });

  it('applies journal_size_limit = 64 MiB (67108864)', () => {
    db = openDatabase(dbPath);
    const limit = db.pragma('journal_size_limit', { simple: true });
    expect(limit).toBe(BOOT_PRAGMAS.journal_size_limit);
  });

  it('BOOT_PRAGMAS constant matches spec values', () => {
    // Lock the constants — if the spec ever changes these, this assertion
    // forces the wrapper, the constant, and this test to update together.
    expect(BOOT_PRAGMAS).toEqual({
      journal_mode: 'wal',
      synchronous: 'NORMAL',
      foreign_keys: 'ON',
      busy_timeout: 5000,
      journal_size_limit: 67108864,
    });
  });
});
