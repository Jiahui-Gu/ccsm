// T29: v0.2 → v0.3 SQLite schema migration runner.
//
// Spec refs:
//   - docs/superpowers/specs/v0.3-fragments/frag-8-sqlite-migration.md
//     §8.5 (atomic, recoverable migration steps)
//   - daemon/src/db/schema/v0.3.sql (target schema, T28)
//   - electron/db.ts (v0.2 source schema: single `app_state(key,value,updated_at)`
//     KV table + PRAGMA user_version = 1)
//
// Scope (Single Responsibility): pure schema-and-row translation on a single
// SQLite file path. NO event emission (T30 owns contracts), NO modal driver
// (T33), NO lockfile / dataRoot resolution (frag-8 §8.3 / T35), NO .backup()
// copy from legacyDb to tmpDb (that orchestration lives in the boot path
// that calls this runner — see frag-8 §8.5 S3-S6). The runner receives a
// db file that is already a working copy and converts it in place.
//
// Atomicity: all DDL + row translation happens inside a single SQLite
// transaction. Any throw triggers rollback; the file is left in its
// pre-call state (PRAGMAs aside — see PRAGMA note in `applyV03Schema`).
// The caller (T35 MIGRATION_PENDING gate) detects failure by catching the
// thrown error.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolved at module load — path to the canonical T28 schema file. */
const V03_SCHEMA_PATH = join(__dirname, 'schema', 'v0.3.sql');

/**
 * v0.2 KV keys that map to v0.3 typed columns on the `app_state` singleton.
 * Source: `electron/prefs/{closeAction,notifyEnabled,crashReporting,userCwds}.ts`
 * + frag-8 §8.5 task description. `closeToTrayShownAt` was never written by
 * v0.2 (column added in v0.3 per frag-6-7 §6.8 R3-T12) but we accept it
 * defensively in case any pre-release build seeded it.
 */
const KV_TO_COLUMN: ReadonlyArray<{
  key: string;
  column: 'close_action' | 'notify_enabled' | 'crash_reporting_opt_out' | 'user_cwds' | 'close_to_tray_shown_at';
  parse: (raw: string) => string | number | null;
}> = [
  // closeAction: stored as the literal string ('ask' | 'tray' | 'quit').
  { key: 'closeAction', column: 'close_action', parse: (raw) => raw },
  // notifyEnabled: stored as 'true'/'false' or '1'/'0'. v0.3 column is
  // INTEGER (0/1). Default ON: anything not explicitly off becomes 1.
  // Mirrors the parse in electron/prefs/notifyEnabled.ts.
  { key: 'notifyEnabled', column: 'notify_enabled', parse: (raw) => (raw === 'false' || raw === '0' ? 0 : 1) },
  // crashReportingOptOut: 'true'/'1' → opted out (1). Mirrors
  // electron/prefs/crashReporting.ts: only explicit true/1 means opted out.
  { key: 'crashReportingOptOut', column: 'crash_reporting_opt_out', parse: (raw) => (raw === 'true' || raw === '1' ? 1 : 0) },
  // userCwds: stored as a JSON array string. v0.3 column is TEXT (still JSON).
  // Pass through as-is so callers parse the same shape they wrote in v0.2.
  { key: 'userCwds', column: 'user_cwds', parse: (raw) => raw },
  // close_to_tray_shown_at: integer ms-epoch. Defensive — v0.2 didn't write
  // this; if seeded, accept numeric strings only.
  {
    key: 'closeToTrayShownAt',
    column: 'close_to_tray_shown_at',
    parse: (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    },
  },
];

interface KvRow {
  key: string;
  value: string;
}

interface SchemaVersionRow {
  v: string;
}

interface MasterRow {
  name: string;
}

/**
 * Cached, parsed v0.3 schema body. The on-disk file contains three top-level
 * PRAGMA statements (`journal_mode = WAL`, `synchronous = NORMAL`,
 * `foreign_keys = ON`). `journal_mode` cannot run inside a transaction, so
 * we split them out and apply them BEFORE BEGIN. The remaining DDL +
 * INSERTs are exec'd inside the migration transaction.
 */
let cachedSchemaParts: { pragmas: string; ddl: string } | null = null;

function loadSchemaParts(): { pragmas: string; ddl: string } {
  if (cachedSchemaParts) return cachedSchemaParts;
  const raw = readFileSync(V03_SCHEMA_PATH, 'utf8');
  const pragmaLines: string[] = [];
  const ddlLines: string[] = [];
  // Cheap line-level split. The schema file's PRAGMAs are each on a single
  // line ending with `;` (verified at T28 commit). If a future schema rev
  // splits a PRAGMA across lines, the test will catch it.
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^PRAGMA\s+/i.test(trimmed)) {
      pragmaLines.push(trimmed);
    } else {
      ddlLines.push(line);
    }
  }
  cachedSchemaParts = { pragmas: pragmaLines.join('\n'), ddl: ddlLines.join('\n') };
  return cachedSchemaParts;
}

/**
 * Detect whether `db` is already on the v0.3 schema. Truth signal is the
 * presence of a `schema_version` row with `v = '0.3'`. The v0.2 file has
 * no such table — `PRAGMA user_version = 1` was the v0.2 marker.
 */
function isAlreadyV03(db: Database.Database): boolean {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").all() as MasterRow[];
  if (tables.length === 0) return false;
  const row = db.prepare('SELECT v FROM schema_version WHERE v = ?').get('0.3') as SchemaVersionRow | undefined;
  return row?.v === '0.3';
}

/**
 * Sniff whether the table named `name` looks like the v0.2 KV `app_state`
 * (columns key/value/updated_at) vs the v0.3 singleton (columns id/...).
 * Returns true if it's the v0.2 KV shape.
 */
function isLegacyKvAppState(db: Database.Database, name: string): boolean {
  const cols = db.prepare(`PRAGMA table_info('${name}')`).all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  return colNames.has('key') && colNames.has('value') && !colNames.has('id');
}

/**
 * Run the v0.2 → v0.3 migration on the SQLite database at `dbPath`, in
 * place. Synchronous because better-sqlite3 is sync; matches the daemon's
 * boot path which already runs sync DB ops on the main thread before the
 * event loop is busy.
 *
 * Throws on any unrecoverable error. The transaction rolls back so the
 * tables/rows revert; PRAGMAs (journal_mode, synchronous, foreign_keys)
 * are NOT rolled back because SQLite cannot revert them — they are
 * idempotent settings the v0.3 daemon would have set anyway, so leaving
 * them stamped on a rolled-back v0.2 file is harmless.
 *
 * Idempotent: if the file is already on v0.3 (schema_version row = '0.3')
 * the function returns immediately without touching anything.
 */
export function migrateV02ToV03(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    if (isAlreadyV03(db)) return;

    const { pragmas, ddl } = loadSchemaParts();

    // Apply PRAGMAs OUTSIDE the transaction — `journal_mode = WAL` is
    // illegal inside BEGIN. These are also idempotent so re-runs after a
    // rolled-back failure don't cause issues.
    db.exec(pragmas);

    // Snapshot the v0.2 KV rows (if any) BEFORE we touch the table.
    // Some v0.2 installs may have an empty `app_state` (fresh install with
    // no prefs touched); legacy table may even be missing if a user
    // manually nuked it. Both cases are valid — we just produce an empty
    // KV map and proceed to schema creation.
    const legacyRows = readLegacyKv(db);

    // Atomic transformation. better-sqlite3's `transaction()` wraps the
    // function body in BEGIN/COMMIT and rolls back on any throw.
    const runMigration = db.transaction(() => {
      // Step 1: rename the v0.2 `app_state` table out of the way (if it
      // exists). v0.3.sql will CREATE TABLE IF NOT EXISTS app_state with
      // the new singleton shape; without renaming first, the IF NOT EXISTS
      // would silently no-op against the v0.2 KV table and leave the file
      // half-migrated.
      const appStateMaster = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_state'")
        .all() as MasterRow[];
      let renamedLegacy = false;
      if (appStateMaster.length > 0 && isLegacyKvAppState(db, 'app_state')) {
        // Drop any prior orphan from a previously failed migration before
        // renaming, so the rename can't collide.
        db.exec('DROP TABLE IF EXISTS app_state_v02_legacy');
        db.exec('ALTER TABLE app_state RENAME TO app_state_v02_legacy');
        renamedLegacy = true;
      }

      // Step 2: apply the v0.3 schema (creates sessions, messages, agents,
      // jobs, app_state singleton, schema_version row, indices). The file
      // uses CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE / INSERT OR
      // REPLACE, so it's safe to exec on a partially-set-up file too.
      db.exec(ddl);

      // Step 3: translate the captured v0.2 KV rows into typed-column
      // writes on the singleton row. Build a single UPDATE so we touch
      // the row once.
      writeMappedColumns(db, legacyRows);

      // Step 4: drop the renamed legacy table now that its data is folded
      // into the singleton. Skipped if there was no v0.2 table to begin
      // with (renamedLegacy === false).
      if (renamedLegacy) {
        db.exec('DROP TABLE IF EXISTS app_state_v02_legacy');
      }

      // Step 5: clear PRAGMA user_version (v0.2's stamp). v0.3's truth
      // signal is the schema_version row, but leaving user_version=1
      // around is misleading for forensic dumps.
      db.pragma('user_version = 0');

      // Step 6: schema_version row was already INSERT OR REPLACE'd to
      // '0.3' by the schema file itself — no extra write needed.
    });

    runMigration();
  } finally {
    db.close();
  }
}

/**
 * Read KV rows from `app_state` if and only if the table currently has the
 * v0.2 KV shape. Returns an empty map otherwise (table missing OR table
 * already has the v0.3 singleton shape — the latter shouldn't happen given
 * the `isAlreadyV03` guard but is defensive).
 */
function readLegacyKv(db: Database.Database): Map<string, string> {
  const out = new Map<string, string>();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_state'")
    .all() as MasterRow[];
  if (tables.length === 0) return out;
  if (!isLegacyKvAppState(db, 'app_state')) return out;
  const rows = db.prepare('SELECT key, value FROM app_state').all() as KvRow[];
  for (const row of rows) {
    out.set(row.key, row.value);
  }
  return out;
}

/**
 * Apply the captured KV map onto the v0.3 singleton row. Unknown keys are
 * dropped (forward-compat: v0.2 may have written keys we no longer track,
 * e.g. the long-removed `claudeBinPath`; see electron/db.ts:215). Each
 * known key writes one column; missing keys leave the column NULL (the
 * v0.3 default per schema comment "NULL = unset/default").
 */
function writeMappedColumns(db: Database.Database, kv: Map<string, string>): void {
  const setters: string[] = [];
  const values: Array<string | number | null> = [];
  for (const mapping of KV_TO_COLUMN) {
    const raw = kv.get(mapping.key);
    if (raw === undefined) continue;
    const parsed = mapping.parse(raw);
    if (parsed === null) continue;
    setters.push(`${mapping.column} = ?`);
    values.push(parsed);
  }
  if (setters.length === 0) return;
  // updated_at refresh stamps "this row was touched by the migrator". The
  // schema's DEFAULT only fires on INSERT; UPDATE needs an explicit set.
  setters.push('updated_at = ?');
  values.push(Date.now());
  const sql = `UPDATE app_state SET ${setters.join(', ')} WHERE id = 1`;
  db.prepare(sql).run(...values);
}
