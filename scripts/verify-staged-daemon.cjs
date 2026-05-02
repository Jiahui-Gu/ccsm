#!/usr/bin/env node
// Task #114 — pre-package CI gate.
//
// Verify the daemon binary produced by `npm run build:daemon-bin` is sane
// BEFORE electron-builder picks it up. Belt-and-suspenders: the after-pack
// hook (scripts/required-after-pack.cjs) runs the same check on the
// post-pack staged copy inside the resources tree, but if pkg silently
// produced a zero-byte / wrong-platform file we want CI to fail at the
// daemon-build step, not 5 minutes later inside electron-builder.
//
// Discovers the host's daemon binary at `daemon/dist/ccsm-daemon-<plat>-<arch><ext>`
// (the path build-daemon-bin.cjs writes to) and asserts size + magic
// bytes via scripts/daemon-binary-guard.cjs.
//
// Wired into .github/workflows/release.yml as a step right after
// `Build daemon binary`.

const path = require('node:path');
const guard = require('./daemon-binary-guard.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

const PLATFORM_NAMES = {
  win32: { electron: 'win32', pkg: 'win', ext: '.exe' },
  darwin: { electron: 'darwin', pkg: 'macos', ext: '' },
  linux: { electron: 'linux', pkg: 'linux', ext: '' },
};

function main() {
  const meta = PLATFORM_NAMES[process.platform];
  if (!meta) {
    console.error(`[verify-staged-daemon] unsupported host platform: ${process.platform}`);
    process.exit(1);
  }
  const arch = process.arch;
  if (arch !== 'x64' && arch !== 'arm64') {
    console.error(`[verify-staged-daemon] unsupported host arch: ${arch}`);
    process.exit(1);
  }
  // Match build-daemon-bin.cjs output naming: ccsm-daemon-<pkg-platform>-<arch><ext>.
  const fileName = `ccsm-daemon-${meta.pkg}-${arch}${meta.ext}`;
  const filePath = path.join(REPO_ROOT, 'daemon', 'dist', fileName);

  try {
    const result = guard.assertDaemonBinary(filePath, meta.electron);
    console.log(
      `[verify-staged-daemon] OK ${fileName}: ` +
        `${(result.size / 1024 / 1024).toFixed(1)} MiB, magic=${result.magic}`,
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { main, PLATFORM_NAMES };
