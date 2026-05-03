/**
 * tools/test/check-v02-shrinking.spec.ts
 *
 * Tests for `tools/check-v02-shrinking.sh` (FOLLOWUP per Task #279, #278).
 *
 * Spins up disposable git repo fixtures in a tmp dir to verify:
 *   1. Baseline (no growth, no shrink)        → exit 0
 *   2. Step-wise shrink only                   → exit 0
 *   3. PR-level grow vs base                   → exit 1 (overall)
 *   4. Step-wise re-grow inside branch series  → exit 1 (step)
 *      (file shrinks in commit 1, grows back in commit 2 within HEAD~base
 *      to original size — base-vs-HEAD is unchanged but a step grew)
 *   5. New file added inside branch (base=0)   → exit 1 (overall)
 *
 * The script invokes `git rev-list --first-parent`, so we drive the chain
 * via a linear branch history (no merges) — same shape as a typical PR.
 *
 * Run with:
 *   npx vitest run --config tools/vitest.config.ts \
 *     tools/test/check-v02-shrinking.spec.ts
 *
 * No new deps: vitest + node:fs + node:os + node:child_process + node:path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT_SRC = join(REPO_ROOT, 'tools', 'check-v02-shrinking.sh');

type Step = (
  /** repo path */ repo: string,
  /** absolute path to tools/check-v02-shrinking.sh inside the fixture */ script: string,
) => void;

interface Fixture {
  /** the on-disk repo path */
  repo: string;
  /** path to the script copy inside the fixture */
  script: string;
  /** invoke the script in the fixture, returns {status, stdout, stderr} */
  run(env?: Record<string, string>): {
    status: number | null;
    stdout: string;
    stderr: string;
  };
}

function git(repo: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${repo}:\n${r.stdout}\n${r.stderr}`,
    );
  }
  return r.stdout;
}

function makeFixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), 'check-v02-shrinking-'));
  const repo = join(tmp, 'repo');
  mkdirSync(repo, { recursive: true });

  // Init repo with a deterministic default branch ('working' to mirror
  // the real repo's integration branch).
  git(repo, 'init', '--initial-branch=working', '--quiet');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'tag.gpgsign', 'false');

  // Copy the script into the fixture (script reads its own location only
  // for its workdir-relative LIST_FILE, so a copy is fine).
  const script = join(repo, 'check-v02-shrinking.sh');
  cpSync(SCRIPT_SRC, script);

  return {
    repo,
    script,
    run(env: Record<string, string> = {}) {
      const r = spawnSync('bash', [script], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
      return {
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
      };
    },
  };
}

function writeListFile(repo: string, patterns: string[]): void {
  writeFileSync(join(repo, '.v0.2-only-files'), patterns.join('\n') + '\n');
}

function writeLines(repo: string, relPath: string, lineCount: number): void {
  const full = join(repo, relPath);
  mkdirSync(dirname(full), { recursive: true });
  // Each line is unique so changes are real edits, not no-ops.
  const body = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join(
    '\n',
  );
  writeFileSync(full, body + '\n');
}

function commit(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message, '--quiet', '--allow-empty');
  return git(repo, 'rev-parse', 'HEAD').trim();
}

/**
 * Build the CI scenario: an "origin/working" base sha (we set the env var
 * GITHUB_BASE_REF=working and create a fake `origin/working` ref pointing
 * at the chosen base commit).
 */
function setOriginWorking(repo: string, sha: string): void {
  git(repo, 'update-ref', 'refs/remotes/origin/working', sha);
}

describe('tools/check-v02-shrinking.sh — step-wise monotonicity', () => {
  let fixtures: Fixture[] = [];

  function track(): Fixture {
    const f = makeFixture();
    fixtures.push(f);
    return f;
  }

  afterAll(() => {
    for (const f of fixtures) {
      try {
        rmSync(dirname(f.repo), { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  });

  it('PASS: file shrinks monotonically across commits', () => {
    const f = track();
    writeListFile(f.repo, ['src/big.ts']);
    writeLines(f.repo, 'src/big.ts', 100);
    const base = commit(f.repo, 'base: 100 lines');
    setOriginWorking(f.repo, base);

    writeLines(f.repo, 'src/big.ts', 80);
    commit(f.repo, 'shrink to 80');
    writeLines(f.repo, 'src/big.ts', 50);
    commit(f.repo, 'shrink to 50');

    const r = f.run({ GITHUB_BASE_REF: 'working' });
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/PASS: no v0\.2-only file grew/);
    expect(r.stdout).toMatch(/OK:\s+src\/big\.ts.*-50/);
    // REVERSE-VERIFY (#291) — must be reverted before merge.
    expect('reverse-verify-sentinel').toBe('this-must-fail');
  });

  it('PASS: file untouched in series (skip step walk)', () => {
    const f = track();
    writeListFile(f.repo, ['src/stable.ts']);
    writeLines(f.repo, 'src/stable.ts', 30);
    writeLines(f.repo, 'src/other.ts', 10);
    const base = commit(f.repo, 'base');
    setOriginWorking(f.repo, base);

    writeLines(f.repo, 'src/other.ts', 5);
    commit(f.repo, 'unrelated change');

    const r = f.run({ GITHUB_BASE_REF: 'working' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/untouched in series/);
  });

  it('FAIL: PR-level grow vs base (overall check)', () => {
    const f = track();
    writeListFile(f.repo, ['src/big.ts']);
    writeLines(f.repo, 'src/big.ts', 100);
    const base = commit(f.repo, 'base: 100');
    setOriginWorking(f.repo, base);

    writeLines(f.repo, 'src/big.ts', 150);
    commit(f.repo, 'grew to 150');

    const r = f.run({ GITHUB_BASE_REF: 'working' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/GROW\(overall\):\s+src\/big\.ts/);
    expect(r.stdout).toMatch(/FAIL/);
  });

  it('FAIL: step-wise re-grow inside branch series (the #279 bug)', () => {
    // The exact scenario reviewer #278 flagged: file shrinks in commit 1,
    // re-grows in commit 2 back to <= original. Old impl (base-vs-HEAD only)
    // would PASS because HEAD <= base. New impl must catch the step grow.
    const f = track();
    writeListFile(f.repo, ['src/budget.ts']);
    writeLines(f.repo, 'src/budget.ts', 100);
    const base = commit(f.repo, 'base: 100');
    setOriginWorking(f.repo, base);

    writeLines(f.repo, 'src/budget.ts', 50); // claim shrink budget
    commit(f.repo, 'shrink to 50');
    writeLines(f.repo, 'src/budget.ts', 100); // silently re-grow
    commit(f.repo, 're-grow to 100');

    const r = f.run({ GITHUB_BASE_REF: 'working' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/GROW\(step\):\s+src\/budget\.ts/);
    expect(r.stdout).toMatch(/prev=50, this=100/);
  });

  it('FAIL: step-wise re-grow even when HEAD < base overall', () => {
    // Reviewer concern in even sharper form: HEAD ends up SMALLER than base,
    // so overall check passes — but a step in between still re-grew. That
    // intermediate re-grow wasted budget and must fail.
    const f = track();
    writeListFile(f.repo, ['src/budget.ts']);
    writeLines(f.repo, 'src/budget.ts', 100);
    const base = commit(f.repo, 'base: 100');
    setOriginWorking(f.repo, base);

    writeLines(f.repo, 'src/budget.ts', 30); // big shrink
    commit(f.repo, 'shrink to 30');
    writeLines(f.repo, 'src/budget.ts', 60); // re-grow but still < base
    commit(f.repo, 're-grow to 60');
    writeLines(f.repo, 'src/budget.ts', 50); // shrink a bit
    commit(f.repo, 'shrink to 50');

    const r = f.run({ GITHUB_BASE_REF: 'working' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/GROW\(step\):\s+src\/budget\.ts/);
    expect(r.stdout).toMatch(/prev=30, this=60/);
  });

  it('FAIL: brand-new v0.2-only file added in branch (base=0)', () => {
    const f = track();
    writeListFile(f.repo, ['src/forbidden.ts']);
    writeLines(f.repo, 'src/placeholder.ts', 1);
    const base = commit(f.repo, 'base without forbidden file');
    setOriginWorking(f.repo, base);

    writeLines(f.repo, 'src/forbidden.ts', 25);
    commit(f.repo, 'add forbidden v0.2-only file');

    const r = f.run({ GITHUB_BASE_REF: 'working' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/GROW\(overall\):\s+src\/forbidden\.ts/);
  });

  it('SKIP: missing in both base and head', () => {
    const f = track();
    writeListFile(f.repo, ['src/never-existed.ts']);
    writeLines(f.repo, 'src/something.ts', 1);
    const base = commit(f.repo, 'base');
    setOriginWorking(f.repo, base);

    writeLines(f.repo, 'src/something.ts', 2);
    commit(f.repo, 'tweak');

    const r = f.run({ GITHUB_BASE_REF: 'working' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/SKIP:\s+src\/never-existed\.ts/);
  });

  it('PASS: glob pattern shrinks step-wise', () => {
    const f = track();
    writeListFile(f.repo, ['src/glob/*.ts']);
    writeLines(f.repo, 'src/glob/a.ts', 20);
    writeLines(f.repo, 'src/glob/b.ts', 30);
    const base = commit(f.repo, 'base: glob sums to 50');
    setOriginWorking(f.repo, base);

    writeLines(f.repo, 'src/glob/a.ts', 10);
    commit(f.repo, 'shrink a to 10');

    const r = f.run({ GITHUB_BASE_REF: 'working' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/OK:\s+src\/glob\/\*\.ts/);
  });

  it('FAIL: glob pattern re-grows step-wise', () => {
    const f = track();
    writeListFile(f.repo, ['src/glob/*.ts']);
    writeLines(f.repo, 'src/glob/a.ts', 20);
    writeLines(f.repo, 'src/glob/b.ts', 30);
    const base = commit(f.repo, 'base');
    setOriginWorking(f.repo, base);

    writeLines(f.repo, 'src/glob/a.ts', 5);
    commit(f.repo, 'shrink a to 5 (sum=35)');
    writeLines(f.repo, 'src/glob/c.ts', 50);
    commit(f.repo, 'add c.ts (sum=85, re-grew)');

    const r = f.run({ GITHUB_BASE_REF: 'working' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/GROW.*src\/glob\/\*\.ts/);
  });
});
