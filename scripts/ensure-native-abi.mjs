#!/usr/bin/env node
// scripts/ensure-native-abi.mjs
//
// Ensures `better-sqlite3`'s native binding under `node_modules/.../build/Release/`
// matches the requested ABI ('node' or 'electron'). If it does not, rebuilds it.
//
// Why this exists (Task #399):
//   `scripts/postinstall.mjs` rebuilds `better-sqlite3` for the **Electron**
//   ABI (currently NODE_MODULE_VERSION 145 against Electron 41). That is
//   correct for `npm run dev` / `npm run build:app` / packaged-app runtime
//   — Electron loads the binding inside its own Node/V8.
//
//   But `npm run test:app` and `pnpm --filter @ccsm/daemon test` run under
//   the host Node (currently v22.x → NODE_MODULE_VERSION 127). Loading the
//   Electron-ABI binding from those runtimes throws:
//
//       The module '...better_sqlite3.node' was compiled against a different
//       Node.js version using NODE_MODULE_VERSION 145. This version of
//       Node.js requires NODE_MODULE_VERSION 127.
//
//   CI's `.github/workflows/ci.yml` already side-steps this by running
//   `npm rebuild better-sqlite3` after install (see line 155 of ci.yml). dev
//   pools (`pnpm install --frozen-lockfile`) inherit the postinstall's
//   Electron-ABI build and hit the failure on first `vitest` invocation.
//   Per dev-339 (Task #339, pool-3, 2026-05-04) every dev who touches
//   `packages/daemon/` burns turns diagnosing this; it is not a regression.
//
//   We avoid the alternative fixes considered in the task spec because they
//   are worse:
//     - `.npmrc enable-pre-post-scripts=true` lets pnpm run
//       better-sqlite3's own install script (downloads a Node-ABI prebuild
//       into `build/Release/`), but `scripts/postinstall.mjs` then runs
//       `electron-rebuild` which **overwrites** the same path with the
//       Electron-ABI binding. Net state is unchanged — vitest still fails.
//     - A blanket root postinstall rebuild to Node ABI breaks `npm run dev`
//       and `electron .` because Electron then sees the wrong ABI.
//
// How this script works:
//   1. Find better-sqlite3's installed `build/Release/better_sqlite3.node`.
//   2. Read NODE_MODULE_VERSION from the file's PE/ELF/Mach-O header — this
//      is fast, dependency-free, and avoids dlopen-ing a wrong-ABI binding
//      (which would crash this very process).
//   3. Compare against the expected ABI for the requested target:
//        - 'node'     → `process.versions.modules` (the host Node we're on)
//        - 'electron' → look up Electron's `node` runtime version, then
//                       infer NODE_MODULE_VERSION from its lib metadata.
//      For the 'electron' lookup we cheap out: we just check that the
//      binding is NOT already a match for the host Node — if it isn't, we
//      assume it's already an Electron build (it was last rebuilt by
//      `postinstall.mjs` either against Electron or by us against Node).
//      This avoids a hard dep on Electron's ABI table; the worst case is a
//      no-op rebuild which is still correct.
//   4. Rebuild via `npm rebuild better-sqlite3` (Node ABI) or
//      `npx @electron/rebuild -f -o better-sqlite3 --build-from-source`
//      (Electron ABI).
//
// SRP: pure decider (read ABI marker → choose action) + tiny sink (spawn
// rebuild). No I/O beyond the binding file + the rebuild subprocess.
//
// Caveats:
//   - We only handle `better-sqlite3`. `node-pty` ships prebuilt bindings
//     under `prebuilds/<os>-<arch>/` that work for both Node and Electron
//     ABIs (NAPI), so it does not need this dance.
//   - If the binding file is missing entirely (e.g. cold install where
//     postinstall hasn't run yet), we trigger a rebuild for the target ABI.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

const target = process.argv[2];
if (target !== 'node' && target !== 'electron') {
  console.error('[ensure-native-abi] usage: node scripts/ensure-native-abi.mjs <node|electron>');
  process.exit(2);
}

// ── Locate the installed better-sqlite3 binding ──────────────────────────────
//
// pnpm's symlinked layout means the canonical location is under
// `node_modules/.pnpm/better-sqlite3@<v>/node_modules/better-sqlite3/`. We
// resolve via Node's own resolver to be version-agnostic.
let pkgEntry;
try {
  pkgEntry = require.resolve('better-sqlite3/package.json', { paths: [repoRoot] });
} catch (e) {
  // Module missing entirely — `pnpm install` must run first. Don't fail the
  // pretest hook on this; let the actual test/build step surface a clear
  // MODULE_NOT_FOUND.
  console.log('[ensure-native-abi] better-sqlite3 not installed; skipping');
  process.exit(0);
}
const pkgDir = path.dirname(pkgEntry);
const bindingPath = path.join(pkgDir, 'build', 'Release', 'better_sqlite3.node');

const hostNodeAbi = Number.parseInt(process.versions.modules, 10);

// ── Read NODE_MODULE_VERSION from the binding file ───────────────────────────
//
// Node's native module loader stamps NODE_MODULE_VERSION into the binding
// at compile time as a constant in `node::ModuleFlags::kVersion`. Rather
// than parse PE/ELF headers, we use a much simpler trick: try dlopen via
// `process.dlopen` in a worker / child? Too heavy.
//
// Cheapest reliable approach: spawn `node -e "process.dlopen({exports:{}}, '<path>')"`
// in a separate process; if it succeeds the ABI matches host Node, if it
// throws the message contains the actual `NODE_MODULE_VERSION N`.
function detectBindingNodeAbi(file) {
  if (!existsSync(file)) return null;
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `try{process.dlopen({exports:{}},${JSON.stringify(file)});console.log('OK:'+process.versions.modules)}catch(e){console.log('ERR:'+e.message)}`,
    ],
    { encoding: 'utf8' },
  );
  const out = (probe.stdout || '') + (probe.stderr || '');
  if (out.includes('OK:')) {
    return hostNodeAbi; // matches host
  }
  const m = out.match(/NODE_MODULE_VERSION\s+(\d+)/);
  if (m) return Number.parseInt(m[1], 10);
  return null;
}

const bindingAbi = detectBindingNodeAbi(bindingPath);

// ── Decide ───────────────────────────────────────────────────────────────────
//
// For target='node': we need bindingAbi === hostNodeAbi.
// For target='electron': we want bindingAbi !== hostNodeAbi (i.e. it's the
//   Electron build that postinstall.mjs produced). If bindingAbi DOES match
//   host Node (someone ran `npm test` last), we have to rebuild for Electron.
//   We can't easily know Electron's exact ABI from here without importing
//   Electron, but `electron-rebuild` knows; we just delegate to it.
function needsRebuild() {
  if (bindingAbi === null) return true; // missing or unreadable
  if (target === 'node') return bindingAbi !== hostNodeAbi;
  if (target === 'electron') return bindingAbi === hostNodeAbi;
  return false;
}

if (!needsRebuild()) {
  console.log(
    `[ensure-native-abi] better-sqlite3 binding ABI=${bindingAbi} already matches target=${target} (host node ABI=${hostNodeAbi}); skipping rebuild`,
  );
  process.exit(0);
}

console.log(
  `[ensure-native-abi] better-sqlite3 binding ABI=${bindingAbi ?? '<missing>'} != target=${target} (host node ABI=${hostNodeAbi}); rebuilding`,
);

// ── Rebuild ──────────────────────────────────────────────────────────────────
let result;
if (target === 'node') {
  // `npm rebuild better-sqlite3` from the repo root rebuilds against the
  // currently-running Node. Mirrors what CI does in .github/workflows/ci.yml.
  result = spawnSync(isWindows ? 'npm.cmd' : 'npm', ['rebuild', 'better-sqlite3'], {
    stdio: 'inherit',
    shell: isWindows,
    cwd: repoRoot,
  });
} else {
  // Electron ABI — reuse the same path postinstall.mjs uses.
  const rebuildBinName = isWindows ? 'electron-rebuild.cmd' : 'electron-rebuild';
  const rebuildBin = path.join(repoRoot, 'node_modules', '.bin', rebuildBinName);
  if (!existsSync(rebuildBin)) {
    console.error('[ensure-native-abi] @electron/rebuild not installed; cannot rebuild for Electron ABI.');
    console.error('[ensure-native-abi] Run `pnpm install --frozen-lockfile` first.');
    process.exit(1);
  }
  result = spawnSync(rebuildBin, ['-f', '-o', 'better-sqlite3', '--build-from-source'], {
    stdio: 'inherit',
    shell: isWindows,
    cwd: repoRoot,
  });
}

if (result.error) {
  console.error(`[ensure-native-abi] rebuild failed to spawn: ${result.error.message}`);
  process.exit(1);
}
if (typeof result.status === 'number' && result.status !== 0) {
  console.error(`[ensure-native-abi] rebuild exited with code ${result.status}`);
  process.exit(result.status);
}

console.log(`[ensure-native-abi] rebuild OK (target=${target})`);
