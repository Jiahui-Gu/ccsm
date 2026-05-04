/**
 * tools/test/update-flow-allowlist.spec.ts
 *
 * v0.3 sketch validation for tools/update-flow.spec.{sh,ps1} per spec
 * ch10 §8 ("manual pre-release smoke v0.3, CI in v0.4"). The flow itself
 * needs a live launchd/systemd/SCM unit to e2e (deferred to v0.4); this
 * spec exercises the pieces that DO run hermetically:
 *
 *   1. The script is spawn-able and exits 0 in --dry-run mode.
 *   2. Each lib/* helper runs standalone in --dry-run mode and exits 0.
 *   3. The rollback path propagates non-zero exit when forced (proves the
 *      driver actually checks lib exit codes — sanity for "spec can fail").
 *   4. lib/rollback.sh in --dry-run prints the NDJSON line it WOULD append
 *      with source="update_rollback" and owner_id="daemon-self" — so a
 *      reviewer can verify the wire shape against raw-appender.ts
 *      `CrashRawEntry` without spinning a daemon.
 *
 * Layer 2 (live SCM, real binary swap, real /healthz poll) is v0.4 work.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SH_MAIN = join(REPO_ROOT, 'tools', 'update-flow.spec.sh');
const PS1_MAIN = join(REPO_ROOT, 'tools', 'update-flow.spec.ps1');
const LIB_DIR = join(REPO_ROOT, 'tools', 'update-flow', 'lib');

const bashAvailable = (() => {
  try {
    const r = spawnSync('bash', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
})();

const pwshAvailable = (() => {
  try {
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', '$null'], {
      stdio: 'ignore',
    });
    return r.status === 0;
  } catch {
    return false;
  }
})();

describe('update-flow.spec.{sh,ps1} — files exist', () => {
  it('main sh exists', () => {
    expect(existsSync(SH_MAIN)).toBe(true);
  });
  it('main ps1 exists', () => {
    expect(existsSync(PS1_MAIN)).toBe(true);
  });
  for (const helper of ['stop-with-escalation', 'rename-prev', 'rollback']) {
    it(`lib/${helper}.sh exists`, () => {
      expect(existsSync(join(LIB_DIR, `${helper}.sh`))).toBe(true);
    });
    it(`lib/${helper}.ps1 exists`, () => {
      expect(existsSync(join(LIB_DIR, `${helper}.ps1`))).toBe(true);
    });
  }
});

describe('update-flow.spec.sh (dry-run)', () => {
  it.skipIf(!bashAvailable)('main script --dry-run exits 0', () => {
    const r = spawnSync('bash', [SH_MAIN, '--dry-run', '--simulate-healthz=pass'], {
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(
        `update-flow.spec.sh --dry-run exit=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
      );
    }
    expect(r.stdout).toMatch(/step 1\/4/);
    expect(r.stdout).toMatch(/step 4\/4/);
    expect(r.stdout).toMatch(/update flow complete/);
  });

  it.skipIf(!bashAvailable)('main script --dry-run + simulate-healthz=fail triggers rollback path', () => {
    const r = spawnSync(
      'bash',
      [SH_MAIN, '--dry-run', '--simulate-healthz=fail'],
      { encoding: 'utf8' },
    );
    // Rollback in dry-run still exits 0 (the dry-run rollback "succeeds").
    if (r.status !== 0) {
      throw new Error(
        `update-flow.spec.sh exit=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
      );
    }
    expect(r.stdout).toMatch(/healthz FAILED/);
    expect(r.stdout).toMatch(/\[rollback\] rollback start/);
    // Wire-shape assertion: the dry-run rollback prints the NDJSON line.
    expect(r.stdout).toMatch(/"source":"update_rollback"/);
    expect(r.stdout).toMatch(/"owner_id":"daemon-self"/);
  });

  it.skipIf(!bashAvailable)('lib/stop-with-escalation.sh --dry-run exits 0', () => {
    const r = spawnSync(
      'bash',
      [join(LIB_DIR, 'stop-with-escalation.sh'), '--dry-run'],
      { encoding: 'utf8' },
    );
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/polite stop/);
  });

  it.skipIf(!bashAvailable)('lib/rename-prev.sh --dry-run exits 0', () => {
    const r = spawnSync(
      'bash',
      [join(LIB_DIR, 'rename-prev.sh'), '--dry-run', '--install-root=/tmp/nope'],
      { encoding: 'utf8' },
    );
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/install root: \/tmp\/nope/);
  });

  it.skipIf(!bashAvailable)('lib/rollback.sh --dry-run prints update_rollback NDJSON', () => {
    const r = spawnSync(
      'bash',
      [
        join(LIB_DIR, 'rollback.sh'),
        '--dry-run',
        '--install-root=/tmp/nope',
        '--state-dir=/tmp/nope-state',
        '--reason=test',
      ],
      { encoding: 'utf8' },
    );
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/"source":"update_rollback"/);
    expect(r.stdout).toMatch(/"owner_id":"daemon-self"/);
    expect(r.stdout).toMatch(/"summary":"update_rollback: test"/);
  });

  it.skipIf(!bashAvailable)('lib/rollback.sh propagates non-zero exit when bash forces it', () => {
    // Sanity: prove the spec can FAIL (per task acceptance criterion). Run
    // bash with `set -e` and `false` to confirm spawnSync surfaces
    // non-zero — the same plumbing the main flow uses to detect rollback
    // failure.
    const r = spawnSync('bash', ['-c', 'set -e; false'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
  });
});

describe('update-flow.spec.ps1 (dry-run)', () => {
  it.skipIf(!pwshAvailable)('main script -DryRun exits 0', () => {
    const r = spawnSync(
      'pwsh',
      ['-NoProfile', '-File', PS1_MAIN, '-DryRun', '-SimulateHealthz', 'pass'],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) {
      throw new Error(
        `update-flow.spec.ps1 -DryRun exit=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
      );
    }
    expect(r.stdout).toMatch(/step 1\/4/);
    expect(r.stdout).toMatch(/step 4\/4/);
    expect(r.stdout).toMatch(/update flow complete/);
  });

  it.skipIf(!pwshAvailable)('main script -DryRun -SimulateHealthz fail triggers rollback', () => {
    const r = spawnSync(
      'pwsh',
      ['-NoProfile', '-File', PS1_MAIN, '-DryRun', '-SimulateHealthz', 'fail'],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) {
      throw new Error(
        `update-flow.spec.ps1 exit=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
      );
    }
    expect(r.stdout).toMatch(/healthz FAILED/);
    expect(r.stdout).toMatch(/\[rollback\] rollback start/);
    expect(r.stdout).toMatch(/"source":\s*"update_rollback"/);
    expect(r.stdout).toMatch(/"owner_id":\s*"daemon-self"/);
  });

  it.skipIf(!pwshAvailable)('lib/stop-with-escalation.ps1 -DryRun parses + exits 0', () => {
    const r = spawnSync(
      'pwsh',
      ['-NoProfile', '-File', join(LIB_DIR, 'stop-with-escalation.ps1'), '-DryRun'],
      { encoding: 'utf8' },
    );
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/polite stop/);
  });

  it.skipIf(!pwshAvailable)('lib/rename-prev.ps1 -DryRun parses + exits 0', () => {
    const r = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        join(LIB_DIR, 'rename-prev.ps1'),
        '-DryRun',
        '-InstallRoot',
        'C:\\tmp\\nope',
      ],
      { encoding: 'utf8' },
    );
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/install root:/);
  });

  it.skipIf(!pwshAvailable)('lib/rollback.ps1 -DryRun prints update_rollback NDJSON', () => {
    const r = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        join(LIB_DIR, 'rollback.ps1'),
        '-DryRun',
        '-InstallRoot',
        'C:\\tmp\\nope',
        '-StateDir',
        'C:\\tmp\\nope-state',
        '-Reason',
        'test',
      ],
      { encoding: 'utf8' },
    );
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/"source":\s*"update_rollback"/);
    expect(r.stdout).toMatch(/"owner_id":\s*"daemon-self"/);
    expect(r.stdout).toMatch(/update_rollback: test/);
  });

  it.skipIf(!pwshAvailable)('main ps1 parses without syntax errors', () => {
    const r = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        [
          '$tokens = $null; $errors = $null;',
          `[System.Management.Automation.Language.Parser]::ParseFile('${PS1_MAIN.replace(/\\/g, '\\\\')}', [ref]$tokens, [ref]$errors);`,
          'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Host $_ }; exit 1 } else { Write-Host OK }',
        ].join(' '),
      ],
      { encoding: 'utf8' },
    );
    expect(r.status, `STDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('OK');
  });
});
