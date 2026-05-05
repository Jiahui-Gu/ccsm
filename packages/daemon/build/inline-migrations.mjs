#!/usr/bin/env node
/* global console, process */
// packages/daemon/build/inline-migrations.mjs — generate src/db/migrations/inlined.ts
// from the bundled *.sql files so the SEA-bundled daemon does NOT depend on
// runtime filesystem reads of `import.meta.url`.
//
// Why this exists (Task #463 / P0 ship blocker):
//
//   The daemon SEA binary (`build:sea:posix` / `build:sea:win`) bundles
//   `dist/index.js` via esbuild into a single CJS file (`dist/bundle.cjs`),
//   then postjects it into the Node binary. esbuild rewrites every
//   `import.meta.url` reference to the literal `(typeof __filename !==
//   "undefined" ? __filename : (typeof document === "undefined" ? require(...
//   ).pathToFileURL(__filename).href : ...))` shim. In the postjected SEA
//   binary `__filename` is **undefined** for the bundled CJS entry, so
//   `fileURLToPath(import.meta.url)` throws and the daemon dies before
//   `OPENING_DB`. dev round-3 traced the exact crash to
//   `dist/bundle.cjs:6961` (formerly `runner.ts:32`).
//
//   Option A (this script): inline every `*.sql` byte sequence into a TS
//   module at build time. The runner reads `MIGRATION_SQL[filename]` from
//   the inlined module instead of `readFileSync(...)`. Zero filesystem
//   dependency — works in dev (tsc), test (vitest), and SEA bundle alike.
//   Migration sha256 verification stays in `src/db/locked.ts` (FOREVER-
//   STABLE per spec ch07 §4 + ch15 §3); the runner still hashes the inlined
//   bytes and compares against `MIGRATION_LOCKS[].sha256`, so tampering with
//   the inlined module triggers the same `MigrationLockMismatchError`.
//
// Generated file is gitignored (same convention as `gen/ts/` proto output
// and `dist/`). It is produced by the `prebuild` npm script before `tsc`.
//
// Determinism:
//   - filenames sorted (stable Object key order in TS output)
//   - SQL bytes embedded as a Buffer literal (preserves exact bytes incl.
//     trailing newline; matches the FOREVER-STABLE sha256 in locked.ts)
//   - "GENERATED FILE — DO NOT EDIT" header for human readers + reviewer
//     greps

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(HERE, '..');
const MIGRATIONS_DIR = join(PKG_DIR, 'src', 'db', 'migrations');
const OUT_FILE = join(MIGRATIONS_DIR, 'inlined.ts');

function main() {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`[inline-migrations] ${MIGRATIONS_DIR} does not exist`);
    process.exit(1);
  }

  const sqlFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (sqlFiles.length === 0) {
    console.error(`[inline-migrations] no *.sql files in ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  // Encode each SQL file as a base64 string. Base64 keeps the TS source
  // small and round-trip-safe (binary-clean — preserves the trailing
  // newline byte that the locked SHA-256 was computed over). Decoded once
  // at module load via `Buffer.from(b64, 'base64').toString('utf8')`.
  const entries = sqlFiles.map((filename) => {
    const bytes = readFileSync(join(MIGRATIONS_DIR, filename));
    const b64 = bytes.toString('base64');
    return { filename, b64, byteLength: bytes.length };
  });

  const lines = [
    '// packages/daemon/src/db/migrations/inlined.ts',
    '//',
    '// GENERATED FILE — DO NOT EDIT BY HAND.',
    '// Regenerated on every build by packages/daemon/build/inline-migrations.mjs',
    '// (npm `prebuild` hook). Source of truth: the *.sql files in this directory.',
    '//',
    '// This module exists so the SEA-bundled daemon can read migration SQL',
    '// without touching the filesystem (Task #463 / P0 ship blocker — esbuild',
    '// rewrites `import.meta.url` to a `__filename` shim that is undefined in',
    '// a postjected SEA binary, crashing `fileURLToPath(...)` before',
    '// OPENING_DB). The runner still SHA-256-verifies the bytes here against',
    '// `src/db/locked.ts:MIGRATION_HASHES`, so tampering with this file is',
    '// caught by `MigrationLockMismatchError` exactly as a tampered on-disk',
    '// SQL file would be.',
    '',
    '/**',
    ' * Inlined migration payload. Keys are the basenames under',
    ' * `packages/daemon/src/db/migrations/` (e.g. `001_initial.sql`); values',
    ' * are the exact UTF-8 byte sequence of the SQL file (including any',
    ' * trailing newline) decoded from a build-time base64 literal. The',
    ' * decoded bytes are SHA-256-equivalent to the on-disk file — verified',
    ' * at runtime against `MIGRATION_LOCKS[].sha256`.',
    ' */',
    '// NOTE: not Object.freeze()d so unit tests can inject synthetic entries',
    '// for partial-apply / missing-payload coverage. Production callers MUST',
    '// treat this object as read-only (the type signature enforces this).',
    'export const MIGRATION_SQL: Record<string, string> = {',
  ];

  for (const { filename, b64, byteLength } of entries) {
    lines.push(`  // ${filename} (${byteLength} bytes)`);
    lines.push(
      `  ${JSON.stringify(filename)}: Buffer.from(${JSON.stringify(b64)}, 'base64').toString('utf8'),`,
    );
  }

  lines.push('};');
  lines.push('');
  lines.push('/**');
  lines.push(' * Sorted list of inlined migration filenames. Useful for the runner to');
  lines.push(' * detect a lock entry whose corresponding SQL is missing from the bundle');
  lines.push(' * (would happen if someone hand-edited this file or deleted a *.sql');
  lines.push(' * before regenerating).');
  lines.push(' */');
  lines.push('export const INLINED_MIGRATION_FILENAMES: readonly string[] = [');
  for (const { filename } of entries) {
    lines.push(`  ${JSON.stringify(filename)},`);
  }
  lines.push('];');
  lines.push('');

  const out = lines.join('\n');

  // Idempotency: only rewrite if content changed. Avoids triggering tsc
  // incremental rebuild churn when nothing actually changed.
  if (existsSync(OUT_FILE)) {
    const current = readFileSync(OUT_FILE, 'utf8');
    if (current === out) {
      console.log(`[inline-migrations] up-to-date (${entries.length} file(s)) -> ${OUT_FILE}`);
      return;
    }
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, out, 'utf8');
  console.log(`[inline-migrations] wrote ${entries.length} migration(s) -> ${OUT_FILE}`);
}

main();
