// packages/daemon/test/db/migration-lock.spec.ts
//
// FOREVER-STABLE per docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// chapter 15 §3 item #4 + chapter 07 §4. The runtime self-check side of the
// migration immutability lock: at boot the daemon will compute SHA256s of its
// bundled migration files and assert against `MIGRATION_LOCKS` exported from
// `packages/daemon/src/db/locked.ts`. This spec runs the same comparison
// in-process so the invariant fails CI before it can fail production.
//
// Two-tier safety net (see ch07 §4):
//   - tools/check-migration-locks.sh — compares against the GitHub release body
//     of v0.3.0 (the immutable witness)
//   - this spec — compares against `MIGRATION_LOCKS` in locked.ts (the
//     in-process self-check the daemon runs at boot)
//
// `locked.ts` is created later by Task #56 (T5.4 migration runner). Until then
// this whole describe block auto-skips via `describe.skipIf`. No other tests
// exist in `packages/daemon/test/` yet (T0.1 / PR #848 created the empty
// daemon package skeleton); this file is forward-compatible with that wiring.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Paths are resolved relative to the daemon package root (parent of test/).
// Project is ESM (no CommonJS `__dirname`); derive it from `import.meta.url`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DAEMON_ROOT = resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = join(DAEMON_ROOT, 'src', 'db', 'migrations');
const LOCKED_TS_PATH = join(DAEMON_ROOT, 'src', 'db', 'locked.ts');

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Skip the entire suite until locked.ts lands. We deliberately do not try to
// dynamically import locked.ts here — vitest evaluates the import graph eagerly
// and a missing module would surface as a hard error before describe.skipIf
// runs. Instead we read it as text and parse the MIGRATION_LOCKS entries.
const lockedTsExists = existsSync(LOCKED_TS_PATH);

describe.skipIf(!lockedTsExists)('migration-lock (runtime self-check)', () => {
  // Parse `MIGRATION_LOCKS` entries from locked.ts source text. We accept
  // either object-literal form (`'<file>': '<hex>'`) or a Map/array form
  // with the same string pair shape. Source-text parsing avoids pinning this
  // spec to one particular export style — Task #56 picks the shape; this
  // spec just needs (filename, sha256) pairs.
  const lockedSrc = readFileSync(LOCKED_TS_PATH, 'utf8');
  // Strip `//` line comments so a stale commented-out hash (e.g. left during
  // a migration rename) does not produce a false-positive match below.
  const lockedSrcStripped = lockedSrc.replace(/\/\/.*$/gm, '');
  const entryRe = /['"]([0-9]{3}_[A-Za-z0-9_-]+\.sql)['"]\s*[:,]\s*['"]([0-9a-fA-F]{64})['"]/g;
  const recorded = new Map<string, string>();
  for (const m of lockedSrcStripped.matchAll(entryRe)) {
    recorded.set(m[1], m[2].toLowerCase());
  }

  it('locked.ts declares at least one MIGRATION_LOCKS entry', () => {
    expect(recorded.size).toBeGreaterThan(0);
  });

  it('every recorded migration file exists on disk', () => {
    for (const filename of recorded.keys()) {
      const path = join(MIGRATIONS_DIR, filename);
      expect(existsSync(path), `${filename} missing at ${path}`).toBe(true);
    }
  });

  it('every recorded SHA256 matches the on-disk file', () => {
    for (const [filename, expected] of recorded) {
      const path = join(MIGRATIONS_DIR, filename);
      const actual = sha256OfFile(path);
      expect(actual, `SHA256 mismatch for ${filename}`).toBe(expected);
    }
  });

  it('every on-disk migration file has a recorded lock', () => {
    // Inverse direction — guards against a developer adding a migration
    // without locking it. Only checks files matching the v0.3 naming pattern
    // (`NNN_<name>.sql`) so unrelated fixtures, if any, do not trip it.
    if (!existsSync(MIGRATIONS_DIR)) return;
    const onDisk = readdirSync(MIGRATIONS_DIR).filter((f) => /^[0-9]{3}_.+\.sql$/.test(f));
    for (const filename of onDisk) {
      expect(recorded.has(filename), `${filename} on disk but not in MIGRATION_LOCKS`).toBe(true);
    }
  });
});
