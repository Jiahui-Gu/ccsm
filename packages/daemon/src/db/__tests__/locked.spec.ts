// packages/daemon/src/db/__tests__/locked.spec.ts
//
// Unit test for `MIGRATION_LOCKS` (T5.4 / Task #56). Spec ch07 §4.
//
// This complements the FOREVER-STABLE test at
// `packages/daemon/test/db/migration-lock.spec.ts` (which parses locked.ts
// as text). This co-located spec imports the typed export directly and
// verifies:
//   - every entry's SHA256 matches the on-disk file's bytes
//   - versions are unique and strictly increasing in declaration order
//   - filenames match the `NNN_<name>.sql` convention from ch07 §4
//
// Why we still read the on-disk *.sql file here even after Task #463 moved
// the runner to an inlined module: this spec is the upstream invariant —
// it asserts the *.sql source files agree with locked.ts. The runner-side
// invariant (inlined bytes agree with locked.ts) is covered by
// `migrations/__tests__/runner.spec.ts`. Two independent checks, one for
// each link in the chain `*.sql → inlined.ts → MIGRATION_LOCKS`.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MIGRATION_LOCKS } from '../locked.js';

// Resolve the migrations dir relative to this test file (vitest runs from
// the source tree, so `import.meta.url` is well-defined here — unlike the
// SEA-bundled runner case that motivated Task #463).
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

describe('MIGRATION_LOCKS (T5.4 — ch07 §4)', () => {
  it('has at least one entry', () => {
    expect(MIGRATION_LOCKS.length).toBeGreaterThan(0);
  });

  it('every recorded SHA256 matches the on-disk file', () => {
    for (const lock of MIGRATION_LOCKS) {
      const path = join(MIGRATIONS_DIR, lock.filename);
      const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
      expect(actual, `SHA256 mismatch for ${lock.filename}`).toBe(lock.sha256);
    }
  });

  it('versions are unique and strictly increasing in declaration order', () => {
    const seen = new Set<number>();
    let prev = 0;
    for (const lock of MIGRATION_LOCKS) {
      expect(seen.has(lock.version), `duplicate version ${lock.version}`).toBe(false);
      seen.add(lock.version);
      expect(lock.version).toBeGreaterThan(prev);
      prev = lock.version;
    }
  });

  it('filenames follow the NNN_<name>.sql convention', () => {
    for (const lock of MIGRATION_LOCKS) {
      expect(lock.filename).toMatch(/^[0-9]{3}_[A-Za-z0-9_-]+\.sql$/);
    }
  });

  it('sha256 entries are 64 lowercase hex chars', () => {
    for (const lock of MIGRATION_LOCKS) {
      expect(lock.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

