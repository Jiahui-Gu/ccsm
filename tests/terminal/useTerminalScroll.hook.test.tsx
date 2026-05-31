// Hook-level tests for `useTerminalScroll`'s xterm subscription — distinct
// from `useTerminalScroll.test.ts`, which pins the pure geometry. These
// prove the thumb re-projects on the events that actually move `viewportY`,
// most importantly `onRender` (the wheel-scroll path, #82): wheel moves
// `viewportY` but xterm suppresses `onScroll` for it, so without the
// `onRender` subscription the thumb would freeze while content scrolls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

let scrollListener: (() => void) | null = null;
let lineFeedListener: (() => void) | null = null;
let resizeListener: (() => void) | null = null;
let renderListener: (() => void) | null = null;

const fakeBuffer = { active: { viewportY: 0, baseY: 0 } };
const fakeTerm = {
  rows: 24,
  get buffer() {
    return fakeBuffer;
  },
  onScroll: vi.fn((cb: () => void) => {
    scrollListener = cb;
    return { dispose: vi.fn(() => { scrollListener = null; }) };
  }),
  onLineFeed: vi.fn((cb: () => void) => {
    lineFeedListener = cb;
    return { dispose: vi.fn(() => { lineFeedListener = null; }) };
  }),
  onResize: vi.fn((cb: () => void) => {
    resizeListener = cb;
    return { dispose: vi.fn(() => { resizeListener = null; }) };
  }),
  onRender: vi.fn((cb: () => void) => {
    renderListener = cb;
    return { dispose: vi.fn(() => { renderListener = null; }) };
  }),
};

vi.mock('../../src/terminal/shellRegistry', () => ({
  getTopShell: vi.fn(() => ({ term: fakeTerm })),
}));

import { useTerminalScroll, computeThumb } from '../../src/terminal/useTerminalScroll';

const H = 200;

describe('useTerminalScroll (xterm subscription)', () => {
  beforeEach(() => {
    fakeBuffer.active.viewportY = 0;
    fakeBuffer.active.baseY = 0;
    scrollListener = null;
    lineFeedListener = null;
    resizeListener = null;
    renderListener = null;
    fakeTerm.onScroll.mockClear();
    fakeTerm.onLineFeed.mockClear();
    fakeTerm.onResize.mockClear();
    fakeTerm.onRender.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('projects the initial thumb from buffer state on mount', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 100; // at bottom
    const { result } = renderHook(() => useTerminalScroll('sid-A', H));
    const expected = computeThumb({ baseY: 100, viewportY: 100, rows: 24 }, H);
    expect(result.current.visible).toBe(true);
    expect(result.current.thumbTop).toBeCloseTo(expected.thumbTop, 6);
  });

  it('subscribes to onRender (the wheel-scroll repaint event)', () => {
    renderHook(() => useTerminalScroll('sid-A', H));
    expect(fakeTerm.onRender).toHaveBeenCalledTimes(1);
    expect(renderListener).toBeInstanceOf(Function);
  });

  // THE #82 regression lock: a wheel scroll moves viewportY but xterm fires
  // NO onScroll / onLineFeed / onResize for it — only a repaint (onRender).
  // The thumb must still re-project. If the onRender subscription is removed,
  // this test goes red (thumbTop stays at the bottom while content moved up).
  it('re-projects the thumb on onRender alone when wheel moves viewportY', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 100; // start at bottom
    const { result } = renderHook(() => useTerminalScroll('sid-A', H));
    const bottomThumbTop = result.current.thumbTop;
    expect(bottomThumbTop).toBeGreaterThan(0);

    // Simulate wheel-up: viewportY drops, but ONLY onRender fires.
    act(() => {
      fakeBuffer.active.viewportY = 0;
      renderListener!();
    });

    expect(result.current.thumbTop).toBe(0); // thumb followed content to top
    expect(result.current.thumbTop).toBeLessThan(bottomThumbTop);
  });

  it('still re-projects on onScroll (drag / programmatic path)', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 100;
    const { result } = renderHook(() => useTerminalScroll('sid-A', H));
    act(() => {
      fakeBuffer.active.viewportY = 50;
      scrollListener!();
    });
    const mid = computeThumb({ baseY: 100, viewportY: 50, rows: 24 }, H);
    expect(result.current.thumbTop).toBeCloseTo(mid.thumbTop, 6);
  });

  it('disposes the onRender listener (with the others) on unmount', () => {
    const { unmount } = renderHook(() => useTerminalScroll('sid-A', H));
    const renderDispose = fakeTerm.onRender.mock.results[0]!.value
      .dispose as ReturnType<typeof vi.fn>;
    unmount();
    expect(renderDispose).toHaveBeenCalled();
    expect(renderListener).toBeNull();
  });
});
