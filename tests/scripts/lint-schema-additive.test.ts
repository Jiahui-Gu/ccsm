/**
 * Unit tests for scripts/lint-schema-additive.ts.
 *
 * Each test builds a small migrations tree under a tmp dir with an
 * explicit `.v03-baseline` and invokes the exported `lintSchemaAdditive()`
 * API. Walking the real `daemon/src/db/migrations/` tree is covered
 * transitively by the CI workflow gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintSchemaAdditive } from '../../scripts/lint-schema-additive';

let tmpRoot: string;
let migrationsDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'lint-schema-additive-'));
  migrationsDir = join(tmpRoot, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeMigration(name: string, sql: string): string {
  const abs = join(migrationsDir, name);
  writeFileSync(abs, sql);
  return abs;
}

function writeBaseline(content: string): void {
  writeFileSync(join(migrationsDir, '.v03-baseline'), content);
}

describe('lint-schema-additive', () => {
  it('exit 0: ADD TABLE is additive', () => {
    writeBaseline('__none__');
    writeMigration(
      '0001_add_session_index.sql',
      `CREATE TABLE sessions_v2 (
         id TEXT PRIMARY KEY,
         created_at INTEGER NOT NULL DEFAULT 0
       );`,
    );
    const r = lintSchemaAdditive({ cwd: tmpRoot, migrationsDir });
    expect(r.violations).toEqual([]);
    expect(r.scanned).toBe(1);
  });

  it('exit 0: ADD COLUMN nullable is additive', () => {
    writeBaseline('__none__');
    writeMigration(
      '0001_add_nullable_col.sql',
      `ALTER TABLE sessions ADD COLUMN nickname TEXT;`,
    );
    const r = lintSchemaAdditive({ cwd: tmpRoot, migrationsDir });
    expect(r.violations).toEqual([]);
  });

  it('exit 0: ADD COLUMN NOT NULL DEFAULT 0 is additive', () => {
    writeBaseline('__none__');
    writeMigration(
      '0001_add_not_null_default.sql',
      `ALTER TABLE sessions ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;`,
    );
    const r = lintSchemaAdditive({ cwd: tmpRoot, migrationsDir });
    expect(r.violations).toEqual([]);
  });

  it('exit 1: DROP TABLE flagged with file:line', () => {
    writeBaseline('__none__');
    const file = writeMigration(
      '0001_drop_old.sql',
      `-- destructive
DROP TABLE old_sessions;`,
    );
    const r = lintSchemaAdditive({ cwd: tmpRoot, migrationsDir });
    expect(r.violations.length).toBeGreaterThan(0);
    const v = r.violations.find((x) => x.rule === 'DROP TABLE');
    expect(v).toBeDefined();
    expect(v!.file).toBe(file);
    expect(v!.line).toBe(2);
  });

  it('exit 1: DROP COLUMN flagged', () => {
    writeBaseline('__none__');
    writeMigration(
      '0001_drop_col.sql',
      `ALTER TABLE sessions DROP COLUMN obsolete;`,
    );
    const r = lintSchemaAdditive({ cwd: tmpRoot, migrationsDir });
    const names = r.violations.map((v) => v.rule);
    expect(names).toContain('DROP COLUMN');
  });

  it('exit 1: ADD COLUMN NOT NULL without DEFAULT is flagged', () => {
    writeBaseline('__none__');
    writeMigration(
      '0001_add_not_null.sql',
      `ALTER TABLE sessions ADD COLUMN required_field TEXT NOT NULL;`,
    );
    const r = lintSchemaAdditive({ cwd: tmpRoot, migrationsDir });
    const names = r.violations.map((v) => v.rule);
    expect(names).toContain('ADD COLUMN NOT NULL without DEFAULT');
  });

  it('exit 1: RENAME COLUMN flagged', () => {
    writeBaseline('__none__');
    writeMigration(
      '0001_rename.sql',
      `ALTER TABLE sessions RENAME COLUMN old_name TO new_name;`,
    );
    const r = lintSchemaAdditive({ cwd: tmpRoot, migrationsDir });
    const names = r.violations.map((v) => v.rule);
    expect(names).toContain('RENAME (table or column)');
  });

  it('exit 1: ALTER COLUMN ... TYPE flagged', () => {
    writeBaseline('__none__');
    writeMigration(
      '0001_alter_type.sql',
      `ALTER TABLE sessions ALTER COLUMN created_at TYPE BIGINT;`,
    );
    const r = lintSchemaAdditive({ cwd: tmpRoot, migrationsDir });
    const names = r.violations.map((v) => v.rule);
    expect(names).toContain('ALTER COLUMN type change');
  });

  it('exit 0: migration before/at baseline is ignored regardless of content', () => {
    writeBaseline('0099_last_v03.sql');
    // This destructive file is at-or-before baseline → ignored.
    writeMigration('0099_last_v03.sql', `DROP TABLE legacy;`);
    // Confirm post-baseline files still get linted (sanity).
    writeMigration(
      '0100_post.sql',
      `CREATE TABLE noted (id INTEGER PRIMARY KEY);`,
    );
    const r = lintSchemaAdditive({ cwd: tmpRoot, migrationsDir });
    expect(r.violations).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.scanned).toBe(1);
  });
});
