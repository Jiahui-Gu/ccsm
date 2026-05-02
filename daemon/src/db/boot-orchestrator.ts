// T36: fresh-install silent path — boot orchestrator.
//
// Spec refs:
//   - docs/superpowers/specs/v0.3-fragments/frag-8-sqlite-migration.md
//     §8.3 step 2-3 + step 5 (fresh-install branch).
//   - daemon/src/db/ensure-data-dir.ts (T34) — produces `kind: 'fresh' |
//     'existing'`.
//   - daemon/src/db/migrate-v02-to-v03.ts (T29) — idempotent runner that
//     handles already-v0.3 as a no-op.
//   - daemon/src/db/schema/v0.3.sql (T28) — canonical schema (also stamps
//     `INSERT OR REPLACE INTO schema_version VALUES ('0.3')` itself, so
//     fresh-install needs nothing more than `db.exec(sql)`).
//
// Single Responsibility (producer / decider / sink): DECIDER. This module
// composes T34 (producer of `EnsuredDataDir`) and the migration runner
// (sink) into a single boot decision: when the canonical db file does
// NOT yet exist we silently apply the v0.3 schema (no events, no modal,
// no progress); when it DOES exist we delegate to the migration runner
// which is responsible for detecting "already current" as a no-op.
//
// "Silent" is the load-bearing word. The fresh-install branch MUST NOT
// emit any `migration.*` event (T30 contracts) so the renderer-side
// modal driver (T33, future) stays dormant. A first-time user opening
// ccsm sees no modal flash.
//
// Pure composition: this module owns no I/O of its own beyond:
//   1. invoking the injected `ensureDataDir()`
//   2. on `kind: 'fresh'`, opening a `Database(dbPath)` and `exec()`-ing
//      the v0.3 schema text
//   3. on `kind: 'existing'`, invoking the injected `runMigration(dbPath)`
//
// No lockfile acquisition, no marker file write, no event emission, no
// log line — all of those are owned by other tasks (lockfile: frag-6-7
// §6.4; marker file: §8.5 S8 / a future task; events: T30 + the runner;
// log line: the boot path that calls bootDb()).

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAdditiveMigrations as defaultRunAdditiveMigrations } from './additive-migrations.js';
import { ensureDataDir as defaultEnsureDataDir, type EnsuredDataDir } from './ensure-data-dir.js';
import { migrateV02ToV03 as defaultRunMigration } from './migrate-v02-to-v03.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Path to the canonical v0.3 schema file. Same source the migration
 * runner reads (T29) — both code paths converge on a single SQL truth.
 */
const V03_SCHEMA_PATH = join(__dirname, 'schema', 'v0.3.sql');

/** Lazy-cached schema text. Read once per process, reused across boots. */
let cachedSchemaText: string | null = null;

function loadV03Schema(): string {
  if (cachedSchemaText !== null) return cachedSchemaText;
  cachedSchemaText = readFileSync(V03_SCHEMA_PATH, 'utf8');
  return cachedSchemaText;
}

/**
 * Outcome of `bootDb()`:
 *
 * - `'fresh-install'` — `<dataRoot>/data/ccsm.db` did not exist before
 *   this call; the orchestrator created it and applied the v0.3 schema
 *   silently. No migration events fired.
 * - `'existing'` — the canonical db file already existed; the
 *   orchestrator delegated to the migration runner. The runner's own
 *   idempotency guard (T29 `isAlreadyV03`) handles already-current
 *   files as a no-op without emitting events.
 */
export type BootDbOutcome = 'fresh-install' | 'existing';

/**
 * Result of `bootDb()`. `ensured` is the unmodified return value of
 * `ensureDataDir()`; useful for callers that want to log the resolved
 * paths and orphan-cleanup count.
 */
export interface BootDbResult {
  readonly ensured: EnsuredDataDir;
  readonly outcome: BootDbOutcome;
}

/**
 * Dependency injection seam. Tests (and the future legacy-resolver
 * wiring) replace `ensureDataDir`, `runMigration`, and/or
 * `applyFreshSchema` to control the fork without touching real fs.
 *
 * `applyFreshSchema(dbPath)` exists as a separate seam (vs hard-coded
 * `db.exec(loadV03Schema())`) so tests can assert "fresh path called
 * applyFreshSchema, NOT runMigration" without spinning a real sqlite
 * file when better-sqlite3's prebuilt ABI doesn't match the host node.
 */
export interface BootDbDeps {
  /** T34 producer. Defaults to the real `ensureDataDir`. */
  readonly ensureDataDir?: () => EnsuredDataDir;
  /**
   * T29 runner. Defaults to `migrateV02ToV03`. Called only when
   * `ensured.kind === 'existing'`. Receives the canonical db file path.
   */
  readonly runMigration?: (dbPath: string) => void;
  /**
   * Fresh-install schema applier. Defaults to "open `dbPath` with
   * better-sqlite3, exec the v0.3 schema text, close". Called only
   * when `ensured.kind === 'fresh'`.
   */
  readonly applyFreshSchema?: (dbPath: string) => void;
  /**
   * Post-schema additive migration runner (T31a). Defaults to
   * `runAdditiveMigrations` over `daemon/src/db/migrations/`. Called on
   * BOTH `fresh` and `existing` paths AFTER the schema / migration
   * runner has produced a v0.3-baseline-shaped db, so every additive
   * delta from the chapter 09 §8 schema-additive promise is applied
   * exactly once (ledger-tracked).
   *
   * Receives the canonical db path; opens its own `Database` handle so
   * the runner is decoupled from the fresh / existing handle lifetimes.
   */
  readonly runAdditiveMigrations?: (dbPath: string) => void;
}

/**
 * Default fresh-schema applier. Opens `dbPath` (creates the file),
 * runs the entire v0.3 schema (which itself stamps
 * `schema_version (v) VALUES ('0.3')`), and closes the handle.
 *
 * Synchronous because better-sqlite3 is sync; matches the daemon's
 * boot path which already runs sync DB ops on the main thread before
 * the event loop is busy (T29 docstring same rationale).
 */
function defaultApplyFreshSchema(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(loadV03Schema());
  } finally {
    db.close();
  }
}

/**
 * Default additive-migration runner wrapper. Opens the canonical db
 * file, delegates to `runAdditiveMigrations` over the shipped
 * `daemon/src/db/migrations/` directory, then closes. Synchronous for
 * the same reason as `defaultApplyFreshSchema` — better-sqlite3 is sync
 * and the boot path runs before the event loop is busy.
 *
 * Throws on checksum mismatch or SQL exec error; the caller (boot path)
 * surfaces as fatal per frag-8 §8.6 daemon-spawn-failure modal.
 */
function defaultRunAdditive(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    defaultRunAdditiveMigrations(db);
  } finally {
    db.close();
  }
}

/**
 * Orchestrate the daemon-boot db decision per frag-8 §8.3 steps 2-3 +
 * step 5 (fresh-install branch).
 *
 * Sequence:
 *   1. Call `ensureDataDir()` (T34): provisions `<dataRoot>/data`,
 *      cleans orphan tmp files, probes for the canonical db file.
 *   2. Fork on `ensured.kind`:
 *      - `'fresh'`  → `applyFreshSchema(ensured.dbPath)` then return
 *                     `{ ensured, outcome: 'fresh-install' }`. NO events.
 *      - `'existing'` → `runMigration(ensured.dbPath)` then return
 *                       `{ ensured, outcome: 'existing' }`. The runner
 *                       owns event emission (T30) for the truly-needs-
 *                       migration case; for already-v0.3 it returns
 *                       silently (T29 `isAlreadyV03` guard).
 *
 * Throws whatever `ensureDataDir`, `applyFreshSchema`, or `runMigration`
 * throw — the caller (boot path) is responsible for surfacing fatals as
 * the §8.6 daemon-spawn-failure modal.
 */
export function bootDb(deps: BootDbDeps = {}): BootDbResult {
  const ensureDataDirFn = deps.ensureDataDir ?? defaultEnsureDataDir;
  const runMigrationFn = deps.runMigration ?? defaultRunMigration;
  const applyFreshSchemaFn = deps.applyFreshSchema ?? defaultApplyFreshSchema;
  const runAdditiveFn = deps.runAdditiveMigrations ?? defaultRunAdditive;

  const ensured = ensureDataDirFn();

  if (ensured.kind === 'fresh') {
    // §8.3 step 5: fresh install. Open new db, schema runs, NO events.
    // The marker file write (`writeMarker({ completed: true, reason:
    // 'fresh-install' })`) lives in a separate task — T36's scope is
    // strictly the silent-schema branch; the marker is the boot path's
    // responsibility once the marker writer module lands.
    applyFreshSchemaFn(ensured.dbPath);
    // Apply the additive deltas (T31a) on top of the freshly-stamped
    // v0.3 baseline. Same call on both branches so a fresh install ends
    // up at the same shape an upgraded install does — no shape skew.
    runAdditiveFn(ensured.dbPath);
    return { ensured, outcome: 'fresh-install' };
  }

  // §8.3 step 3: db exists at the v0.3 target. Delegate to the migration
  // runner. T29 detects already-current via `isAlreadyV03` and returns
  // immediately — no events, no work — so the legacy-v0.3 reinstall path
  // is also silent. The genuine "v0.2-shaped data sitting at the v0.3
  // target" case (which would only happen via manual user file copy,
  // since v0.2 wrote to a different per-OS path) DOES produce a
  // migration: T29 will translate it and the events the runner emits
  // are the source of truth.
  runMigrationFn(ensured.dbPath);
  // Apply the additive deltas (T31a) AFTER the v0.2→v0.3 lift so the
  // ledger sees the v0.3 baseline tables already present. Idempotent:
  // re-runs short-circuit on the `applied_migrations` ledger.
  runAdditiveFn(ensured.dbPath);
  return { ensured, outcome: 'existing' };
}
