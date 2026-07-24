import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVisibleDesktopResizeScheduler,
  VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS,
} from '../../src/terminal/visibleDesktopResize';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('visibleDesktopResize', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces continuous measurements into one commit at 140 ms with the latest dimensions', async () => {
    const resize = vi.fn().mockResolvedValue(undefined);
    const scheduler = createVisibleDesktopResizeScheduler({
      isVisible: (sid) => sid === 's1',
      resize,
    });

    scheduler.schedule('s1', 100, 30);
    scheduler.schedule('s1', 120, 34);
    scheduler.schedule('s1', 140, 38);

    vi.advanceTimersByTime(VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS - 1);
    expect(resize).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(resize).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledWith('s1', 140, 38);
  });

  it('drops pending scheduled work when the session becomes hidden before flush', async () => {
    let visibleSid: string | null = 's1';
    const resize = vi.fn().mockResolvedValue(undefined);
    const scheduler = createVisibleDesktopResizeScheduler({
      isVisible: (sid) => sid === visibleSid,
      resize,
    });

    scheduler.schedule('s1', 120, 34);
    visibleSid = 's2';
    vi.advanceTimersByTime(VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS);
    await Promise.resolve();

    expect(resize).not.toHaveBeenCalled();
  });

  it('commits immediately for a visible shell and skips duplicate dimensions', async () => {
    const resize = vi.fn().mockResolvedValue(undefined);
    const scheduler = createVisibleDesktopResizeScheduler({
      isVisible: (sid) => sid === 's1',
      resize,
    });

    await scheduler.commitNow('s1', 132, 40);
    await scheduler.commitNow('s1', 132, 40);

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith('s1', 132, 40);
  });

  it('ignores invalid/no-layout dimensions and never calls resize', async () => {
    const resize = vi.fn().mockResolvedValue(undefined);
    const scheduler = createVisibleDesktopResizeScheduler({
      isVisible: () => true,
      resize,
    });

    await expect(scheduler.commitNow('s1', Number.NaN, 30)).resolves.toBeUndefined();
    await expect(scheduler.commitNow('s1', 120.5, 30)).resolves.toBeUndefined();
    await expect(scheduler.commitNow('s1', 120, 0)).resolves.toBeUndefined();
    await expect(scheduler.commitNow('s1', 2001, 30)).resolves.toBeUndefined();
    scheduler.schedule('s1', 0, 30);
    scheduler.schedule('s1', 120, Number.POSITIVE_INFINITY);
    vi.advanceTimersByTime(VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS);
    await Promise.resolve();

    expect(resize).not.toHaveBeenCalled();
  });

  it('dedupes same dimensions while a resize is in flight and resolves all callers', async () => {
    const first = createDeferred<void>();
    const resize = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const scheduler = createVisibleDesktopResizeScheduler({
      isVisible: () => true,
      resize: resize as unknown as (sid: string, cols: number, rows: number) => Promise<void>,
    });

    const p1 = scheduler.commitNow('s1', 120, 30);
    const p2 = scheduler.commitNow('s1', 120, 30);

    expect(resize).toHaveBeenCalledTimes(1);
    first.resolve();
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it('propagates in-flight rejection for duplicate dimensions and allows retry after settlement', async () => {
    const first = createDeferred<void>();
    const err = new Error('boom');
    const resize = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const scheduler = createVisibleDesktopResizeScheduler({
      isVisible: () => true,
      resize: resize as unknown as (sid: string, cols: number, rows: number) => Promise<void>,
    });

    const p1 = scheduler.commitNow('s1', 120, 30);
    const p2 = scheduler.commitNow('s1', 120, 30);

    first.reject(err);
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');

    await expect(scheduler.commitNow('s1', 120, 30)).resolves.toBeUndefined();
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it('serializes a later different dimension behind an in-flight resize', async () => {
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const resize = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const scheduler = createVisibleDesktopResizeScheduler({
      isVisible: () => true,
      resize: resize as unknown as (sid: string, cols: number, rows: number) => Promise<void>,
    });

    const p1 = scheduler.commitNow('s1', 120, 30);
    const p2 = scheduler.commitNow('s1', 140, 40);

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenNthCalledWith(1, 's1', 120, 30);

    first.resolve();
    second.resolve();
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenNthCalledWith(2, 's1', 140, 40);
  });

  it('clears per-sid suppression state on cancel', async () => {
    const resize = vi.fn().mockResolvedValue(undefined);
    const scheduler = createVisibleDesktopResizeScheduler({
      isVisible: () => true,
      resize,
    });

    await scheduler.commitNow('s1', 120, 30);
    expect(resize).toHaveBeenCalledTimes(1);

    scheduler.cancel('s1');
    await scheduler.commitNow('s1', 120, 30);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it('drops canceled work and disposed work', async () => {
    const resize = vi.fn().mockResolvedValue(undefined);
    const scheduler = createVisibleDesktopResizeScheduler({
      isVisible: () => true,
      resize,
    });

    scheduler.schedule('s1', 120, 30);
    scheduler.cancel('s1');
    vi.advanceTimersByTime(VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS);
    await Promise.resolve();
    expect(resize).not.toHaveBeenCalled();

    scheduler.schedule('s1', 130, 31);
    scheduler.dispose();
    vi.advanceTimersByTime(VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS);
    await Promise.resolve();
    expect(resize).not.toHaveBeenCalled();
  });
});
