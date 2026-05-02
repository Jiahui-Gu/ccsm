#!/usr/bin/env node
// scripts/build-ccsm-native.cjs
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
//   §3.5.1.1   "Built artifact name (P0 packaging contract):
//              daemon/native/<platform>-<arch>/ccsm_native.node"
//
// Convenience wrapper that:
//   1. installs node-addon-api inside daemon/native/ccsm_native/ (no-op
//      if already present)
//   2. runs `node-gyp rebuild` against daemon/.nvmrc Node target
//   3. copies the built .node into daemon/native/<platform>-<arch>/
//      so the daemon-side `loadCcsmNative()` shim resolves it.
//
// Used by the CI matrix (`ccsm-native.yml`) AND by developers who
// only want the addon built (without rebuilding better-sqlite3 +
// node-pty, which `npm run rebuild:natives` also touches).
//
// Single-responsibility: this script is a SINK (build side effect).
// English-only logging.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const addonDir = path.join(repoRoot, 'daemon', 'native', 'ccsm_native');
const nvmrcPath = path.join(repoRoot, 'daemon', '.nvmrc');

if (!fs.existsSync(addonDir)) {
  console.error(`[build:ccsm-native] FATAL: ${addonDir} missing.`);
  process.exit(1);
}
if (!fs.existsSync(nvmrcPath)) {
  console.error(`[build:ccsm-native] FATAL: ${nvmrcPath} missing.`);
  process.exit(1);
}
const NODE_TARGET = fs.readFileSync(nvmrcPath, 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(NODE_TARGET)) {
  console.error(
    `[build:ccsm-native] FATAL: daemon/.nvmrc must be semver, got "${NODE_TARGET}".`,
  );
  process.exit(1);
}

const platformArch = `${process.platform}-${process.arch}`;
const outDir = path.join(repoRoot, 'daemon', 'native', platformArch);
fs.mkdirSync(outDir, { recursive: true });

console.log(`[build:ccsm-native] platform=${platformArch}`);
console.log(`[build:ccsm-native] NODE_TARGET=${NODE_TARGET}`);
console.log(`[build:ccsm-native] addon dir=${addonDir}`);

// Step 1: install node-addon-api locally (creates node_modules in
// the addon dir if needed). We use --no-package-lock to avoid
// committing a per-platform lockfile to a directory that lives
// inside daemon/native/ (which is gitignored except for the addon
// source — see .gitignore).
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const ngypCmd = isWin ? 'node-gyp.cmd' : 'node-gyp';

console.log('[build:ccsm-native] step 1/3: install node-addon-api');
const installRes = spawnSync(
  npmCmd,
  [
    'install',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--ignore-scripts',
  ],
  { cwd: addonDir, stdio: 'inherit', shell: isWin },
);
if (installRes.status !== 0) {
  console.error(
    `[build:ccsm-native] FATAL: npm install failed (exit ${installRes.status})`,
  );
  process.exit(installRes.status || 1);
}

// Step 2: node-gyp rebuild against the daemon Node target.
console.log(
  `[build:ccsm-native] step 2/3: node-gyp rebuild --target=${NODE_TARGET}`,
);
const buildRes = spawnSync(
  ngypCmd,
  [
    'rebuild',
    `--target=${NODE_TARGET}`,
    '--runtime=node',
    '--dist-url=https://nodejs.org/dist',
  ],
  { cwd: addonDir, stdio: 'inherit', shell: isWin },
);
if (buildRes.status !== 0) {
  console.error(
    `[build:ccsm-native] FATAL: node-gyp rebuild failed (exit ${buildRes.status})`,
  );
  process.exit(buildRes.status || 1);
}

// Step 3: copy the built .node into daemon/native/<platform-arch>/.
const built = path.join(addonDir, 'build', 'Release', 'ccsm_native.node');
if (!fs.existsSync(built)) {
  console.error(`[build:ccsm-native] FATAL: expected artifact missing: ${built}`);
  process.exit(1);
}
const dst = path.join(outDir, 'ccsm_native.node');
fs.copyFileSync(built, dst);
console.log(`[build:ccsm-native] step 3/3: copied -> ${dst}`);
console.log('[build:ccsm-native] OK');
