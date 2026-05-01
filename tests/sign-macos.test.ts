// Tests for scripts/sign-macos.cjs — placeholder-safe macOS codesign hook.
//
// We exercise:
//   1. env-not-set → skip (no spawnSync called)
//   2. env-set + entitlements present → correct codesign argv per target
//   3. depth-first traversal order (deepest first, outer .app last)
//   4. missing entitlements + identity set → warn + skip
//   5. codesign exit nonzero → clear error
//   6. CCSM_MAC_HARDENED_RUNTIME=0 omits --options runtime
//
// We mock spawnSync (the codesign runner) and the fs view via opts so
// the test is hermetic — no real `codesign` invocation, no temp dirs
// for the env-skip cases.

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const signMod = require('../scripts/sign-macos.cjs');
const { signMacApp, collectSignTargets } = signMod;

function makeRunnerOk() {
  return vi.fn().mockReturnValue({ status: 0 });
}

function baseCtx(appOutDir = '/tmp/release/mac') {
  return { electronPlatformName: 'darwin', appOutDir, arch: 1 };
}

describe('sign-macos: env contract', () => {
  it('skips silently when CCSM_MAC_IDENTITY unset', async () => {
    const runner = makeRunnerOk();
    const log = vi.fn();
    const res = await signMacApp(baseCtx(), { env: {}, runner, log });
    expect(res).toEqual({ skipped: true, reason: 'no-identity' });
    expect(runner).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toMatch(
      /\[skip\] codesign: CCSM_MAC_IDENTITY not set/,
    );
  });

  it('skips on non-darwin platforms regardless of env', async () => {
    const runner = makeRunnerOk();
    const res = await signMacApp(
      { electronPlatformName: 'win32', appOutDir: '/x', arch: 1 },
      { env: { CCSM_MAC_IDENTITY: 'X' }, runner, log: vi.fn() },
    );
    expect(res).toEqual({ skipped: true, reason: 'not-darwin' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('warns and skips when identity set but entitlements missing', async () => {
    const runner = makeRunnerOk();
    const log = vi.fn();
    const fakeFs = {
      existsSync: vi.fn().mockReturnValue(false),
      readdirSync: vi.fn().mockReturnValue([]),
    };
    const res = await signMacApp(baseCtx(), {
      env: { CCSM_MAC_IDENTITY: 'Developer ID Application: Acme (TEAM)' },
      runner,
      log,
      fs: fakeFs,
    });
    expect(res).toEqual({ skipped: true, reason: 'no-entitlements' });
    expect(runner).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toMatch(/\[warn\] entitlements not found/);
  });
});

describe('sign-macos: codesign argv', () => {
  function setupRealAppBundle() {
    // Create a tiny fake .app structure on disk so we can use the real
    // collectSignTargets. Cleanup is best-effort (test temp dir).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-macos-'));
    const appOut = path.join(tmp, 'mac');
    fs.mkdirSync(appOut, { recursive: true });
    const appBundle = path.join(appOut, 'CCSM.app');
    const macOSDir = path.join(appBundle, 'Contents', 'MacOS');
    const resourcesDeep = path.join(
      appBundle,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
    );
    const fwDir = path.join(
      appBundle,
      'Contents',
      'Frameworks',
      'Helper.framework',
      'Versions',
      'A',
    );
    fs.mkdirSync(macOSDir, { recursive: true });
    fs.mkdirSync(resourcesDeep, { recursive: true });
    fs.mkdirSync(fwDir, { recursive: true });
    fs.writeFileSync(path.join(macOSDir, 'CCSM'), 'mach-o');
    fs.writeFileSync(path.join(resourcesDeep, 'better_sqlite3.node'), 'node');
    fs.writeFileSync(path.join(fwDir, 'Helper'), 'mach-o');
    // _CodeSignature dir should be skipped.
    fs.mkdirSync(path.join(appBundle, 'Contents', '_CodeSignature'));
    fs.writeFileSync(
      path.join(appBundle, 'Contents', '_CodeSignature', 'CodeResources'),
      'xml',
    );
    // Stub entitlements file.
    const entPath = path.join(tmp, 'ents.plist');
    fs.writeFileSync(entPath, '<plist/>');
    return { tmp, appOut, appBundle, entPath };
  }

  it('signs every target depth-first with correct argv (outer .app last)', async () => {
    const { appOut, appBundle, entPath } = setupRealAppBundle();
    const runner = makeRunnerOk();
    const log = vi.fn();
    const res = await signMacApp(
      { electronPlatformName: 'darwin', appOutDir: appOut, arch: 1 },
      {
        env: {
          CCSM_MAC_IDENTITY: 'Developer ID Application: Acme (TEAM)',
          CCSM_MAC_ENTITLEMENTS: entPath,
        },
        runner,
        log,
      },
    );
    expect(res.skipped).toBe(false);
    expect(res.signed).toBeGreaterThanOrEqual(4);

    // Last call must be the outer .app bundle (sealed last).
    const lastCall = runner.mock.calls[runner.mock.calls.length - 1];
    expect(lastCall[0]).toBe('codesign');
    const lastArgs = lastCall[1];
    expect(lastArgs[lastArgs.length - 1]).toBe(appBundle);

    // Argv shape on a representative call.
    const firstArgs = runner.mock.calls[0][1];
    expect(firstArgs).toContain('--force');
    expect(firstArgs).toContain('--sign');
    expect(firstArgs).toContain('Developer ID Application: Acme (TEAM)');
    expect(firstArgs).toContain('--timestamp');
    expect(firstArgs).toContain('--options');
    expect(firstArgs).toContain('runtime');
    expect(firstArgs).toContain('--entitlements');
    expect(firstArgs).toContain(entPath);

    // Depth-first: the deepest .node must appear before its containing
    // dirs and before the outer .app.
    const orderedTargets = runner.mock.calls.map(
      (c) => c[1][c[1].length - 1],
    );
    const idxNode = orderedTargets.findIndex((t) =>
      t.endsWith('better_sqlite3.node'),
    );
    const idxApp = orderedTargets.indexOf(appBundle);
    expect(idxNode).toBeGreaterThanOrEqual(0);
    expect(idxApp).toBe(orderedTargets.length - 1);
    expect(idxNode).toBeLessThan(idxApp);

    // _CodeSignature/CodeResources must NOT be in the target list.
    expect(
      orderedTargets.some((t) => t.includes('_CodeSignature')),
    ).toBe(false);
  });

  it('omits --options runtime when CCSM_MAC_HARDENED_RUNTIME=0', async () => {
    const { appOut, entPath } = setupRealAppBundle();
    const runner = makeRunnerOk();
    await signMacApp(
      { electronPlatformName: 'darwin', appOutDir: appOut, arch: 1 },
      {
        env: {
          CCSM_MAC_IDENTITY: 'X',
          CCSM_MAC_ENTITLEMENTS: entPath,
          CCSM_MAC_HARDENED_RUNTIME: '0',
        },
        runner,
        log: vi.fn(),
      },
    );
    for (const call of runner.mock.calls) {
      expect(call[1]).not.toContain('runtime');
    }
  });

  it('throws clear error when codesign exits nonzero', async () => {
    const { appOut, entPath } = setupRealAppBundle();
    const runner = vi.fn().mockReturnValue({ status: 1 });
    await expect(
      signMacApp(
        { electronPlatformName: 'darwin', appOutDir: appOut, arch: 1 },
        {
          env: {
            CCSM_MAC_IDENTITY: 'BadIdentity',
            CCSM_MAC_ENTITLEMENTS: entPath,
          },
          runner,
          log: vi.fn(),
        },
      ),
    ).rejects.toThrow(/codesign failed \(exit 1\)/);
  });
});

describe('sign-macos: collectSignTargets', () => {
  it('returns empty when bundle path does not exist', () => {
    const out = collectSignTargets('/nonexistent/path/CCSM.app');
    // Outer bundle is always pushed last.
    expect(out).toEqual(['/nonexistent/path/CCSM.app']);
  });
});
