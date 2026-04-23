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
// Now we fail loudly and tell the user exactly how to recover.

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
const result = spawnSync(binPath, ['install-app-deps'], {
  stdio: 'inherit',
  shell: isWindows,
  cwd: repoRoot,
});

if (result.error) {
  console.error('\n[postinstall] Failed to spawn electron-builder:', result.error.message);
  printHint();
  process.exit(1);
}

if (result.signal) {
  console.error(`\n[postinstall] electron-builder install-app-deps killed by signal ${result.signal}.`);
  printHint();
  process.exit(1);
}

if (typeof result.status === 'number' && result.status !== 0) {
  console.error(`\n[postinstall] electron-builder install-app-deps exited with code ${result.status}.`);
  printHint();
  process.exit(result.status);
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
