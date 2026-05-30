// Unit tests for `useTerminalScroll`'s pure geometry — the single source
// of truth for the self-drawn terminal scrollbar. These pin the exact
// projection from xterm buffer state (baseY / viewportY / rows) onto a
// thumb rect, plus the inverse used by drag. No DOM / xterm needed: the
// geometry is deliberately pure (spec §3 / §5).

import { describe, it, expect } from 'vitest';
import {
  computeThumb,
  thumbTopToViewportY,
  MIN_THUMB,
} from '../../src/terminal/useTerminalScroll';

describe('computeThumb', () => {
  const H = 200;
  const rows = 24;

  it('hides the scrollbar when there is no scrollback (baseY = 0)', () => {
    const g = computeThumb({ baseY: 0, viewportY: 0, rows }, H);
    expect(g.visible).toBe(false);
    expect(g.thumbTop).toBe(0);
    expect(g.thumbHeight).toBe(0);
  });

  it('hides when the track has no height', () => {
    const g = computeThumb({ baseY: 100, viewportY: 0, rows }, 0);
    expect(g.visible).toBe(false);
  });

  it('parks the thumb at the top when viewportY = 0 (scrolled all the way up)', () => {
    const g = computeThumb({ baseY: 100, viewportY: 0, rows }, H);
    expect(g.visible).toBe(true);
    expect(g.thumbTop).toBe(0);
  });

  it('parks the thumb at the bottom when viewportY = baseY (at live tail)', () => {
    const baseY = 100;
    const g = computeThumb({ baseY, viewportY: baseY, rows }, H);
    expect(g.visible).toBe(true);
    // bottom => thumbTop = travel = H - thumbHeight
    expect(g.thumbTop).toBeCloseTo(H - g.thumbHeight, 6);
  });

  it('places the thumb mid-track at viewportY = baseY / 2', () => {
    const baseY = 100;
    const g = computeThumb({ baseY, viewportY: baseY / 2, rows }, H);
    const travel = H - g.thumbHeight;
    expect(g.thumbTop).toBeCloseTo(travel / 2, 6);
  });

  it('sizes the thumb proportionally: H * rows / (baseY + rows)', () => {
    const baseY = 76; // total = 100, rows = 24 => thumb covers 24% of track
    const g = computeThumb({ baseY, viewportY: 0, rows }, H);
    expect(g.thumbHeight).toBeCloseTo((H * rows) / (baseY + rows), 6);
    expect(g.thumbHeight).toBeGreaterThan(MIN_THUMB);
  });

  it('clamps the thumb to MIN_THUMB when scrollback dwarfs the viewport', () => {
    // Huge scrollback: raw proportional height would be tiny.
    const g = computeThumb({ baseY: 100000, viewportY: 0, rows: 1 }, H);
    expect(g.thumbHeight).toBe(MIN_THUMB);
    // Still parked at top with viewportY 0.
    expect(g.thumbTop).toBe(0);
  });

  it('clamps an out-of-range viewportY into [0, baseY]', () => {
    const baseY = 100;
    const over = computeThumb({ baseY, viewportY: 9999, rows }, H);
    expect(over.thumbTop).toBeCloseTo(H - over.thumbHeight, 6);
    const under = computeThumb({ baseY, viewportY: -50, rows }, H);
    expect(under.thumbTop).toBe(0);
  });
});

describe('thumbTopToViewportY (drag inverse)', () => {
  const H = 200;

  it('round-trips computeThumb at the top', () => {
    const baseY = 100;
    const { thumbHeight } = computeThumb({ baseY, viewportY: 0, rows: 24 }, H);
    expect(thumbTopToViewportY(0, baseY, H, thumbHeight)).toBe(0);
  });

  it('round-trips computeThumb at the bottom', () => {
    const baseY = 100;
    const g = computeThumb({ baseY, viewportY: baseY, rows: 24 }, H);
    expect(thumbTopToViewportY(g.thumbTop, baseY, H, g.thumbHeight)).toBe(baseY);
  });

  it('round-trips a mid-track position back to viewportY', () => {
    const baseY = 100;
    const g = computeThumb({ baseY, viewportY: 40, rows: 24 }, H);
    expect(thumbTopToViewportY(g.thumbTop, baseY, H, g.thumbHeight)).toBe(40);
  });

  it('rounds fractional targets to the nearest line', () => {
    const baseY = 100;
    const thumbHeight = 50;
    const travel = H - thumbHeight; // 150
    // thumbTop that maps to 33.5 lines => rounds to 34
    const thumbTop = (33.5 / baseY) * travel;
    expect(thumbTopToViewportY(thumbTop, baseY, H, thumbHeight)).toBe(34);
  });

  it('clamps drag targets above the bottom to baseY', () => {
    const baseY = 100;
    const thumbHeight = 50;
    expect(thumbTopToViewportY(99999, baseY, H, thumbHeight)).toBe(baseY);
  });

  it('clamps negative drag targets to 0', () => {
    const baseY = 100;
    const thumbHeight = 50;
    expect(thumbTopToViewportY(-100, baseY, H, thumbHeight)).toBe(0);
  });

  it('returns 0 when there is no travel (thumb fills the track)', () => {
    expect(thumbTopToViewportY(10, 100, H, H)).toBe(0);
  });

  it('returns 0 when there is no scrollback', () => {
    expect(thumbTopToViewportY(10, 0, H, 50)).toBe(0);
  });
});
