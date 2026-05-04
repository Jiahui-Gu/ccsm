/**
 * tools/test/release-candidate.spec.ts
 *
 * Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
 * ch13 §2 phase 11 (release-candidate orchestrator).
 * Task #414 (T8.15a) — gate-a/b real, gate-c/d placeholder for v0.3 ship.
 *
 * Forever-stable shape + behavior gate for tools/release-candidate.sh.
 * We assert:
 *
 *   1. All six files exist at spec-pinned paths (driver + 4 gate libs +
 *      emit-tag).
 *   2. Driver runs all four gates in order and prints emit-tag suggestion
 *      when every gate passes (we substitute the lib dir via
 *      CCSM_RC_LIB_DIR so this stays hermetic — no real lint:no-ipc, no
 *      real vitest invocation, no minute-long test runs).
 *   3. Driver exits non-zero and does NOT print the tag suggestion when
 *      any real gate (a or b) fails.
 *   4. Placeholder gates (c and d) print WARN + exit 0 — guarding the
 *      "v0.3 ships on placeholders, v0.4 lands real impl (#415)" plan
 *      from accidental tightening.
 *
 * We invoke bash via `bash` on the PATH (Git Bash on Windows, system
 * bash elsewhere). The driver scripts are pure POSIX shell — no
 * platform-specific tools — so this works cross-OS in the same matrix
 * the rest of tools/test/*.spec.ts already runs in.
 *
 * Run with:
 *   npx vitest run --config tools/vitest.config.ts \
 *     tools/test/release-candidate.spec.ts
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DRIVER = join(REPO_ROOT, 'tools', 'release-candidate.sh');
const LIB_DIR = join(REPO_ROOT, 'tools', 'release-candidate', 'lib');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function runDriver(env: Record<string, string>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync('bash', [DRIVER], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('tools/release-candidate.sh (spec ch13 §2 phase 11, T8.15a / #414)', () => {
  describe('files exist at spec-pinned paths', () => {
    it('tools/release-candidate.sh present', () => {
      expect(existsSync(DRIVER)).toBe(true);
    });
    for (const name of ['gate-a.sh', 'gate-b.sh', 'gate-c.sh', 'gate-d.sh', 'emit-tag.sh']) {
      it(`tools/release-candidate/lib/${name} present`, () => {
        expect(existsSync(join(LIB_DIR, name))).toBe(true);
      });
    }
  });

  describe('placeholder gates document v0.3 ship policy', () => {
    it('gate-c.sh WARNs and exits 0 (placeholder, see #415)', () => {
      const r = spawnSync('bash', [join(LIB_DIR, 'gate-c.sh')], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/WARN: gate-c .* PLACEHOLDER/);
      expect(r.stdout).toMatch(/#415/);
    });

    it('gate-d.sh WARNs and exits 0 (placeholder, see #415)', () => {
      const r = spawnSync('bash', [join(LIB_DIR, 'gate-d.sh')], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/WARN: gate-d .* PLACEHOLDER/);
      expect(r.stdout).toMatch(/#415/);
    });

    it('gate-c source explicitly references #416 (T8.4 reopen blocker)', () => {
      expect(read(join(LIB_DIR, 'gate-c.sh'))).toMatch(/#416/);
    });

    it('gate-d source explicitly references #417 (T8.6 followup blocker)', () => {
      expect(read(join(LIB_DIR, 'gate-d.sh'))).toMatch(/#417/);
    });
  });

  describe('driver orchestration (mocked lib dir)', () => {
    let mockLib: string;

    beforeEach(() => {
      mockLib = mkdtempSync(join(tmpdir(), 'ccsm-rc-mock-'));
    });

    afterEach(() => {
      rmSync(mockLib, { recursive: true, force: true });
    });

    function writeStub(name: string, body: string) {
      const p = join(mockLib, name);
      writeFileSync(p, `#!/usr/bin/env bash\nset -e\n${body}\n`, 'utf8');
      chmodSync(p, 0o755);
    }

    function writeAllPassing() {
      writeStub('gate-a.sh', "echo 'mock gate-a OK'");
      writeStub('gate-b.sh', "echo 'mock gate-b OK'");
      writeStub('gate-c.sh', "echo 'mock gate-c OK'");
      writeStub('gate-d.sh', "echo 'mock gate-d OK'");
      writeStub('emit-tag.sh', "echo 'git tag v0.3.0 deadbeef'");
    }

    it('runs all four gates in order then emit-tag when everything passes', () => {
      writeAllPassing();
      const r = runDriver({ CCSM_RC_LIB_DIR: mockLib });
      expect(r.status).toBe(0);
      // Gate ordering must be a → b → c → d → emit-tag.
      const idxA = r.stdout.indexOf('gate-a:');
      const idxB = r.stdout.indexOf('gate-b:');
      const idxC = r.stdout.indexOf('gate-c:');
      const idxD = r.stdout.indexOf('gate-d:');
      const idxEmit = r.stdout.indexOf('emit-tag');
      expect(idxA).toBeGreaterThanOrEqual(0);
      expect(idxB).toBeGreaterThan(idxA);
      expect(idxC).toBeGreaterThan(idxB);
      expect(idxD).toBeGreaterThan(idxC);
      expect(idxEmit).toBeGreaterThan(idxD);
      expect(r.stdout).toMatch(/git tag v0\.3\.0/);
    });

    it('exits non-zero and skips emit-tag when gate-a fails', () => {
      writeAllPassing();
      writeStub('gate-a.sh', "echo 'mock gate-a FAIL' >&2; exit 1");
      const r = runDriver({ CCSM_RC_LIB_DIR: mockLib });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/FAIL: gate-a/);
      expect(r.stdout).not.toMatch(/git tag v0\.3\.0/);
      // gate-b should NOT have run after gate-a failed.
      expect(r.stdout).not.toMatch(/gate-b:/);
    });

    it('exits non-zero and skips emit-tag when gate-b fails', () => {
      writeAllPassing();
      writeStub('gate-b.sh', "echo 'mock gate-b FAIL' >&2; exit 1");
      const r = runDriver({ CCSM_RC_LIB_DIR: mockLib });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/FAIL: gate-b/);
      expect(r.stdout).not.toMatch(/git tag v0\.3\.0/);
    });

    it('exits with code 2 when a gate script is missing', () => {
      writeAllPassing();
      rmSync(join(mockLib, 'gate-c.sh'));
      const r = runDriver({ CCSM_RC_LIB_DIR: mockLib });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/gate-c script missing/);
    });
  });

  describe('emit-tag content', () => {
    it('prints a git tag suggestion (v0.3.0 by default) without executing it', () => {
      const r = spawnSync('bash', [join(LIB_DIR, 'emit-tag.sh')], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/git tag v0\.3\.0 [0-9a-f]{7,40}/);
      expect(r.stdout).toMatch(/minisign/i);
    });

    it('honors CCSM_RC_VERSION override', () => {
      const r = spawnSync('bash', [join(LIB_DIR, 'emit-tag.sh')], {
        cwd: REPO_ROOT,
        env: { ...process.env, CCSM_RC_VERSION: 'v0.3.1-rc1' },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/git tag v0\.3\.1-rc1 /);
    });
  });
});
