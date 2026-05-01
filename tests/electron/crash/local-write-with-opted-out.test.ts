// tests/electron/crash/local-write-with-opted-out.test.ts
//
// Phase 4 hard-constraint regression: local crash logs MUST keep writing
// regardless of `crashUploadConsent` value. Only the network-upload path
// (Sentry init) is gated. This test belt-and-suspenders the contract by
// driving a recordIncident with consent forced to 'opted-out' and asserting
// the on-disk artifact is present.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Stub the consent module to opted-out so we prove the collector ignores it.
vi.mock('../../../electron/prefs/crashConsent', () => ({
  isCrashUploadAllowed: () => false,
  loadCrashConsent: () => 'opted-out',
}));

import { startCrashCollector } from '../../../electron/crash/collector';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-crash-local-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe('local crash log writer', () => {
  it('writes the incident dir + meta.json even when consent is opted-out', () => {
    const collector = startCrashCollector({
      crashRoot: path.join(tmpRoot, 'crashes'),
      dmpStaging: path.join(tmpRoot, 'crashes', '_dmp-staging'),
      appVersion: '0.3.0-test',
      electronVersion: '41.0.0',
    });
    const dir = collector.recordIncident({
      surface: 'main',
      error: { message: 'simulated crash', name: 'Error' },
    });
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'README.txt'))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(meta.surface).toBe('main');
    expect(meta.appVersion).toBe('0.3.0-test');
  });

  it('writes daemon-exit incidents with stderr/stdout tails when consent is opted-out', () => {
    const collector = startCrashCollector({
      crashRoot: path.join(tmpRoot, 'crashes'),
      dmpStaging: path.join(tmpRoot, 'crashes', '_dmp-staging'),
      appVersion: '0.3.0-test',
      electronVersion: '41.0.0',
    });
    const dir = collector.recordIncident({
      surface: 'daemon-exit',
      exitCode: 70,
      signal: null,
      stderrTail: ['boot ok', 'crash: SIGSEGV'],
      stdoutTail: ['hello world'],
      bootNonce: 'BN-1',
      lastTraceId: 'TR-1',
    });
    expect(fs.readFileSync(path.join(dir, 'stderr-tail.txt'), 'utf8'))
      .toContain('crash: SIGSEGV');
    expect(fs.readFileSync(path.join(dir, 'stdout-tail.txt'), 'utf8'))
      .toContain('hello world');
  });
});
