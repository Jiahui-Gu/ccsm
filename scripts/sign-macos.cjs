// electron-builder afterSign hook — macOS codesign loop.
//
// Why a custom loop on top of electron-builder's own signing?
// electron-builder signs the outer .app bundle and the Electron Helper
// binaries it knows about, but it does NOT recursively sign every
// nested Mach-O / .node / .dylib that ships under
// `Contents/Resources/app.asar.unpacked/` or under our `extraResources`
// (daemon, native bindings, etc). Per frag-11 §11.3 (line 297):
//
//   "The installer signature does not propagate inward... an unsigned
//    Mach-O inside a signed .app fails `codesign --verify --deep` and
//    Gatekeeper kills the app."
//
// This hook walks the .app bundle depth-first (deepest first — required
// because nested signatures must be sealed before their containers) and
// invokes `codesign` on every executable Mach-O / .node / .dylib /
// .framework it finds, then re-signs the outer .app.
//
// Env contract (placeholder-safe — never fails the build when unset):
//   CCSM_MAC_IDENTITY        codesign identity, e.g.
//                            "Developer ID Application: Acme (TEAMID)".
//                            Unset → log "[skip]" and return success.
//   CCSM_MAC_ENTITLEMENTS    path to .plist; default
//                            build/entitlements.mac.plist. Missing AND
//                            identity set → warn + skip. Missing AND
//                            identity unset → silent skip.
//   CCSM_MAC_HARDENED_RUNTIME '1' (default) to pass --options runtime.
//
// T54 (#1011) coexistence: this hook is platform-gated on
// `electronPlatformName === 'darwin'`. T54's sign-windows.cjs will be
// gated on 'win32'. Both can coexist as `afterSign` entries via a
// thin dispatcher when whichever lands second wires it.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MACHO_EXTS = new Set(['.node', '.dylib', '.so']);
const SKIP_DIR_NAMES = new Set(['_CodeSignature']);

function isMachOByName(name) {
  const ext = path.extname(name).toLowerCase();
  if (MACHO_EXTS.has(ext)) return true;
  // Bare-name binaries (no extension) inside MacOS/ dirs or shipped
  // helpers (e.g. `ccsm-daemon`) — caller decides via context.
  return false;
}

// Depth-first walk: yields files/dirs deepest first. Returns array of
// absolute paths to candidate sign targets, ordered for codesign.
function collectSignTargets(appBundlePath) {
  const targets = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Recurse into subdirs first (depth-first).
    for (const e of entries) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        walk(full);
        // .framework / .app nested bundles are themselves sign targets.
        if (e.name.endsWith('.framework') || e.name.endsWith('.app')) {
          targets.push(full);
        }
      }
    }
    // Then files at this level.
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(appBundlePath, full);
      const inMacOSDir = rel.split(path.sep).includes('MacOS');
      if (isMachOByName(e.name) || inMacOSDir) {
        targets.push(full);
      }
    }
  }
  walk(appBundlePath);
  // Outer .app last (must be sealed after all nested signatures).
  targets.push(appBundlePath);
  return targets;
}

function codesignOne({ identity, entitlements, hardenedRuntime, target, runner }) {
  const args = ['--force', '--sign', identity, '--timestamp'];
  if (hardenedRuntime) args.push('--options', 'runtime');
  if (entitlements) args.push('--entitlements', entitlements);
  args.push(target);
  const res = runner('codesign', args, { stdio: 'inherit' });
  if (res.status !== 0) {
    const err = res.error ? ` (${res.error.message})` : '';
    throw new Error(
      `[sign-macos] codesign failed (exit ${res.status})${err} for ${target}\n` +
        `  identity: ${identity}\n` +
        `  args: ${args.join(' ')}`,
    );
  }
}

async function signMacApp(context, opts = {}) {
  const log = opts.log || console.log;
  const env = opts.env || process.env;
  const runner = opts.runner || spawnSync;
  const fsApi = opts.fs || fs;
  const collect = opts.collect || collectSignTargets;

  if (context.electronPlatformName !== 'darwin') {
    return { skipped: true, reason: 'not-darwin' };
  }

  const identity = env.CCSM_MAC_IDENTITY;
  const entitlementsPath =
    env.CCSM_MAC_ENTITLEMENTS || path.join('build', 'entitlements.mac.plist');
  const hardenedRuntime = (env.CCSM_MAC_HARDENED_RUNTIME ?? '1') === '1';

  if (!identity) {
    log('[sign-macos] [skip] codesign: CCSM_MAC_IDENTITY not set');
    return { skipped: true, reason: 'no-identity' };
  }

  const entitlementsExists = fsApi.existsSync(entitlementsPath);
  if (!entitlementsExists) {
    log(
      `[sign-macos] [warn] entitlements not found at ${entitlementsPath}; ` +
        `skipping codesign (set CCSM_MAC_ENTITLEMENTS or create the file).`,
    );
    return { skipped: true, reason: 'no-entitlements' };
  }

  const { appOutDir } = context;
  const appBundle = fsApi
    .readdirSync(appOutDir)
    .find((n) => n.endsWith('.app'));
  if (!appBundle) {
    throw new Error(`[sign-macos] No .app bundle found in ${appOutDir}`);
  }
  const appBundlePath = path.join(appOutDir, appBundle);
  log(`[sign-macos] signing ${appBundlePath} with identity "${identity}"`);

  const targets = collect(appBundlePath);
  log(`[sign-macos] ${targets.length} sign target(s) (depth-first)`);

  for (const target of targets) {
    codesignOne({
      identity,
      entitlements: entitlementsPath,
      hardenedRuntime,
      target,
      runner,
    });
  }
  log(`[sign-macos] OK signed ${targets.length} target(s)`);
  return { skipped: false, signed: targets.length, targets };
}

exports.default = signMacApp;
exports.signMacApp = signMacApp;
exports.collectSignTargets = collectSignTargets;
exports.codesignOne = codesignOne;
