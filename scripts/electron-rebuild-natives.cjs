#!/usr/bin/env node
// scripts/electron-rebuild-natives.cjs
//
// Spec: docs/superpowers/specs/v0.3-design.md §11 + frag-11 native ABI handling
// Task: T60 — L6 electron-rebuild for Node 22 ABI
//
// Builds native modules TWICE per release so the daemon (separate Node-22
// process produced by @yao-pkg/pkg) and the Electron main process can each
// dlopen ABI-matched bindings:
//
//   (a) Node 22 ABI  →  daemon/native/<platform>-<arch>/   (consumed by daemon)
//   (b) Electron ABI →  node_modules/<mod>/build/Release/  (consumed by main)
//
// The two ABIs are NOT compatible — sharing one .node between daemon and main
// would crash one of them at load time (NODE_MODULE_VERSION mismatch). Hence
// two output trees.
//
// Pass (a) is built via `npm rebuild ... --runtime=node --target=$NODE_TARGET
// --build-from-source` (matches spec §11.1 sketch — node-gyp downloads Node
// headers for the target version) and the resulting .node files are copied
// into daemon/native/<platform>-<arch>/.
//
// Pass (b) is built via @electron/rebuild's programmatic API against the
// installed Electron version. This leaves node_modules/<mod>/build/Release/
// in the canonical Electron-ABI state expected by `npm run dev` /
// `electron-builder`.
//
// Single source of truth for the daemon's Node version: daemon/.nvmrc.
//
// Single Responsibility: this script is a SINK (rebuild side effect).
// English-only logging.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const nvmrcPath = path.join(repoRoot, 'daemon', '.nvmrc');
if (!fs.existsSync(nvmrcPath)) {
  console.error(`[rebuild:natives] FATAL: ${nvmrcPath} missing. Cannot determine daemon Node target.`);
  process.exit(1);
}
const NODE_TARGET = fs.readFileSync(nvmrcPath, 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(NODE_TARGET)) {
  console.error(`[rebuild:natives] FATAL: daemon/.nvmrc must be a semver Node version, got "${NODE_TARGET}".`);
  process.exit(1);
}

// Modules to rebuild for the daemon. ccsm_native is in-tree (frag-3.5.1
// §3.5.1.1) and may not exist yet — guard with a directory probe.
//
// node-pty 1.x exposes its native bindings as **N-API** prebuilds (see
// node_modules/node-pty/prebuilds/<platform>/{pty,conpty,conpty_console_list}.node
// on Win and pty.node on POSIX). N-API is ABI-stable across Node majors, so
// the prebuilt napi binaries load under both Electron's V8 ABI and Node 22 —
// no source rebuild required for the daemon path. We `cp` the prebuild into
// daemon/native/<platform>-<arch>/. Source rebuild on Windows additionally
// requires git-bash on PATH (winpty submodule's GetCommitHash.bat) and would
// destroy the prebuilds the main process relies on.
const DAEMON_MODULES = [
  { name: 'better-sqlite3', source: 'npm-rebuild', binary: 'better_sqlite3.node' },
  { name: 'node-pty',       source: 'napi-prebuild' },
  { name: 'ccsm_native',    source: 'in-tree', dir: path.join(repoRoot, 'daemon', 'native', 'ccsm_native'), binary: 'ccsm_native.node' },
];

const platformArch = `${process.platform}-${process.arch}`;
const daemonNativeOutDir = path.join(repoRoot, 'daemon', 'native', platformArch);
fs.mkdirSync(daemonNativeOutDir, { recursive: true });

console.log(`[rebuild:natives] platform=${platformArch}`);
console.log(`[rebuild:natives] NODE_TARGET=${NODE_TARGET} (from daemon/.nvmrc)`);
console.log(`[rebuild:natives] daemon native out: ${daemonNativeOutDir}`);

// ---------------------------------------------------------------------------
// Pass (a): Node 22 ABI for daemon
// ---------------------------------------------------------------------------
console.log('\n[rebuild:natives] === Pass (a): Node 22 ABI for daemon ===');

for (const mod of DAEMON_MODULES) {
  if (mod.source === 'in-tree') {
    if (!fs.existsSync(mod.dir)) {
      console.log(`[rebuild:natives] skip ${mod.name}: ${path.relative(repoRoot, mod.dir)} not present yet`);
      continue;
    }
    console.log(`[rebuild:natives] node-gyp rebuild ${mod.name} (Node ${NODE_TARGET}) ...`);
    const r = spawnSync(
      process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp',
      ['rebuild', `--target=${NODE_TARGET}`, '--runtime=node', '--dist-url=https://nodejs.org/dist'],
      { cwd: mod.dir, stdio: 'inherit', shell: process.platform === 'win32' },
    );
    if (r.status !== 0) {
      console.error(`[rebuild:natives] FATAL: node-gyp rebuild failed for ${mod.name} (exit ${r.status})`);
      process.exit(r.status || 1);
    }
    const built = path.join(mod.dir, 'build', 'Release', mod.binary);
    if (!fs.existsSync(built)) {
      console.error(`[rebuild:natives] FATAL: expected built artifact missing: ${built}`);
      process.exit(1);
    }
    fs.copyFileSync(built, path.join(daemonNativeOutDir, mod.binary));
    console.log(`[rebuild:natives]   copied -> ${path.join(daemonNativeOutDir, mod.binary)}`);
    continue;
  }

  if (mod.source === 'napi-prebuild') {
    // N-API binding is ABI-stable; copy the shipped prebuild without rebuild.
    const prebuildDir = path.join(repoRoot, 'node_modules', mod.name, 'prebuilds', platformArch);
    if (!fs.existsSync(prebuildDir)) {
      // node-pty 1.1.0 historically did not always publish a prebuild for
      // every platform/arch (in particular, fresh installs on Windows fail
      // mid-rebuild because the bundled winpty submodule's GetCommitHash.bat
      // requires git-bash on PATH, leaving no .node behind). Treat as a
      // soft warning: the daemon binary still builds (better-sqlite3 + the
      // pkg-bundled JS), and pty.node is dlopen'd lazily on first session
      // spawn. If a user actually starts a session without a working
      // pty.node the daemon will surface a clear error at that point.
      // before-pack.cjs's REQUIRED_NATIVES check is the hard gate for
      // installer builds; this script is only the dev-loop best-effort.
      console.warn(
        `[rebuild:natives] WARN ${mod.name} prebuild dir missing: ${prebuildDir}. ` +
          `Skipping (frag-11 §11.1 daemon-side native; installer build is ` +
          `gated by before-pack.cjs REQUIRED_NATIVES).`,
      );
      continue;
    }
    let copied = 0;
    for (const f of fs.readdirSync(prebuildDir)) {
      if (f.endsWith('.node') || f.endsWith('.dll') || f.endsWith('.exe')) {
        fs.copyFileSync(path.join(prebuildDir, f), path.join(daemonNativeOutDir, f));
        console.log(`[rebuild:natives]   copied ${mod.name} prebuild ${f}`);
        copied++;
      }
    }
    if (copied === 0) {
      console.error(`[rebuild:natives] FATAL: ${mod.name} prebuild dir contained no .node files`);
      process.exit(1);
    }
    continue;
  }

  // mod.source === 'npm-rebuild': rebuild against Node target ABI then copy.
  // (node-pty avoids this branch precisely because --build-from-source nukes
  // its prebuilds and then fails on Win without git-bash.)
  const modRoot = path.join(repoRoot, 'node_modules', mod.name);
  if (!fs.existsSync(modRoot)) {
    console.error(`[rebuild:natives] FATAL: node_modules/${mod.name} not installed; run \`npm ci\` first.`);
    process.exit(1);
  }
  console.log(`[rebuild:natives] npm rebuild ${mod.name} (Node ${NODE_TARGET}) ...`);
  const args = [
    'rebuild', mod.name,
    `--runtime=node`,
    `--target=${NODE_TARGET}`,
    `--build-from-source`,
    `--dist-url=https://nodejs.org/dist`,
  ];
  const r = spawnSync('npm', args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error(`[rebuild:natives] FATAL: npm rebuild failed for ${mod.name} (exit ${r.status})`);
    process.exit(r.status || 1);
  }
  const built = path.join(modRoot, 'build', 'Release', mod.binary);
  if (!fs.existsSync(built)) {
    console.error(`[rebuild:natives] FATAL: no .node artifact at ${built}`);
    process.exit(1);
  }
  fs.copyFileSync(built, path.join(daemonNativeOutDir, mod.binary));
  console.log(`[rebuild:natives]   copied ${path.relative(repoRoot, built)} -> ${path.relative(repoRoot, path.join(daemonNativeOutDir, mod.binary))}`);
}

// ---------------------------------------------------------------------------
// Pass (b): Electron ABI restore (programmatic @electron/rebuild API)
// ---------------------------------------------------------------------------
console.log('\n[rebuild:natives] === Pass (b): Electron ABI for main process ===');

let rebuildApi;
try {
  rebuildApi = require('@electron/rebuild');
} catch (err) {
  console.error('[rebuild:natives] FATAL: @electron/rebuild not installed (devDependency missing).');
  console.error(err.message);
  process.exit(1);
}

const electronVersion = (() => {
  const pkg = require(path.join(repoRoot, 'node_modules', 'electron', 'package.json'));
  return pkg.version;
})();
console.log(`[rebuild:natives] Electron version: ${electronVersion}`);

// Only npm-rebuild modules whose Electron-ABI .node we just overwrote in pass (a)
// need to be restored. node-pty was not touched (napi-prebuild branch).
// ccsm_native is daemon-only (never loaded by main process) per spec
// frag-3.5.1 §3.5.1.1.
const electronModules = DAEMON_MODULES
  .filter((m) => m.source === 'npm-rebuild')
  .map((m) => m.name);

(async () => {
  if (electronModules.length === 0) {
    console.log('[rebuild:natives] no Electron-ABI restore required.');
  } else {
    try {
      await rebuildApi.rebuild({
        buildPath: repoRoot,
        electronVersion,
        onlyModules: electronModules,
        force: true,
        mode: 'sequential',
      });
    } catch (err) {
      console.error(`[rebuild:natives] FATAL: @electron/rebuild failed: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\n[rebuild:natives] DONE');
  console.log(`[rebuild:natives]   daemon (Node ${NODE_TARGET} ABI):  ${path.relative(repoRoot, daemonNativeOutDir)}/`);
  console.log(`[rebuild:natives]   main   (Electron ${electronVersion} ABI): node_modules/<mod>/build/Release/`);
})();
