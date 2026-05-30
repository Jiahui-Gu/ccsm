import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Hook-level subscription test for `useTerminalScroll`. The pure geometry is
// pinned in `useTerminalScroll.test.ts`; this file guards the *subscription*
// regression behind the "scrollbar always pinned to the bottom" bug.
//
// Root cause: xterm's `onScroll` emitter does NOT fire on mouse-wheel
// scrolling — only `onRender` does. The hook must subscribe to `onRender`
// (in addition to `onScroll` / `onLineFeed` / `onResize`) so the thumb
// follows wheel scrolling instead of freezing at its last position.

type Listener = () => void;
const listeners: Record<'scroll' | 'lineFeed' | 'resize' | 'render', Listener | null> = {
  scroll: null,
  lineFeed: null,
  resize: null,
  render: null,
};

const fakeBuffer = { active: { viewportY: 0, baseY: 0 } };
const mk = (key: keyof typeof listeners) =>
  vi.fn((cb: Listener) => {
    listeners[key] = cb;
    return {
      dispose: vi.fn(() => {
        listeners[key] = null;
      }),
    };
  });

const fakeTerm = {
  rows: 24,
  get buffer() {
    return fakeBuffer;
  },
  onScroll: mk('scroll'),
  onLineFeed: mk('lineFeed'),
  onResize: mk('resize'),
  onRender: mk('render'),
  scrollToLine: vi.fn(),
  scrollLines: vi.fn(),
};

vi.mock('../../src/terminal/shellRegistry', () => ({
  getTopShell: vi.fn(() => ({ term: fakeTerm })),
}));

import { useTerminalScroll } from '../../src/terminal/useTerminalScroll';

const H = 200;

describe('useTerminalScroll (subscriptions)', () => {
  beforeEach(() => {
    fakeBuffer.active.viewportY = 0;
    fakeBuffer.active.baseY = 0;
    listeners.scroll = null;
    listeners.lineFeed = null;
    listeners.resize = null;
    listeners.render = null;
    fakeTerm.onScroll.mockClear();
    fakeTerm.onLineFeed.mockClear();
    fakeTerm.onResize.mockClear();
    fakeTerm.onRender.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to onRender (wheel scroll signal), not just onScroll', () => {
    renderHook(() => useTerminalScroll('sid-A', H));
    expect(fakeTerm.onScroll).toHaveBeenCalledTimes(1);
    expect(fakeTerm.onLineFeed).toHaveBeenCalledTimes(1);
    expect(fakeTerm.onResize).toHaveBeenCalledTimes(1);
    expect(fakeTerm.onRender).toHaveBeenCalledTimes(1);
  });

  it('follows wheel scroll: thumb moves off the bottom when only onRender fires', () => {
    // Start at the live tail (thumb at bottom).
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 100;
    const { result } = renderHook(() => useTerminalScroll('sid-A', H));
    const bottomTop = result.current.thumbTop;
    expect(bottomTop).toBeCloseTo(H - result.current.thumbHeight, 6);

    // Wheel scroll up: xterm moves viewportY but fires ONLY onRender
    // (no onScroll). The thumb must follow.
    act(() => {
      fakeBuffer.active.viewportY = 0;
      listeners.render!();
    });
    expect(result.current.thumbTop).toBe(0);
    expect(result.current.thumbTop).not.toBe(bottomTop);
  });

  it('disposes the onRender listener on unmount', () => {
    const { unmount } = renderHook(() => useTerminalScroll('sid-A', H));
    const renderDispose = fakeTerm.onRender.mock.results[0]!.value
      .dispose as ReturnType<typeof vi.fn>;
    unmount();
    expect(renderDispose).toHaveBeenCalled();
  });

  it('skips redundant state updates when geometry is unchanged across renders', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 40;
    const { result } = renderHook(() => useTerminalScroll('sid-A', H));
    const first = result.current;
    // onRender fires repeatedly during live output but geometry is identical;
    // the hook should keep the same geometry object (no-op update).
    act(() => {
      listeners.render!();
      listeners.render!();
    });
    expect(result.current.thumbTop).toBe(first.thumbTop);
    expect(result.current.thumbHeight).toBe(first.thumbHeight);
    expect(result.current.visible).toBe(first.visible);
  });
});
