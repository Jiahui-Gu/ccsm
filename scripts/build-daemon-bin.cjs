// Root entrypoint for `npm run build:daemon-bin` (frag-11 §11.1).
//
// One command produces `daemon/dist/ccsm-daemon-${platform}-${arch}${ext}`
// from a clean checkout. Used both locally (dogfood worker / dev) and by
// the release.yml `Build daemon binary` step (frag-11 §11.5 step 2).
//
// Pipeline:
//   1. Compile daemon TS (`npm run build:daemon` at root → tsc + emit
//      dist-daemon/package.json with type:module).
//   2. Rebuild native modules against Node 22 ABI for the host
//      platform/arch and stage them into daemon/native/<platform>-<arch>/
//      (delegated to scripts/electron-rebuild-natives.cjs).
//   3. Pre-bundle the daemon ESM entry into a single CommonJS file via
//      esbuild (spike `docs/spikes/2026-05-pkg-esm-connect.md` Fallback A).
//      pkg's resolver does not honour package.json `exports` subpath maps
//      and trips on top-level await + export combos in ESM (yao-pkg/pkg
//      issues #215 + ESM transformer limits). esbuild bundles the whole
//      ESM graph into one CJS file with all `exports` paths inlined; pkg
//      then ingests the bundle cleanly.
//   4. Invoke @yao-pkg/pkg with --targets node22-${platform}-${arch} so
//      each binary embeds only its own arch's `.node` files
//      (frag-11 round-3 P1-7).
//
// Cross-compilation between Win/mac/Linux native modules is unsupported
// (round-3 P1-2/P1-3); the matrix in release.yml runs one leg per OS and
// each leg invokes this script on its own runner.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON_DIST = path.join(REPO_ROOT, 'daemon', 'dist');

const PKG_PLATFORM_MAP = {
  win32: 'win',
  darwin: 'macos',
  linux: 'linux',
};

const platform = process.platform;
const arch = process.arch;
const pkgPlatform = PKG_PLATFORM_MAP[platform];
if (!pkgPlatform) {
  console.error(`[build:daemon-bin] unsupported platform: ${platform}`);
  process.exit(1);
}
if (arch !== 'x64' && arch !== 'arm64') {
  console.error(`[build:daemon-bin] unsupported arch: ${arch} (expected x64 or arm64)`);
  process.exit(1);
}

const ext = platform === 'win32' ? '.exe' : '';
const outName = `ccsm-daemon-${pkgPlatform}-${arch}${ext}`;
const outPath = path.join(DAEMON_DIST, outName);
const pkgTarget = `node22-${pkgPlatform}-${arch}`;

function run(cmd, opts = {}) {
  console.log(`[build:daemon-bin] $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: REPO_ROOT, ...opts });
}

console.log(`[build:daemon-bin] target=${pkgPlatform}-${arch} pkg=${pkgTarget}`);
console.log(`[build:daemon-bin] output=${path.relative(REPO_ROOT, outPath)}`);

// 1. Compile daemon TS via the existing root script (handles clean +
//    type:module marker emission).
run('npm run build:daemon');

// 2. Rebuild natives for Node 22 ABI on this host. Reuses the existing
//    scripts/electron-rebuild-natives.cjs which already implements the
//    correct per-module strategy (N-API prebuild copy for node-pty,
//    source rebuild for better-sqlite3, in-tree node-gyp for ccsm_native
//    when present) AND restores Electron-ABI bindings in pass (b) so the
//    main process keeps working after this script runs.
run('npm run rebuild:natives');

// 3. esbuild bundle: daemon/dist-daemon/index.js (ESM) -> daemon/dist-daemon-bundle/index.cjs.
//    Per spike Fallback A (docs/spikes/2026-05-pkg-esm-connect.md): bundle
//    every import — including `exports`-subpath maps that pkg's legacy
//    resolver does not understand — into one CJS file. CJS is required
//    because pkg's snapshot virtual fs only intercepts `require()`, not
//    ESM `import()` — an ESM bundle inside the snapshot fails resolution
//    at runtime even when the file is embedded. Daemon source uses an
//    async IIFE around the boot-time `await listen()` calls (rather than
//    top-level await) so this CJS transform succeeds.
const esbuild = require('esbuild');
const bundleEntry = path.join(REPO_ROOT, 'daemon', 'dist-daemon', 'index.js');
const bundleDir = path.join(REPO_ROOT, 'daemon', 'dist-daemon-bundle');
const bundleOut = path.join(bundleDir, 'index.cjs');
fs.rmSync(bundleDir, { recursive: true, force: true });
fs.mkdirSync(bundleDir, { recursive: true });
console.log(`[build:daemon-bin] $ esbuild bundle ${path.relative(REPO_ROOT, bundleEntry)} -> ${path.relative(REPO_ROOT, bundleOut)}`);
const esbuildResult = esbuild.buildSync({
  entryPoints: [bundleEntry],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: bundleOut,
  sourcemap: true,
  // Keep native modules out of the bundle. They're loaded at runtime via
  // path.dirname(process.execPath)/native/<platform>-<arch>/ (frag-11
  // §11.1).
  external: ['better-sqlite3', 'node-pty'],
  // Substitute import.meta.url to a CJS-friendly equivalent so the daemon's
  // `createRequire(import.meta.url)` ends up as `createRequire(__filename)`
  // after esbuild's pre-define pass; otherwise esbuild emits an empty
  // import.meta and `createRequire(undefined)` throws at boot.
  define: {
    'import.meta.url': '__esbuildEsmFileUrl',
  },
  banner: {
    js:
      `'use strict';\n` +
      `const __esbuildEsmFileUrl = require('node:url').pathToFileURL(__filename).href;\n`,
  },
  logLevel: 'warning',
});
if (esbuildResult.errors.length > 0) {
  console.error('[build:daemon-bin] esbuild errors:', esbuildResult.errors);
  process.exit(1);
}

// 4. Pkg-bundle the daemon. We invoke pkg directly (rather than the
//    daemon-side `npm run package`) so we can pass --targets per host.
//    --no-bytecode keeps the binary loadable across patch versions of
//    Node within Node 22 (and avoids the V8 cached-data stalls some hosts
//    hit in CI). --public-packages "*" + --public dampens the pkg
//    "private package" warnings for our @ccsm/daemon entry.
fs.mkdirSync(DAEMON_DIST, { recursive: true });
run(
  `npx pkg . --targets ${pkgTarget} --output ${path.relative(path.join(REPO_ROOT, 'daemon'), outPath)} --no-bytecode --public-packages "*" --public`,
  { cwd: path.join(REPO_ROOT, 'daemon') },
);

// 4. Sanity check.
if (!fs.existsSync(outPath)) {
  console.error(`[build:daemon-bin] FAIL: expected output missing: ${outPath}`);
  process.exit(1);
}
const sizeBytes = fs.statSync(outPath).size;
const sizeMb = sizeBytes / (1024 * 1024);
console.log(`[build:daemon-bin] OK: ${outName} (${sizeMb.toFixed(1)} MB)`);

// pkg-bundled Node 22 binaries are ~50MB+; under 10MB means something
// was stripped (pkg failed silently / bundled almost nothing).
if (sizeMb < 10) {
  console.error(
    `[build:daemon-bin] FAIL: binary suspiciously small (${sizeMb.toFixed(1)} MB < 10 MB). ` +
    `pkg likely failed to embed Node base; inspect logs above.`,
  );
  process.exit(1);
}
