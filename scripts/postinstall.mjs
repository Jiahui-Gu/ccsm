#!/usr/bin/env node
// Runs `electron-builder install-app-deps` and surfaces failures clearly.
//
// Background: previously package.json had
//   "postinstall": "electron-builder install-app-deps || true"
// which silently swallowed native rebuild failures. better-sqlite3 would
// end up compiled against the host Node ABI (e.g. NODE_MODULE_VERSION 127)
// instead of Electron's ABI (e.g. 130), and the app would fail at runtime
// with cryptic "renderer window didn't appear" errors.
//
// Now we fail loudly for native deps required by the app — currently
// better-sqlite3 (DB) and node-pty (terminal). Windows toast no longer
// requires a native rebuild; it goes through Electron's built-in
// `Notification` API directly.
//
// `electron-builder install-app-deps` walks every native module declared
// in package.json's `dependencies` and rebuilds against Electron's ABI,
// so node-pty is covered automatically alongside better-sqlite3.
//
// node-pty rebuild failure caveat (Windows): node-pty pulls winpty as a
// transitive dep whose `GetCommitHash.bat` shells out to git-bash;
// builders without git-bash on PATH see a non-fatal warning. The
// `prebuilds/win32-x64/pty.node` shipped in the node-pty tarball is the
// runtime fallback and is verified by scripts/after-pack.cjs.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// Preflight: warn (don't block) when running on a Node major other than 20.
// better-sqlite3 builds cleanly on Node 20.x; newer node-gyp + Node may need
// extra toolchain. We don't pin engines.node so contributors who only touch
// UI/tests can still `npm install` on newer Node; this warning gives them
// the clue if it breaks.
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor !== 20) {
  console.warn(
    `[postinstall] WARNING: ccsm native deps (better-sqlite3 + node-pty) build cleanly on Node 20.x. You're on Node ${process.version}. If you only touch UI/tests, this is fine; if you hit \`node-gyp\` errors during install, switch with \`nvm use 20\` and re-run \`npm ci --legacy-peer-deps\`. CI uses Node 20.`,
  );
}

// Strategy:
//   1. Rebuild better-sqlite3 strictly via @electron/rebuild — failure
//      here is fatal (DB unusable at runtime).
//   2. Attempt to rebuild node-pty — failure here is logged but
//      non-fatal. node-pty 1.x ships a prebuilt
//      `prebuilds/<os>-<arch>/node.napi.node` that the runtime falls
//      back to. The common Windows failure (winpty's `GetCommitHash.bat`
//      requiring git-bash on PATH) is benign for that reason.
//   3. scripts/after-pack.cjs asserts ONE of the two binding paths
//      exists in the packaged app; missing both is a hard build failure.
//
// We deliberately do NOT use `electron-builder install-app-deps` here
// because it aborts the full rebuild on the first native module that
// fails — that turns the recoverable node-pty/winpty case into a hard
// `npm install` failure.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const rebuildBinName = isWindows ? 'electron-rebuild.cmd' : 'electron-rebuild';
const rebuildBin = path.join(repoRoot, 'node_modules', '.bin', rebuildBinName);

if (!existsSync(rebuildBin)) {
  // @electron/rebuild ships its own bin via the devDependency. In an
  // --omit=dev install it legitimately won't exist; skip silently —
  // the app bundle was built elsewhere and shouldn't need a rebuild.
  console.log('[postinstall] @electron/rebuild not installed (dev dep); skipping native rebuild.');
  process.exit(0);
}

function runRebuild(moduleName, { allowFailure } = { allowFailure: false }) {
  console.log(`[postinstall] Rebuilding ${moduleName} for Electron ABI...`);
  const result = spawnSync(
    rebuildBin,
    ['-f', '-o', moduleName, '--build-from-source'],
    { stdio: 'inherit', shell: isWindows, cwd: repoRoot },
  );
  if (result.error) {
    if (allowFailure) {
      console.warn(`[postinstall] ${moduleName} rebuild failed to spawn: ${result.error.message} (continuing — prebuild fallback)`);
      return false;
    }
    console.error(`\n[postinstall] Failed to spawn @electron/rebuild for ${moduleName}: ${result.error.message}`);
    printHint();
    process.exit(1);
  }
  if (result.signal) {
    if (allowFailure) {
      console.warn(`[postinstall] ${moduleName} rebuild killed by signal ${result.signal} (continuing — prebuild fallback)`);
      return false;
    }
    console.error(`\n[postinstall] @electron/rebuild for ${moduleName} killed by signal ${result.signal}.`);
    printHint();
    process.exit(1);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    if (allowFailure) {
      console.warn(
        `[postinstall] ${moduleName} rebuild exited with code ${result.status} (continuing — node-pty ships a prebuilt ${process.platform}-${process.arch} binding under prebuilds/ that the runtime will fall back to; common Windows cause is winpty's GetCommitHash.bat needing git-bash on PATH).`,
      );
      return false;
    }
    console.error(`\n[postinstall] @electron/rebuild for ${moduleName} exited with code ${result.status}.`);
    printHint();
    process.exit(result.status);
  }
  return true;
}

runRebuild('better-sqlite3', { allowFailure: false });
runRebuild('node-pty', { allowFailure: true });

function printHint() {
  console.error('');
  console.error('Native modules (better-sqlite3 + node-pty) must be rebuilt');
  console.error('for the Electron ABI before the app can start. If the');
  console.error('automatic rebuild fails, try running it manually:');
  console.error('');
  console.error('  npx @electron/rebuild -f -o better-sqlite3 --build-from-source');
  console.error('  npx @electron/rebuild -f -o node-pty --build-from-source');
  console.error('');
  console.error('On Windows you need Visual Studio Build Tools (C++ workload)');
  console.error('+ Python 3 on PATH. On macOS, Xcode Command Line Tools. On Linux,');
  console.error('build-essential + python3.');
  console.error('');
  console.error('node-pty rebuild that fails on winpty\'s GetCommitHash.bat');
  console.error('(git-bash dependency) is non-fatal — the prebuilt');
  console.error('node-pty/prebuilds/win32-x64/pty.node is the runtime');
  console.error('fallback and is asserted by scripts/after-pack.cjs.');
  console.error('');
}
