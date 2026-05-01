import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeBackoff,
  ReconnectQueue,
  type ReconnectFn,
} from '../src/lib/reconnect-queue';
import { DaemonEventBus } from '../src/lib/daemon-events';

describe('computeBackoff', () => {
  it('attempt 0 = no delay (immediate first try)', () => {
    expect(computeBackoff(0)).toBe(0);
  });
  it('attempt 1 = base 200ms', () => {
    expect(computeBackoff(1)).toBe(200);
  });
  it('attempt 2 = 400ms', () => {
    expect(computeBackoff(2)).toBe(400);
  });
  it('attempt 3 = 800ms', () => {
    expect(computeBackoff(3)).toBe(800);
  });
  it('caps at maxDelayMs (5000) on high attempts', () => {
    expect(computeBackoff(10)).toBe(5000);
    expect(computeBackoff(20)).toBe(5000);
  });
  it('honors custom base + cap', () => {
    expect(computeBackoff(1, 100, 1000)).toBe(100);
    expect(computeBackoff(5, 100, 1000)).toBe(1000);
  });
});

describe('ReconnectQueue', () => {
  let bus: DaemonEventBus;
  let queue: ReconnectQueue | undefined;
  let calls: Array<{ subId: string; lastSeq: number | undefined }>;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new DaemonEventBus();
    calls = [];
  });

  afterEach(() => {
    queue?.dispose();
    queue = undefined;
    vi.useRealTimers();
  });

  function makeQueue(fn: ReconnectFn, concurrency = 3): ReconnectQueue {
    queue = new ReconnectQueue(fn, {
      bus,
      concurrency,
      baseDelayMs: 200,
      maxDelayMs: 5000,
    });
    return queue;
  }

  /** Drain microtasks + advance fake timers so awaiting code progresses. */
  async function flush(ms = 0): Promise<void> {
    if (ms > 0) vi.advanceTimersByTime(ms);
    // Multiple rounds because the queue chains promises through scheduleRetry.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  it('streamDead enqueues exactly 1 reconnect for that subId', async () => {
    const fn: ReconnectFn = async (subId, lastSeq) => {
      calls.push({ subId, lastSeq });
      return 'ok';
    };
    const q = makeQueue(fn);
    q.register({ subId: 's1', lastSeq: 42 });
    q.register({ subId: 's2', lastSeq: 7 });

    bus.emit('streamDead', { subId: 's1' });
    await flush();

    expect(calls).toEqual([{ subId: 's1', lastSeq: 42 }]);
    expect(q.getQueueDepth()).toBe(0);
  });

  it('streamDead falls back to event lastSeq when sub not registered', async () => {
    const fn: ReconnectFn = async (subId, lastSeq) => {
      calls.push({ subId, lastSeq });
      return 'ok';
    };
    const q = makeQueue(fn);
    bus.emit('streamDead', { subId: 'orphan', lastSeq: 99 });
    await flush();
    expect(calls).toEqual([{ subId: 'orphan', lastSeq: 99 }]);
  });

  it('bootChanged enqueues N tasks (one per active subscription)', async () => {
    const fn: ReconnectFn = async (subId, lastSeq) => {
      calls.push({ subId, lastSeq });
      return 'ok';
    };
    const q = makeQueue(fn);
    q.register({ subId: 'a', lastSeq: 1 });
    q.register({ subId: 'b', lastSeq: 2 });
    q.register({ subId: 'c', lastSeq: 3 });

    bus.emit('bootChanged', { bootNonce: 'nonce-2' });
    await flush();

    // bootChanged clears lastSeq → all undefined (daemon replays from 0).
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.subId).sort()).toEqual(['a', 'b', 'c']);
    for (const c of calls) expect(c.lastSeq).toBeUndefined();
  });

  it('respects concurrency cap (N=3) when 5 subs are active on bootChanged', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const release: Array<() => void> = [];

    const fn: ReconnectFn = (subId) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      calls.push({ subId, lastSeq: undefined });
      return new Promise<'ok'>((resolve) => {
        release.push(() => {
          inFlight--;
          resolve('ok');
        });
      });
    };
    const q = makeQueue(fn, 3);
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      q.register({ subId: id, lastSeq: 0 });
    }

    bus.emit('bootChanged', { bootNonce: 'x' });
    await flush();

    expect(calls).toHaveLength(3);
    expect(peakInFlight).toBe(3);
    expect(q.getInFlightCount()).toBe(3);

    // Release one slot; another should pick up.
    release.shift()!();
    await flush();
    expect(calls).toHaveLength(4);

    // Release the rest.
    while (release.length) release.shift()!();
    await flush();
    expect(calls).toHaveLength(5);
    expect(peakInFlight).toBe(3);
  });

  it('exponential backoff schedule: 200 → 400 → 800 on consecutive failures', async () => {
    const timestamps: number[] = [];
    let start = 0;
    const fn: ReconnectFn = async (subId) => {
      timestamps.push(Date.now() - start);
      calls.push({ subId, lastSeq: undefined });
      if (calls.length < 4) throw new Error('boom');
      return 'ok';
    };
    const q = makeQueue(fn, 1);
    q.register({ subId: 's1', lastSeq: 0 });

    start = Date.now();
    bus.emit('streamDead', { subId: 's1' });

    // Attempt 1: immediate (microtask).
    await flush();
    expect(calls).toHaveLength(1);

    // Attempt 2: after 200ms.
    await flush(200);
    expect(calls).toHaveLength(2);

    // Attempt 3: after 400ms more.
    await flush(400);
    expect(calls).toHaveLength(3);

    // Attempt 4 (success): after 800ms more.
    await flush(800);
    expect(calls).toHaveLength(4);

    // Verify the recorded delays line up with the expected schedule
    // (allowing tiny microtask slop).
    expect(timestamps[0]).toBe(0);
    expect(timestamps[1]).toBe(200);
    expect(timestamps[2]).toBe(600);
    expect(timestamps[3]).toBe(1400);

    expect(q.getQueueDepth()).toBe(0);
  });

  it('backoff caps at maxDelayMs (5000) after enough failures', async () => {
    let attempt = 0;
    const fn: ReconnectFn = async () => {
      attempt++;
      // Always fail to force the cap.
      throw new Error('still down');
    };
    const q = makeQueue(fn, 1);
    q.register({ subId: 's1', lastSeq: 0 });
    bus.emit('streamDead', { subId: 's1' });

    await flush(); // attempt 1 immediate
    expect(attempt).toBe(1);
    await flush(200); // attempt 2
    await flush(400); // attempt 3
    await flush(800); // attempt 4
    await flush(1600); // attempt 5
    await flush(3200); // attempt 6
    expect(attempt).toBe(6);

    // Next delay should be capped at 5000, not 6400.
    await flush(4999);
    expect(attempt).toBe(6);
    await flush(1);
    expect(attempt).toBe(7);
  });

  it("'fatal' outcome aborts the task without retry", async () => {
    let n = 0;
    const fn: ReconnectFn = async () => {
      n++;
      return 'fatal';
    };
    const q = makeQueue(fn, 1);
    q.register({ subId: 's1', lastSeq: 0 });
    bus.emit('streamDead', { subId: 's1' });
    await flush(10000);
    expect(n).toBe(1);
    expect(q.getQueueDepth()).toBe(0);
  });

  it('coalesces duplicate streamDead bursts for the same subId', async () => {
    let resolveCall: (() => void) | undefined;
    const fn: ReconnectFn = (subId) => {
      calls.push({ subId, lastSeq: undefined });
      return new Promise<'ok'>((r) => {
        resolveCall = () => r('ok');
      });
    };
    const q = makeQueue(fn, 3);
    q.register({ subId: 's1', lastSeq: 0 });

    // Three bursts before the first attempt completes.
    bus.emit('streamDead', { subId: 's1' });
    bus.emit('streamDead', { subId: 's1' });
    bus.emit('streamDead', { subId: 's1' });
    await flush();

    // Only one call in flight; the 2nd/3rd bursts coalesced because the
    // first task is in-flight (no queued duplicate).
    expect(calls).toHaveLength(1);

    resolveCall!();
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('uses tracked lastSeq from updateLastSeq, not stale registration value', async () => {
    const fn: ReconnectFn = async (subId, lastSeq) => {
      calls.push({ subId, lastSeq });
      return 'ok';
    };
    const q = makeQueue(fn);
    q.register({ subId: 's1', lastSeq: 10 });
    q.updateLastSeq('s1', 55);
    bus.emit('streamDead', { subId: 's1' });
    await flush();
    expect(calls).toEqual([{ subId: 's1', lastSeq: 55 }]);
  });

  it('dispose() unsubscribes from bus and ignores subsequent events', async () => {
    const fn: ReconnectFn = async (subId) => {
      calls.push({ subId, lastSeq: undefined });
      return 'ok';
    };
    const q = makeQueue(fn);
    q.register({ subId: 's1', lastSeq: 0 });
    q.dispose();
    queue = undefined; // prevent afterEach double-dispose
    bus.emit('streamDead', { subId: 's1' });
    bus.emit('bootChanged', { bootNonce: 'x' });
    await flush(10000);
    expect(calls).toHaveLength(0);
  });
});

describe('DaemonEventBus', () => {
  it('delivers events to all subscribed listeners', () => {
    const bus = new DaemonEventBus();
    const seen: string[] = [];
    bus.on('bootChanged', (e) => seen.push(`a:${e.bootNonce}`));
    bus.on('bootChanged', (e) => seen.push(`b:${e.bootNonce}`));
    bus.emit('bootChanged', { bootNonce: 'n1' });
    expect(seen).toEqual(['a:n1', 'b:n1']);
  });

  it('off() / returned unsub stops delivery', () => {
    const bus = new DaemonEventBus();
    let count = 0;
    const unsub = bus.on('streamDead', () => count++);
    bus.emit('streamDead', { subId: 's' });
    unsub();
    bus.emit('streamDead', { subId: 's' });
    expect(count).toBe(1);
  });

  it('listener throw does not break sibling listeners', () => {
    const bus = new DaemonEventBus();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let sib = 0;
    bus.on('reconnected', () => {
      throw new Error('bad listener');
    });
    bus.on('reconnected', () => sib++);
    bus.emit('reconnected', { bootNonce: 'n' });
    expect(sib).toBe(1);
    errSpy.mockRestore();
  });
});
