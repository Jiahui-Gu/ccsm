import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Capture the listener xterm registered so the test can fire it synthetically.
let scrollListener: (() => void) | null = null;
let lineFeedListener: (() => void) | null = null;
let renderListener: (() => void) | null = null;

const fakeBuffer = { active: { viewportY: 0, baseY: 0 } };
const scrollToBottomSpy = vi.fn(() => {
  fakeBuffer.active.viewportY = fakeBuffer.active.baseY;
  scrollListener?.();
});
const fakeTerm = {
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
  onRender: vi.fn((cb: () => void) => {
    renderListener = cb;
    return { dispose: vi.fn(() => { renderListener = null; }) };
  }),
  scrollToBottom: scrollToBottomSpy,
};

vi.mock('../../src/terminal/shellRegistry', () => ({
  getTopShell: vi.fn(() => ({ term: fakeTerm })),
}));

import { useAtBottom } from '../../src/terminal/useAtBottom';

describe('useAtBottom (warm registry)', () => {
  beforeEach(() => {
    fakeBuffer.active.viewportY = 0;
    fakeBuffer.active.baseY = 0;
    scrollListener = null;
    lineFeedListener = null;
    renderListener = null;
    scrollToBottomSpy.mockClear();
    fakeTerm.onScroll.mockClear();
    fakeTerm.onLineFeed.mockClear();
    fakeTerm.onRender.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports atBottom=true when viewportY tracks baseY', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 100;
    const { result } = renderHook(() => useAtBottom('sid-A'));
    expect(result.current.atBottom).toBe(true);
  });

  it('tolerates a 1-line gap (rounding) as still atBottom', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 99;
    const { result } = renderHook(() => useAtBottom('sid-A'));
    expect(result.current.atBottom).toBe(true);
  });

  it('reports atBottom=false when the user has scrolled up', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 40;
    const { result } = renderHook(() => useAtBottom('sid-A'));
    expect(result.current.atBottom).toBe(false);
  });

  it('flips atBottom when xterm fires onScroll after user scroll', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 100;
    const { result } = renderHook(() => useAtBottom('sid-A'));
    expect(result.current.atBottom).toBe(true);

    act(() => {
      fakeBuffer.active.viewportY = 20;
      scrollListener!();
    });
    expect(result.current.atBottom).toBe(false);
  });

  it('flips atBottom when new lines arrive (onLineFeed) and user is scrolled up', () => {
    fakeBuffer.active.baseY = 50;
    fakeBuffer.active.viewportY = 50;
    const { result } = renderHook(() => useAtBottom('sid-A'));
    expect(result.current.atBottom).toBe(true);

    act(() => {
      fakeBuffer.active.viewportY = 50;
      fakeBuffer.active.baseY = 80;
      lineFeedListener!();
    });
    expect(result.current.atBottom).toBe(false);
  });

  it('flips atBottom on wheel scroll (onRender only — xterm suppresses onScroll)', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 100;
    const { result } = renderHook(() => useAtBottom('sid-A'));
    expect(result.current.atBottom).toBe(true);

    // Wheel-up moves viewportY but fires NO onScroll/onLineFeed — only a
    // repaint (onRender). The button must still reveal. Red if the onRender
    // subscription is dropped.
    act(() => {
      fakeBuffer.active.viewportY = 20;
      renderListener!();
    });
    expect(result.current.atBottom).toBe(false);
  });

  it('scrollToBottom delegates to term.scrollToBottom and restores atBottom', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 20;
    const { result } = renderHook(() => useAtBottom('sid-A'));
    expect(result.current.atBottom).toBe(false);

    act(() => {
      result.current.scrollToBottom();
    });
    expect(scrollToBottomSpy).toHaveBeenCalledTimes(1);
    expect(result.current.atBottom).toBe(true);
  });

  it('disposes the scroll + lineFeed + render listeners on unmount', () => {
    const { unmount } = renderHook(() => useAtBottom('sid-A'));
    const scrollDispose = fakeTerm.onScroll.mock.results[0]!.value.dispose as ReturnType<typeof vi.fn>;
    const lineFeedDispose = fakeTerm.onLineFeed.mock.results[0]!.value.dispose as ReturnType<typeof vi.fn>;
    const renderDispose = fakeTerm.onRender.mock.results[0]!.value.dispose as ReturnType<typeof vi.fn>;
    unmount();
    expect(scrollDispose).toHaveBeenCalled();
    expect(lineFeedDispose).toHaveBeenCalled();
    expect(renderDispose).toHaveBeenCalled();
  });

  it('recomputes on session change (effect re-runs on sessionId change)', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 20;
    const { result, rerender } = renderHook(({ sid }: { sid: string }) => useAtBottom(sid), {
      initialProps: { sid: 'sid-A' },
    });
    expect(result.current.atBottom).toBe(false);

    act(() => {
      fakeBuffer.active.baseY = 0;
      fakeBuffer.active.viewportY = 0;
      rerender({ sid: 'sid-B' });
    });
    expect(result.current.atBottom).toBe(true);
  });
});
