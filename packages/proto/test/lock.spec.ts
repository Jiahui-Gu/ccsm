// packages/proto/test/lock.spec.ts
//
// Forever-stable enforcement of the proto SHA256 lock contract
// (design spec ch12 §2 + ch15 §3 rules #1, #2, #19, #23).
//
// This spec asserts, from inside the unit suite, that:
//   1. Every `.proto` file under packages/proto/src/**/*.proto has a
//      corresponding entry in packages/proto/lock.json.
//   2. The on-disk SHA256 of each proto matches the value recorded in
//      lock.json.
//   3. lock.json contains no orphan entries (no recorded path missing
//      from disk).
//
// Differentiation from sibling specs and scripts:
//   - `test/lock-script.spec.ts` (PR #870, T0.6) tests the BEHAVIOUR of
//     `scripts/lock.mjs` and `scripts/lock-check.mjs` against a throw-away
//     scratch fixture mini-package. It does not look at the real protos.
//   - `scripts/lock-check.mjs` (PR #870, T0.6) is the standalone CLI that
//     CI invokes via `pnpm --filter @ccsm/proto run lock-check`.
//   - This spec (T10.2) is the IN-VITEST guard that runs whenever anyone
//     runs the proto unit suite locally or in CI; it fails loudly the
//     moment a real proto drifts from lock.json without going through
//     the regen workflow. Any of: hand-editing a .proto without
//     `pnpm --filter @ccsm/proto run lock`, adding a new .proto without
//     re-locking, or deleting a .proto without re-locking, is caught here.
//
// Hashing routine: identical to `scripts/lock.mjs` and
// `scripts/lock-check.mjs` — `createHash('sha256').update(readFileSync(p))`
// over raw on-disk bytes, no normalization (no line-ending fix-up, no
// comment stripping). Re-implemented inline (5 lines) rather than extracted
// to a shared module: the routine is trivially small and the script files
// are .mjs (no TS types), so any "shared" extraction would itself be a
// new abstraction layer to maintain. If the routine ever grows
// non-trivial logic (normalization, ordering, etc.), revisit and extract.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTO_ROOT = resolve(__dirname, '..');
const SRC_DIR = join(PROTO_ROOT, 'src');
const LOCK_PATH = join(PROTO_ROOT, 'lock.json');

interface LockFile {
  version: number;
  files: Record<string, string>;
}

function walkProtos(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walkProtos(abs));
    else if (st.isFile() && entry.endsWith('.proto')) out.push(abs);
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Verify a (rootDir, lockEntries) pair: returns the three categories of
 * drift the production check script also tracks. Empty arrays = clean.
 *
 * This is the same algorithm as `scripts/lock-check.mjs` reduced to a
 * pure function so we can exercise it against both the real repo and
 * synthetic fixtures.
 */
function verifyLock(
  rootDir: string,
  srcDir: string,
  lockEntries: Record<string, string>
): {
  mismatches: { rel: string; expected: string; actual: string }[];
  missingInLock: string[];
  extraInLock: string[];
} {
  const onDisk = new Map<string, string>();
  for (const abs of walkProtos(srcDir)) {
    onDisk.set(toPosix(relative(rootDir, abs)), sha256OfFile(abs));
  }
  const recorded = new Map(Object.entries(lockEntries));

  const mismatches: { rel: string; expected: string; actual: string }[] = [];
  const missingInLock: string[] = [];
  const extraInLock: string[] = [];

  for (const [rel, sha] of onDisk) {
    if (!recorded.has(rel)) missingInLock.push(rel);
    else if (recorded.get(rel) !== sha) {
      mismatches.push({ rel, expected: recorded.get(rel) as string, actual: sha });
    }
  }
  for (const rel of recorded.keys()) {
    if (!onDisk.has(rel)) extraInLock.push(rel);
  }
  return { mismatches, missingInLock, extraInLock };
}

function loadRealLock(): LockFile {
  const raw = readFileSync(LOCK_PATH, 'utf8');
  const parsed = JSON.parse(raw) as LockFile;
  return parsed;
}

describe('packages/proto lock.json — real protos vs real lock', () => {
  it('lock.json is a v1 lock with a non-empty files map', () => {
    const lock = loadRealLock();
    expect(lock.version).toBe(1);
    expect(lock.files).toBeTypeOf('object');
    expect(Object.keys(lock.files).length).toBeGreaterThan(0);
  });

  it('every .proto under src/** has an entry in lock.json AND the SHA matches', () => {
    const lock = loadRealLock();
    const result = verifyLock(PROTO_ROOT, SRC_DIR, lock.files);

    // Compose a single human-readable error if anything drifted, so the
    // CI failure message points straight at the offending file(s).
    const messages: string[] = [];
    for (const { rel, expected, actual } of result.mismatches) {
      messages.push(`mismatch: ${rel}\n    expected ${expected}\n    actual   ${actual}`);
    }
    for (const rel of result.missingInLock) {
      messages.push(`missing in lock: ${rel}`);
    }
    for (const rel of result.extraInLock) {
      messages.push(`extra in lock:   ${rel}`);
    }
    expect(
      messages,
      messages.length === 0
        ? ''
        : `lock.json drift detected — run \`pnpm --filter @ccsm/proto run lock\` after intentional changes:\n  ${messages.join('\n  ')}`
    ).toEqual([]);
  });

  it('lock.json contains no orphan entries (every recorded path exists on disk)', () => {
    const lock = loadRealLock();
    const result = verifyLock(PROTO_ROOT, SRC_DIR, lock.files);
    expect(result.extraInLock).toEqual([]);
  });

  it('lock.json files map is sorted ascending by POSIX path (deterministic output)', () => {
    const lock = loadRealLock();
    const keys = Object.keys(lock.files);
    expect([...keys].sort()).toEqual(keys);
  });
});

// --------------------------------------------------------------------------
// Negative-path coverage: synthetic fixtures exercise the same verify
// algorithm with deliberately broken (lock, disk) pairs to prove the
// check actually catches drift. These mirror the script-level tests in
// test/lock-script.spec.ts but stay inside the vitest process — no child
// `node` invocation, just the in-process verifyLock function.
// --------------------------------------------------------------------------

interface Scratch {
  root: string;
  src: string;
  protoA: string;
  protoB: string;
}

function makeScratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), 'ccsm-proto-lock-spec-'));
  const src = join(root, 'src', 'ccsm', 'v1');
  mkdirSync(src, { recursive: true });
  const protoA = join(src, 'a.proto');
  const protoB = join(src, 'b.proto');
  writeFileSync(protoA, 'syntax = "proto3";\npackage ccsm.v1;\nmessage A {}\n');
  writeFileSync(protoB, 'syntax = "proto3";\npackage ccsm.v1;\nmessage B {}\n');
  return { root, src, protoA, protoB };
}

function lockSnapshot(s: Scratch): Record<string, string> {
  return {
    'src/ccsm/v1/a.proto': sha256OfFile(s.protoA),
    'src/ccsm/v1/b.proto': sha256OfFile(s.protoB),
  };
}

describe('packages/proto lock.json — negative paths (synthetic fixtures)', () => {
  let s: Scratch;

  beforeEach(() => {
    s = makeScratch();
  });

  afterEach(() => {
    rmSync(s.root, { recursive: true, force: true });
  });

  it('happy path: matching lock + disk produces zero drift', () => {
    const result = verifyLock(s.root, join(s.root, 'src'), lockSnapshot(s));
    expect(result.mismatches).toEqual([]);
    expect(result.missingInLock).toEqual([]);
    expect(result.extraInLock).toEqual([]);
  });

  it('tamper detection: mutating a .proto on disk after locking surfaces a mismatch', () => {
    const recorded = lockSnapshot(s);
    // Mutate the file AFTER snapshotting the lock — simulates "edited a
    // proto without running `pnpm --filter @ccsm/proto run lock`".
    writeFileSync(s.protoA, 'syntax = "proto3";\npackage ccsm.v1;\nmessage A { string x = 1; }\n');

    const result = verifyLock(s.root, join(s.root, 'src'), recorded);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].rel).toBe('src/ccsm/v1/a.proto');
    expect(result.mismatches[0].expected).toMatch(/^[0-9a-f]{64}$/);
    expect(result.mismatches[0].actual).toMatch(/^[0-9a-f]{64}$/);
    expect(result.mismatches[0].expected).not.toBe(result.mismatches[0].actual);
    expect(result.missingInLock).toEqual([]);
    expect(result.extraInLock).toEqual([]);
  });

  it('missing-entry detection: lock.json variant lacking one proto flags missing-in-lock', () => {
    const recorded = lockSnapshot(s);
    // Drop b.proto from the lock — simulates "added a new .proto and
    // forgot to re-run lock".
    delete recorded['src/ccsm/v1/b.proto'];

    const result = verifyLock(s.root, join(s.root, 'src'), recorded);
    expect(result.missingInLock).toEqual(['src/ccsm/v1/b.proto']);
    expect(result.mismatches).toEqual([]);
    expect(result.extraInLock).toEqual([]);
  });

  it('extra-entry detection: lock.json with bogus extra path flags extra-in-lock', () => {
    const recorded: Record<string, string> = {
      ...lockSnapshot(s),
      'src/ccsm/v1/ghost.proto': 'a'.repeat(64),
    };

    const result = verifyLock(s.root, join(s.root, 'src'), recorded);
    expect(result.extraInLock).toEqual(['src/ccsm/v1/ghost.proto']);
    expect(result.mismatches).toEqual([]);
    expect(result.missingInLock).toEqual([]);
  });

  it('combined drift: tamper + missing + extra are all reported in one pass', () => {
    const recorded: Record<string, string> = {
      ...lockSnapshot(s),
      'src/ccsm/v1/ghost.proto': 'b'.repeat(64),
    };
    delete recorded['src/ccsm/v1/b.proto'];
    writeFileSync(s.protoA, 'syntax = "proto3";\npackage ccsm.v1;\nmessage A { string x = 1; }\n');

    const result = verifyLock(s.root, join(s.root, 'src'), recorded);
    expect(result.mismatches.map((m) => m.rel)).toEqual(['src/ccsm/v1/a.proto']);
    expect(result.missingInLock).toEqual(['src/ccsm/v1/b.proto']);
    expect(result.extraInLock).toEqual(['src/ccsm/v1/ghost.proto']);
  });
});
