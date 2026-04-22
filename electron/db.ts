import Database from 'better-sqlite3';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let db: Database.Database | null = null;

export function initDb(): Database.Database {
  if (db) return db;
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agentory.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId);
  `);
  // Drop legacy endpoints tables if they exist from a pre-refactor install.
  // The app no longer reads them — connection config now comes from
  // ~/.claude/settings.json. Cheap to issue at every boot; SQLite ignores
  // missing tables.
  db.exec(`
    DROP TABLE IF EXISTS endpoint_models;
    DROP TABLE IF EXISTS endpoints;
  `);
  return db;
}

export function loadMessages(sessionId: string): unknown[] {
  const rows = initDb()
    .prepare('SELECT content FROM messages WHERE sessionId = ? ORDER BY createdAt ASC')
    .all(sessionId) as Array<{ content: string }>;
  return rows.map((r) => JSON.parse(r.content));
}

export function saveMessages(sessionId: string, blocks: Array<{ id: string; kind: string }>): void {
  const db = initDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE sessionId = ?').run(sessionId);
    const insert = db.prepare(
      'INSERT INTO messages (id, sessionId, kind, content, createdAt) VALUES (?, ?, ?, ?, ?)'
    );
    const now = Date.now();
    blocks.forEach((block, i) => {
      // Use index-based createdAt tiebreaker so ordering is stable even when
      // many blocks land in the same millisecond.
      insert.run(block.id, sessionId, block.kind, JSON.stringify(block), now + i);
    });
  });
  tx();
}

// Test-only: swap in an in-memory database. Never call from app code.
export function __setDbForTests(instance: Database.Database | null): void {
  db = instance;
  if (instance) {
    instance.pragma('foreign_keys = ON');
    instance.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId);
    `);
  }
}

export function getDb(): Database.Database {
  return initDb();
}

export function loadState(key: string): string | null {
  const row = initDb().prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function saveState(key: string, value: string): void {
  initDb()
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, Date.now());
}

export function closeDb(): void {
  db?.close();
  db = null;
}

const CLAUDE_BIN_PATH_KEY = 'claudeBinPath';

/**
 * Load the persisted user-picked claude binary path (the "Browse for binary"
 * flow in the first-run wizard). Returns `null` when the user has not picked
 * one; caller falls back to `AGENTORY_CLAUDE_BIN` env then PATH.
 */
export function loadClaudeBinPath(): string | null {
  return loadState(CLAUDE_BIN_PATH_KEY);
}

export function saveClaudeBinPath(value: string | null): void {
  if (value == null || value.length === 0) {
    initDb().prepare('DELETE FROM app_state WHERE key = ?').run(CLAUDE_BIN_PATH_KEY);
    return;
  }
  saveState(CLAUDE_BIN_PATH_KEY, value);
}
