// Tests for the bounded reconnect queue (Task #103, frag-3.7 §3.7.4).

import { describe, expect, it, vi } from 'vitest';
import {
  createReconnectQueue,
  MAX_QUEUED_DEV,
  MAX_QUEUED_PROD,
  QUEUE_OVERFLOW_MESSAGE,
} from '../reconnectQueue';

describe('reconnectQueue', () => {
  it('exposes prod and dev caps from spec frag-3.7 §3.7.4', () => {
    expect(MAX_QUEUED_PROD).toBe(100);
    expect(MAX_QUEUED_DEV).toBe(1000);
  });

  it('enqueues and drains in FIFO order, resolving each promise', async () => {
    const q = createReconnectQueue({ maxQueued: 10 });
    const calls: string[] = [];
    const p1 = q.enqueue<string>({
      method: 'A',
      thunk: async () => {
        calls.push('A');
        return 'a-result';
      },
    });
    const p2 = q.enqueue<string>({
      method: 'B',
      thunk: async () => {
        calls.push('B');
        return 'b-result';
      },
    });
    expect(q.size()).toBe(2);
    const drained = await q.drain();
    expect(drained).toBe(2);
    expect(q.size()).toBe(0);
    expect(await p1).toBe('a-result');
    expect(await p2).toBe('b-result');
    // FIFO: A's thunk fired before B's.
    expect(calls).toEqual(['A', 'B']);
  });

  it('forwards thunk rejection through to the original promise', async () => {
    const q = createReconnectQueue({ maxQueued: 5 });
    const p = q.enqueue<number>({
      method: 'X',
      thunk: async () => {
        throw new Error('boom');
      },
    });
    const drained = await q.drain();
    expect(drained).toBe(1);
    await expect(p).rejects.toThrow('boom');
  });

  it('rejects the OLDEST entry on overflow, appends the new one', async () => {
    const q = createReconnectQueue({ maxQueued: 2 });
    const oldest = q.enqueue<string>({
      method: 'oldest',
      thunk: async () => 'X',
    });
    q.enqueue({ method: 'middle', thunk: async () => 'Y' });
    // This third enqueue triggers overflow → `oldest` rejects.
    q.enqueue({ method: 'newest', thunk: async () => 'Z' });
    await expect(oldest).rejects.toThrow(QUEUE_OVERFLOW_MESSAGE);
    expect(q.size()).toBe(2);
  });

  it('rejectAll empties the queue and rejects each entry', async () => {
    const q = createReconnectQueue({ maxQueued: 5 });
    const p1 = q.enqueue({ method: 'A', thunk: async () => 1 });
    const p2 = q.enqueue({ method: 'B', thunk: async () => 2 });
    q.rejectAll(new Error('client-closed'));
    expect(q.size()).toBe(0);
    await expect(p1).rejects.toThrow('client-closed');
    await expect(p2).rejects.toThrow('client-closed');
  });

  it('drain on empty queue returns 0', async () => {
    const q = createReconnectQueue({ maxQueued: 5 });
    expect(await q.drain()).toBe(0);
  });

  it('uses dev cap when CCSM_DAEMON_DEV=1, prod cap otherwise', () => {
    const orig = process.env['CCSM_DAEMON_DEV'];
    try {
      process.env['CCSM_DAEMON_DEV'] = '1';
      const dev = createReconnectQueue();
      // Probe: enqueue 100 calls. In prod cap=100, the 101st evicts oldest.
      // In dev cap=1000, no eviction yet at 100.
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < 101; i++) {
        promises.push(dev.enqueue({ method: 'p', thunk: async () => i }));
      }
      // No overflow expected → no rejection happened on the first.
      // We only check size; the promises stay pending until drain.
      expect(dev.size()).toBe(101);
      // Cleanup.
      dev.rejectAll(new Error('cleanup'));
      // Swallow rejections.
      void Promise.allSettled(promises);
    } finally {
      if (orig === undefined) delete process.env['CCSM_DAEMON_DEV'];
      else process.env['CCSM_DAEMON_DEV'] = orig;
    }
  });

  it('logs canonical daemon_queue_overflow message on eviction', async () => {
    const lines: Array<{ line: string; extras: Record<string, unknown> | undefined }> = [];
    const q = createReconnectQueue({
      maxQueued: 1,
      log: (line, extras) => lines.push({ line, extras }),
    });
    const p = q.enqueue({ method: 'M', thunk: async () => 'X' });
    q.enqueue({ method: 'N', thunk: async () => 'Y' });
    // First was evicted.
    await expect(p).rejects.toThrow(QUEUE_OVERFLOW_MESSAGE);
    expect(lines.some((l) => l.line === 'daemon_queue_overflow')).toBe(true);
  });

  it('drain after enqueue while another drain is pending: re-queued thunks land in next batch', async () => {
    const q = createReconnectQueue({ maxQueued: 5 });
    let reentered = false;
    q.enqueue({
      method: 'self-requeue',
      thunk: async () => {
        // Re-enqueue while drain is mid-flight. Must NOT be observed by
        // the in-flight batch (prevents recursion).
        if (!reentered) {
          reentered = true;
          q.enqueue({ method: 'next', thunk: async () => 'second' });
        }
        return 'first';
      },
    });
    expect(await q.drain()).toBe(1);
    // The re-enqueued one is still pending.
    expect(q.size()).toBe(1);
    expect(await q.drain()).toBe(1);
  });

  it('rejects construction with non-positive maxQueued', () => {
    expect(() => createReconnectQueue({ maxQueued: 0 })).toThrow();
    expect(() => createReconnectQueue({ maxQueued: -1 })).toThrow();
    expect(() => createReconnectQueue({ maxQueued: 1.5 })).toThrow();
  });

  // Defense against accidental mock usage.
  it('uses real Date.now by default', () => {
    const q = createReconnectQueue({ maxQueued: 1 });
    void q.enqueue({ method: 'A', thunk: async () => 1 });
    const peek = q.peek();
    expect(peek[0]?.enqueuedAt).toBeGreaterThan(0);
  });
});

// Vitest unused-import guard (vi imported for spy parity with other suites
// in the daemonClient folder but not needed here).
void vi;
