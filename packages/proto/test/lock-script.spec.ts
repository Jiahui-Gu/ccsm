// packages/proto/test/lock-script.spec.ts
//
// Integrity tests for scripts/lock.mjs and scripts/lock-check.mjs.
//
// Strategy: build a throw-away "mini proto package" in a temp directory that
// mirrors the real layout (`src/**/*.proto` + `lock.json` + `scripts/*.mjs`).
// We copy the real scripts in and exercise them via `node`. This avoids
// mocking node:fs and gives us the same end-to-end behaviour CI sees.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTO_ROOT = resolve(__dirname, '..');
const REAL_LOCK_SCRIPT = join(PROTO_ROOT, 'scripts', 'lock.mjs');
const REAL_LOCK_CHECK_SCRIPT = join(PROTO_ROOT, 'scripts', 'lock-check.mjs');

interface ScratchPkg {
  root: string;
  lockPath: string;
  protoA: string;
  protoB: string;
}

function makeScratchPkg(): ScratchPkg {
  const root = mkdtempSync(join(tmpdir(), 'ccsm-proto-lock-'));
  mkdirSync(join(root, 'src', 'ccsm', 'v1'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  // Two trivial proto fixtures — content is irrelevant; only the SHA matters.
  const protoA = join(root, 'src', 'ccsm', 'v1', 'a.proto');
  const protoB = join(root, 'src', 'ccsm', 'v1', 'b.proto');
  writeFileSync(protoA, 'syntax = "proto3";\npackage ccsm.v1;\nmessage A {}\n');
  writeFileSync(protoB, 'syntax = "proto3";\npackage ccsm.v1;\nmessage B {}\n');
  // Copy the real scripts so we exercise the production code path verbatim.
  cpSync(REAL_LOCK_SCRIPT, join(root, 'scripts', 'lock.mjs'));
  cpSync(REAL_LOCK_CHECK_SCRIPT, join(root, 'scripts', 'lock-check.mjs'));
  return {
    root,
    lockPath: join(root, 'lock.json'),
    protoA,
    protoB,
  };
}

function runNode(script: string, cwd: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [script], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
      code: typeof e.status === 'number' ? e.status : 1,
    };
  }
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('packages/proto lock scripts', () => {
  let pkg: ScratchPkg;

  beforeEach(() => {
    pkg = makeScratchPkg();
  });

  afterEach(() => {
    rmSync(pkg.root, { recursive: true, force: true });
  });

  it('lock.mjs writes a v1 lock.json sorted by POSIX path with correct SHA256s', () => {
    const r = runNode(join(pkg.root, 'scripts', 'lock.mjs'), pkg.root);
    expect(r.code, `lock.mjs failed: ${r.stderr}`).toBe(0);

    const lock = JSON.parse(readFileSync(pkg.lockPath, 'utf8'));
    expect(lock.version).toBe(1);

    const keys = Object.keys(lock.files);
    expect(keys).toEqual(['src/ccsm/v1/a.proto', 'src/ccsm/v1/b.proto']);
    // Confirm sort order survived (sorted ascending).
    expect([...keys].sort()).toEqual(keys);

    expect(lock.files['src/ccsm/v1/a.proto']).toBe(sha256(readFileSync(pkg.protoA)));
    expect(lock.files['src/ccsm/v1/b.proto']).toBe(sha256(readFileSync(pkg.protoB)));
  });

  it('lock-check.mjs exits 0 when lock.json matches the on-disk protos', () => {
    runNode(join(pkg.root, 'scripts', 'lock.mjs'), pkg.root);
    const r = runNode(join(pkg.root, 'scripts', 'lock-check.mjs'), pkg.root);
    expect(r.code, `lock-check should pass on a fresh lock; stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/lock-check: OK \(2 \.proto files match lock\.json\)/);
  });

  it('lock-check.mjs exits 1 with mismatch diff when a .proto SHA changes (tamper detection)', () => {
    runNode(join(pkg.root, 'scripts', 'lock.mjs'), pkg.root);
    // Tamper with one proto byte after lock generation.
    writeFileSync(pkg.protoA, 'syntax = "proto3";\npackage ccsm.v1;\nmessage A { string x = 1; }\n');

    const r = runNode(join(pkg.root, 'scripts', 'lock-check.mjs'), pkg.root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/lock-check: FAIL/);
    expect(r.stderr).toMatch(/mismatch: src\/ccsm\/v1\/a\.proto/);
    expect(r.stderr).toMatch(/expected [0-9a-f]{64}/);
    expect(r.stderr).toMatch(/actual\s+[0-9a-f]{64}/);
  });

  it('lock-check.mjs reports "missing in lock" when a new .proto appears without re-lock', () => {
    runNode(join(pkg.root, 'scripts', 'lock.mjs'), pkg.root);
    // Add a brand-new proto after lock — should be flagged as missing-in-lock.
    writeFileSync(
      join(pkg.root, 'src', 'ccsm', 'v1', 'c.proto'),
      'syntax = "proto3";\npackage ccsm.v1;\nmessage C {}\n'
    );

    const r = runNode(join(pkg.root, 'scripts', 'lock-check.mjs'), pkg.root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/missing in lock: src\/ccsm\/v1\/c\.proto/);
  });

  it('lock-check.mjs reports "extra in lock" when a recorded .proto is deleted from disk', () => {
    runNode(join(pkg.root, 'scripts', 'lock.mjs'), pkg.root);
    rmSync(pkg.protoB);

    const r = runNode(join(pkg.root, 'scripts', 'lock-check.mjs'), pkg.root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/extra in lock:\s+src\/ccsm\/v1\/b\.proto/);
  });

  it('lock-check.mjs rejects a malformed (non-v1) lock.json', () => {
    runNode(join(pkg.root, 'scripts', 'lock.mjs'), pkg.root);
    writeFileSync(pkg.lockPath, JSON.stringify({ version: 999, files: {} }));
    const r = runNode(join(pkg.root, 'scripts', 'lock-check.mjs'), pkg.root);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not a valid v1 lock/);
  });
});
