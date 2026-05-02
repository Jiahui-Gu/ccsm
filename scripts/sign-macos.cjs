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
//
// Task #116 (frag-11 §11.3, daemon binary signing): the standalone
// pkg-built daemon binary lands at `Contents/Resources/daemon/ccsm-daemon`
// (no extension, NOT under MacOS/). The legacy "MachO ext OR inside
// MacOS/" rule misses it entirely → the binary ships unsigned, fails
// notarize submission ("code object is not signed at all") AND fails
// `codesign --verify --deep --strict` on the outer .app. The collector
// now also treats any file whose first 4 bytes match a Mach-O magic
// number as a sign target — extension-agnostic, future-proof for any
// extra extensionless helper binaries we might add.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MACHO_EXTS = new Set(['.node', '.dylib', '.so']);
const SKIP_DIR_NAMES = new Set(['_CodeSignature']);

// Mach-O magic numbers (32-bit BE/LE, 64-bit BE/LE, fat BE/LE).
// Reference: <mach-o/loader.h> MH_MAGIC / MH_CIGAM / MH_MAGIC_64 /
// MH_CIGAM_64 and <mach-o/fat.h> FAT_MAGIC / FAT_CIGAM.
const MACHO_MAGICS = new Set([
  0xfeedface, // MH_MAGIC (32-bit BE)
  0xcefaedfe, // MH_CIGAM (32-bit LE)
  0xfeedfacf, // MH_MAGIC_64 (64-bit BE)
  0xcffaedfe, // MH_CIGAM_64 (64-bit LE)
  0xcafebabe, // FAT_MAGIC (universal, BE)
  0xbebafeca, // FAT_CIGAM (universal, LE)
]);

function isMachOByName(name) {
  const ext = path.extname(name).toLowerCase();
  if (MACHO_EXTS.has(ext)) return true;
  // Bare-name binaries (no extension) inside MacOS/ dirs or shipped
  // helpers (e.g. `ccsm-daemon`) — caller decides via context.
  return false;
}

// Reads the first 4 bytes of `filePath` and returns true iff the file is
// a Mach-O object (any of: 32-/64-bit thin, fat/universal, BE or LE).
// Returns false on any read error (unreadable / too short / etc.) — those
// files cannot be sign targets anyway. Used to catch extensionless
// executables under Contents/Resources/ that would otherwise be missed.
function isMachOByMagic(filePath, fsApi) {
  const fsImpl = fsApi || fs;
  let fd = -1;
  try {
    fd = fsImpl.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    const n = fsImpl.readSync(fd, buf, 0, 4, 0);
    if (n < 4) return false;
    const magic = buf.readUInt32BE(0);
    return MACHO_MAGICS.has(magic);
  } catch {
    return false;
  } finally {
    if (fd >= 0) {
      try { fsImpl.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// Depth-first walk: yields files/dirs deepest first. Returns array of
// absolute paths to candidate sign targets, ordered for codesign.
//
// Three inclusion rules (any match → sign):
//   1. Name-based: `.node` / `.dylib` / `.so` extension.
//   2. Location-based: any file under a `MacOS/` directory.
//   3. Magic-byte-based (Task #116): any plain file whose first 4 bytes
//      are a Mach-O magic number — catches the extensionless daemon
//      binary at Contents/Resources/daemon/ccsm-daemon and any future
//      extensionless helper without hardcoding a path.
function collectSignTargets(appBundlePath, opts = {}) {
  const fsApi = opts.fs || fs;
  const targets = [];
  function walk(dir) {
    let entries;
    try {
      entries = fsApi.readdirSync(dir, { withFileTypes: true });
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
        continue;
      }
      // Rule 3: extensionless / unconventionally-named Mach-O. Cheap
      // 4-byte read; only triggers for files we'd otherwise skip.
      if (isMachOByMagic(full, fsApi)) {
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

// Post-sign verification (Task #116). `codesign --verify --strict` on the
// daemon binary catches unsigned-binary regressions (e.g. someone disables
// the magic-byte rule); `--deep --strict` on the outer .app catches any
// nested unsigned Mach-O the collector missed. Both run with the same
// `runner` injection point so tests can stub them.
function codesignVerify({ target, deep, runner }) {
  const args = ['--verify', '--strict'];
  if (deep) args.push('--deep');
  args.push(target);
  const res = runner('codesign', args, { stdio: 'inherit' });
  if (res.status !== 0) {
    const err = res.error ? ` (${res.error.message})` : '';
    throw new Error(
      `[sign-macos] codesign --verify failed (exit ${res.status})${err} for ${target}\n` +
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

  const targets = collect(appBundlePath, { fs: fsApi });
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

  // Task #116 — post-sign verification. Two passes:
  //   (a) explicit --verify --strict on the standalone daemon binary if
  //       present (catches the regression this task fixes);
  //   (b) --verify --deep --strict on the outer .app (covers everything
  //       reachable via the bundle's seal graph, including nested
  //       frameworks / helper bundles).
  // Both fail-closed: any nonzero exit raises and fails the build.
  const daemonBinary = path.join(appBundlePath, 'Contents', 'Resources', 'daemon', 'ccsm-daemon');
  if (fsApi.existsSync(daemonBinary)) {
    log(`[sign-macos] verify (strict): ${daemonBinary}`);
    codesignVerify({ target: daemonBinary, deep: false, runner });
  } else {
    log(`[sign-macos] [info] daemon binary not found at ${daemonBinary}; skipping daemon verify`);
  }
  log(`[sign-macos] verify (deep --strict): ${appBundlePath}`);
  codesignVerify({ target: appBundlePath, deep: true, runner });

  return { skipped: false, signed: targets.length, targets };
}

exports.default = signMacApp;
exports.signMacApp = signMacApp;
exports.collectSignTargets = collectSignTargets;
exports.codesignOne = codesignOne;
exports.codesignVerify = codesignVerify;
exports.isMachOByMagic = isMachOByMagic;
exports.MACHO_MAGICS = MACHO_MAGICS;
