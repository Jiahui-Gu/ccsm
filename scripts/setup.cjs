#!/usr/bin/env node
// scripts/setup.cjs
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-3.7.md §3.7.2.c
// Task: v0.3 #138 — one-shot dev environment bootstrap.
//
// What this does (in order):
//   1. `npm install` at repo root (also installs the `daemon` workspace)
//   2. Build ccsm_native N-API addon (delegates to scripts/build-ccsm-native.cjs;
//      task #109 owns that build).
//   3. electron-rebuild for native deps (better-sqlite3 + node-pty) — actually
//      a no-op when `npm install` already triggered the `postinstall` hook
//      (scripts/postinstall.mjs). Re-running is safe; we still call it
//      explicitly for the case where someone ran `npm install --ignore-scripts`.
//   4. Prep dev dataRoot location. Honors `CCSM_DATA_ROOT` env (same env
//      respected by electron/crash/incident-dir.ts + tests). When unset,
//      defaults to `~/.ccsm-dev` so dev work doesn't pollute the OS-native
//      `<dataRoot>` (frag-12 r5: %LOCALAPPDATA%\ccsm | ~/Library/Application
//      Support/ccsm | ~/.local/share/ccsm).
//
// Idempotent: re-running on a populated tree is safe — npm install is no-op,
// build:ccsm-native rebuilds in place, electron-rebuild --force overwrites,
// dataRoot mkdir is recursive.
//
// Cross-platform: dispatches `npm` -> `npm.cmd` on Windows, otherwise `npm`.
// Same convention as scripts/build-ccsm-native.cjs and scripts/postinstall.mjs.
//
// English-only logging.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

const STEPS = 4;
let stepNum = 0;

function header(label) {
  stepNum += 1;
  const banner = `[setup] === Step ${stepNum}/${STEPS}: ${label} ===`;
  console.log('\n' + banner);
}

function info(msg) {
  console.log(`[setup] ${msg}`);
}

function fatal(msg, code) {
  console.error(`\n[setup] FATAL: ${msg}`);
  process.exit(typeof code === 'number' ? code : 1);
}

function run(cmd, args, opts) {
  const merged = Object.assign(
    { cwd: repoRoot, stdio: 'inherit', shell: isWin },
    opts || {},
  );
  const printable = `${cmd} ${args.join(' ')}`;
  info(`$ ${printable}  (cwd=${path.relative(repoRoot, merged.cwd) || '.'})`);
  const r = spawnSync(cmd, args, merged);
  if (r.error) {
    fatal(`failed to spawn \`${printable}\`: ${r.error.message}`);
  }
  if (r.signal) {
    fatal(`\`${printable}\` killed by signal ${r.signal}`);
  }
  if (typeof r.status === 'number' && r.status !== 0) {
    fatal(`\`${printable}\` exited with code ${r.status}`, r.status);
  }
}

// ----- preflight -------------------------------------------------------------

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 20) {
  fatal(
    `Node ${process.version} is too old. ccsm requires Node 20.x (see scripts/postinstall.mjs).`,
  );
} else if (nodeMajor !== 20) {
  console.warn(
    `[setup] WARNING: ccsm CI uses Node 20.x; you're on Node ${process.version}. better-sqlite3 / node-pty may need extra toolchain to build. If install fails, switch with \`nvm use 20\` and re-run \`npm run setup\`.`,
  );
}

const rootPkgPath = path.join(repoRoot, 'package.json');
if (!fs.existsSync(rootPkgPath)) {
  fatal(`expected package.json at ${rootPkgPath}; are you running setup from the wrong tree?`);
}

console.log('[setup] ccsm one-shot dev bootstrap (frag-3.7 §3.7.2.c)');
info(`repo root : ${repoRoot}`);
info(`platform  : ${process.platform}-${process.arch}`);
info(`node      : ${process.version}`);

// ----- step 1: npm install (root + workspaces) -------------------------------

header('npm install (root + daemon workspace)');
// `npm install` at the root walks every workspace declared in package.json's
// "workspaces" key (currently just `daemon`). --no-audit/--no-fund keep
// stdout focused on actionable output.
run(npmCmd, ['install', '--no-audit', '--no-fund']);

// ----- step 2: build ccsm_native ---------------------------------------------

header('build ccsm_native (N-API addon)');
// Delegated to task #109's script — do not re-implement.
run('node', [path.join('scripts', 'build-ccsm-native.cjs')]);

// ----- step 3: electron-rebuild for native deps ------------------------------

header('electron-rebuild for native deps (better-sqlite3 + node-pty)');
// `npm install` above triggers `postinstall` -> scripts/postinstall.mjs which
// already runs @electron/rebuild for better-sqlite3 (fatal) and node-pty
// (best-effort). Re-invoking is idempotent and protects the case where the
// user did `npm install --ignore-scripts`. We delegate to the same script
// rather than duplicating the @electron/rebuild bin invocation.
run('node', [path.join('scripts', 'postinstall.mjs')]);

// ----- step 4: prep dev dataRoot ---------------------------------------------

header('prep dev dataRoot');
// CCSM_DATA_ROOT env is the test/dev override honored by
// electron/crash/incident-dir.ts and the daemon (frag-12 r5). When unset,
// dev work defaults to `~/.ccsm-dev` so it doesn't shadow a real install's
// `<dataRoot>` on the same machine.
const envOverride = (process.env.CCSM_DATA_ROOT || '').trim();
const devDataRoot = envOverride.length > 0
  ? envOverride
  : path.join(os.homedir(), '.ccsm-dev');

try {
  fs.mkdirSync(devDataRoot, { recursive: true });
} catch (err) {
  fatal(`could not create dev dataRoot at ${devDataRoot}: ${err.message}`);
}
info(`dev dataRoot ready: ${devDataRoot}`);
if (envOverride.length === 0) {
  info('  (default; export CCSM_DATA_ROOT=/your/path to override)');
} else {
  info('  (from CCSM_DATA_ROOT env)');
}

// ----- done ------------------------------------------------------------------

console.log('\n[setup] ============================================');
console.log('[setup]  All steps complete. Ready to run:');
console.log('[setup]    npm run dev       # web + daemon + electron, hot reload');
console.log('[setup] ============================================\n');
