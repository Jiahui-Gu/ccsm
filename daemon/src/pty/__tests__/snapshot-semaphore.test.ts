import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  SNAPSHOT_SEMAPHORE_DEFAULT_CAPACITY,
  SNAPSHOT_SEMAPHORE_GLOBAL_KEY,
  SnapshotSemaphoreCancelledError,
  SnapshotSemaphoreTimeoutError,
  createSnapshotSemaphore,
} from '../snapshot-semaphore.js';

describe('snapshot-semaphore: spec-default constants (frag-3.5.1 §3.5.1.5)', () => {
  it('exports capacity 4 — global pool, any session, any caller', () => {
    expect(SNAPSHOT_SEMAPHORE_DEFAULT_CAPACITY).toBe(4);
  });

  it('exports the conventional global key', () => {
    expect(SNAPSHOT_SEMAPHORE_GLOBAL_KEY).toBe('global');
  });
});

describe('snapshot-semaphore: construction', () => {
  it('rejects non-positive capacity', () => {
    expect(() => createSnapshotSemaphore({ capacity: 0 })).toThrow(RangeError);
    expect(() => createSnapshotSemaphore({ capacity: -1 })).toThrow(RangeError);
    expect(() => createSnapshotSemaphore({ capacity: 1.5 })).toThrow(RangeError);
    expect(() => createSnapshotSemaphore({ capacity: Number.NaN })).toThrow(RangeError);
  });

  it('accepts capacity = 1', () => {
    const sem = createSnapshotSemaphore({ capacity: 1 });
    expect(sem.stats('k').active).toBe(0);
  });
});

describe('snapshot-semaphore: acquire/release', () => {
  it('admits up to capacity synchronously with waitMs = 0', async () => {
    const sem = createSnapshotSemaphore({ capacity: 3 });
    const a = await sem.acquire('k', 1000);
    const b = await sem.acquire('k', 1000);
    const c = await sem.acquire('k', 1000);
    expect(a.waitMs).toBe(0);
    expect(b.waitMs).toBe(0);
    expect(c.waitMs).toBe(0);
    expect(sem.stats('k')).toEqual({ active: 3, queued: 0 });
    a.release();
    b.release();
    c.release();
    expect(sem.stats('k')).toEqual({ active: 0, queued: 0 });
  });

  it('queues over-capacity callers; release admits the head waiter FIFO', async () => {
    const sem = createSnapshotSemaphore({ capacity: 1 });
    const first = await sem.acquire('k', 1000);
    let secondResolved = false;
    let thirdResolved = false;
    const second = sem.acquire('k', 1000).then((l) => {
      secondResolved = true;
      return l;
    });
    const third = sem.acquire('k', 1000).then((l) => {
      thirdResolved = true;
      return l;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    expect(thirdResolved).toBe(false);
    expect(sem.stats('k')).toEqual({ active: 1, queued: 2 });
    first.release();
    const s = await second;
    expect(secondResolved).toBe(true);
    expect(thirdResolved).toBe(false);
    expect(sem.stats('k')).toEqual({ active: 1, queued: 1 });
    s.release();
    const t = await third;
    expect(thirdResolved).toBe(true);
    t.release();
    expect(sem.stats('k')).toEqual({ active: 0, queued: 0 });
  });

  it('reports waitMs measured from enqueue to admission via injected clock', async () => {
    let nowVal = 1000;
    const sem = createSnapshotSemaphore({ capacity: 1, now: () => nowVal });
    const first = await sem.acquire('k', 10_000);
    const queued = sem.acquire('k', 10_000);
    nowVal += 250; // simulate 250 ms passing
    first.release();
    const second = await queued;
    expect(second.waitMs).toBe(250);
  });

  it('release is idempotent — second call is a no-op', async () => {
    const sem = createSnapshotSemaphore({ capacity: 1 });
    const a = await sem.acquire('k', 1000);
    a.release();
    expect(sem.stats('k').active).toBe(0);
    // Re-release must not push active negative or admit phantom waiters.
    a.release();
    a.release();
    expect(sem.stats('k').active).toBe(0);
    // A fresh acquire must still work after the redundant releases.
    const b = await sem.acquire('k', 1000);
    expect(b.waitMs).toBe(0);
    b.release();
  });
});

describe('snapshot-semaphore: per-key independence', () => {
  it('different keys do not share permits', async () => {
    const sem = createSnapshotSemaphore({ capacity: 1 });
    const a = await sem.acquire('keyA', 1000);
    // keyB has its own permit pool.
    const b = await sem.acquire('keyB', 1000);
    expect(a.waitMs).toBe(0);
    expect(b.waitMs).toBe(0);
    expect(sem.stats('keyA')).toEqual({ active: 1, queued: 0 });
    expect(sem.stats('keyB')).toEqual({ active: 1, queued: 0 });
    a.release();
    b.release();
  });

  it('queue on keyA does not block keyB', async () => {
    const sem = createSnapshotSemaphore({ capacity: 1 });
    const aHeld = await sem.acquire('keyA', 1000);
    const aQueued = sem.acquire('keyA', 1000); // will queue
    // Meanwhile keyB stays fully responsive.
    const b = await sem.acquire('keyB', 1000);
    expect(b.waitMs).toBe(0);
    b.release();
    aHeld.release();
    (await aQueued).release();
  });
});

describe('snapshot-semaphore: timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with SnapshotSemaphoreTimeoutError when the budget elapses while queued', async () => {
    const sem = createSnapshotSemaphore({ capacity: 1 });
    const held = await sem.acquire('k', 60_000);
    const queued = sem.acquire('k', 100);
    const onReject = vi.fn();
    queued.catch(onReject);
    // Advance past the 100 ms budget.
    await vi.advanceTimersByTimeAsync(150);
    expect(onReject).toHaveBeenCalledOnce();
    const err = onReject.mock.calls[0]![0] as SnapshotSemaphoreTimeoutError;
    expect(err).toBeInstanceOf(SnapshotSemaphoreTimeoutError);
    expect(err.code).toBe('SNAPSHOT_SEMAPHORE_TIMEOUT');
    expect(err.key).toBe('k');
    expect(err.timeoutMs).toBe(100);
    expect(err.waitedMs).toBeGreaterThanOrEqual(100);
    held.release();
    // After the holder releases, no phantom admission should resolve the
    // timed-out waiter — it has already been settled.
    await vi.advanceTimersByTimeAsync(10);
    expect(sem.stats('k')).toEqual({ active: 0, queued: 0 });
  });

  it('does NOT time out a holder that has already been admitted', async () => {
    const sem = createSnapshotSemaphore({ capacity: 1 });
    const a = await sem.acquire('k', 50);
    // The 50 ms budget only governs the queue wait — a is already admitted.
    await vi.advanceTimersByTimeAsync(200);
    expect(sem.stats('k').active).toBe(1);
    a.release();
  });

  it('admits the next non-timed-out waiter after a stale entry is skipped', async () => {
    const sem = createSnapshotSemaphore({ capacity: 1 });
    const held = await sem.acquire('k', 60_000);
    const willTimeout = sem.acquire('k', 100);
    const willSucceed = sem.acquire('k', 60_000);
    willTimeout.catch(() => {
      /* expected */
    });
    await vi.advanceTimersByTimeAsync(150);
    held.release();
    const ok = await willSucceed;
    expect(ok.waitMs).toBeGreaterThanOrEqual(150);
    ok.release();
  });
});

describe('snapshot-semaphore: input validation', () => {
  it('rejects acquire with non-positive timeoutMs', async () => {
    const sem = createSnapshotSemaphore({ capacity: 1 });
    await expect(sem.acquire('k', 0)).rejects.toBeInstanceOf(RangeError);
    await expect(sem.acquire('k', -1)).rejects.toBeInstanceOf(RangeError);
    await expect(sem.acquire('k', Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(sem.acquire('k', Number.NaN)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('snapshot-semaphore: drain (spec §3.5.1.2 step 5)', () => {
  it('rejects every queued waiter with CANCELLED and returns the count', async () => {
    const sem = createSnapshotSemaphore({ capacity: 1 });
    const held = await sem.acquire('k', 60_000);
    const queuedA = sem.acquire('k', 60_000);
    const queuedB = sem.acquire('k', 60_000);
    const onA = vi.fn();
    const onB = vi.fn();
    queuedA.catch(onA);
    queuedB.catch(onB);
    const rejected = sem.drain('daemonShutdown');
    expect(rejected).toBe(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(onA).toHaveBeenCalledOnce();
    expect(onB).toHaveBeenCalledOnce();
    const err = onA.mock.calls[0]![0] as SnapshotSemaphoreCancelledError;
    expect(err).toBeInstanceOf(SnapshotSemaphoreCancelledError);
    expect(err.code).toBe('CANCELLED');
    expect(err.key).toBe('k');
    expect(err.reason).toBe('daemonShutdown');
    // Holder is untouched — caller manages its own release path.
    expect(sem.stats('k').active).toBe(1);
    held.release();
    expect(sem.stats('k')).toEqual({ active: 0, queued: 0 });
  });

  it('drain across multiple keys reports total rejected', async () => {
    const sem = createSnapshotSemaphore({ capacity: 1 });
    const ha = await sem.acquire('A', 60_000);
    const hb = await sem.acquire('B', 60_000);
    const qa = sem.acquire('A', 60_000);
    const qb = sem.acquire('B', 60_000);
    qa.catch(() => {});
    qb.catch(() => {});
    expect(sem.drain('shutdown')).toBe(2);
    ha.release();
    hb.release();
  });

  it('drain with no waiters returns 0', () => {
    const sem = createSnapshotSemaphore({ capacity: 4 });
    expect(sem.drain('noop')).toBe(0);
  });
});

describe('snapshot-semaphore: stats for unknown keys', () => {
  it('returns 0/0 for never-touched keys without allocating state', () => {
    const sem = createSnapshotSemaphore({ capacity: 1 });
    expect(sem.stats('never')).toEqual({ active: 0, queued: 0 });
  });
});
