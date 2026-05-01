// scripts/sentry-upload-symbols.cjs
//
// Phase 3 crash observability (spec §5.4 / §6, plan Task 10).
//
// electron-builder `afterAllArtifactBuild` hook + standalone CLI entrypoint.
// Uploads source maps + JS bundles + native debug-info files (dSYM on macOS,
// .pdb on Windows) to the three per-surface Sentry projects:
//
//   * SENTRY_PROJECT_RENDERER   <- dist/renderer/   (source maps + bundles)
//   * SENTRY_PROJECT_MAIN       <- dist/electron/   (source maps + bundles)
//                                  + native dSYM/.pdb from electron-builder
//                                    artifact dirs (Crashpad symbolication)
//   * SENTRY_PROJECT_DAEMON     <- daemon/dist/     (source maps + bundles)
//
// Skips silently when SENTRY_AUTH_TOKEN is unset (local dev / OSS forks).
// Idempotent + version-keyed: re-running on the same release is a no-op
// for already-uploaded artifacts (sentry-cli dedups by checksum).
//
// Invocations:
//   1. electron-builder hook — `module.exports = async (buildResult) => {...}`
//   2. release-CI step       — `node scripts/sentry-upload-symbols.cjs`
//
// Both paths share the same `runUpload(buildResult?)` core. The CLI entry is
// equivalent to invoking with `buildResult.artifactPaths = []` (no native dif
// upload — only the JS source-map paths). When CI runs this AFTER
// electron-builder, it can also pass artifact dirs via env vars
// `CCSM_ARTIFACT_DIRS=dir1:dir2:...` so native upload still happens.

const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..');

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[sentry-upload-symbols]', ...args);
}

function readPackageVersion() {
  return require(path.join(REPO_ROOT, 'package.json')).version;
}

/**
 * Run sentry-cli with the given args, scoped to a per-surface project.
 * `execImpl` is exposed for tests so they can intercept the spawn without
 * actually invoking sentry-cli.
 */
function runCli({ args, project, env, execImpl }) {
  const sentryCliPath = require.resolve('@sentry/cli/bin/sentry-cli');
  const fullEnv = { ...env, SENTRY_PROJECT: project };
  log('project=' + project, args.join(' '));
  execImpl(sentryCliPath, args, { stdio: 'inherit', env: fullEnv });
}

/**
 * Upload source maps + JS bundles for a single surface dir to its project.
 * No-op when the dir doesn't exist (e.g. daemon/dist absent in a renderer-only
 * build) — builds that don't produce a given surface should not fail.
 */
function uploadSourcemaps({ dir, release, project, env, execImpl }) {
  if (!project) {
    log('skip ' + dir + ': project name unset');
    return;
  }
  if (!fs.existsSync(dir)) {
    log('skip ' + dir + ': dir does not exist');
    return;
  }
  runCli({
    args: [
      'releases',
      'files',
      release,
      'upload-sourcemaps',
      dir,
      '--ext', 'map',
      '--ext', 'js',
    ],
    project,
    env,
    execImpl,
  });
}

/**
 * Upload native debug-info (dSYM / .pdb) for the main process from
 * electron-builder artifact directories.
 */
function uploadNativeDif({ artifactDirs, project, env, execImpl }) {
  if (!project) {
    log('skip native dif: SENTRY_PROJECT_MAIN unset');
    return;
  }
  for (const dir of artifactDirs) {
    if (!fs.existsSync(dir)) continue;
    runCli({
      args: ['debug-files', 'upload', '--include-sources', dir],
      project,
      env,
      execImpl,
    });
  }
}

/**
 * Core: routes the three per-surface uploads. `buildResult` is the
 * electron-builder hook payload (`{ artifactPaths: string[] }`); CLI mode
 * passes `undefined` and falls back to `CCSM_ARTIFACT_DIRS` env var.
 */
async function runUpload({ buildResult, env = process.env, execImpl } = {}) {
  const token = env.SENTRY_AUTH_TOKEN;
  if (!token) {
    log('SENTRY_AUTH_TOKEN absent, skipping all uploads');
    return { skipped: true, reason: 'no-token' };
  }

  // Resolve execImpl lazily so tests can pass a stub without us requiring
  // child_process at all (keeps the test mock surface tiny).
  const exec = execImpl ?? require('node:child_process').execFileSync;

  const org = env.SENTRY_ORG;
  if (!org) {
    log('SENTRY_ORG unset; refusing to upload to an unknown org');
    return { skipped: true, reason: 'no-org' };
  }
  const release = readPackageVersion();
  const baseEnv = {
    ...env,
    SENTRY_AUTH_TOKEN: token,
    SENTRY_ORG: org,
  };

  // 1. Renderer source maps + JS bundles → SENTRY_PROJECT_RENDERER.
  uploadSourcemaps({
    dir: path.join(REPO_ROOT, 'dist', 'renderer'),
    release,
    project: env.SENTRY_PROJECT_RENDERER,
    env: baseEnv,
    execImpl: exec,
  });

  // 2. Electron-main source maps + JS bundles → SENTRY_PROJECT_MAIN.
  uploadSourcemaps({
    dir: path.join(REPO_ROOT, 'dist', 'electron'),
    release,
    project: env.SENTRY_PROJECT_MAIN,
    env: baseEnv,
    execImpl: exec,
  });

  // 3. Daemon source maps + JS bundles → SENTRY_PROJECT_DAEMON.
  uploadSourcemaps({
    dir: path.join(REPO_ROOT, 'daemon', 'dist'),
    release,
    project: env.SENTRY_PROJECT_DAEMON,
    env: baseEnv,
    execImpl: exec,
  });

  // 4. Native debug-info (Crashpad symbolication) → SENTRY_PROJECT_MAIN.
  // electron-builder produces dSYM bundles (macOS) and .pdb files (Windows)
  // alongside the packaged binaries. We upload from the artifact directories
  // the hook hands us; CLI mode falls back to CCSM_ARTIFACT_DIRS (`:`-sep).
  const hookDirs = (buildResult?.artifactPaths ?? []).map((p) => path.dirname(p));
  const envDirs = (env.CCSM_ARTIFACT_DIRS ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  const artifactDirs = Array.from(new Set([...hookDirs, ...envDirs]));
  uploadNativeDif({
    artifactDirs,
    project: env.SENTRY_PROJECT_MAIN,
    env: baseEnv,
    execImpl: exec,
  });

  return { skipped: false, release, artifactDirs };
}

// electron-builder hook signature. Returns [] so electron-builder doesn't
// expect any new artifact paths.
module.exports = async function afterAllArtifactBuild(buildResult) {
  await runUpload({ buildResult });
  return [];
};

// CLI entrypoint — no-op when token absent, prints summary otherwise.
module.exports.runUpload = runUpload;

if (require.main === module) {
  runUpload().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[sentry-upload-symbols] upload failed:', err);
    process.exit(1);
  });
}
