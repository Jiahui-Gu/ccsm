// T31a: post-schema additive migration runner.
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-01-v0.4-web-design.md chapter 09 §8
//     (schema-additive promise) — the on-disk migrations are guaranteed
//     additive by `scripts/lint-schema-additive.ts`; THIS runner is the
//     execution half of that contract.
//   - daemon/src/db/migrations/.v03-baseline — sentinel `__none__` ⇒
//     every file in `daemon/src/db/migrations/` is post-baseline and
//     additive.
//   - frag-8 §8.5 S5 — "If a future v0.4 bumps SCHEMA_VERSION the
//     existing `migrate(from, to)` hook in dbService runs at first open
//     of the moved db." This module IS that hook for the v0.3-line
//     additive deltas; SCHEMA_VERSION row stays '0.3' while the
//     `applied_migrations` table tracks per-file application.
//
// Single Responsibility: apply every `.sql` file under
// `daemon/src/db/migrations/` that has not yet been applied to the
// supplied database, in filename-sort order, each inside its own
// transaction. Records the applied filename + sha256 + applied_at_ms in
// an `applied_migrations` ledger table (auto-created on first run) so
// re-runs are no-ops and so a checksum mismatch surfaces tampering /
// upstream edit drift.
//
// Why a ledger and not "just CREATE TABLE IF NOT EXISTS in the .sql":
//   - `ALTER TABLE ... ADD COLUMN` is NOT idempotent in SQLite (no
//     `IF NOT EXISTS`). Re-running 001-session-extensions would throw
//     "duplicate column name". A ledger short-circuits before exec.
//   - The lint script enforces the additive shape; the runner enforces
//     "applied exactly once". Two halves, one promise.
//   - Checksum protects against the historical "developer hand-edits a
//     shipped migration after dogfood already ran it" footgun.
//
// Idempotent: zero unapplied files ⇒ zero work; second invocation in
// the same boot is a no-op. Throws on checksum mismatch (caller =
// boot-orchestrator surfaces as a fatal — `<dataRoot>/data/ccsm.db`
// has been hand-edited; refuse to keep going).
//
// Ordering: filenames sort lexicographically; the on-disk convention is
// `NNN-slug.sql` (zero-padded 3-digit prefix), so byte-sort = intended
// order. Same convention the schema-additive lint enforces via its
// `rel <= baseline` filename compare.

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolved at module load — directory containing the additive `.sql`
 * migration files. Same path the schema-additive lint walks.
 */
const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Ledger DDL. Created on first runner invocation; thereafter every
 * applied file inserts a row (filename, sha256, applied_at_ms).
 *
 * `applied_at_ms` defaults so ad-hoc inserts work in tests; the runner
 * always supplies an explicit value to keep traceability tight.
 */
const APPLIED_LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS applied_migrations (
    filename       TEXT PRIMARY KEY,
    sha256         TEXT NOT NULL,
    applied_at_ms  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  )
`;

interface AppliedRow {
  filename: string;
  sha256: string;
}

interface MigrationFile {
  filename: string;
  abspath: string;
  sql: string;
  sha256: string;
}

/**
 * Result of `runAdditiveMigrations()`. `applied` is the list of files
 * the runner just applied (in apply order); `skipped` is the list it
 * found already in the ledger. Tests + boot logging consume both.
 */
export interface AdditiveMigrationResult {
  readonly applied: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

/**
 * Dependency injection seam. Tests override `migrationsDir` to point at
 * a fixture directory without touching the shipped on-disk files.
 */
export interface AdditiveMigrationOptions {
  readonly migrationsDir?: string;
}

/**
 * sha256 hex of a UTF-8 text payload. Used for the ledger checksum;
 * tampering detection is the explicit goal so we want a strong digest,
 * not a weaker non-cryptographic hash.
 */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * List `.sql` files in `dir`, byte-sorted. Returns `[]` if the directory
 * doesn't exist (fresh checkout shape; runner stays a no-op).
 */
function listSqlFiles(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.sql$/i.test(entry.name)) continue;
    const abspath = join(dir, entry.name);
    const sql = readFileSync(abspath, 'utf8');
    out.push({
      filename: entry.name,
      abspath,
      sql,
      sha256: sha256Hex(sql),
    });
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

/**
 * Run every additive `.sql` migration under `daemon/src/db/migrations/`
 * (or `opts.migrationsDir`) that has not yet been applied to `db`.
 *
 * Each file is applied inside its own implicit transaction (better-sqlite3
 * `db.transaction()` wrapper). Throws on:
 *   - SQL exec error (rolled back, ledger row NOT inserted),
 *   - checksum mismatch vs ledger (caller surfaces as fatal).
 *
 * Returns the list of applied + skipped filenames for caller logging.
 */
export function runAdditiveMigrations(
  db: Database.Database,
  opts: AdditiveMigrationOptions = {},
): AdditiveMigrationResult {
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;

  // Ledger DDL is itself idempotent (CREATE TABLE IF NOT EXISTS) and
  // owned by this runner — applying it OUTSIDE any per-file transaction
  // keeps "ledger was created BEFORE the first migration row was tried"
  // a structural guarantee even on first-ever call.
  db.exec(APPLIED_LEDGER_DDL);

  const ledger = new Map<string, string>();
  const ledgerRows = db
    .prepare('SELECT filename, sha256 FROM applied_migrations')
    .all() as AppliedRow[];
  for (const row of ledgerRows) {
    ledger.set(row.filename, row.sha256);
  }

  const files = listSqlFiles(dir);
  const applied: string[] = [];
  const skipped: string[] = [];

  const insertLedger = db.prepare(
    'INSERT INTO applied_migrations (filename, sha256, applied_at_ms) VALUES (?, ?, ?)',
  );

  for (const file of files) {
    const recordedSha = ledger.get(file.filename);
    if (recordedSha !== undefined) {
      if (recordedSha !== file.sha256) {
        throw new Error(
          `additive migration sha256 mismatch for ${file.filename}: ` +
            `ledger=${recordedSha} on-disk=${file.sha256}. ` +
            `Migration files are append-only — never edit a shipped migration; ` +
            `add a new file with a higher numeric prefix instead.`,
        );
      }
      skipped.push(file.filename);
      continue;
    }

    // Single transaction per file: SQL exec + ledger insert succeed or
    // roll back together. better-sqlite3's `transaction()` wrapper
    // rolls back on any throw inside the body.
    const apply = db.transaction(() => {
      db.exec(file.sql);
      insertLedger.run(file.filename, file.sha256, Date.now());
    });
    apply();
    applied.push(file.filename);
  }

  return { applied, skipped };
}
