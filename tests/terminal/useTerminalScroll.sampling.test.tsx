import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Behavioural test for `useTerminalScroll`'s rAF-sampling driver.
//
// Architecture under test: the hook does NOT subscribe to discrete xterm
// events (`onScroll` / `onLineFeed` / `onResize` / `onRender`). Instead it
// samples `buffer.active.{viewportY, baseY}` + `term.rows` on a
// requestAnimationFrame loop and re-projects the thumb each frame. The
// point of this design is that mouse-wheel / middle-mouse scrolling moves
// `viewportY` WITHOUT emitting `onScroll`, so an event-subscription thumb
// freezes — but a sampling thumb follows `viewportY` regardless of which
// input changed it.
//
// These tests pin that contract:
//   1. mutating `viewportY` with NO event emitted still updates the geom
//      after a frame tick (the wheel/middle-mouse case);
//   2. the loop is a no-op (no extra renders) when nothing moved;
//   3. the rAF is cancelled on unmount (no leak);
//   4. it copes with the term not being ready yet, then mounting.
//
// The pure geometry itself is pinned separately in useTerminalScroll.test.ts.

const fakeBuffer = { active: { viewportY: 0, baseY: 0, type: 'normal' } };
let termPresent = true;
const fakeTerm = {
  get buffer() {
    return fakeBuffer;
  },
  rows: 24,
  // Deliberately NO onScroll / onLineFeed / onResize / onRender: the hook
  // must not depend on them. If the implementation regresses to calling any
  // of these, `term.onScroll` would be `undefined` and throw — a useful
  // guard.
  scrollToLine: vi.fn(),
  scrollLines: vi.fn(),
};

vi.mock('../../src/terminal/shellRegistry', () => ({
  getTopShell: vi.fn(() => (termPresent ? { term: fakeTerm } : null)),
}));

import { useTerminalScroll, computeThumb } from '../../src/terminal/useTerminalScroll';

const H = 200;

// Drive a single rAF frame under fake timers. jsdom's requestAnimationFrame
// is backed by a timer, so advancing time flushes the queued callback.
function tickFrame(): void {
  act(() => {
    vi.advanceTimersByTime(16);
  });
}

describe('useTerminalScroll (rAF sampling)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeBuffer.active.viewportY = 0;
    fakeBuffer.active.baseY = 0;
    fakeTerm.rows = 24;
    termPresent = true;
    fakeTerm.scrollToLine.mockClear();
    fakeTerm.scrollLines.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('follows viewportY changes with NO event emitted (wheel / middle-mouse path)', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 100; // at tail
    const { result } = renderHook(() => useTerminalScroll('sid-A', H));

    // First frame samples the tail position.
    tickFrame();
    const atTail = computeThumb({ baseY: 100, viewportY: 100, rows: 24 }, H);
    expect(result.current.visible).toBe(true);
    expect(result.current.thumbTop).toBeCloseTo(atTail.thumbTop, 6);

    // Simulate a wheel scroll-up: viewportY moves WITHOUT any xterm event.
    // An event-subscription thumb would stay frozen here.
    fakeBuffer.active.viewportY = 20;
    tickFrame();

    const scrolledUp = computeThumb({ baseY: 100, viewportY: 20, rows: 24 }, H);
    expect(result.current.thumbTop).toBeCloseTo(scrolledUp.thumbTop, 6);
    // And it actually moved off the bottom.
    expect(result.current.thumbTop).toBeLessThan(atTail.thumbTop);
  });

  it('does not re-render on idle frames when geometry is unchanged', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 50;
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useTerminalScroll('sid-A', H);
    });

    tickFrame(); // first commit
    const rendersAfterFirstCommit = renders;
    const top = result.current.thumbTop;

    // Several idle frames with no buffer change — must not bump render count.
    tickFrame();
    tickFrame();
    tickFrame();

    expect(renders).toBe(rendersAfterFirstCommit);
    expect(result.current.thumbTop).toBe(top);
  });

  it('cancels the rAF loop on unmount (no leak)', () => {
    const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const { unmount } = renderHook(() => useTerminalScroll('sid-A', H));
    tickFrame();
    unmount();
    expect(cancelSpy).toHaveBeenCalled();
    cancelSpy.mockRestore();
  });

  it('handles the term-not-ready case, then projects once it mounts', () => {
    termPresent = false;
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 30;

    const { result } = renderHook(() => useTerminalScroll('sid-A', H));
    tickFrame();
    // No term yet → hidden, no throw.
    expect(result.current.visible).toBe(false);

    // Term mounts; next sample picks up real geometry.
    termPresent = true;
    tickFrame();
    const expected = computeThumb({ baseY: 100, viewportY: 30, rows: 24 }, H);
    expect(result.current.visible).toBe(true);
    expect(result.current.thumbTop).toBeCloseTo(expected.thumbTop, 6);
  });

  it('re-arms when trackHeight changes (geometry re-projects)', () => {
    fakeBuffer.active.baseY = 100;
    fakeBuffer.active.viewportY = 50;
    const { result, rerender } = renderHook(
      ({ h }: { h: number }) => useTerminalScroll('sid-A', h),
      { initialProps: { h: H } },
    );
    tickFrame();
    const tallTrack = computeThumb({ baseY: 100, viewportY: 50, rows: 24 }, H);
    expect(result.current.thumbHeight).toBeCloseTo(tallTrack.thumbHeight, 6);

    act(() => {
      rerender({ h: 400 });
    });
    tickFrame();
    const shortTrack = computeThumb({ baseY: 100, viewportY: 50, rows: 24 }, 400);
    expect(result.current.thumbHeight).toBeCloseTo(shortTrack.thumbHeight, 6);
  });
});
