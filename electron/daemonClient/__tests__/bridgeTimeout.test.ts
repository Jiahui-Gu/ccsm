// Tests for the bridge timeout primitives (Task #103).
//
// Covers:
//   - BridgeTimeoutError shape (code/method/timeoutMs/traceId).
//   - anyAbortSignal merge semantics on Node 20.3+ AND on the polyfill
//     path (we force-disable the native path with a stub).
//   - timeoutMap startCall / markFired / endCall / leakedSince.

import { describe, expect, it } from 'vitest';
import {
  BridgeTimeoutError,
  anyAbortSignal,
  createTimeoutMap,
  isBridgeTimeoutError,
} from '../bridgeTimeout';

describe('BridgeTimeoutError', () => {
  it('exposes code, method, timeoutMs, traceId', () => {
    const e = new BridgeTimeoutError({
      method: 'getBootNonce',
      timeoutMs: 5000,
      traceId: '01TESTTRACE',
    });
    expect(e.code).toBe('DEADLINE_EXCEEDED');
    expect(e.method).toBe('getBootNonce');
    expect(e.timeoutMs).toBe(5000);
    expect(e.traceId).toBe('01TESTTRACE');
    expect(e.name).toBe('BridgeTimeoutError');
    // The message MUST mention method + timeout for log triage.
    expect(e.message).toContain('getBootNonce');
    expect(e.message).toContain('5000ms');
  });

  it('omits traceId from message when absent', () => {
    const e = new BridgeTimeoutError({ method: 'm', timeoutMs: 100 });
    expect(e.traceId).toBeUndefined();
    expect(e.message).not.toContain('traceId=');
  });

  it('isBridgeTimeoutError narrows', () => {
    expect(isBridgeTimeoutError(new BridgeTimeoutError({ method: 'm', timeoutMs: 1 }))).toBe(true);
    expect(isBridgeTimeoutError(new Error('x'))).toBe(false);
    expect(isBridgeTimeoutError(null)).toBe(false);
  });
});

describe('anyAbortSignal', () => {
  it('returns a never-aborting signal for empty input', () => {
    const sig = anyAbortSignal([]);
    expect(sig.aborted).toBe(false);
  });

  it('returns the input verbatim for a single signal', () => {
    const c = new AbortController();
    expect(anyAbortSignal([c.signal])).toBe(c.signal);
  });

  it('aborts immediately if any input is already aborted', () => {
    const a = new AbortController();
    const b = new AbortController();
    a.abort(new Error('reason-A'));
    const merged = anyAbortSignal([a.signal, b.signal]);
    expect(merged.aborted).toBe(true);
    // reason should match the first already-aborted input in declared order
    expect((merged.reason as Error).message).toBe('reason-A');
  });

  it('aborts when the first input aborts later (polyfill path)', async () => {
    // Force the polyfill by hiding the native implementation.
    const original = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    try {
      const a = new AbortController();
      const b = new AbortController();
      const merged = anyAbortSignal([a.signal, b.signal]);
      expect(merged.aborted).toBe(false);
      const aborted = new Promise<void>((resolve) => {
        merged.addEventListener('abort', () => resolve(), { once: true });
      });
      b.abort(new Error('reason-B'));
      await aborted;
      expect(merged.aborted).toBe(true);
      expect((merged.reason as Error).message).toBe('reason-B');
    } finally {
      (AbortSignal as unknown as { any?: unknown }).any = original;
    }
  });

  it('uses native AbortSignal.any when available', () => {
    if (typeof (AbortSignal as unknown as { any?: unknown }).any !== 'function') {
      // Node version too old; skip.
      return;
    }
    const a = new AbortController();
    const merged = anyAbortSignal([a.signal, new AbortController().signal]);
    expect(merged.aborted).toBe(false);
    a.abort();
    expect(merged.aborted).toBe(true);
  });
});

describe('timeoutMap', () => {
  it('tracks size on start/end', () => {
    const m = createTimeoutMap();
    expect(m.size()).toBe(0);
    m.startCall({ callId: 'c1', method: 'A', timeoutMs: 100, now: 1000 });
    m.startCall({ callId: 'c2', method: 'B', timeoutMs: 200, now: 1000 });
    expect(m.size()).toBe(2);
    m.endCall('c1');
    expect(m.size()).toBe(1);
  });

  it('counts leaked calls past the threshold', () => {
    const m = createTimeoutMap();
    m.startCall({ callId: 'c1', method: 'A', timeoutMs: 100, now: 0 });
    m.startCall({ callId: 'c2', method: 'B', timeoutMs: 100, now: 0 });
    // Pre-fire: zero leaked.
    expect(m.leakedSince(30_000, 100_000)).toBe(0);
    m.markFired('c1', 100);
    m.markFired('c2', 100);
    // 30s after fire → both leaked.
    expect(m.leakedSince(30_000, 30_100)).toBe(2);
    // 29s after fire → not yet leaked.
    expect(m.leakedSince(30_000, 29_000)).toBe(0);
    // After endCall, no longer counted.
    m.endCall('c1');
    expect(m.leakedSince(30_000, 30_100)).toBe(1);
  });

  it('markFired is idempotent (firedAt latches to first call)', () => {
    const m = createTimeoutMap();
    m.startCall({ callId: 'c1', method: 'A', timeoutMs: 50, now: 0 });
    m.markFired('c1', 50);
    m.markFired('c1', 60); // ignored
    const e = m.entries()[0]!;
    expect(e.firedAt).toBe(50);
  });

  it('endCall on unknown callId is a no-op', () => {
    const m = createTimeoutMap();
    expect(() => m.endCall('does-not-exist')).not.toThrow();
  });
});
