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

    CREATE TABLE IF NOT EXISTS endpoints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'anthropic',
      api_key_encrypted BLOB,
      is_default INTEGER NOT NULL DEFAULT 0,
      last_status TEXT,
      last_error TEXT,
      last_refreshed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      detected_kind TEXT,
      manual_model_ids TEXT
    );

    CREATE TABLE IF NOT EXISTS endpoint_models (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      display_name TEXT,
      discovered_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'listed',
      exists_confirmed INTEGER NOT NULL DEFAULT 1,
      UNIQUE(endpoint_id, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_endpoint_models_endpoint
      ON endpoint_models(endpoint_id);

    CREATE TABLE IF NOT EXISTS worktrees (
      sessionId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      baseRepo TEXT NOT NULL,
      branch TEXT NOT NULL,
      sourceBranch TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worktrees_baseRepo ON worktrees(baseRepo);
  `);
  migrateEndpointDiscoveryColumns(db);
  return db;
}

/**
 * Idempotent column additions for pre-existing databases that predate the
 * tiered discovery pipeline. `ALTER TABLE ADD COLUMN` in SQLite is cheap and
 * additive, so we can run this on every boot without a version counter.
 */
function migrateEndpointDiscoveryColumns(db: Database.Database): void {
  const addIfMissing = (table: string, column: string, ddl: string): void => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addIfMissing('endpoints', 'detected_kind', 'detected_kind TEXT');
  addIfMissing('endpoints', 'manual_model_ids', 'manual_model_ids TEXT');
  addIfMissing('endpoint_models', 'source', "source TEXT NOT NULL DEFAULT 'listed'");
  addIfMissing('endpoint_models', 'exists_confirmed', 'exists_confirmed INTEGER NOT NULL DEFAULT 1');
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
      CREATE TABLE IF NOT EXISTS endpoints (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'anthropic',
        api_key_encrypted BLOB,
        is_default INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_error TEXT,
        last_refreshed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        detected_kind TEXT,
        manual_model_ids TEXT
      );
      CREATE TABLE IF NOT EXISTS endpoint_models (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        display_name TEXT,
        discovered_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'listed',
        exists_confirmed INTEGER NOT NULL DEFAULT 1,
        UNIQUE(endpoint_id, model_id)
      );
      CREATE INDEX IF NOT EXISTS idx_endpoint_models_endpoint
        ON endpoint_models(endpoint_id);

      CREATE TABLE IF NOT EXISTS worktrees (
        sessionId TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        baseRepo TEXT NOT NULL,
        branch TEXT NOT NULL,
        sourceBranch TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worktrees_baseRepo ON worktrees(baseRepo);
    `);
    migrateEndpointDiscoveryColumns(instance);
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

// ───────────────────────────── worktrees ──────────────────────────────────
//
// Per-session git worktree records. Consumed by WorktreeManager via the
// storage adapter wired up in electron/main.ts. Schema lives in `initDb`
// above; these helpers are just the CRUD surface so the manager doesn't
// hand out raw SQL strings.

export interface WorktreeRow {
  sessionId: string;
  name: string;
  path: string;
  baseRepo: string;
  branch: string;
  sourceBranch: string | null;
  createdAt: number;
}

export function saveWorktree(row: WorktreeRow): void {
  initDb()
    .prepare(
      `INSERT INTO worktrees (sessionId, name, path, baseRepo, branch, sourceBranch, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sessionId) DO UPDATE SET
         name = excluded.name,
         path = excluded.path,
         baseRepo = excluded.baseRepo,
         branch = excluded.branch,
         sourceBranch = excluded.sourceBranch,
         createdAt = excluded.createdAt`
    )
    .run(
      row.sessionId,
      row.name,
      row.path,
      row.baseRepo,
      row.branch,
      row.sourceBranch,
      row.createdAt
    );
}

export function loadWorktree(sessionId: string): WorktreeRow | null {
  const row = initDb()
    .prepare('SELECT * FROM worktrees WHERE sessionId = ?')
    .get(sessionId) as WorktreeRow | undefined;
  return row ?? null;
}

export function deleteWorktree(sessionId: string): void {
  initDb().prepare('DELETE FROM worktrees WHERE sessionId = ?').run(sessionId);
}

export function listWorktreesDb(): WorktreeRow[] {
  return initDb()
    .prepare('SELECT * FROM worktrees ORDER BY createdAt ASC')
    .all() as WorktreeRow[];
}
