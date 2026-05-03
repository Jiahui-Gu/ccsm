// packages/daemon/src/db/locked.ts
//
// FOREVER-STABLE per docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// chapter 07 §4 (migration immutability) + chapter 15 §3 item #4. Runtime
// self-check side of the two-tier safety net:
//
//   - tools/check-migration-locks.sh — compares against the v0.3.0 GitHub
//     release body (the immutable witness, source of truth).
//   - this file — the daemon at boot computes SHA256s of bundled migration
//     files via `runner.ts` and asserts each matches the entry below.
//     packages/daemon/test/db/migration-lock.spec.ts is the in-process spec
//     that fails CI before this fails production.
//
// Path lives at `src/db/locked.ts` (NOT `src/db/migrations/locked.ts`) to
// match the path baked into `tools/check-migration-locks.sh` (FOREVER-STABLE
// from Task #127 / PR #849) and `packages/daemon/test/db/migration-lock.spec.ts`
// (Task #55). The design doc text in ch07 §4 mentions the migrations/ subpath
// — that wording is stale; the canonical path is the one CI consumes.
//
// Adding a migration:
//   1. Land the new SQL file under `packages/daemon/src/db/migrations/`.
//   2. Append a new entry below — version monotonically increases.
//   3. CI's check-migration-locks.sh ensures locked.ts agrees with the
//      release body; the runtime self-check ensures bundled SQL agrees with
//      this file. Both must pass.
//
// Editing an existing entry:
//   - Permitted ONLY before the v0.3.0 tag exists. After tag, every entry
//     here is frozen forever; a fix is a new migration file with a new row.

/**
 * One migration's lock metadata. `version` is the integer row written to
 * `schema_migrations.version` once the file applies cleanly. `filename` is
 * the basename under `packages/daemon/src/db/migrations/`. `sha256` is the
 * lowercase hex SHA-256 of the file's bytes (no normalization — exact bytes
 * including the trailing newline).
 */
export interface MigrationLock {
  readonly version: number;
  readonly filename: string;
  readonly sha256: string;
}

/**
 * Filename → SHA256 record. Source-of-truth literal — every other shape
 * exported below is derived from this. The literal-pair form on one line
 * is REQUIRED by `tools/check-migration-locks.sh` (a regex of the form
 * `['"]<filename>['"]\s*:\s*['"]<sha>['"]` greps this file). The same form
 * is required by `packages/daemon/test/db/migration-lock.spec.ts`. Do NOT
 * reshape into multi-line object literals — that would break both consumers.
 */
const MIGRATION_HASHES = {
  '001_initial.sql': 'f76859d5ad478a54f78754b6bd2874495452826a6430ab102534275979e0b06c',
} as const;

/**
 * Ordered list of locked migrations. Iteration order is application order —
 * the runner walks this list, applies any whose `version` is greater than
 * the current `schema_migrations.version`, and asserts SHA256 of each
 * already-applied row matches the entry below.
 *
 * Versions are explicit (not derived from filename prefix) so a future
 * rename / squash never silently shifts a row.
 */
export const MIGRATION_LOCKS: readonly MigrationLock[] = [
  { version: 1, filename: '001_initial.sql', sha256: MIGRATION_HASHES['001_initial.sql'] },
] as const;
