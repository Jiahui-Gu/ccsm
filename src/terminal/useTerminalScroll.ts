import { useEffect, useState } from 'react';
import { getTopShell } from './shellRegistry';

// `useTerminalScroll` — single-source-of-truth scrollbar driver.
//
// The native `.xterm-viewport` scrollbar is a lagging shadow of xterm's
// real scroll state (`buffer.active.viewportY` / `baseY`): xterm writes
// the internal viewportY into the DOM element's `scrollTop` on its own
// schedule, and that write races dimension settling on cold-start / fit /
// reflow. So the native thumb desyncs from the content (bug #82 and the
// reflow-drift family).
//
// This hook reads xterm's buffer geometry directly and projects a thumb
// position. There is no reverse sync — the thumb is a *pure function* of
// the buffer state, so it can never desync. We re-read on `onScroll` +
// `onLineFeed` + `onResize` (fit) and `onRender` — the last catches wheel
// scroll, which moves `viewportY` but fires no `onScroll` (xterm passes
// `suppressScrollEvent=true` on its wheel path). Drag / track-click
// translate back to `term.scrollToLine` / `term.scrollLines`.
//
// All geometry is in the pure functions below, exported for unit tests.

/** Minimum thumb height in px — keep the handle grabbable even when the
 *  scrollback is enormous relative to the visible rows. */
export const MIN_THUMB = 24;

export type ScrollGeometry = {
  /** Whether a scrollbar should render at all (there is scrollback). */
  visible: boolean;
  /** Thumb top offset in px within the track. */
  thumbTop: number;
  /** Thumb height in px. */
  thumbHeight: number;
};

/** Raw xterm buffer geometry the projection needs. */
export type BufferGeometry = {
  /** `buffer.active.baseY` — top scrollback line index of the viewport's
   *  bottom-most resting position. 0 means no scrollback. */
  baseY: number;
  /** `buffer.active.viewportY` — current top line of the viewport. */
  viewportY: number;
  /** Visible rows (`term.rows`). */
  rows: number;
};

/**
 * Project xterm buffer geometry onto a thumb rect for a track of pixel
 * height `H`. Pure — the unit tests pin this directly.
 *
 *   total       = baseY + rows                     (scrollback + one screen)
 *   visible     = baseY > 0                         (only if scrollback exists)
 *   thumbHeight = max(MIN_THUMB, H * rows / total)
 *   thumbTop    = baseY > 0
 *                   ? (H - thumbHeight) * viewportY / baseY
 *                   : 0
 */
export function computeThumb(buf: BufferGeometry, H: number): ScrollGeometry {
  const { baseY, viewportY, rows } = buf;
  if (baseY <= 0 || rows <= 0 || H <= 0) {
    return { visible: false, thumbTop: 0, thumbHeight: 0 };
  }
  const total = baseY + rows;
  const rawHeight = (H * rows) / total;
  const thumbHeight = Math.min(H, Math.max(MIN_THUMB, rawHeight));
  const travel = H - thumbHeight;
  const clampedViewportY = Math.max(0, Math.min(baseY, viewportY));
  const thumbTop = travel > 0 ? (travel * clampedViewportY) / baseY : 0;
  return { visible: true, thumbTop, thumbHeight };
}

/**
 * Inverse of `computeThumb`'s `thumbTop` — given a desired thumb-top in px,
 * return the target `viewportY` (clamped to `[0, baseY]`, integer). Used by
 * drag to translate pointer position back into a buffer scroll target.
 *
 *   targetViewportY = round(baseY * thumbTop' / (H - thumbHeight))
 */
export function thumbTopToViewportY(
  thumbTop: number,
  baseY: number,
  H: number,
  thumbHeight: number,
): number {
  const travel = H - thumbHeight;
  if (travel <= 0 || baseY <= 0) return 0;
  const raw = (baseY * thumbTop) / travel;
  const rounded = Math.round(raw);
  return Math.max(0, Math.min(baseY, rounded));
}

export type TerminalScrollState = ScrollGeometry & {
  /** Drag the thumb to an absolute top offset in px (within the track). */
  dragTo: (thumbTopPx: number) => void;
  /** Page up (-1) / down (+1) by one screen of rows. */
  pageBy: (dir: 1 | -1) => void;
};

function readBuffer(): BufferGeometry | null {
  const term = getTopShell()?.term;
  const buf = term?.buffer?.active;
  if (!term || !buf) return null;
  return { baseY: buf.baseY, viewportY: buf.viewportY, rows: term.rows };
}

/**
 * Subscribe to the top shell's xterm buffer and expose a controlled thumb
 * geometry plus drag / page actions. `trackHeight` is the pixel height of
 * the scrollbar track (the host height) — the caller measures and passes
 * it so the geometry stays a pure function of (buffer, trackHeight).
 */
export function useTerminalScroll(
  sessionId: string | null,
  trackHeight: number,
): TerminalScrollState {
  const [geom, setGeom] = useState<ScrollGeometry>({
    visible: false,
    thumbTop: 0,
    thumbHeight: 0,
  });

  useEffect(() => {
    const recompute = (): void => {
      const buf = readBuffer();
      if (!buf) {
        setGeom({ visible: false, thumbTop: 0, thumbHeight: 0 });
        return;
      }
      setGeom(computeThumb(buf, trackHeight));
    };

    const term = getTopShell()?.term;
    if (!term) {
      const id = requestAnimationFrame(recompute);
      return () => cancelAnimationFrame(id);
    }
    recompute();
    const scrollDisposable = term.onScroll(recompute);
    const lineFeedDisposable = term.onLineFeed(recompute);
    const resizeDisposable = term.onResize(recompute);
    // Wheel scroll moves viewportY but xterm suppresses onScroll for it
    // (Viewport.handleWheel → scrollLines(amount, suppressScrollEvent=true)),
    // so onScroll/onLineFeed/onResize all miss it and the thumb freezes (#82).
    // onRender fires on the wheel-driven repaint, re-syncing the thumb.
    const renderDisposable = term.onRender(recompute);
    return () => {
      scrollDisposable.dispose();
      lineFeedDisposable.dispose();
      resizeDisposable.dispose();
      renderDisposable.dispose();
    };
  }, [sessionId, trackHeight]);

  return {
    ...geom,
    dragTo: (thumbTopPx: number) => {
      const term = getTopShell()?.term;
      if (!term) return;
      const buf = term.buffer.active;
      const target = thumbTopToViewportY(
        thumbTopPx,
        buf.baseY,
        trackHeight,
        geom.thumbHeight,
      );
      term.scrollToLine(target);
    },
    pageBy: (dir: 1 | -1) => {
      const term = getTopShell()?.term;
      if (!term) return;
      term.scrollLines(dir * term.rows);
    },
  };
}
