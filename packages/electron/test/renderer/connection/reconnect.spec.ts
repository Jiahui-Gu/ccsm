// T6.7 — Reconnect schedule UT.
//
// Spec ref: chapter 08 §6 (renderer error contract). The boot-side schedule
// locked by the T6.7 brief: 100 → 200 → 400 → 800 → 1600 → 3200ms cap 5000.
//
// Why pure UT (not e2e): the schedule is a pure decider with no React /
// Connect surface. Vitest fake timers prove the driver actually waits the
// right amount; an e2e would test nothing this UT cannot already prove.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  RECONNECT_SCHEDULE_MS,
  RECONNECT_CAP_MS,
  nextDelayMs,
  runWithReconnect,
} from '../../../src/renderer/connection/reconnect.js';

describe('nextDelayMs (pure decider)', () => {
  it('matches the locked schedule 100/200/400/800/1600/3200/5000', () => {
    expect(RECONNECT_SCHEDULE_MS).toEqual([100, 200, 400, 800, 1600, 3200, 5000]);
    expect(RECONNECT_CAP_MS).toBe(5000);
    for (let i = 0; i < RECONNECT_SCHEDULE_MS.length; i += 1) {
      expect(nextDelayMs(i)).toBe(RECONNECT_SCHEDULE_MS[i]);
    }
  });

  it('caps anything past the schedule at 5000ms', () => {
    expect(nextDelayMs(7)).toBe(5000);
    expect(nextDelayMs(99)).toBe(5000);
    expect(nextDelayMs(1_000_000)).toBe(5000);
  });

  it('treats negative attempts as the first delay', () => {
    expect(nextDelayMs(-1)).toBe(100);
    expect(nextDelayMs(-100)).toBe(100);
  });
});

describe('runWithReconnect (driver)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately on first-attempt success', async () => {
    const attempt = vi.fn(async () => 'ok');
    const promise = runWithReconnect<string>({ attempt });
    await expect(promise).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith(0);
  });

  it('emits the locked schedule on consecutive failures', async () => {
    const seen: number[] = [];
    let calls = 0;
    const attempt = vi.fn(async (idx: number) => {
      calls += 1;
      if (calls < 5) throw new Error('flaky');
      return idx;
    });
    // Inject a fake sleep that records the delay and resolves synchronously
    // — this avoids vitest fake-timer / await-microtask interleaving.
    const sleep = vi.fn(async (ms: number) => {
      seen.push(ms);
    });

    const result = await runWithReconnect<number>({ attempt, sleep });
    expect(result).toBe(4);
    // 4 failures → 4 backoffs at indices 0,1,2,3 → delays 100/200/400/800.
    expect(seen).toEqual([100, 200, 400, 800]);
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it('caps schedule at 5000ms once past the table', async () => {
    const seen: number[] = [];
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls < 10) throw new Error('flaky');
      return 'ok';
    });
    const sleep = vi.fn(async (ms: number) => {
      seen.push(ms);
    });

    await runWithReconnect<string>({ attempt, sleep });
    // Indices 0..8 map to the schedule; once exhausted (idx>=7), cap kicks in.
    expect(seen).toEqual([100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000]);
  });

  it('does NOT retry when shouldRetry returns false (version mismatch path)',
    async () => {
      const fatal = new Error('FAILED_PRECONDITION');
      const attempt = vi.fn(async () => { throw fatal; });
      const sleep = vi.fn();
      await expect(
        runWithReconnect({ attempt, sleep, shouldRetry: () => false }),
      ).rejects.toBe(fatal);
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

  it('honors AbortSignal — aborts during sleep', async () => {
    const ctl = new AbortController();
    const attempt = vi.fn(async () => {
      throw new Error('try-again');
    });
    const sleep = vi.fn(async () => {
      // Abort while "sleeping" so the next loop iteration trips the
      // signal.aborted check.
      ctl.abort();
    });
    const promise = runWithReconnect({ attempt, sleep, signal: ctl.signal });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    // First attempt ran; sleep ran once; next iteration tripped aborted.
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('fires onBackoff with delay + attempt index', async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('flaky');
      return null;
    });
    const sleep = vi.fn();
    const onBackoff = vi.fn();
    await runWithReconnect({ attempt, sleep, onBackoff });
    expect(onBackoff).toHaveBeenNthCalledWith(1, 100, 0);
    expect(onBackoff).toHaveBeenNthCalledWith(2, 200, 1);
  });
});
