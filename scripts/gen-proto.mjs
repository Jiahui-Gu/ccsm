#!/usr/bin/env node
// scripts/gen-proto.mjs — root-side proto codegen for `npm run build:app`.
//
// Why this exists:
//
//   The renderer bundle (compiled by webpack via `npm run build:app`)
//   imports `@ccsm/proto`, which is wildcard-re-exported from
//   `packages/proto/src/index.ts` over `gen/ts/**`. The `gen/ts/` tree is
//   gitignored — it is regenerated from the .proto sources via `buf
//   generate`. Local `pnpm install` users typically run `npm run gen`
//   (turbo → packages/proto:gen) before `build:app`; CI runs `npm ci` at
//   root which has no turbo `gen` hook, so the renderer bundle would try
//   to compile against an empty `gen/ts/`.
//
//   Adding `npm run gen` (turbo) directly into `build:app` does not work
//   under root `npm ci` because `turbo` resolves the gen task across all
//   packages and pulls in their build pipelines. We want JUST the proto
//   codegen step.
//
//   This script invokes `buf generate` against the proto package's
//   buf.gen.yaml using the `@bufbuild/buf` CLI installed at the root
//   `node_modules` (npm hoist) or `packages/proto/node_modules` (pnpm).
//   It cd's into `packages/proto` so all relative paths in buf.yaml /
//   buf.gen.yaml resolve against that workspace root.
//
//   Idempotent: if `gen/ts/` already exists and is non-empty, this script
//   is a fast no-op (~ 1 ms). The buf-generate path takes ~ 4 s.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const protoPkg = path.join(repoRoot, 'packages', 'proto');
const genDir = path.join(protoPkg, 'gen', 'ts');

// Fast path — already generated.
if (existsSync(genDir)) {
  try {
    const entries = readdirSync(genDir);
    if (entries.length > 0) {
      process.exit(0);
    }
  } catch {
    /* fall through to regen */
  }
}

// Locate `buf` CLI. npm hoists @bufbuild/buf to root node_modules; pnpm
// keeps it under packages/proto/node_modules. Try root first, fall back
// to the workspace.
const candidates = [
  path.join(repoRoot, 'node_modules', '@bufbuild', 'buf', 'bin', 'buf'),
  path.join(protoPkg, 'node_modules', '@bufbuild', 'buf', 'bin', 'buf'),
];
const bufBin = candidates.find((p) => existsSync(p));
if (!bufBin) {
  console.error(
    '[gen-proto] @bufbuild/buf not found in node_modules. Looked in:\n  ' +
      candidates.join('\n  ') +
      '\nRun `npm install` (or `pnpm install`) and retry.',
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [bufBin, 'generate'], {
  cwd: protoPkg,
  stdio: 'inherit',
});
process.exit(result.status ?? 0);
