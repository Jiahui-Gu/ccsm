#!/usr/bin/env node
/* global console */
// packages/proto/scripts/lock.mjs
//
// Regenerate packages/proto/lock.json from packages/proto/src/**/*.proto.
//
// Walks the src tree, computes SHA256 of each .proto file (raw bytes — no
// normalization, hash is over the exact on-disk content), and writes the
// result to lock.json sorted by relative POSIX path. Pair with lock-check.mjs
// (CI / pre-commit) to detect unintended schema drift.
//
// Usage: pnpm --filter @ccsm/proto run lock

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTO_ROOT = resolve(__dirname, '..');
const SRC_DIR = join(PROTO_ROOT, 'src');
const LOCK_PATH = join(PROTO_ROOT, 'lock.json');

function walkProtos(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walkProtos(abs));
    else if (st.isFile() && entry.endsWith('.proto')) out.push(abs);
  }
  return out;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main() {
  const files = walkProtos(SRC_DIR);
  const entries = {};
  for (const abs of files) {
    const rel = toPosix(relative(PROTO_ROOT, abs));
    entries[rel] = sha256OfFile(abs);
  }
  // Sort keys for deterministic output.
  const sorted = Object.fromEntries(
    Object.keys(entries)
      .sort()
      .map((k) => [k, entries[k]])
  );
  const lock = { version: 1, files: sorted };
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  console.log(`wrote ${LOCK_PATH} (${Object.keys(sorted).length} files)`);
}

main();
