#!/usr/bin/env node
/* global console, process */
// packages/proto/scripts/lock-check.mjs
//
// Verify packages/proto/lock.json matches the on-disk SHA256 of every
// packages/proto/src/**/*.proto. Exits 0 on match, 1 on any drift, with a
// human-readable diff covering three categories:
//   - mismatch    (file exists on disk and in lock.json, hashes differ)
//   - missing in lock  (.proto on disk, no entry in lock.json)
//   - extra in lock    (entry in lock.json, .proto missing on disk)
//
// Pair with scripts/lock.mjs (`pnpm --filter @ccsm/proto run lock`) to
// regenerate after intentional schema changes.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  let lock;
  try {
    lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  } catch (err) {
    console.error(`lock-check: failed to read ${LOCK_PATH}: ${err.message}`);
    process.exit(1);
  }
  if (!lock || typeof lock !== 'object' || lock.version !== 1 || !lock.files) {
    console.error(`lock-check: ${LOCK_PATH} is not a valid v1 lock (expected { version: 1, files: {...} })`);
    process.exit(1);
  }

  const onDisk = new Map();
  for (const abs of walkProtos(SRC_DIR)) {
    const rel = toPosix(relative(PROTO_ROOT, abs));
    onDisk.set(rel, sha256OfFile(abs));
  }
  const recorded = new Map(Object.entries(lock.files));

  const mismatches = [];
  const missingInLock = [];
  const extraInLock = [];

  for (const [rel, sha] of onDisk) {
    if (!recorded.has(rel)) missingInLock.push(rel);
    else if (recorded.get(rel) !== sha) mismatches.push({ rel, expected: recorded.get(rel), actual: sha });
  }
  for (const rel of recorded.keys()) {
    if (!onDisk.has(rel)) extraInLock.push(rel);
  }

  if (mismatches.length === 0 && missingInLock.length === 0 && extraInLock.length === 0) {
    console.log(`lock-check: OK (${onDisk.size} .proto files match lock.json)`);
    process.exit(0);
  }

  console.error('lock-check: FAIL — packages/proto/lock.json drift detected');
  for (const { rel, expected, actual } of mismatches) {
    console.error(`  mismatch: ${rel}\n    expected ${expected}\n    actual   ${actual}`);
  }
  for (const rel of missingInLock) {
    console.error(`  missing in lock: ${rel}`);
  }
  for (const rel of extraInLock) {
    console.error(`  extra in lock:   ${rel}`);
  }
  console.error('\nRun `pnpm --filter @ccsm/proto run lock` to regenerate after intentional changes.');
  process.exit(1);
}

main();
