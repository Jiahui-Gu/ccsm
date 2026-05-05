#!/usr/bin/env node
// packages/daemon/build/bundle-for-sea-spec.mjs — pretest helper.
//
// `test/integration/daemon-sea-boot.spec.ts` (Task #463) inspects
// `dist/bundle.cjs` to assert the SEA-bound CJS bundle does not contain
// any boot-path `fileURLToPath(import.meta.url)` calls. This script
// regenerates that bundle from the current `src/` tree before vitest
// starts, so individual specs do not race each other rebuilding it
// in-process (which deadlocks `pnpm exec tsc` under parallel workers
// because the workers share the same `dist/` and the same `pnpm` lock).
//
// Steps:
//   1. tsc compile (idempotent — fast no-op if dist/ is up to date)
//   2. esbuild bundle dist/index.js -> dist/bundle.cjs
//
// Both steps mirror exactly what `build/build-sea.{sh,ps1}` do at the
// SEA-build stage. Keeping them here means the test asserts the same
// artifact CI / release ships, not a parallel construction.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(PKG_DIR, '..', '..');
const DIST_DIR = join(PKG_DIR, 'dist');
const INDEX_JS = join(DIST_DIR, 'index.js');
const BUNDLE = join(DIST_DIR, 'bundle.cjs');

function resolveEsbuildBin() {
  const pnpmDir = join(REPO_ROOT, 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    const candidates = readdirSync(pnpmDir).filter((d) => d.startsWith('esbuild@'));
    for (const c of candidates) {
      const bin = join(pnpmDir, c, 'node_modules', 'esbuild', 'bin', 'esbuild');
      if (existsSync(bin)) return bin;
    }
  }
  const flat = join(REPO_ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');
  if (existsSync(flat)) return flat;
  throw new Error('could not resolve esbuild binary in workspace node_modules');
}

function maxMtime(paths) {
  let max = 0;
  for (const p of paths) {
    if (existsSync(p)) {
      const m = statSync(p).mtimeMs;
      if (m > max) max = m;
    }
  }
  return max;
}

function tscCompileIfStale() {
  const srcRunner = join(PKG_DIR, 'src', 'db', 'migrations', 'runner.ts');
  const srcIndex = join(PKG_DIR, 'src', 'index.ts');
  const inlined = join(PKG_DIR, 'src', 'db', 'migrations', 'inlined.ts');
  const distFresh =
    existsSync(INDEX_JS) && statSync(INDEX_JS).mtimeMs > maxMtime([srcRunner, srcIndex, inlined]);
  if (distFresh) {
    console.log('[bundle-for-sea-spec] dist/index.js up-to-date');
    return;
  }
  console.log('[bundle-for-sea-spec] tsc compile');
  // Use a TS-only path: spawn `node <tsc.js>` directly — `pnpm exec tsc` is
  // unsafe under vitest worker parallelism (file lock contention on the
  // pnpm cache). We resolve typescript from the workspace.
  const tscBin = resolveTscBin();
  const r = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], {
    cwd: PKG_DIR,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error(`tsc exited ${r.status}`);
  }
}

function resolveTscBin() {
  const pnpmDir = join(REPO_ROOT, 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    const candidates = readdirSync(pnpmDir).filter((d) => d.startsWith('typescript@'));
    for (const c of candidates) {
      const bin = join(pnpmDir, c, 'node_modules', 'typescript', 'bin', 'tsc');
      if (existsSync(bin)) return bin;
    }
  }
  const flat = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (existsSync(flat)) return flat;
  throw new Error('could not resolve tsc in workspace node_modules');
}

function bundleIfStale() {
  const bundleFresh =
    existsSync(BUNDLE) && existsSync(INDEX_JS) && statSync(BUNDLE).mtimeMs >= statSync(INDEX_JS).mtimeMs;
  if (bundleFresh) {
    console.log('[bundle-for-sea-spec] dist/bundle.cjs up-to-date');
    return;
  }
  console.log('[bundle-for-sea-spec] esbuild bundle');
  const esbuild = resolveEsbuildBin();
  const r = spawnSync(
    process.execPath,
    [
      esbuild,
      'dist/index.js',
      '--bundle',
      '--platform=node',
      '--target=node22',
      '--format=cjs',
      '--outfile=dist/bundle.cjs',
      '--external:better-sqlite3',
      '--external:node-pty',
      '--external:*.node',
    ],
    { cwd: PKG_DIR, stdio: 'inherit' },
  );
  if (r.status !== 0) {
    throw new Error(`esbuild exited ${r.status}`);
  }
}

tscCompileIfStale();
bundleIfStale();
