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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MIGRATION_LOCKS } from '../locked.js';
import { migrationFilePath } from '../migrations/runner.js';

describe('MIGRATION_LOCKS (T5.4 — ch07 §4)', () => {
  it('has at least one entry', () => {
    expect(MIGRATION_LOCKS.length).toBeGreaterThan(0);
  });

  it('every recorded SHA256 matches the on-disk file', () => {
    for (const lock of MIGRATION_LOCKS) {
      const path = migrationFilePath(lock.filename);
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
