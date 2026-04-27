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
// Now we fail loudly for ALL native deps required by the app. On Windows
// that includes both better-sqlite3 (DB) and the
// electron-windows-notifications -> @nodert-win10-au/* chain (Adaptive Toast
// notifications). Shipping an installer without the notifications native
// chain is a silent regression — the wrapper falls back to no toasts at all
// (see #267 + notify-ship-native fix). On non-Windows the notifications
// package is win32-only and absent by design; the rebuild only touches
// better-sqlite3 there.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// Preflight: warn (don't block) when running on a Node major other than 20.
// Native deps (better-sqlite3, electron-windows-notifications, @nodert-win10-au)
// build cleanly on Node 20.x. node-gyp 10.x + Node >= 22 trips a `/std:c++20`
// vs WinRT `/ZW` clash that surfaces as `error C1107: could not find assembly
// 'platform.winmd'`, even with the full VS 2022 C++/CX SDK installed. We don't
// pin engines.node so contributors who only touch UI/tests can still
// `npm install` on newer Node; this warning gives them the clue if it breaks.
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor !== 20) {
  console.warn(
    `[postinstall] WARNING: ccsm native deps (better-sqlite3, electron-windows-notifications, @nodert-win10-au) build cleanly on Node 20.x. You're on Node ${process.version}. If you only touch UI/tests, this is fine; if you hit \`node-gyp\` C1107 or \`/std:c++20 /ZW\` errors during install, switch with \`nvm use 20\` and re-run \`npm ci --legacy-peer-deps\`. CI uses Node 20.`,
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const binName = isWindows ? 'electron-builder.cmd' : 'electron-builder';
const binPath = path.join(repoRoot, 'node_modules', '.bin', binName);

if (!existsSync(binPath)) {
  // electron-builder is in devDependencies; in --omit=dev installs it
  // legitimately won't exist. Skip silently in that case — the app
  // bundle was built elsewhere and shouldn't need a rebuild here.
  console.log('[postinstall] electron-builder not installed (dev dep); skipping install-app-deps.');
  process.exit(0);
}

// Node's spawnSync on Windows refuses to launch .cmd files without
// shell:true since the CVE-2024-27980 mitigation. Use shell mode there.
const fullRebuild = spawnSync(binPath, ['install-app-deps'], {
  stdio: 'inherit',
  shell: isWindows,
  cwd: repoRoot,
});

if (fullRebuild.error) {
  console.error('\n[postinstall] Failed to spawn electron-builder:', fullRebuild.error.message);
  printHint();
  process.exit(1);
}

if (fullRebuild.signal) {
  console.error(`\n[postinstall] electron-builder install-app-deps killed by signal ${fullRebuild.signal}.`);
  printHint();
  process.exit(1);
}

if (typeof fullRebuild.status === 'number' && fullRebuild.status !== 0) {
  console.error(
    `\n[postinstall] electron-builder install-app-deps exited with code ${fullRebuild.status}.`,
  );
  printHint();
  process.exit(fullRebuild.status);
}

// On Windows verify the notifications native chain actually built. The
// rebuild can sometimes report success while leaving a transitive
// @nodert-win10-au addon broken; surface that here as a hard failure so the
// installer never ships without OS notifications again.
if (isWindows) {
  const nativeNotifyDir = path.join(
    repoRoot,
    'node_modules',
    'electron-windows-notifications',
  );
  if (!existsSync(nativeNotifyDir)) {
    console.error(
      '\n[postinstall] electron-windows-notifications is not installed. ' +
        'It is a required dependency on Windows — `npm install` should have ' +
        'placed it in node_modules.',
    );
    printHint();
    process.exit(1);
  }
}

function printHint() {
  console.error('');
  console.error('Native modules (notably better-sqlite3 and');
  console.error('electron-windows-notifications) must be rebuilt for the');
  console.error('Electron ABI before the app can start. If automatic rebuild');
  console.error('fails, try running it manually:');
  console.error('');
  console.error('  npx @electron/rebuild -f -w better-sqlite3 --build-from-source');
  console.error('  npx @electron/rebuild -f -w electron-windows-notifications --build-from-source');
  console.error('');
  console.error('On Windows you need Visual Studio Build Tools (C++ workload)');
  console.error('+ Python 3 on PATH. On macOS, Xcode Command Line Tools. On Linux,');
  console.error('build-essential + python3.');
  console.error('');
}
