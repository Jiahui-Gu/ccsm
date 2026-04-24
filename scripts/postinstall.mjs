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
// Now we fail loudly for REQUIRED native deps (better-sqlite3) and tolerate
// failures for OPTIONAL native deps (the @nodert-win10-au/* chain pulled in
// by @ccsm/notify, which has no prebuilds and needs a working MSBuild
// toolchain to compile). The optional chain is exposed through
// `electron/notify.ts`, which lazy-loads @ccsm/notify and falls back to
// in-app banners if the import throws — so a failed rebuild is recoverable.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

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
  // The full rebuild failed. The most common cause is the @nodert-win10-au
  // native chain pulled in by the optional @ccsm/notify dep (no prebuilds,
  // requires MSBuild). Try rebuilding just better-sqlite3 — that's the only
  // REQUIRED native module the app needs at runtime. If that succeeds,
  // demote the original failure to a warning and let install proceed; the
  // app's notify wrapper will fall back to in-app banners.
  console.warn(
    `\n[postinstall] electron-builder install-app-deps exited with code ${fullRebuild.status}. ` +
      `Retrying with the required-only set (better-sqlite3) — see task #267.`,
  );

  const rebuildBinName = isWindows ? 'electron-rebuild.cmd' : 'electron-rebuild';
  const rebuildBinPath = path.join(repoRoot, 'node_modules', '.bin', rebuildBinName);
  if (!existsSync(rebuildBinPath)) {
    console.error('\n[postinstall] @electron/rebuild binary not found; cannot retry required-only.');
    printHint();
    process.exit(fullRebuild.status);
  }

  const requiredOnly = spawnSync(
    rebuildBinPath,
    ['-f', '--only', 'better-sqlite3', '--types', 'prod'],
    { stdio: 'inherit', shell: isWindows, cwd: repoRoot },
  );

  if (
    requiredOnly.error ||
    requiredOnly.signal ||
    (typeof requiredOnly.status === 'number' && requiredOnly.status !== 0)
  ) {
    console.error('\n[postinstall] Required-only rebuild (better-sqlite3) also failed.');
    printHint();
    process.exit(requiredOnly.status ?? 1);
  }

  console.warn(
    '\n[postinstall] better-sqlite3 rebuilt OK. Optional native deps (e.g. ' +
      '@ccsm/notify -> @nodert-win10-au/*) failed to build; CCSM will fall ' +
      'back to in-app banners and standard system notifications. See ' +
      'electron/notify.ts.',
  );
  process.exit(0);
}

function printHint() {
  console.error('');
  console.error('Native modules (notably better-sqlite3) must be rebuilt for the');
  console.error('Electron ABI before the app can start. If automatic rebuild fails,');
  console.error('try running it manually:');
  console.error('');
  console.error('  npx @electron/rebuild -f -w better-sqlite3 --build-from-source');
  console.error('');
  console.error('On Windows you may need Visual Studio Build Tools (C++ workload)');
  console.error('+ Python 3 on PATH. On macOS, Xcode Command Line Tools. On Linux,');
  console.error('build-essential + python3.');
  console.error('');
}
