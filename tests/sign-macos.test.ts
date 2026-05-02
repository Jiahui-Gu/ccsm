// Tests for scripts/sign-macos.cjs — placeholder-safe macOS codesign hook.
//
// We exercise:
//   1. env-not-set → skip (no spawnSync called)
//   2. env-set + entitlements present → correct codesign argv per target
//   3. depth-first traversal order (deepest first, outer .app last)
//   4. missing entitlements + identity set → warn + skip
//   5. codesign exit nonzero → clear error
//   6. CCSM_MAC_HARDENED_RUNTIME=0 omits --options runtime
//   7. Task #116 — extensionless daemon binary detected by Mach-O magic bytes
//   8. Task #116 — post-sign codesign --verify pass runs on daemon + .app
//   9. Task #116 — codesign --verify failure propagates as Error
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
const { signMacApp, collectSignTargets, isMachOByMagic, codesignVerify } = signMod;

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

    // Filter to --sign calls only (Task #116 added trailing --verify calls).
    const signCalls = runner.mock.calls.filter((c) => c[1].includes('--sign'));
    const lastSignCall = signCalls[signCalls.length - 1];
    expect(lastSignCall[0]).toBe('codesign');
    const lastArgs = lastSignCall[1];
    // Last --sign target must be the outer .app bundle (sealed last).
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
    // dirs and before the outer .app (within the --sign subset).
    const orderedSignTargets = signCalls.map(
      (c) => c[1][c[1].length - 1],
    );
    const idxNode = orderedSignTargets.findIndex((t) =>
      t.endsWith('better_sqlite3.node'),
    );
    const idxApp = orderedSignTargets.indexOf(appBundle);
    expect(idxNode).toBeGreaterThanOrEqual(0);
    expect(idxApp).toBe(orderedSignTargets.length - 1);
    expect(idxNode).toBeLessThan(idxApp);

    // _CodeSignature/CodeResources must NOT be in the target list.
    expect(
      orderedSignTargets.some((t) => t.includes('_CodeSignature')),
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

// Task #116 — extensionless daemon binary detection + post-sign verify pass.
describe('sign-macos: Task #116 daemon binary signing', () => {
  // Smallest valid Mach-O 64-bit LE header magic (cffaedfe in BE-read).
  // First 4 bytes alone are enough — collectSignTargets only reads 4 bytes.
  const MACHO_64_LE_HEADER = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

  function setupBundleWithDaemon() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-macos-daemon-'));
    const appOut = path.join(tmp, 'mac');
    const appBundle = path.join(appOut, 'CCSM.app');
    const macOSDir = path.join(appBundle, 'Contents', 'MacOS');
    const daemonDir = path.join(appBundle, 'Contents', 'Resources', 'daemon');
    fs.mkdirSync(macOSDir, { recursive: true });
    fs.mkdirSync(daemonDir, { recursive: true });
    // Outer Electron exec under MacOS/.
    fs.writeFileSync(path.join(macOSDir, 'CCSM'), 'mach-o');
    // The Task #116 target: extensionless daemon binary in Resources/daemon/.
    // First 4 bytes are a real Mach-O 64-bit LE magic; rest is junk padding
    // (codesign would reject this in real life, but our runner is mocked).
    fs.writeFileSync(
      path.join(daemonDir, 'ccsm-daemon'),
      Buffer.concat([MACHO_64_LE_HEADER, Buffer.alloc(60)]),
    );
    // A non-Mach-O sibling text file that MUST NOT be picked up.
    fs.writeFileSync(path.join(daemonDir, 'README.txt'), 'plain text');
    // Stub entitlements file.
    const entPath = path.join(tmp, 'ents.plist');
    fs.writeFileSync(entPath, '<plist/>');
    return { tmp, appOut, appBundle, daemonDir, entPath };
  }

  it('isMachOByMagic detects 64-bit LE Mach-O magic and rejects non-Mach-O', () => {
    const { daemonDir } = setupBundleWithDaemon();
    expect(isMachOByMagic(path.join(daemonDir, 'ccsm-daemon'))).toBe(true);
    expect(isMachOByMagic(path.join(daemonDir, 'README.txt'))).toBe(false);
    // Nonexistent file: false (no throw).
    expect(isMachOByMagic(path.join(daemonDir, 'definitely-not-here'))).toBe(false);
  });

  it('isMachOByMagic returns false on missing file (no throw)', () => {
    expect(isMachOByMagic('/nonexistent/path/foo')).toBe(false);
  });

  it('collectSignTargets includes extensionless daemon binary via magic detection', () => {
    const { appBundle, daemonDir } = setupBundleWithDaemon();
    const targets = collectSignTargets(appBundle);
    // The daemon binary (extensionless, NOT under MacOS/) must be in the list.
    expect(targets).toContain(path.join(daemonDir, 'ccsm-daemon'));
    // The plain-text sibling must NOT be in the list.
    expect(targets).not.toContain(path.join(daemonDir, 'README.txt'));
    // Outer .app sealed last.
    expect(targets[targets.length - 1]).toBe(appBundle);
  });

  it('signMacApp signs daemon binary and runs --verify on it + --deep --strict on .app', async () => {
    const { appOut, appBundle, daemonDir, entPath } = setupBundleWithDaemon();
    const runner = vi.fn().mockReturnValue({ status: 0 });
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

    // --sign call exists for the daemon binary.
    const daemonPath = path.join(daemonDir, 'ccsm-daemon');
    const signCalls = runner.mock.calls.filter((c) => c[1].includes('--sign'));
    const signedTargets = signCalls.map((c) => c[1][c[1].length - 1]);
    expect(signedTargets).toContain(daemonPath);

    // --verify call exists for the daemon binary (Task #116 explicit verify).
    const verifyCalls = runner.mock.calls.filter((c) => c[1].includes('--verify'));
    const daemonVerify = verifyCalls.find((c) => c[1].includes(daemonPath));
    expect(daemonVerify).toBeDefined();
    expect(daemonVerify![1]).toEqual(['--verify', '--strict', daemonPath]);

    // --verify --deep --strict call exists for the outer .app.
    const appDeepVerify = verifyCalls.find(
      (c) => c[1].includes('--deep') && c[1].includes(appBundle),
    );
    expect(appDeepVerify).toBeDefined();
    expect(appDeepVerify![1]).toEqual(['--verify', '--strict', '--deep', appBundle]);
  });

  it('signMacApp throws when codesign --verify fails (post-sign gate is fail-closed)', async () => {
    const { appOut, entPath } = setupBundleWithDaemon();
    // Sign passes, verify fails. Distinguish by whether `--verify` is in argv.
    const runner = vi.fn().mockImplementation((_bin: string, args: string[]) => {
      if (args.includes('--verify')) return { status: 1 };
      return { status: 0 };
    });
    await expect(
      signMacApp(
        { electronPlatformName: 'darwin', appOutDir: appOut, arch: 1 },
        {
          env: {
            CCSM_MAC_IDENTITY: 'Developer ID Application: Acme (TEAM)',
            CCSM_MAC_ENTITLEMENTS: entPath,
          },
          runner,
          log: vi.fn(),
        },
      ),
    ).rejects.toThrow(/codesign --verify failed \(exit 1\)/);
  });

  it('codesignVerify builds correct argv with and without --deep', () => {
    const calls: any[] = [];
    const runner = vi.fn().mockImplementation((bin, args) => {
      calls.push({ bin, args });
      return { status: 0 };
    });
    codesignVerify({ target: '/some/app', deep: false, runner });
    codesignVerify({ target: '/some/app', deep: true, runner });
    expect(calls[0].args).toEqual(['--verify', '--strict', '/some/app']);
    expect(calls[1].args).toEqual(['--verify', '--strict', '--deep', '/some/app']);
  });
});
