// Task #1011 — unit tests for scripts/sign-windows.cjs (frag-11 §11.3.1).
//
// Covers:
//   1. env-not-set → log + skip (no spawn, no throw).
//   2. env-set + valid spawn → correct argv shape including timestamp default.
//   3. bad cert path → clear error.
//   4. CCSM_WIN_REQUIRE_SIGN=1 + missing cert → throw.
//   5. signtool non-zero exit → propagated as Error including stderr.
//   6. collectTargets walks recursively and matches .exe/.dll case-insensitive.
//   7. non-Windows context → no-op.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const signMod = require('../scripts/sign-windows.cjs');
const signWindowsHook = signMod.default || signMod;
const { buildSignArgs, collectTargets, runSign, DEFAULT_TIMESTAMP_URL } = signMod;

function withTmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ccsm-sign-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('sign-windows.cjs', () => {
  const ENV_KEYS = [
    'CCSM_WIN_CERT_PATH',
    'CCSM_WIN_CERT_PASSWORD',
    'CCSM_WIN_TIMESTAMP_URL',
    'CCSM_WIN_REQUIRE_SIGN',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  describe('buildSignArgs', () => {
    it('builds argv with default timestamp + sha256 algos', () => {
      const argv = buildSignArgs({
        certPath: 'C:\\certs\\test.pfx',
        certPassword: 'pw123',
        file: 'C:\\out\\app.exe',
      });
      expect(argv).toEqual([
        'sign',
        '/f', 'C:\\certs\\test.pfx',
        '/p', 'pw123',
        '/tr', DEFAULT_TIMESTAMP_URL,
        '/td', 'sha256',
        '/fd', 'sha256',
        'C:\\out\\app.exe',
      ]);
    });

    it('omits /p when no password and uses custom timestamp', () => {
      const argv = buildSignArgs({
        certPath: 'cert.cer',
        timestampUrl: 'http://ts.example/ts',
        file: 'a.dll',
      });
      expect(argv).toEqual([
        'sign',
        '/f', 'cert.cer',
        '/tr', 'http://ts.example/ts',
        '/td', 'sha256',
        '/fd', 'sha256',
        'a.dll',
      ]);
      expect(argv).not.toContain('/p');
    });

    it('throws on missing required fields', () => {
      expect(() => buildSignArgs({ file: 'a.exe' } as any)).toThrow(/certPath/);
      expect(() => buildSignArgs({ certPath: 'c.pfx' } as any)).toThrow(/file/);
    });
  });

  describe('collectTargets', () => {
    it('walks recursively and matches .exe/.dll case-insensitive', () => {
      const { dir, cleanup } = withTmp();
      try {
        mkdirSync(join(dir, 'sub', 'nested'), { recursive: true });
        writeFileSync(join(dir, 'a.exe'), '');
        writeFileSync(join(dir, 'b.DLL'), '');
        writeFileSync(join(dir, 'c.txt'), '');
        writeFileSync(join(dir, 'sub', 'd.Exe'), '');
        writeFileSync(join(dir, 'sub', 'nested', 'e.dll'), '');

        const found = collectTargets(dir).map((p: string) => p.replace(dir, '').replace(/\\/g, '/'));
        expect(found.sort()).toEqual(
          ['/a.exe', '/b.DLL', '/sub/d.Exe', '/sub/nested/e.dll'].sort(),
        );
      } finally {
        cleanup();
      }
    });

    it('returns [] when root does not exist', () => {
      expect(collectTargets(join(tmpdir(), 'definitely-not-here-xyz123'))).toEqual([]);
    });
  });

  describe('runSign', () => {
    it('invokes spawnImpl with correct argv and resolves on status 0', () => {
      const spawnImpl = vi.fn().mockReturnValue({
        status: 0,
        stdout: Buffer.from('Successfully signed'),
        stderr: Buffer.from(''),
      });
      runSign({
        certPath: 'c.pfx',
        certPassword: 'pw',
        file: 'app.exe',
        spawnImpl,
      });
      expect(spawnImpl).toHaveBeenCalledTimes(1);
      const [bin, argv, opts] = spawnImpl.mock.calls[0];
      expect(bin).toBe('signtool.exe');
      expect(argv[0]).toBe('sign');
      expect(argv).toContain('app.exe');
      expect(opts.windowsHide).toBe(true);
      // No `shell: true` — must be array argv exec, not shell string.
      expect(opts.shell).toBeUndefined();
    });

    it('throws with stderr on non-zero exit', () => {
      const spawnImpl = vi.fn().mockReturnValue({
        status: 1,
        stdout: Buffer.from('out'),
        stderr: Buffer.from('SignerSign() failed: 0x80092004'),
      });
      expect(() =>
        runSign({ certPath: 'c.pfx', file: 'a.exe', spawnImpl }),
      ).toThrow(/exited 1.*0x80092004/s);
    });

    it('wraps spawn errors with file context', () => {
      const spawnImpl = vi.fn().mockReturnValue({
        status: null,
        error: new Error('ENOENT'),
      });
      expect(() =>
        runSign({ certPath: 'c.pfx', file: 'a.exe', spawnImpl }),
      ).toThrow(/spawn failed for a\.exe.*ENOENT/);
    });
  });

  describe('signWindowsHook (afterSign)', () => {
    it('skips with log when CCSM_WIN_CERT_PATH unset (no throw)', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await signWindowsHook({ electronPlatformName: 'win32', appOutDir: tmpdir() });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('CCSM_WIN_CERT_PATH not set'),
      );
    });

    it('skips on non-Windows platform', async () => {
      process.env.CCSM_WIN_CERT_PATH = 'whatever.pfx';
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await signWindowsHook({ electronPlatformName: 'darwin', appOutDir: tmpdir() });
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/skip.*darwin/));
    });

    it('throws clearly when CCSM_WIN_CERT_PATH points at missing file', async () => {
      process.env.CCSM_WIN_CERT_PATH = join(tmpdir(), 'missing-cert-xyz.pfx');
      await expect(
        signWindowsHook({ electronPlatformName: 'win32', appOutDir: tmpdir() }),
      ).rejects.toThrow(/missing file/);
    });

    it('throws when CCSM_WIN_REQUIRE_SIGN=1 and cert env unset', async () => {
      process.env.CCSM_WIN_REQUIRE_SIGN = '1';
      await expect(
        signWindowsHook({ electronPlatformName: 'win32', appOutDir: tmpdir() }),
      ).rejects.toThrow(/CCSM_WIN_REQUIRE_SIGN=1.*not set/);
    });
  });
});
