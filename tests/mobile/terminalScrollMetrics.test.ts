import { describe, expect, it } from 'vitest';

import { type TerminalScrollMetrics } from '../../src/mobile/mobileTerminalAdapter';
import {
  calculateScrollbarGeometry,
  lineForTrackOffset,
} from '../../src/mobile/terminalScrollMetrics';

describe('terminalScrollMetrics', () => {
  it('renders a disabled full-height thumb with no scrollback', () => {
    expect(
      calculateScrollbarGeometry(
        { maximumTop: 0, currentTop: 0, visibleRows: 30 },
        300,
      ),
    ).toEqual({
      disabled: true,
      maximumTop: 0,
      thumbHeightPx: 300,
      thumbOffsetPx: 0,
      travelPx: 0,
    });
  });

  it('enforces a 44 px thumb and maps the full track to logical lines', () => {
    const geometry = calculateScrollbarGeometry(
      { maximumTop: 970, currentTop: 485, visibleRows: 30 },
      220,
    );

    expect(geometry.thumbHeightPx).toBeGreaterThanOrEqual(44);
    expect(lineForTrackOffset(0, geometry)).toBe(0);
    expect(lineForTrackOffset(220, geometry)).toBe(970);
  });

  it('keeps geometry finite and bounded for non-finite and negative inputs', () => {
    const metrics = {
      maximumTop: Number.POSITIVE_INFINITY,
      currentTop: Number.NaN,
      visibleRows: -12,
    } as TerminalScrollMetrics;

    const geometry = calculateScrollbarGeometry(metrics, Number.NaN);

    expect(geometry.maximumTop).toBe(0);
    expect(geometry.disabled).toBe(true);
    expect(Number.isFinite(geometry.thumbHeightPx)).toBe(true);
    expect(Number.isFinite(geometry.thumbOffsetPx)).toBe(true);
    expect(Number.isFinite(geometry.travelPx)).toBe(true);
    expect(geometry.thumbOffsetPx).toBeGreaterThanOrEqual(0);
    expect(geometry.thumbOffsetPx).toBeLessThanOrEqual(geometry.travelPx);
  });

  it('keeps a short track bounded when minimum thumb exceeds track height', () => {
    const geometry = calculateScrollbarGeometry(
      { maximumTop: 120, currentTop: 60, visibleRows: 30 },
      30,
    );

    expect(geometry.disabled).toBe(false);
    expect(geometry.thumbHeightPx).toBe(30);
    expect(geometry.thumbOffsetPx).toBe(0);
    expect(geometry.travelPx).toBe(0);
    expect(lineForTrackOffset(-999, geometry)).toBe(0);
    expect(lineForTrackOffset(999, geometry)).toBe(0);
  });

  it('projects fractional track offsets deterministically and within bounds', () => {
    const geometry = calculateScrollbarGeometry(
      { maximumTop: 333, currentTop: 111, visibleRows: 27 },
      220.5,
    );

    expect(lineForTrackOffset(-1000, geometry)).toBe(0);
    expect(lineForTrackOffset(220.5, geometry)).toBe(333);
  });
});
