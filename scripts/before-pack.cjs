// electron-builder beforePack hook (Task #1006 / spec frag-11 §11.2 + §11.2.1).
//
// Stages the per-platform daemon binary, native dlopen targets, and the
// claude-agent-sdk + daemon ESM-dep closure into fixed paths that the
// `build.extraResources` rules in package.json can copy verbatim.
//
// electron-builder does NOT expand a ${platform} token inside `from` paths
// (only ${os}, ${arch}, ${ext}, ${productName}, ${version}). So the hook
// MUST resolve the per-platform paths at pack time and stage everything
// into platform-agnostic destinations.
//
// Layout (post-hook, pre-pack):
//   daemon/dist/ccsm-daemon-staged${ext}      <- per-platform daemon binary
//   daemon/native-staged/                     <- per-platform native folder
//   daemon/sdk-staged/                        <- claude-agent-sdk + closure
//                                                (consumed by daemon-side
//                                                 node_modules row)
//   daemon/deps-staged/                       <- daemon's own ESM deps (pino,
//                                                ulid) merged into the same
//                                                node_modules tree as the SDK
//
// T49 ships the staging mechanics. T2 (build glue) provides the daemon
// binary + native folder; T57 adds the after-pack required-files
// validation. When T2 hasn't merged yet (or before `npm run build:daemon`
// has run locally), the binary/native sources won't exist — we emit a loud
// warning and fall back to empty placeholder files so electron-builder's
// extraResources copy still succeeds for smoke-test purposes.
// REMOVE THIS FALLBACK WHEN T2 LANDS — after-pack validation (T57) will
// then catch any missing artifact as a hard build failure.

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

// app-builder-lib's Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64, 4=universal.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

// REQUIRED_NATIVES — every `.node` the daemon dlopens. Drift between this
// list and the after-pack REQUIRED_AFTER_PACK list (T57) is a build bug.
const REQUIRED_NATIVES = ['better_sqlite3.node', 'pty.node', 'ccsm_native.node'];

// Daemon ESM deps — copied alongside the SDK so the pkg-bundled daemon's
// require.resolve walks find them under <resources>/daemon/node_modules/.
// Keep in sync with daemon/src/*.ts imports. T2 will replace this with a
// real per-package staging step once daemon has its own package.json.
const DAEMON_ESM_DEPS = ['pino', 'ulid'];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

function stagePlaceholder(dst, label) {
  // Emits a marker file so electron-builder's extraResources copy still
  // finds something at the expected path. The marker is text so the
  // installer is self-documenting if a user ever inspects it.
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(
    dst,
    `placeholder: ${label} not yet built (T2 build glue pending). ` +
      `This file ships only in pre-T2 smoke builds; T57 after-pack ` +
      `validation will fail the build once T2 lands.\n`,
  );
}

function stageDaemonBinary(electronPlatformName, archName) {
  const ext = electronPlatformName === 'win32' ? '.exe' : '';
  const map = {
    win32: `ccsm-daemon-win-${archName}.exe`,
    darwin: `ccsm-daemon-macos-${archName}`,
    linux: `ccsm-daemon-linux-${archName}`,
  };
  const srcName = map[electronPlatformName];
  if (!srcName) {
    throw new Error(`[before-pack] unsupported electronPlatformName: ${electronPlatformName}`);
  }

  const src = path.join(REPO_ROOT, 'daemon', 'dist', srcName);
  const dst = path.join(REPO_ROOT, 'daemon', 'dist', `ccsm-daemon-staged${ext}`);

  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`[before-pack] staged daemon binary: ${srcName} -> ccsm-daemon-staged${ext}`);
  } else {
    console.warn(
      `[before-pack] WARN daemon binary missing: ${src}. ` +
        `Falling back to placeholder (T2 build glue not yet merged).`,
    );
    stagePlaceholder(dst, `daemon binary for ${electronPlatformName}-${archName}`);
  }
}

function stageNatives(electronPlatformName, archName) {
  const folder = `${electronPlatformName}-${archName}`;
  const src = path.join(REPO_ROOT, 'daemon', 'native', folder);
  const dst = path.join(REPO_ROOT, 'daemon', 'native-staged');

  rmrf(dst);
  fs.mkdirSync(dst, { recursive: true });

  if (fs.existsSync(src)) {
    fs.cpSync(src, dst, { recursive: true });
    for (const f of REQUIRED_NATIVES) {
      const p = path.join(dst, f);
      if (!fs.existsSync(p)) {
        throw new Error(`[before-pack] required native missing after staging: ${p}`);
      }
    }
    console.log(`[before-pack] staged natives from ${folder} (${REQUIRED_NATIVES.length} required)`);
  } else {
    console.warn(
      `[before-pack] WARN native folder missing: ${src}. ` +
        `Falling back to placeholders (T2 build glue not yet merged).`,
    );
    for (const f of REQUIRED_NATIVES) {
      stagePlaceholder(path.join(dst, f), `native ${f} for ${folder}`);
    }
  }
}

function stageSdk() {
  // Daemon-side SDK staging: copies the SDK package tree into a fixed
  // dir consumed by the `daemon/sdk-staged -> daemon/node_modules/...` row.
  // The Electron-main residual shim consumes the unstaged hoisted root
  // copy directly via the second extraResources row.
  const sdkSrc = path.join(REPO_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  const sdkDst = path.join(REPO_ROOT, 'daemon', 'sdk-staged');

  rmrf(sdkDst);

  if (!fs.existsSync(sdkSrc)) {
    console.warn(
      `[before-pack] WARN SDK source missing: ${sdkSrc}. ` +
        `Falling back to placeholder package.json (run \`npm install\` to populate).`,
    );
    fs.mkdirSync(sdkDst, { recursive: true });
    fs.writeFileSync(
      path.join(sdkDst, 'package.json'),
      JSON.stringify(
        { name: '@anthropic-ai/claude-agent-sdk', version: '0.0.0-placeholder', main: 'index.js' },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(sdkDst, 'index.js'),
      '// placeholder; T2 will provision real SDK via npm install\n',
    );
  } else {
    copyDir(sdkSrc, sdkDst);
    console.log(`[before-pack] staged SDK: ${sdkSrc} -> ${sdkDst}`);
  }
}

function stageUninstallHelper(electronPlatformName) {
  // Spec frag-11 §11.6.4 — `ccsm-uninstall-helper.exe` is a Windows-only
  // NSIS uninstall pre-step. The helper is built ahead of time by
  // `npm run build:uninstall-helper` (pkg-bundles installer/uninstall-helper/
  // into `daemon/dist/ccsm-uninstall-helper.exe`).
  //
  // The Windows extraResources row in package.json points at this file
  // directly; this stage step exists only to (a) emit a placeholder when
  // the toolchain hasn't run yet (pre-T54 build worker), so the smoke
  // build doesn't fail, and (b) document the dependency in one place.
  if (electronPlatformName !== 'win32') return;

  const dst = path.join(REPO_ROOT, 'daemon', 'dist', 'ccsm-uninstall-helper.exe');
  if (fs.existsSync(dst)) {
    console.log('[before-pack] uninstall helper present (built by build:uninstall-helper)');
    return;
  }
  console.warn(
    `[before-pack] WARN uninstall helper missing: ${dst}. ` +
      `Run \`npm run build:uninstall-helper\` (requires @yao-pkg/pkg). ` +
      `Falling back to placeholder for smoke builds; T57 after-pack ` +
      `validation will fail the build once the helper is wired into CI.`,
  );
  stagePlaceholder(dst, 'ccsm-uninstall-helper.exe');
}

function stageDaemonDeps() {
  // Stages daemon's own ESM deps (pino, ulid, ...) into a fixed dir that
  // the `daemon/deps-staged -> daemon/node_modules` extraResources row
  // merges into the same node_modules tree as the SDK. Each package is
  // copied with its full transitive closure (electron-builder's `from`
  // copies the directory recursively as-is — so we stage each top-level
  // dep dir; nested deps under node_modules/<dep>/node_modules/ are
  // included by recursive copy).
  //
  // T2 will replace this with `npm --prefix daemon ci --omit=dev` once
  // daemon has its own package.json; for now we copy from the hoisted
  // root node_modules.
  const dst = path.join(REPO_ROOT, 'daemon', 'deps-staged');
  rmrf(dst);
  fs.mkdirSync(dst, { recursive: true });

  for (const dep of DAEMON_ESM_DEPS) {
    const src = path.join(REPO_ROOT, 'node_modules', dep);
    const out = path.join(dst, dep);
    if (!fs.existsSync(src)) {
      console.warn(
        `[before-pack] WARN daemon dep missing: ${src}. ` +
          `Skipping (run \`npm install\` to populate).`,
      );
      // Placeholder so the dst dir is non-empty and extraResources copy
      // doesn't end up with a missing target.
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(
        path.join(out, 'package.json'),
        JSON.stringify({ name: dep, version: '0.0.0-placeholder', main: 'index.js' }, null, 2),
      );
      fs.writeFileSync(path.join(out, 'index.js'), `// placeholder for ${dep}\n`);
      continue;
    }
    copyDir(src, out);
  }
  console.log(`[before-pack] staged daemon deps: ${DAEMON_ESM_DEPS.join(', ')}`);
}

// Phase 2 crash observability (spec §6, plan Task 7).
//
// Bake per-surface Sentry DSNs into a build-info module that:
//   * electron-main reads via require('../../dist/electron/build-info.js')
//     in electron/sentry/init.ts (the renderer side gets its DSN injected
//     via webpack.DefinePlugin which already ran by the time this hook
//     fires);
//   * the supervisor reads to forward CCSM_DAEMON_SENTRY_DSN to the daemon
//     child process at spawn time.
//
// Inputs are CCSM_SENTRY_DSN_{RENDERER,MAIN,DAEMON} env vars set by the
// release workflow from the `release`-environment secret. PR / fork builds
// run with the env unset → the file emits empty strings → init short-circuits
// in every surface (spec §6 OSS-fork leak prevention). Zero risk of leaking
// the maintainer DSN.
function stageBuildInfo() {
  const dir = path.join(REPO_ROOT, 'dist', 'electron');
  fs.mkdirSync(dir, { recursive: true });
  const info = {
    sentryDsnRenderer: process.env.CCSM_SENTRY_DSN_RENDERER ?? '',
    sentryDsnMain: process.env.CCSM_SENTRY_DSN_MAIN ?? '',
    sentryDsnDaemon: process.env.CCSM_SENTRY_DSN_DAEMON ?? '',
  };
  const out =
    `// AUTO-GENERATED by scripts/before-pack.cjs. Do not edit.\n` +
    `// Phase 2 crash observability (spec §6, plan Task 7).\n` +
    `module.exports = ${JSON.stringify(info, null, 2)};\n`;
  fs.writeFileSync(path.join(dir, 'build-info.js'), out, 'utf8');
  // Also expose as env vars so any downstream packaging step (e.g. native
  // installer scripts that also embed the daemon DSN) can read them
  // uniformly without re-reading the CCSM_* names.
  if (info.sentryDsnRenderer) process.env.SENTRY_DSN_RENDERER = info.sentryDsnRenderer;
  if (info.sentryDsnMain) process.env.SENTRY_DSN_MAIN = info.sentryDsnMain;
  if (info.sentryDsnDaemon) process.env.SENTRY_DSN_DAEMON = info.sentryDsnDaemon;
  const has = (s) => (s ? 'set' : 'empty');
  console.log(
    `[before-pack] wrote dist/electron/build-info.js ` +
      `(renderer:${has(info.sentryDsnRenderer)} main:${has(info.sentryDsnMain)} daemon:${has(info.sentryDsnDaemon)})`,
  );
}

exports.default = async function beforePack(context) {
  const { electronPlatformName, arch } = context;
  const archName = ARCH_NAMES[arch];

  if (archName === 'universal' || archName === 'armv7l') {
    throw new Error(
      `[before-pack] arch ${archName} not supported in v0.3 (build x64 + arm64 separately; pkg cannot merge fat Mach-O)`,
    );
  }
  if (!archName) {
    throw new Error(`[before-pack] unknown arch index ${arch}`);
  }

  console.log(`[before-pack] staging for ${electronPlatformName}-${archName}`);

  stageDaemonBinary(electronPlatformName, archName);
  stageNatives(electronPlatformName, archName);
  stageUninstallHelper(electronPlatformName);
  stageSdk();
  stageDaemonDeps();
  stageBuildInfo();

  console.log('[before-pack] staging complete');
};

// Exposed for unit tests + standalone invocation. Idempotent.
exports.stageBuildInfo = stageBuildInfo;
