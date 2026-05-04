#!/usr/bin/env node
/* global console, process */
// packages/proto/scripts/breaking-check.mjs
//
// Run `buf breaking` against the appropriate baseline ref:
//   * post-tag (a v0.3.* git tag exists in the local clone): the highest
//     v0.3.* tag in semver-ish lexical order — the "v0.3 release tag" in
//     ch11 §4 / ch15 §3 #1, #2, #19, #20.
//   * pre-tag: the merge-base SHA of HEAD and the PR's base ref. CI sets
//     `GITHUB_BASE_REF` (the PR target branch) and ensures the working
//     ref is fetched. Locally `git merge-base HEAD origin/working` is the
//     fallback.
//
// Override mechanism for CI / dev: set `BUF_BREAKING_AGAINST=<ref>` to
// pin the comparison target explicitly (used by the unit spec to exercise
// ref-selection branches without faking git state).
//
// The script execs `buf breaking packages/proto --against ".git#ref=<ref>,subdir=packages/proto"`
// from the repo root, mirroring the spec ch11 §6 invocation
// (`pnpm --filter @ccsm/proto run breaking`).
//
// Exit codes:
//   0  no breaking changes detected (or skipped — see below)
//   1  buf reported breaking changes OR the script could not pick a ref
//
// Skip condition:
//   If neither a v0.3.* tag exists in the local clone NOR a usable
//   merge-base ref can be resolved (e.g. shallow clone with no base ref
//   fetched and no override), the script exits 1 with a diagnostic
//   pointing at the missing setup. We do NOT silently skip — the spec
//   ch15 §3 says the gate is "active from phase 1 onward, not deferred
//   until ship", and a silent skip would defeat the gate exactly when
//   it's most needed.

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTO_ROOT = resolve(__dirname, '..');
// Repo root is two levels up from packages/proto/.
const REPO_ROOT = resolve(PROTO_ROOT, '..', '..');

/**
 * Run a git command and return trimmed stdout, or null if it failed.
 * We never throw — callers branch on null.
 */
export function git(args, cwd = REPO_ROOT) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Pick the highest v0.3.* tag reachable in the local clone, or null if
 * none. We sort by `git tag --sort=-v:refname` which understands semver
 * suffixes (e.g. v0.3.0-rc.1 < v0.3.0).
 */
export function pickV03Tag(gitFn = git) {
  const out = gitFn(['tag', '--list', 'v0.3.*', '--sort=-v:refname']);
  if (!out) return null;
  const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.length > 0 ? lines[0] : null;
}

/**
 * Pick the merge-base SHA between HEAD and the base ref. Tries:
 *   1. `origin/$GITHUB_BASE_REF` (set by GitHub Actions on PR runs)
 *   2. `origin/working` (project default)
 *   3. `origin/main` (fallback)
 * Returns the SHA, or null if no candidate yields a merge-base.
 */
export function pickMergeBase(env = process.env, gitFn = git) {
  const candidates = [];
  if (env.GITHUB_BASE_REF) candidates.push(`origin/${env.GITHUB_BASE_REF}`);
  candidates.push('origin/working', 'origin/main');
  for (const ref of candidates) {
    // Ensure the ref exists locally before asking for merge-base.
    const verify = gitFn(['rev-parse', '--verify', '--quiet', ref]);
    if (!verify) continue;
    const mb = gitFn(['merge-base', 'HEAD', ref]);
    if (mb) return mb;
  }
  return null;
}

/**
 * Resolve the ref to compare against. Honours BUF_BREAKING_AGAINST
 * override, then v0.3 tag (post-tag), then merge-base (pre-tag).
 * Returns { ref, source } or { ref: null, source: 'none' }.
 */
export function resolveAgainst(env = process.env, gitFn = git) {
  if (env.BUF_BREAKING_AGAINST) {
    return { ref: env.BUF_BREAKING_AGAINST, source: 'env' };
  }
  const tag = pickV03Tag(gitFn);
  if (tag) return { ref: tag, source: 'v0.3-tag' };
  const mb = pickMergeBase(env, gitFn);
  if (mb) return { ref: mb, source: 'merge-base' };
  return { ref: null, source: 'none' };
}

/**
 * Build the buf --against argument. Uses the .git#ref=...,subdir=...
 * format so buf reads the proto module out of the historical commit
 * tree without us having to checkout / clone.
 */
export function buildAgainstArg(ref) {
  // subdir is POSIX-style per buf docs; works on Windows too.
  return `.git#ref=${ref},subdir=packages/proto`;
}

function main() {
  const env = process.env;
  const { ref, source } = resolveAgainst(env);
  if (!ref) {
    console.error(
      'breaking-check: cannot pick a baseline ref.\n' +
        '  - no BUF_BREAKING_AGAINST override\n' +
        '  - no v0.3.* git tag in the local clone\n' +
        '  - no merge-base resolvable against origin/$GITHUB_BASE_REF / origin/working / origin/main\n' +
        'In CI, ensure actions/checkout uses fetch-depth: 0 and that the base branch is fetched.',
    );
    process.exit(1);
  }
  console.log(`breaking-check: comparing HEAD against ${ref} (source=${source})`);
  const against = buildAgainstArg(ref);
  // We invoke buf via `npx --no-install buf` so the script works under both
  // the project's pnpm layout (`packages/proto/node_modules/.bin/buf`) and
  // the CI's npm-workspaces layout (hoisted to root `node_modules/.bin/buf`).
  // npx walks node_modules upward, so either resolves. `--no-install`
  // refuses to fetch from the network — buf must already be a real
  // devDependency.
  //
  // We run from REPO_ROOT, not PROTO_ROOT, because the `.git#...,subdir=...`
  // input format requires the git directory to be discoverable from cwd.
  // The HEAD-side input is the explicit `packages/proto` directory.
  const result = spawnSync(
    'npx',
    ['--no-install', 'buf', 'breaking', 'packages/proto', '--against', against],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  if (result.error) {
    console.error(`breaking-check: failed to spawn buf: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// Only run main() when executed directly, not when imported by the test.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (invokedDirectly) {
  main();
}
