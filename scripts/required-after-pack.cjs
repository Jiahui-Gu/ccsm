// Task #1012 / spec frag-11 §11.2 (r7 P1-A lock).
//
// after-pack required-files validation. Enforces that every file the daemon
// needs at runtime actually landed in the produced bundle, in BOTH stages:
//   - extraResources stage: copied verbatim into <resources>/...
//   - asarUnpack stage: extracted from app.asar into <resources>/app.asar.unpacked/...
//
// Drift between this list and `before-pack.cjs` REQUIRED_NATIVES (T49 #1006)
// or the §11.6.4 uninstall helper or the §11.2.1 SDK staging is a build
// failure here — by design. A green smoke run with placeholder files (pre-T2
// build glue) is fine; a real release build with placeholders is not, and
// the size sanity check below catches placeholder marker files.
//
// Wired into electron-builder via `scripts/after-pack.cjs` (existing hook
// keeps the node-pty check; this module is invoked after).

const fs = require('node:fs');
const path = require('node:path');
const daemonGuard = require('./daemon-binary-guard.cjs');

// app-builder-lib's Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' };

// Spec frag-11 §11.2 REQUIRED_AFTER_PACK (r7 lock). Paths are relative to
// the platform's resources root (Win/Linux: <appOutDir>/resources/, macOS:
// <appOutDir>/<bundle>.app/Contents/Resources/). Anything missing => throw.
function requiredExtraResources(electronPlatformName) {
  const ext = electronPlatformName === 'win32' ? '.exe' : '';
  const list = [
    `daemon/ccsm-daemon${ext}`,
    'daemon/native/better_sqlite3.node',
    'daemon/native/pty.node',
    'daemon/native/ccsm_native.node',
    'daemon/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    'sdk/claude-agent-sdk/package.json',
  ];
  if (electronPlatformName === 'win32') {
    // §11.6.4 — Win-only NSIS uninstall pre-step helper.
    list.push('daemon/ccsm-uninstall-helper.exe');
  }
  return list;
}

// asarUnpack stage: every `**/*.node` glob target lives at
// <resources>/app.asar.unpacked/<original-path>. We assert the two natives
// the Electron-main process dlopens (node-pty, better-sqlite3) made it out
// of asar — a typo in `asarUnpack` would otherwise leave them inside the
// asar where dlopen cannot read them.
function requiredAsarUnpacked() {
  return [
    // node-pty native (rebuilt or prebuilt; existence of EITHER satisfies).
    {
      anyOf: [
        'node_modules/node-pty/build/Release/pty.node',
        // prebuild path; arch-specific so we glob via list at check time.
        'node_modules/node-pty/prebuilds',
      ],
    },
    // better-sqlite3 native.
    {
      anyOf: [
        'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
        'node_modules/better-sqlite3/prebuilds',
      ],
    },
    // SDK package.json — defense-in-depth per spec §11.2.1 step 2.
    { anyOf: ['node_modules/@anthropic-ai/claude-agent-sdk/package.json'] },
  ];
}

function resolveResourcesDir(appOutDir, electronPlatformName) {
  if (electronPlatformName === 'darwin') {
    const bundle = fs
      .readdirSync(appOutDir)
      .find((name) => name.endsWith('.app'));
    if (!bundle) {
      throw new Error(`[required-after-pack] No .app bundle in ${appOutDir}`);
    }
    return path.join(appOutDir, bundle, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

function checkExtraResources(resourcesDir, electronPlatformName) {
  const required = requiredExtraResources(electronPlatformName);
  const missing = [];
  for (const rel of required) {
    const abs = path.join(resourcesDir, rel);
    if (!fs.existsSync(abs)) {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[required-after-pack] extraResources stage missing ${missing.length} required file(s):\n` +
        missing.map((m) => `  - ${path.join(resourcesDir, m)}`).join('\n') +
        `\nHint: confirm before-pack.cjs staged the per-platform daemon binary, ` +
        `native folder, SDK closure, and (Win) uninstall helper, and that the ` +
        `package.json build.extraResources rules copy them into the listed paths.`,
    );
  }
  return required;
}

function checkAsarUnpacked(resourcesDir) {
  const unpackedRoot = path.join(resourcesDir, 'app.asar.unpacked');
  if (!fs.existsSync(unpackedRoot)) {
    // Pre-pack smoke or asar disabled entirely — nothing to validate. The
    // extraResources check above is the load-bearing one in that mode.
    return { skipped: true, reason: 'app.asar.unpacked absent' };
  }
  const required = requiredAsarUnpacked();
  const missing = [];
  for (const entry of required) {
    const found = entry.anyOf.some((rel) =>
      fs.existsSync(path.join(unpackedRoot, rel)),
    );
    if (!found) missing.push(entry.anyOf);
  }
  if (missing.length > 0) {
    throw new Error(
      `[required-after-pack] asarUnpack stage missing ${missing.length} required addon(s):\n` +
        missing
          .map(
            (paths) =>
              `  - none of: ${paths.map((p) => path.join(unpackedRoot, p)).join(', ')}`,
          )
          .join('\n') +
        `\nHint: check package.json build.asarUnpack globs include ` +
        `**/node_modules/better-sqlite3/**, **/node_modules/node-pty/**, ` +
        `node_modules/@anthropic-ai/claude-agent-sdk/**/*, and **/*.node.`,
    );
  }
  return { skipped: false, count: required.length };
}

async function validate(context) {
  const { appOutDir, electronPlatformName, arch } = context;
  const archName = ARCH_NAMES[arch] ?? String(arch);

  if (!['win32', 'darwin', 'linux'].includes(electronPlatformName)) {
    console.log(
      `[required-after-pack] unknown platform ${electronPlatformName}; skipping silently.`,
    );
    return;
  }

  const resourcesDir = resolveResourcesDir(appOutDir, electronPlatformName);
  const extra = checkExtraResources(resourcesDir, electronPlatformName);
  const asar = checkAsarUnpacked(resourcesDir);

  // Task #114 — daemon binary integrity guard. Existence was already
  // enforced by checkExtraResources above; here we additionally assert
  // the file is non-zero, plausibly large, and starts with the expected
  // platform magic. Catches placeholder fallbacks, truncated pkg writes,
  // and wrong-platform artifacts. Signature verification is OUT OF SCOPE
  // (PR #116 owns the signed-binary check).
  const ext = electronPlatformName === 'win32' ? '.exe' : '';
  const daemonBinPath = path.join(resourcesDir, `daemon/ccsm-daemon${ext}`);
  const daemonResult = daemonGuard.assertDaemonBinary(
    daemonBinPath,
    electronPlatformName,
  );

  console.log(
    `[required-after-pack] OK ${electronPlatformName}-${archName}: ` +
      `${extra.length} extraResources verified at ${resourcesDir}; ` +
      (asar.skipped
        ? `asarUnpack stage skipped (${asar.reason}); `
        : `${asar.count} asarUnpack addons verified; `) +
      `daemon binary OK (${(daemonResult.size / 1024 / 1024).toFixed(1)} MiB, ${daemonResult.magic}).`,
  );
}

exports.default = validate;
exports.validate = validate;
exports.requiredExtraResources = requiredExtraResources;
exports.requiredAsarUnpacked = requiredAsarUnpacked;
exports.resolveResourcesDir = resolveResourcesDir;
