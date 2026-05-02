// Smoke test for the daemon binary build pipeline (frag-11 §11.1 Task 20).
//
// Opt-in via CCSM_TEST_DAEMON_BIN=1 because the build itself takes ~2 min
// (npm install in workspace + native rebuild + pkg snapshot), needs the
// pkg-cached Node 22 base binary, and requires a node-gyp toolchain on
// the host. Default-off keeps `npm test` cheap; the release.yml `Build
// daemon binary` step is the always-on enforcement.
//
// When invoked (`CCSM_TEST_DAEMON_BIN=1 npm test -- daemon-build`) it
// asserts the build:daemon-bin pipeline produced a daemon binary for the
// host platform/arch and that the binary is non-trivial in size — pkg
// snapshots embedding Node 22 base produce ~50 MB+; anything <10 MB
// indicates pkg silently bundled almost nothing.

import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PKG_PLATFORM_MAP: Record<string, string> = {
  win32: 'win',
  darwin: 'macos',
  linux: 'linux',
};

const enabled = process.env.CCSM_TEST_DAEMON_BIN === '1';
const describeFn = enabled ? describe : describe.skip;

describeFn('daemon binary build pipeline (frag-11 §11.1)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const platform = process.platform;
  const arch = process.arch;
  const pkgPlatform = PKG_PLATFORM_MAP[platform];
  const ext = platform === 'win32' ? '.exe' : '';
  const expectedName = `ccsm-daemon-${pkgPlatform}-${arch}${ext}`;
  const expectedPath = path.join(repoRoot, 'daemon', 'dist', expectedName);

  it('produces a binary for the host platform/arch', () => {
    expect(pkgPlatform, `unsupported platform ${platform}`).toBeDefined();

    // Build (idempotent; safe to re-run).
    execSync('npm run build:daemon-bin', { cwd: repoRoot, stdio: 'inherit' });

    expect(
      fs.existsSync(expectedPath),
      `expected daemon binary at ${expectedPath}`,
    ).toBe(true);
  }, 5 * 60 * 1000);

  it('binary is at least 10 MB (pkg embeds Node 22 base ~50 MB)', () => {
    const sizeBytes = fs.statSync(expectedPath).size;
    const sizeMb = sizeBytes / (1024 * 1024);
    expect(sizeMb, `binary ${expectedPath} is only ${sizeMb.toFixed(1)} MB`).toBeGreaterThan(10);
  });
});
