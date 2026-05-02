// tests/electron/daemon/healthzPing.test.ts
//
// Task #100 — supervisor-side `/healthz` heartbeat (frag-6-7 §6.1).
//
// Asserts the FSM behaviour:
//   - happy path: every ok tick keeps the miss counter at 0.
//   - miss path: each miss bumps the counter; below threshold fires onMiss
//     with the new count; reaching threshold fires onRestart exactly once
//     and freezes the FSM at `restart-pending` (no further ticks classify).
//   - recovery: an ok tick after a partial miss streak fires onRecover and
//     resets the counter.
//   - thrown pingFn errors are classified as misses (not unhandled).
//   - hooks that throw do not crash the FSM.
//   - mapRpcReplyToResult round-trips `{ ok: true | false }` envelopes.

import { describe, expect, it, vi } from 'vitest';

import {
  classifyTick,
  createHealthzPinger,
  DEFAULT_HEALTHZ_INTERVAL_MS,
  DEFAULT_HEALTHZ_THRESHOLD_MISSES,
  mapRpcReplyToResult,
  type HealthzPingResult,
} from '../../../electron/daemon/healthzPing';

function ok(detail: unknown = { uptimeMs: 1 }): HealthzPingResult {
  return { issuedAt: 0, settledAt: 1, outcome: 'ok', detail };
}
function miss(detail: unknown = 'timeout'): HealthzPingResult {
  return { issuedAt: 0, settledAt: 1, outcome: 'miss', detail };
}

describe('classifyTick (pure FSM)', () => {
  it('ok tick at zero-miss state stays steady', () => {
    expect(classifyTick(0, ok(), 3)).toEqual({ nextConsecutiveMisses: 0, intent: 'ok' });
  });
  it('ok tick after partial miss streak fires recover', () => {
    expect(classifyTick(2, ok(), 3)).toEqual({ nextConsecutiveMisses: 0, intent: 'recover' });
  });
  it('first miss bumps to 1 and warns', () => {
    expect(classifyTick(0, miss(), 3)).toEqual({ nextConsecutiveMisses: 1, intent: 'miss-warn' });
  });
  it('threshold-th consecutive miss fires restart', () => {
    expect(classifyTick(2, miss(), 3)).toEqual({ nextConsecutiveMisses: 3, intent: 'miss-restart' });
  });
  it('beyond-threshold miss still classified as restart (defensive)', () => {
    expect(classifyTick(5, miss(), 3)).toEqual({ nextConsecutiveMisses: 6, intent: 'miss-restart' });
  });
});

describe('createHealthzPinger', () => {
  it('exposes spec defaults (5 s interval, 3 misses) when omitted', () => {
    expect(DEFAULT_HEALTHZ_INTERVAL_MS).toBe(5_000);
    expect(DEFAULT_HEALTHZ_THRESHOLD_MISSES).toBe(3);
  });

  it('classifies a successful tick as ok and forwards onResult', async () => {
    const onResult = vi.fn();
    const onMiss = vi.fn();
    const onRestart = vi.fn();
    const pinger = createHealthzPinger({
      pingFn: async () => ok({ uptimeMs: 42 }),
      hooks: { onResult, onMiss, onRestart },
      // never start the interval — drive ticks manually.
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });
    pinger.start();
    await pinger.tickNow();
    expect(pinger.consecutiveMisses).toBe(0);
    expect(pinger.state).toBe('running');
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]![0].outcome).toBe('ok');
    expect(onMiss).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('three consecutive misses fire onRestart exactly once, then freeze the FSM', async () => {
    const onMiss = vi.fn();
    const onRestart = vi.fn();
    const pinger = createHealthzPinger({
      pingFn: async () => miss('ECONNREFUSED'),
      hooks: { onMiss, onRestart },
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });
    pinger.start();
    await pinger.tickNow();
    await pinger.tickNow();
    await pinger.tickNow();
    expect(onMiss).toHaveBeenCalledTimes(2); // counter 1, 2 — below threshold
    expect(onMiss.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onRestart.mock.calls[0]![0]).toBe(3);
    expect(pinger.state).toBe('restart-pending');
    // Subsequent ticks must not re-fire onRestart (idempotent restart hook).
    await pinger.tickNow();
    await pinger.tickNow();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('an ok tick mid-streak fires onRecover and resets the counter', async () => {
    let outcome: 'miss' | 'ok' = 'miss';
    const onMiss = vi.fn();
    const onRecover = vi.fn();
    const pinger = createHealthzPinger({
      pingFn: async () => (outcome === 'miss' ? miss() : ok()),
      hooks: { onMiss, onRecover },
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });
    pinger.start();
    await pinger.tickNow(); // miss → counter 1
    await pinger.tickNow(); // miss → counter 2
    expect(pinger.consecutiveMisses).toBe(2);
    outcome = 'ok';
    await pinger.tickNow(); // recover
    expect(pinger.consecutiveMisses).toBe(0);
    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(onMiss).toHaveBeenCalledTimes(2);
  });

  it('thrown pingFn errors classify as miss with the error message as detail', async () => {
    const onResult = vi.fn();
    const pinger = createHealthzPinger({
      pingFn: async () => { throw new Error('socket gone'); },
      hooks: { onResult },
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });
    pinger.start();
    await pinger.tickNow();
    expect(onResult).toHaveBeenCalledTimes(1);
    const r = onResult.mock.calls[0]![0] as HealthzPingResult;
    expect(r.outcome).toBe('miss');
    expect(r.detail).toBe('socket gone');
    expect(pinger.consecutiveMisses).toBe(1);
  });

  it('hooks that throw do not crash subsequent ticks', async () => {
    let calls = 0;
    const pinger = createHealthzPinger({
      pingFn: async () => { calls++; return ok(); },
      hooks: {
        onResult: () => { throw new Error('boom'); },
      },
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });
    pinger.start();
    await pinger.tickNow();
    await pinger.tickNow();
    expect(calls).toBe(2);
  });

  it('start is idempotent; stop clears the interval', () => {
    const setSpy = vi.fn(() => 99 as unknown as ReturnType<typeof setInterval>);
    const clearSpy = vi.fn();
    const pinger = createHealthzPinger({
      pingFn: async () => ok(),
      setIntervalFn: setSpy,
      clearIntervalFn: clearSpy,
    });
    pinger.start();
    pinger.start(); // no-op
    expect(setSpy).toHaveBeenCalledTimes(1);
    pinger.stop();
    pinger.stop(); // no-op
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(pinger.state).toBe('idle');
  });

  it('uses the configured intervalMs when scheduling the heartbeat', () => {
    const setSpy = vi.fn(() => 0 as unknown as ReturnType<typeof setInterval>);
    const pinger = createHealthzPinger({
      pingFn: async () => ok(),
      intervalMs: 1234,
      setIntervalFn: setSpy,
      clearIntervalFn: () => {},
    });
    pinger.start();
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 1234);
  });
});

describe('mapRpcReplyToResult', () => {
  it('maps ok envelope to ok result', () => {
    const r = mapRpcReplyToResult(10, 20, { ok: true, value: { uptimeMs: 1 } });
    expect(r).toEqual({ issuedAt: 10, settledAt: 20, outcome: 'ok', detail: { uptimeMs: 1 } });
  });
  it('maps err envelope to miss result with code:message detail', () => {
    const r = mapRpcReplyToResult(10, 20, {
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: 'no handler' },
    });
    expect(r).toEqual({
      issuedAt: 10,
      settledAt: 20,
      outcome: 'miss',
      detail: 'NOT_IMPLEMENTED: no handler',
    });
  });
});
