// T77 — NSIS uninstall hygiene contract probe (#1035).
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-11-packaging.md §11.6.1 —
//     `customUnInstall` macro contract: graceful helper invoke → taskkill
//     /IM ccsm-daemon.exe /F /T safety net → Delete daemon.lock. The install
//     root under %LOCALAPPDATA%\ccsm is wiped by the standard NSIS uninstall
//     sequence after the macro returns; user-data subdirs (data/, logs/,
//     crashes/, daemon.secret) are RETAINED by default per the §11.6 paths
//     table (`deleteAppDataOnUninstall: false`).
//   - frag-11-packaging.md §11.6.4 — helper exit semantics: 0 = graceful OR
//     daemon already dead (idempotent); 1 = hard error (couldn't kill an
//     orphan that needed killing).
//   - installer/uninstall-helper/index.js — `hardstop()` enumerates ccsm
//     processes via `tasklist /FI IMAGENAME eq <image>` and kills each pid
//     via `taskkill /F /T /PID <pid>`.
//
// Scope clarification vs the task brief:
//   The brief mentioned wiping `%LOCALAPPDATA%\ccsm\` and `%PROGRAMDATA%\ccsm\`.
//   Per spec §11.6.1 the helper itself does NOT wipe disk paths — that is the
//   NSIS standard-uninstall responsibility. And `%PROGRAMDATA%\ccsm\` is NOT
//   in the §11.6 paths table (v0.3 is per-user only, `perMachine: false`).
//   This probe asserts the actual contracts:
//     1. NSIS macro wires the §11.6.1 sequence (helper → taskkill → lock).
//     2. Helper hardstop kills every enumerated ccsm-daemon.exe pid.
//     3. Helper is idempotent when no daemon is running (exit 0, no kill calls).
//
// Reverse-verify: removing the `taskkill /IM ccsm-daemon.exe /F /T` line from
// installer.nsh, or making `hardstop()` skip its kill loop, makes the
// corresponding assertion FAIL. Removing the `Delete daemon.lock` line in the
// .nsh also FAILS (regression bait for the proper-lockfile race in §11.6.5).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const requireCjs = createRequire(import.meta.url);
const helperPath = resolve(__dirname, '..', 'index.js');

// The helper destructures execFile at module-load time
// (`const { execFile } = require('node:child_process')` in index.js:43), so
// the mock must be installed on `node:child_process` BEFORE the helper module
// is first cached. Strategy: patch child_process.execFile, drop any cached
// helper module, then re-require fresh. This bypasses vi.mock entirely (which
// only intercepts ESM imports — ineffective against the helper's CJS require).
const childProcess = requireCjs('node:child_process') as { execFile: unknown };
const originalExecFile = childProcess.execFile;
const execFileMock = vi.fn();

function loadHelperFresh(): {
  hardstop: () => Promise<{ ok: boolean; killed: number; failed: number }>;
  listCcsmPids: () => Promise<Array<{ image: string; pid: number }>>;
} {
  // Drop any cached helper module so the next require re-runs its top-level
  // `const { execFile } = require('node:child_process')` against the patched
  // export.
  delete requireCjs.cache[helperPath];
  return requireCjs(helperPath);
}

beforeEach(() => {
  execFileMock.mockReset();
  (childProcess as { execFile: unknown }).execFile = execFileMock;
});

afterEach(() => {
  (childProcess as { execFile: unknown }).execFile = originalExecFile;
  delete requireCjs.cache[helperPath];
});

// One eager require for the static-export tests (parseArgs / NSIS file read)
// — these don't touch execFile so the original ref is fine.
const helper = requireCjs(helperPath);

describe('T77 / NSIS macro contract (build/installer.nsh)', () => {
  const nshPath = resolve(repoRoot, 'build', 'installer.nsh');
  const nsh = readFileSync(nshPath, 'utf8');

  it('invokes the §11.6.4 helper with --shutdown --timeout 2000', () => {
    expect(nsh).toMatch(/ccsm-uninstall-helper\.exe.*--shutdown.*--timeout\s+2000/);
  });

  it('runs the §11.6.1 taskkill safety net on ccsm-daemon.exe with /F /T', () => {
    // Force-kill (/F) + tree (/T) is the contract — covers daemon child procs.
    expect(nsh).toMatch(/taskkill\s+\/IM\s+ccsm-daemon\.exe\s+\/F\s+\/T/);
  });

  it('deletes the daemon.lock under %LOCALAPPDATA%\\ccsm', () => {
    // Closes the proper-lockfile-stale-on-SIGKILL race (§11.6.5).
    expect(nsh).toMatch(/Delete\s+"\$LOCALAPPDATA\\ccsm\\daemon\.lock"/);
  });

  it('does NOT touch user-data subdirs (data/, logs/, crashes/, daemon.secret)', () => {
    // Per §11.6 paths table: cleanup default = "retained". Opt-in cleanup is
    // an in-app surface (frag-6-7 §6.8), NOT the NSIS macro.
    expect(nsh).not.toMatch(/RMDir.*\\ccsm\\(data|logs|crashes)/i);
    expect(nsh).not.toMatch(/Delete\s+"\$LOCALAPPDATA\\ccsm\\daemon\.secret"/);
  });

  it('uses %LOCALAPPDATA% only — never %PROGRAMDATA% or $PROGRAMFILES (round-3 P0-1)', () => {
    // Strip NSIS comment lines (start with `;`) so prose like
    // "; never $PROGRAMFILES" in the file header doesn't trip these guards.
    const codeOnly = nsh
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith(';'))
      .join('\n');
    expect(codeOnly).not.toMatch(/\$PROGRAMFILES/);
    expect(codeOnly).not.toMatch(/\$PROGRAMDATA/i);
    // Sanity: at least one $LOCALAPPDATA reference exists.
    expect(codeOnly).toMatch(/\$LOCALAPPDATA/);
  });
});

describe('T77 / helper.hardstop() — kill ccsm-daemon.exe contract', () => {
  it('kills every enumerated ccsm-daemon.exe pid via taskkill /F /T', async () => {
    // Stub tasklist → return one ccsm-daemon.exe pid; subsequent images empty.
    // Stub taskkill → success.
    execFileMock.mockImplementation(
      (file: string, args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
        if (file === 'tasklist') {
          const imageArgIdx = args.indexOf('IMAGENAME eq ccsm-daemon.exe');
          if (imageArgIdx !== -1) {
            cb(null, '"ccsm-daemon.exe","4242","Console","1","12,345 K"\r\n', '');
          } else {
            cb(null, 'INFO: No tasks are running which match the specified criteria.\r\n', '');
          }
          return;
        }
        if (file === 'taskkill') {
          cb(null, 'SUCCESS', '');
          return;
        }
        cb(new Error(`unexpected execFile: ${file}`), '', '');
      },
    );

    const fresh = loadHelperFresh();
    const result = await fresh.hardstop();

    expect(result).toEqual({ ok: true, killed: 1, failed: 0 });

    // Verify taskkill was invoked on the daemon pid with /F /T.
    const taskkillCalls = execFileMock.mock.calls.filter((c) => c[0] === 'taskkill');
    expect(taskkillCalls.length).toBe(1);
    expect(taskkillCalls[0][1]).toEqual(['/F', '/T', '/PID', '4242']);
  });

  it('is idempotent: zero pids found → ok with killed=0, no taskkill invocations', async () => {
    // Every tasklist returns "no tasks" — daemon already dead.
    execFileMock.mockImplementation(
      (file: string, _args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
        if (file === 'tasklist') {
          cb(null, 'INFO: No tasks are running which match the specified criteria.\r\n', '');
          return;
        }
        cb(new Error(`unexpected execFile: ${file}`), '', '');
      },
    );

    const fresh = loadHelperFresh();
    const result = await fresh.hardstop();

    expect(result).toEqual({ ok: true, killed: 0, failed: 0 });
    const taskkillCalls = execFileMock.mock.calls.filter((c) => c[0] === 'taskkill');
    expect(taskkillCalls.length).toBe(0);
  });

  it('reports hard error (ok=false, exit-1 trigger) when taskkill fails', async () => {
    // tasklist surfaces a pid; taskkill errors. Per index.js main(), this
    // path returns exit code 1 — the only "hard error" the helper reports.
    execFileMock.mockImplementation(
      (file: string, args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
        if (file === 'tasklist') {
          if (args.includes('IMAGENAME eq ccsm-daemon.exe')) {
            cb(null, '"ccsm-daemon.exe","9999","Console","1","12,345 K"\r\n', '');
          } else {
            cb(null, 'INFO: No tasks\r\n', '');
          }
          return;
        }
        if (file === 'taskkill') {
          cb(new Error('Access is denied'), '', 'ERROR: Access is denied.\r\n');
          return;
        }
        cb(new Error(`unexpected execFile: ${file}`), '', '');
      },
    );

    const fresh = loadHelperFresh();
    const result = await fresh.hardstop();
    expect(result.ok).toBe(false);
    expect(result.failed).toBeGreaterThanOrEqual(1);
  });
});

describe('T77 / helper.listCcsmPids() — enumeration contract', () => {
  it('enumerates ccsm-daemon.exe via tasklist with the documented filter', async () => {
    execFileMock.mockImplementation(
      (file: string, _args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
        cb(null, 'INFO: No tasks\r\n', '');
      },
    );

    const fresh = loadHelperFresh();
    await fresh.listCcsmPids();

    // The helper queries three image names per CCSM_IMAGE_NAMES; the daemon
    // image MUST be one of them (the spec §11.6.1 contract is explicit about
    // ccsm-daemon.exe).
    const tasklistCalls = execFileMock.mock.calls.filter((c) => c[0] === 'tasklist');
    const queriedImages = tasklistCalls
      .map((c) => ((c[1] as string[]).find((a: string) => a.startsWith('IMAGENAME eq ')) as string | undefined))
      .filter((s): s is string => Boolean(s));
    expect(queriedImages).toContain('IMAGENAME eq ccsm-daemon.exe');
  });
});
