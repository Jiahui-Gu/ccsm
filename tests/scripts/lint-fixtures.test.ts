/**
 * Unit tests for scripts/lint-fixtures.ts.
 *
 * Each test builds a small filesystem under a tmp dir and invokes the
 * exported `lintFixtures()` API. Walking the real fixture tree is also
 * covered transitively by the CI workflow gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lintFixtures } from '../../scripts/lint-fixtures';

const SCRIPT_DIR = resolve(__dirname, '..', '..', 'scripts');

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'lint-fixtures-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function write(relPath: string, content: string | Buffer): string {
  const abs = join(tmpRoot, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

describe('lint-fixtures', () => {
  it('returns no violations for a clean small fixture', () => {
    write(
      'pkg/__fixtures__/good.json',
      JSON.stringify({ hello: 'world', count: 42 }),
    );
    const result = lintFixtures({ cwd: tmpRoot, scriptDir: SCRIPT_DIR });
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.violations).toEqual([]);
  });

  it('flags Windows real-user paths', () => {
    write(
      'pkg/__fixtures__/winpath.json',
      JSON.stringify({ p: 'C:\\Users\\realname\\Desktop\\foo.txt' }),
    );
    const result = lintFixtures({ cwd: tmpRoot, scriptDir: SCRIPT_DIR });
    expect(result.violations.length).toBeGreaterThan(0);
    const names = result.violations.map((v) => v.rule);
    expect(names).toContain('windows-user-path');
  });

  it('flags JWT tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    write('pkg/__fixtures__/with-jwt.txt', `token=${jwt}`);
    const result = lintFixtures({ cwd: tmpRoot, scriptDir: SCRIPT_DIR });
    const names = result.violations.map((v) => v.rule);
    expect(names).toContain('jwt-token');
  });

  it('flags fixtures larger than 1 MiB with a size message', () => {
    // 1 MiB + 1 byte of plain ASCII so we hit the size check, not content.
    const big = Buffer.alloc(1024 * 1024 + 1, 0x61); // 'a'
    write('pkg/__fixtures__/huge.json', big);
    const result = lintFixtures({ cwd: tmpRoot, scriptDir: SCRIPT_DIR });
    const sizeViolations = result.violations.filter(
      (v) => v.rule === 'size-cap',
    );
    expect(sizeViolations.length).toBe(1);
    expect(sizeViolations[0].detail).toMatch(/bytes/);
    expect(sizeViolations[0].detail).toMatch(/1 MiB/);
  });

  it('exempts files under __fixtures__/anonymized/ even with PII-looking text', () => {
    write(
      'pkg/__fixtures__/anonymized/example.json',
      JSON.stringify({
        winPath: 'C:\\Users\\realname\\code',
        macPath: '/Users/realname/code',
        token:
          'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.4wIPSF98PuB5QgCHRzU3qJrfOsRJM9HLR8MccWBpZJM',
      }),
    );
    const result = lintFixtures({ cwd: tmpRoot, scriptDir: SCRIPT_DIR });
    expect(result.violations).toEqual([]);
  });

  it('flags real-looking session UUIDs not in the allow-list', () => {
    write(
      'pkg/__fixtures__/uuid-bad.json',
      JSON.stringify({ sessionId: 'a1b2c3d4-e5f6-4789-9abc-1234567890ab' }),
    );
    const result = lintFixtures({ cwd: tmpRoot, scriptDir: SCRIPT_DIR });
    const names = result.violations.map((v) => v.rule);
    expect(names).toContain('session-uuid');
  });

  it('accepts session UUIDs that appear in the allow-list', () => {
    // Allow-listed in scripts/__test-uuids.txt.
    write(
      'pkg/__fixtures__/uuid-good.json',
      JSON.stringify({ sessionId: '00000000-0000-4000-8000-000000000000' }),
    );
    const result = lintFixtures({ cwd: tmpRoot, scriptDir: SCRIPT_DIR });
    const uuidViolations = result.violations.filter(
      (v) => v.rule === 'session-uuid',
    );
    expect(uuidViolations).toEqual([]);
  });
});
