import type { TerminalScrollMetrics } from './mobileTerminalAdapter';

export type ScrollbarGeometry = {
  disabled: boolean;
  maximumTop: number;
  thumbHeightPx: number;
  thumbOffsetPx: number;
  travelPx: number;
};

function sanitizeFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitizeNonNegativeInteger(value: number): number {
  const normalized = Math.trunc(sanitizeFinite(value, 0));
  return normalized > 0 ? normalized : 0;
}

function sanitizeTrackHeight(trackHeightPx: number): number {
  const normalized = sanitizeFinite(trackHeightPx, 0);
  return normalized > 0 ? normalized : 0;
}

function sanitizeMinimumThumb(minimumThumbPx: number): number {
  const normalized = sanitizeFinite(minimumThumbPx, 44);
  return normalized > 0 ? normalized : 44;
}

export function calculateScrollbarGeometry(
  metrics: TerminalScrollMetrics,
  trackHeightPx: number,
  minimumThumbPx = 44,
): ScrollbarGeometry {
  const track = sanitizeTrackHeight(trackHeightPx);
  const maximumTop = sanitizeNonNegativeInteger(metrics.maximumTop);
  const currentTop = clamp(sanitizeNonNegativeInteger(metrics.currentTop), 0, maximumTop);

  if (maximumTop === 0 || track === 0) {
    return {
      disabled: true,
      maximumTop,
      thumbHeightPx: track,
      thumbOffsetPx: 0,
      travelPx: 0,
    };
  }

  const visibleRows = Math.max(1, sanitizeNonNegativeInteger(metrics.visibleRows));
  const minimumThumb = sanitizeMinimumThumb(minimumThumbPx);
  const totalRows = maximumTop + visibleRows;
  const proportionalThumb = track * (visibleRows / totalRows);
  const thumbHeightPx = clamp(Math.max(minimumThumb, proportionalThumb), 0, track);
  const travelPx = Math.max(0, track - thumbHeightPx);
  const thumbOffsetPx =
    travelPx <= 0 || maximumTop <= 0 ? 0 : clamp((travelPx * currentTop) / maximumTop, 0, travelPx);

  return {
    disabled: false,
    maximumTop,
    thumbHeightPx,
    thumbOffsetPx,
    travelPx,
  };
}

export function lineForTrackOffset(offsetPx: number, geometry: ScrollbarGeometry): number {
  const maximumTop = sanitizeNonNegativeInteger(geometry.maximumTop);
  if (maximumTop === 0 || geometry.disabled || !Number.isFinite(geometry.travelPx) || geometry.travelPx <= 0) {
    return 0;
  }

  const trackOffset = sanitizeFinite(offsetPx, 0);
  const thumbHeightPx = sanitizeTrackHeight(geometry.thumbHeightPx);
  const travelPx = sanitizeTrackHeight(geometry.travelPx);
  const desiredThumbTop = trackOffset - thumbHeightPx / 2;
  const clampedThumbTop = clamp(desiredThumbTop, 0, travelPx);
  return clamp(Math.round((maximumTop * clampedThumbTop) / travelPx), 0, maximumTop);
}
