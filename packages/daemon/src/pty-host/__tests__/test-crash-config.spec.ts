// Unit tests for the test-only crash branch parser/counter (T4.5 / Task #40).
//
// Spec ref: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// ch06 §1 "Test-only crash branch (FOREVER-STABLE)".

import { describe, expect, it } from 'vitest';

import {
  TEST_CRASH_EXIT_CODE,
  TestCrashByteCounter,
  estimateIpcPayloadBytes,
  parseTestCrashEnv,
} from '../test-crash-config.js';

describe('parseTestCrashEnv — production gate', () => {
  it('returns null when NODE_ENV is exactly "production" even with env set', () => {
    expect(parseTestCrashEnv('boot', 'production')).toBeNull();
    expect(parseTestCrashEnv('spawn', 'production')).toBeNull();
    expect(parseTestCrashEnv('after-bytes:1024', 'production')).toBeNull();
  });

  it('activates for any non-"production" NODE_ENV (test, dev, undefined, "")', () => {
    expect(parseTestCrashEnv('boot', 'test')).toEqual({ kind: 'boot' });
    expect(parseTestCrashEnv('boot', 'development')).toEqual({ kind: 'boot' });
    expect(parseTestCrashEnv('boot', undefined)).toEqual({ kind: 'boot' });
    expect(parseTestCrashEnv('boot', '')).toEqual({ kind: 'boot' });
  });
});

describe('parseTestCrashEnv — env presence gate', () => {
  it('returns null for undefined env regardless of NODE_ENV', () => {
    expect(parseTestCrashEnv(undefined, 'test')).toBeNull();
    expect(parseTestCrashEnv(undefined, undefined)).toBeNull();
  });

  it('treats empty string as unset (likely shell misconfig, not a request)', () => {
    expect(parseTestCrashEnv('', 'test')).toBeNull();
  });
});

describe('parseTestCrashEnv — variant matching', () => {
  it('parses "boot"', () => {
    expect(parseTestCrashEnv('boot', 'test')).toEqual({ kind: 'boot' });
  });

  it('parses "spawn"', () => {
    expect(parseTestCrashEnv('spawn', 'test')).toEqual({ kind: 'spawn' });
  });

  it('parses "after-bytes:N" with positive integer N', () => {
    expect(parseTestCrashEnv('after-bytes:1024', 'test')).toEqual({
      kind: 'after-bytes',
      threshold: 1024,
    });
    expect(parseTestCrashEnv('after-bytes:1', 'test')).toEqual({
      kind: 'after-bytes',
      threshold: 1,
    });
  });

  it('rejects malformed after-bytes (zero, negative, leading zero, non-digit, empty tail)', () => {
    expect(parseTestCrashEnv('after-bytes:0', 'test')).toBeNull();
    expect(parseTestCrashEnv('after-bytes:-5', 'test')).toBeNull();
    expect(parseTestCrashEnv('after-bytes:0010', 'test')).toBeNull();
    expect(parseTestCrashEnv('after-bytes:abc', 'test')).toBeNull();
    expect(parseTestCrashEnv('after-bytes:', 'test')).toBeNull();
    expect(parseTestCrashEnv('after-bytes:1.5', 'test')).toBeNull();
  });

  it('returns null for unknown variants (silent — test surfaces as missing crash)', () => {
    expect(parseTestCrashEnv('unknown-variant', 'test')).toBeNull();
    expect(parseTestCrashEnv('crash', 'test')).toBeNull();
    expect(parseTestCrashEnv('after-deltas:5', 'test')).toBeNull();
  });
});

describe('TEST_CRASH_EXIT_CODE — spec-locked constant', () => {
  it('is 137 (spec ch06 §4 — conventional SIGKILL exit code)', () => {
    expect(TEST_CRASH_EXIT_CODE).toBe(137);
  });
});

describe('TestCrashByteCounter', () => {
  it('does not trigger before threshold is reached', () => {
    const c = new TestCrashByteCounter();
    expect(c.addAndShouldCrash(100, 1024)).toBe(false);
    expect(c.addAndShouldCrash(500, 1024)).toBe(false);
    expect(c.cumulative).toBe(600);
  });

  it('triggers when cumulative reaches threshold exactly (>=, not >)', () => {
    const c = new TestCrashByteCounter();
    expect(c.addAndShouldCrash(1024, 1024)).toBe(true);
    expect(c.cumulative).toBe(1024);
  });

  it('triggers on the call that pushes total over threshold', () => {
    const c = new TestCrashByteCounter();
    expect(c.addAndShouldCrash(500, 1024)).toBe(false);
    expect(c.addAndShouldCrash(600, 1024)).toBe(true);
    expect(c.cumulative).toBe(1100);
  });

  it('ignores negative or non-finite increments without crashing', () => {
    const c = new TestCrashByteCounter();
    expect(c.addAndShouldCrash(-50, 100)).toBe(false);
    expect(c.addAndShouldCrash(Number.NaN, 100)).toBe(false);
    expect(c.addAndShouldCrash(Number.POSITIVE_INFINITY, 100)).toBe(false);
    expect(c.cumulative).toBe(0);
  });
});

describe('estimateIpcPayloadBytes', () => {
  it('returns 0 for null/undefined', () => {
    expect(estimateIpcPayloadBytes(null)).toBe(0);
    expect(estimateIpcPayloadBytes(undefined)).toBe(0);
  });

  it('returns byteLength for a raw Uint8Array', () => {
    expect(estimateIpcPayloadBytes(new Uint8Array(2048))).toBe(2048);
  });

  it('extracts byteLength from { bytes: Uint8Array } shape', () => {
    expect(
      estimateIpcPayloadBytes({ kind: 'delta', bytes: new Uint8Array(512) }),
    ).toBe(512);
  });

  it('falls back to JSON length for non-binary messages', () => {
    const msg = { kind: 'ready', sessionId: 'abc', pid: 12345 };
    expect(estimateIpcPayloadBytes(msg)).toBe(JSON.stringify(msg).length);
  });
});
