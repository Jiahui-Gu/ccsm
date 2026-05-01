// T22 — marker reader: corruption-treat-as-PRESENT.
// Spec ref: docs/superpowers/specs/v0.3-design.md §6.4 (Marker semantics
// "rel-S-R8"): "if the marker file exists but is unreadable / malformed
// JSON, treat as PRESENT".

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DAEMON_SHUTDOWN_MARKER_FILENAME,
  readMarker,
  type MarkerReadResult,
} from '../reader.js';

let dir: string;
let markerPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ccsm-marker-'));
  markerPath = join(dir, DAEMON_SHUTDOWN_MARKER_FILENAME);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('readMarker — decision table', () => {
  it('ENOENT (no file) -> absent', async () => {
    const result = await readMarker(markerPath);
    expect(result).toEqual<MarkerReadResult>({ kind: 'absent' });
  });

  it('empty file -> present (corruption: empty)', async () => {
    await fs.writeFile(markerPath, '');
    const result = await readMarker(markerPath);
    expect(result).toEqual<MarkerReadResult>({
      kind: 'present',
      reason: 'empty',
    });
  });

  it('whitespace-only file -> present (corruption: empty)', async () => {
    await fs.writeFile(markerPath, '   \n\t  ');
    const result = await readMarker(markerPath);
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.reason).toBe('empty');
      expect(result.payload).toBeUndefined();
    }
  });

  it('partial / unparseable JSON -> present (corruption: invalid-json)', async () => {
    // Realistic mid-write fragment — opening brace + half a key, no close.
    await fs.writeFile(markerPath, '{"reason":"upg');
    const result = await readMarker(markerPath);
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.reason).toBe('invalid-json');
      expect(result.payload).toBeUndefined();
    }
  });

  it('non-JSON garbage -> present (corruption: invalid-json)', async () => {
    await fs.writeFile(markerPath, 'not json at all');
    const result = await readMarker(markerPath);
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.reason).toBe('invalid-json');
    }
  });

  it('valid JSON missing required fields -> present (corruption: missing-fields)', async () => {
    await fs.writeFile(markerPath, JSON.stringify({ reason: 'upgrade' }));
    const result = await readMarker(markerPath);
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.reason).toBe('missing-fields');
      expect(result.payload).toBeUndefined();
    }
  });

  it('valid JSON with wrong types -> present (corruption: missing-fields)', async () => {
    await fs.writeFile(
      markerPath,
      JSON.stringify({ reason: 'upgrade', version: '0.3.0', ts: 'not-a-number' }),
    );
    const result = await readMarker(markerPath);
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.reason).toBe('missing-fields');
    }
  });

  it('valid JSON with all required fields -> present + payload (no corruption reason)', async () => {
    const payload = { reason: 'upgrade' as const, version: '0.3.0', ts: 1_700_000_000_000 };
    await fs.writeFile(markerPath, JSON.stringify(payload));
    const result = await readMarker(markerPath);
    expect(result).toEqual<MarkerReadResult>({
      kind: 'present',
      payload,
    });
  });

  it('valid JSON with extra fields -> present + payload (forward-compat)', async () => {
    const payload = {
      reason: 'upgrade' as const,
      version: '0.3.1',
      ts: 1_700_000_000_001,
      futureField: 'allowed',
    };
    await fs.writeFile(markerPath, JSON.stringify(payload));
    const result = await readMarker(markerPath);
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.reason).toBeUndefined();
      expect(result.payload).toBeDefined();
      expect(result.payload?.reason).toBe('upgrade');
      expect(result.payload?.version).toBe('0.3.1');
      expect(result.payload?.ts).toBe(1_700_000_000_001);
    }
  });

  it('JSON with leading BOM -> still parses cleanly', async () => {
    const payload = { reason: 'upgrade' as const, version: '0.3.0', ts: 1 };
    await fs.writeFile(markerPath, '﻿' + JSON.stringify(payload));
    const result = await readMarker(markerPath);
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.payload).toEqual(payload);
    }
  });

  it('I/O error (e.g. EACCES) -> present (corruption: io-error, fail-safe)', async () => {
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const spy = vi.spyOn(fs, 'readFile').mockRejectedValue(eacces);

    const result = await readMarker(markerPath);
    expect(spy).toHaveBeenCalledOnce();
    expect(result).toEqual<MarkerReadResult>({
      kind: 'present',
      reason: 'io-error',
    });
  });

  it('I/O error EISDIR -> present (corruption: io-error)', async () => {
    const eisdir = Object.assign(new Error('is a directory'), { code: 'EISDIR' });
    vi.spyOn(fs, 'readFile').mockRejectedValue(eisdir);

    const result = await readMarker(markerPath);
    expect(result.kind).toBe('present');
    if (result.kind === 'present') {
      expect(result.reason).toBe('io-error');
    }
  });

  it('never throws — even on bizarre non-Error rejections', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue('string rejection' as unknown as Error);
    await expect(readMarker(markerPath)).resolves.toEqual({
      kind: 'present',
      reason: 'io-error',
    });
  });
});

describe('readMarker — invariants', () => {
  it('only ENOENT yields absent', async () => {
    // Sanity sweep: run a sample of corruption flavours and verify NONE return absent.
    const samples = ['', '   ', 'garbage', '{"reason":"x"}', '﻿{}'];
    for (const s of samples) {
      await fs.writeFile(markerPath, s);
      const r = await readMarker(markerPath);
      expect(r.kind).toBe('present');
    }
  });
});
