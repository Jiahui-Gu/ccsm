// Task #1012 — vitest for scripts/required-after-pack.cjs
//
// Covers: missing extraResources file => fail; missing asarUnpack addon =>
// fail; both stages present => pass; unknown platform => skip silently.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// require() the CJS hook from a TS test file via createRequire.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const hook = require('../scripts/required-after-pack.cjs') as {
  validate: (ctx: PackContext) => Promise<void>;
  requiredExtraResources: (platform: string) => string[];
  requiredAsarUnpacked: () => Array<{ anyOf: string[] }>;
  resolveResourcesDir: (appOutDir: string, platform: string) => string;
};

// Magic-byte heads used to forge a "valid" daemon binary in the test
// fixture so the Task #114 guard accepts it. Mirrors scripts/daemon-
// binary-guard.cjs MAGIC table; kept inline here to keep the test
// independent of the guard's internal table layout.
const PLATFORM_MAGIC: Record<string, number[]> = {
  win32: [0x4d, 0x5a],
  darwin: [0xcf, 0xfa, 0xed, 0xfe],
  linux: [0x7f, 0x45, 0x4c, 0x46],
};

// Slightly above the guard's 1 MiB minimum.
const DAEMON_FAKE_SIZE = 1024 * 1024 + 16;

function makeFakeDaemonBuffer(platform: string): Buffer {
  const magic = PLATFORM_MAGIC[platform] ?? PLATFORM_MAGIC.linux;
  const buf = Buffer.alloc(DAEMON_FAKE_SIZE);
  for (let i = 0; i < magic.length; i++) buf[i] = magic[i];
  return buf;
}

interface PackContext {
  appOutDir: string;
  electronPlatformName: string;
  arch: number;
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ccsm-t57-${prefix}-`));
}

function touch(file: string, body = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function stageExtraResources(resourcesDir: string, platform: string): void {
  const ext = platform === 'win32' ? '.exe' : '';
  const daemonRel = `daemon/ccsm-daemon${ext}`;
  for (const rel of hook.requiredExtraResources(platform)) {
    if (rel === daemonRel) {
      // Daemon binary needs to satisfy the Task #114 guard: >= 1 MiB and
      // valid platform magic bytes. Write a forged buffer just above the
      // threshold with the right header.
      const target = path.join(resourcesDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, makeFakeDaemonBuffer(platform));
    } else {
      touch(path.join(resourcesDir, rel), 'stub');
    }
  }
}

function stageAsarUnpacked(resourcesDir: string): void {
  // Pick the first path in each anyOf set as the satisfying file.
  const root = path.join(resourcesDir, 'app.asar.unpacked');
  for (const entry of hook.requiredAsarUnpacked()) {
    touch(path.join(root, entry.anyOf[0]), 'stub');
  }
}

function buildAppOutDir(platform: string): { appOutDir: string; resourcesDir: string } {
  const appOutDir = mkTmp(platform);
  let resourcesDir: string;
  if (platform === 'darwin') {
    const bundle = path.join(appOutDir, 'CCSM.app');
    resourcesDir = path.join(bundle, 'Contents', 'Resources');
    fs.mkdirSync(resourcesDir, { recursive: true });
  } else {
    resourcesDir = path.join(appOutDir, 'resources');
    fs.mkdirSync(resourcesDir, { recursive: true });
  }
  return { appOutDir, resourcesDir };
}

const created: string[] = [];
beforeEach(() => {
  created.length = 0;
});
afterEach(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tracked(platform: string): { appOutDir: string; resourcesDir: string } {
  const out = buildAppOutDir(platform);
  created.push(out.appOutDir);
  return out;
}

describe('required-after-pack: extraResources stage', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    it(`${platform}: passes when every required file present in BOTH stages`, async () => {
      const { appOutDir, resourcesDir } = tracked(platform);
      stageExtraResources(resourcesDir, platform);
      stageAsarUnpacked(resourcesDir);
      await expect(
        hook.validate({ appOutDir, electronPlatformName: platform, arch: 1 }),
      ).resolves.toBeUndefined();
    });

    it(`${platform}: fails with the missing extraResources path in the message`, async () => {
      const { appOutDir, resourcesDir } = tracked(platform);
      stageExtraResources(resourcesDir, platform);
      stageAsarUnpacked(resourcesDir);
      // Remove daemon binary specifically.
      const ext = platform === 'win32' ? '.exe' : '';
      fs.rmSync(path.join(resourcesDir, `daemon/ccsm-daemon${ext}`));
      await expect(
        hook.validate({ appOutDir, electronPlatformName: platform, arch: 1 }),
      ).rejects.toThrow(/extraResources stage missing.*ccsm-daemon/s);
    });
  }

  it('win32: surfaces missing uninstall helper', async () => {
    const { appOutDir, resourcesDir } = tracked('win32');
    stageExtraResources(resourcesDir, 'win32');
    stageAsarUnpacked(resourcesDir);
    fs.rmSync(path.join(resourcesDir, 'daemon/ccsm-uninstall-helper.exe'));
    await expect(
      hook.validate({ appOutDir, electronPlatformName: 'win32', arch: 1 }),
    ).rejects.toThrow(/ccsm-uninstall-helper\.exe/);
  });

  it('linux: does NOT require uninstall helper', async () => {
    const list = hook.requiredExtraResources('linux');
    expect(list.some((p) => p.includes('uninstall-helper'))).toBe(false);
  });

  it('darwin: does NOT require uninstall helper', async () => {
    const list = hook.requiredExtraResources('darwin');
    expect(list.some((p) => p.includes('uninstall-helper'))).toBe(false);
  });
});

describe('required-after-pack: asarUnpack stage', () => {
  it('fails when asarUnpack present but missing one of the natives', async () => {
    const { appOutDir, resourcesDir } = tracked('linux');
    stageExtraResources(resourcesDir, 'linux');
    stageAsarUnpacked(resourcesDir);
    // Remove BOTH alternatives for better-sqlite3.
    const root = path.join(resourcesDir, 'app.asar.unpacked');
    fs.rmSync(path.join(root, 'node_modules/better-sqlite3'), {
      recursive: true,
      force: true,
    });
    await expect(
      hook.validate({ appOutDir, electronPlatformName: 'linux', arch: 1 }),
    ).rejects.toThrow(/asarUnpack stage missing.*better-sqlite3/s);
  });

  it('skips asarUnpack check silently when app.asar.unpacked absent (e.g. asar disabled)', async () => {
    const { appOutDir, resourcesDir } = tracked('linux');
    stageExtraResources(resourcesDir, 'linux');
    // Intentionally do NOT stage app.asar.unpacked.
    await expect(
      hook.validate({ appOutDir, electronPlatformName: 'linux', arch: 1 }),
    ).resolves.toBeUndefined();
  });

  it('accepts EITHER rebuilt OR prebuilt path for natives', async () => {
    const { appOutDir, resourcesDir } = tracked('linux');
    stageExtraResources(resourcesDir, 'linux');
    // Stage only the prebuild dir (second alternative) for each native.
    const root = path.join(resourcesDir, 'app.asar.unpacked');
    for (const entry of hook.requiredAsarUnpacked()) {
      const choice = entry.anyOf[entry.anyOf.length - 1];
      touch(path.join(root, choice), 'stub');
    }
    await expect(
      hook.validate({ appOutDir, electronPlatformName: 'linux', arch: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe('required-after-pack: platform handling', () => {
  it('skips silently for unknown platform', async () => {
    const appOutDir = mkTmp('aix');
    created.push(appOutDir);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m) => {
      logs.push(String(m));
    });
    try {
      await expect(
        hook.validate({ appOutDir, electronPlatformName: 'aix', arch: 1 }),
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(logs.some((l) => /unknown platform aix/.test(l))).toBe(true);
  });

  it('resolveResourcesDir picks the .app bundle on darwin', () => {
    const appOutDir = mkTmp('darwin-resolve');
    created.push(appOutDir);
    fs.mkdirSync(path.join(appOutDir, 'CCSM.app', 'Contents', 'Resources'), {
      recursive: true,
    });
    const out = hook.resolveResourcesDir(appOutDir, 'darwin');
    expect(out).toMatch(/CCSM\.app[\\/]Contents[\\/]Resources$/);
  });
});

describe('required-after-pack: spec contract', () => {
  it('matches frag-11 §11.2 REQUIRED_AFTER_PACK list (Win)', () => {
    expect(new Set(hook.requiredExtraResources('win32'))).toEqual(
      new Set([
        'daemon/ccsm-daemon.exe',
        'daemon/native/better_sqlite3.node',
        'daemon/native/pty.node',
        'daemon/native/ccsm_native.node',
        'daemon/ccsm-uninstall-helper.exe',
        'daemon/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
        'sdk/claude-agent-sdk/package.json',
      ]),
    );
  });

  it('matches frag-11 §11.2 REQUIRED_AFTER_PACK list (mac/linux: no uninstall helper, no .exe)', () => {
    for (const p of ['darwin', 'linux'] as const) {
      const list = hook.requiredExtraResources(p);
      expect(list).toContain('daemon/ccsm-daemon');
      expect(list).toContain('daemon/native/better_sqlite3.node');
      expect(list).toContain('daemon/native/pty.node');
      expect(list).toContain('daemon/native/ccsm_native.node');
      expect(list).toContain('daemon/node_modules/@anthropic-ai/claude-agent-sdk/package.json');
      expect(list).toContain('sdk/claude-agent-sdk/package.json');
      expect(list.some((x) => x.endsWith('.exe'))).toBe(false);
    }
  });
});

// Task #114 — daemon binary integrity guard, exercised through validate().
// daemon-binary-guard has its own unit tests in tests/daemon-binary-guard
// .test.ts; this block confirms the guard is wired into the after-pack
// hook and that the failure surface includes the daemon binary path.
describe('required-after-pack: Task #114 daemon binary guard', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const ext = platform === 'win32' ? '.exe' : '';
    const daemonRel = `daemon/ccsm-daemon${ext}`;

    it(`${platform}: fails when daemon binary is zero-byte`, async () => {
      const { appOutDir, resourcesDir } = tracked(platform);
      stageExtraResources(resourcesDir, platform);
      stageAsarUnpacked(resourcesDir);
      // Truncate daemon binary to zero bytes (the bug this task targets).
      const daemonAbs = path.join(resourcesDir, daemonRel);
      fs.writeFileSync(daemonAbs, '');
      await expect(
        hook.validate({ appOutDir, electronPlatformName: platform, arch: 1 }),
      ).rejects.toThrow(/zero-byte/);
    });

    it(`${platform}: fails when daemon binary is below 1 MiB threshold`, async () => {
      const { appOutDir, resourcesDir } = tracked(platform);
      stageExtraResources(resourcesDir, platform);
      stageAsarUnpacked(resourcesDir);
      // Replace with a few KiB of correct-magic bytes — passes existence
      // but should fail size check (real daemon is ~108 MB; 1 MiB minimum).
      const daemonAbs = path.join(resourcesDir, daemonRel);
      const small = Buffer.alloc(4096);
      const magic = PLATFORM_MAGIC[platform];
      for (let i = 0; i < magic.length; i++) small[i] = magic[i];
      fs.writeFileSync(daemonAbs, small);
      await expect(
        hook.validate({ appOutDir, electronPlatformName: platform, arch: 1 }),
      ).rejects.toThrow(/suspiciously small/);
    });

    it(`${platform}: surfaces placeholder marker text in size-failure message`, async () => {
      const { appOutDir, resourcesDir } = tracked(platform);
      stageExtraResources(resourcesDir, platform);
      stageAsarUnpacked(resourcesDir);
      // Mimic before-pack.cjs stagePlaceholder() output.
      const daemonAbs = path.join(resourcesDir, daemonRel);
      fs.writeFileSync(
        daemonAbs,
        `placeholder: daemon binary for ${platform}-x64 not yet built\n`,
      );
      await expect(
        hook.validate({ appOutDir, electronPlatformName: platform, arch: 1 }),
      ).rejects.toThrow(/placeholder marker/);
    });

    it(`${platform}: fails when daemon binary has wrong-platform magic bytes`, async () => {
      const { appOutDir, resourcesDir } = tracked(platform);
      stageExtraResources(resourcesDir, platform);
      stageAsarUnpacked(resourcesDir);
      const daemonAbs = path.join(resourcesDir, daemonRel);
      // Write >= 1 MiB but with garbage header bytes — none of PE/Mach-O/ELF.
      const buf = Buffer.alloc(DAEMON_FAKE_SIZE);
      buf[0] = 0x00; buf[1] = 0x01; buf[2] = 0x02; buf[3] = 0x03;
      fs.writeFileSync(daemonAbs, buf);
      await expect(
        hook.validate({ appOutDir, electronPlatformName: platform, arch: 1 }),
      ).rejects.toThrow(/magic-byte mismatch/);
    });

    it(`${platform}: passes when daemon binary is well-formed (size + magic)`, async () => {
      const { appOutDir, resourcesDir } = tracked(platform);
      stageExtraResources(resourcesDir, platform);
      stageAsarUnpacked(resourcesDir);
      // stageExtraResources already wrote a valid forged binary; this
      // assertion locks the happy path so a future regression in the
      // forging helper or the guard itself is caught here too.
      await expect(
        hook.validate({ appOutDir, electronPlatformName: platform, arch: 1 }),
      ).resolves.toBeUndefined();
    });
  }
});
