#!/usr/bin/env node
/* global console, process */
// scripts/sync-version.mjs
//
// Propagates the root `package.json` `version` to every workspace package's
// `package.json` (`packages/{daemon,electron,proto}/package.json`).
//
// Why this exists alongside Changesets:
// - Changesets manages CHANGELOG generation + per-package version bumps when
//   you have public packages. v0.3 ships ALL workspace packages as `private:
//   true` (see spec ch11 §7), so we don't actually publish to npm. The
//   product version that matters is the Electron app version (root
//   package.json) which feeds installer metadata + auto-update.
// - To keep `@ccsm/{proto,daemon,electron}` package.json `version` fields in
//   lockstep with the root (so internal logging / sentry tags / `--version`
//   strings agree), this script copies root.version into each package.
// - Run after `pnpm changeset version` (or any manual root version bump):
//     pnpm version-packages    # alias for `pnpm changeset version && node scripts/sync-version.mjs`
//
// PROTO_VERSION (the wire-protocol minor) is independent of the npm version
// and lives in `packages/proto/src/version.ts`. Drift is checked by
// `pnpm --filter @ccsm/proto run version-drift-check`.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const PACKAGES = ['packages/proto', 'packages/daemon', 'packages/electron'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, obj) {
  // Preserve trailing newline (matches existing files written by pnpm /
  // editors). 2-space indent matches the repo convention.
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function main() {
  const rootPkgPath = join(REPO_ROOT, 'package.json');
  const rootVersion = readJson(rootPkgPath).version;
  if (typeof rootVersion !== 'string' || !rootVersion) {
    console.error(`sync-version: root package.json has no \`version\` field`);
    process.exit(1);
  }
  let changed = 0;
  for (const rel of PACKAGES) {
    const pkgPath = join(REPO_ROOT, rel, 'package.json');
    const pkg = readJson(pkgPath);
    if (pkg.version === rootVersion) {
      console.log(`sync-version: ${pkg.name} already at ${rootVersion}`);
      continue;
    }
    console.log(`sync-version: ${pkg.name} ${pkg.version} -> ${rootVersion}`);
    pkg.version = rootVersion;
    writeJson(pkgPath, pkg);
    changed += 1;
  }
  console.log(`sync-version: ${changed} package(s) updated.`);
}

main();
