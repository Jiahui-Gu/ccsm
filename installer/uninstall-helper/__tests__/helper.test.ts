// Smoke tests for ccsm-uninstall-helper (T53).
//
// We test the pure decider parts (arg parsing, pipe-path derivation, frame
// encode) directly. The graceful-shutdown round-trip against a real daemon
// is left to the e2e install/uninstall path (T1019).
//
// Reverse-verify: removing `--shutdown` from parseArgs falls back to help
// (covered) and the userhash slice MUST stay 8 hex chars (regression bait
// if anyone "improves" the SHA-256 truncation).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Buffer } from 'node:buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
const helper = requireCjs(resolve(__dirname, '..', 'index.js'));

describe('uninstall-helper / parseArgs', () => {
  it('defaults to no-op (help) when --shutdown is absent', () => {
    const a = helper.parseArgs([]);
    expect(a.shutdown).toBe(false);
    expect(a.timeoutMs).toBe(2000);
  });

  it('parses --shutdown --timeout 5000', () => {
    const a = helper.parseArgs(['--shutdown', '--timeout', '5000']);
    expect(a.shutdown).toBe(true);
    expect(a.timeoutMs).toBe(5000);
  });

  it('ignores invalid --timeout values, keeping default', () => {
    const a = helper.parseArgs(['--shutdown', '--timeout', 'banana']);
    expect(a.timeoutMs).toBe(2000);
  });

  it('recognises --help', () => {
    expect(helper.parseArgs(['--help']).help).toBe(true);
    expect(helper.parseArgs(['-h']).help).toBe(true);
  });
});

describe('uninstall-helper / controlPipePath', () => {
  it('returns a Windows-shaped \\\\.\\pipe\\ccsm-control-<8hex> path', () => {
    const p = helper.controlPipePath();
    expect(p).toMatch(/^\\\\\.\\pipe\\ccsm-control-[0-9a-f]{8}$/);
  });

  it('is deterministic for same user+host (called twice → equal)', () => {
    expect(helper.controlPipePath()).toBe(helper.controlPipePath());
  });
});

describe('uninstall-helper / encodeJsonFrame', () => {
  it('produces a valid v0.3 JSON frame matching daemon envelope layout', () => {
    const header = {
      id: 1,
      method: 'daemon.shutdownForUpgrade',
      payloadType: 'json',
      payloadLen: 0,
    };
    const frame = helper.encodeJsonFrame(header);
    // Prefix: 4 bytes; high nibble = 0x0 (v0.3), low 28 = payloadLen.
    const raw = frame.readUInt32BE(0);
    const nibble = (raw >>> 28) & 0x0f;
    const payloadLen = raw & 0x0fffffff;
    expect(nibble).toBe(0x0);
    // payloadLen = 2 (headerLen field) + headerJson bytes.
    const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
    expect(payloadLen).toBe(2 + headerJson.length);
    // headerLen field at offset 4, big-endian uint16.
    expect(frame.readUInt16BE(4)).toBe(headerJson.length);
    // Header JSON immediately follows.
    expect(frame.subarray(6, 6 + headerJson.length).toString('utf8')).toBe(
      JSON.stringify(header),
    );
    // Total frame length matches.
    expect(frame.length).toBe(4 + payloadLen);
  });
});
