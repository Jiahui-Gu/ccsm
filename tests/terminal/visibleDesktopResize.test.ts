import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVisibleDesktopResizeScheduler,
  VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS,
} from '../../src/terminal/visibleDesktopResize';

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

  it('does not record failed commits as last committed dimensions', async () => {
    const resize = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const scheduler = createVisibleDesktopResizeScheduler({
      isVisible: (sid) => sid === 's1',
      resize: resize as unknown as (sid: string, cols: number, rows: number) => Promise<void>,
    });

    await expect(scheduler.commitNow('s1', 120, 30)).rejects.toThrow('boom');
    await scheduler.commitNow('s1', 120, 30);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid/no-layout dimensions and never calls resize', async () => {
    const resize = vi.fn().mockResolvedValue(undefined);
    const scheduler = createVisibleDesktopResizeScheduler({
      isVisible: () => true,
      resize,
    });

    await expect(scheduler.commitNow('s1', Number.NaN, 30)).rejects.toThrow();
    await expect(scheduler.commitNow('s1', 120, 0)).rejects.toThrow();
    scheduler.schedule('s1', 0, 30);
    scheduler.schedule('s1', 120, Number.POSITIVE_INFINITY);
    vi.advanceTimersByTime(VISIBLE_DESKTOP_RESIZE_DEBOUNCE_MS);
    await Promise.resolve();

    expect(resize).not.toHaveBeenCalled();
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
