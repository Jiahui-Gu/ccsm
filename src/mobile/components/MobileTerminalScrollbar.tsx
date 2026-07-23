import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import type { TerminalScrollMetrics } from '../mobileTerminalAdapter';
import { calculateScrollbarGeometry, lineForTrackOffset } from '../terminalScrollMetrics';

export type MobileTerminalScrollbarProps = {
  terminalId: string;
  metrics: TerminalScrollMetrics;
  onScrollToLine(line: number): void;
  onScrollLines(lines: number): void;
};

type DragState = {
  pointerId: number;
  grabbedOffsetPx: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitizeRailHeight(height: number): number {
  return Number.isFinite(height) && height > 0 ? height : 0;
}

function sanitizeVisibleRows(visibleRows: number): number {
  const normalized = Math.trunc(Number.isFinite(visibleRows) ? visibleRows : 0);
  return normalized > 0 ? normalized : 1;
}

export function MobileTerminalScrollbar({
  terminalId,
  metrics,
  onScrollToLine,
  onScrollLines,
}: MobileTerminalScrollbarProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [trackHeightPx, setTrackHeightPx] = useState(0);

  const geometry = useMemo(
    () => calculateScrollbarGeometry(metrics, trackHeightPx),
    [metrics, trackHeightPx],
  );

  const clampedCurrentTop = useMemo(() => {
    const currentTop = Number.isFinite(metrics.currentTop) ? Math.trunc(metrics.currentTop) : 0;
    return clamp(currentTop, 0, geometry.maximumTop);
  }, [geometry.maximumTop, metrics.currentTop]);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail || typeof ResizeObserver !== 'function') return;

    const updateHeight = (nextHeight: number) => {
      const normalized = sanitizeRailHeight(nextHeight);
      setTrackHeightPx((previous) => (previous === normalized ? previous : normalized));
    };

    updateHeight(rail.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height ?? rail.getBoundingClientRect().height;
      updateHeight(nextHeight);
    });
    observer.observe(rail);

    return () => {
      observer.disconnect();
    };
  }, []);

  const readPointerOffset = (clientY: number): number => {
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    return clientY - rect.top;
  };

  const clearDrag = (pointerId?: number): void => {
    const rail = railRef.current;
    if (rail && typeof pointerId === 'number' && typeof rail.releasePointerCapture === 'function') {
      try {
        rail.releasePointerCapture(pointerId);
      } catch {
        // best effort cleanup when capture was already lost
      }
    }
    dragRef.current = null;
  };

  const scrollFromDrag = (pointerOffsetPx: number, drag: DragState): void => {
    if (geometry.disabled) return;
    const desiredThumbTop = pointerOffsetPx - drag.grabbedOffsetPx;
    const centeredOffset = desiredThumbTop + geometry.thumbHeightPx / 2;
    onScrollToLine(lineForTrackOffset(centeredOffset, geometry));
  };

  const beginDrag = (pointerId: number, grabbedOffsetPx: number): void => {
    dragRef.current = { pointerId, grabbedOffsetPx };
    const rail = railRef.current;
    if (rail && typeof rail.setPointerCapture === 'function') {
      rail.setPointerCapture(pointerId);
    }
  };

  const handleRailPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (geometry.disabled) return;

    beginDrag(event.pointerId, geometry.thumbHeightPx / 2);
    const pointerOffsetPx = readPointerOffset(event.clientY);
    const drag = dragRef.current;
    if (!drag) return;
    scrollFromDrag(pointerOffsetPx, drag);
  };

  const handleThumbPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (geometry.disabled) return;

    const pointerOffsetPx = readPointerOffset(event.clientY);
    const grabbedOffsetPx = clamp(
      pointerOffsetPx - geometry.thumbOffsetPx,
      0,
      geometry.thumbHeightPx,
    );
    beginDrag(event.pointerId, grabbedOffsetPx);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();

    const drag = dragRef.current;
    if (geometry.disabled || !drag || drag.pointerId !== event.pointerId) return;

    const pointerOffsetPx = readPointerOffset(event.clientY);
    scrollFromDrag(pointerOffsetPx, drag);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    clearDrag(event.pointerId);
  };

  const handlePointerCancel = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    clearDrag(event.pointerId);
  };

  const handleLostPointerCapture = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();

    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const key = event.key;
    const pageSize = sanitizeVisibleRows(metrics.visibleRows);

    if (key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      if (!geometry.disabled) onScrollToLine(0);
      return;
    }

    if (key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      if (!geometry.disabled) onScrollToLine(geometry.maximumTop);
      return;
    }

    const lineDelta =
      key === 'ArrowUp'
        ? -1
        : key === 'ArrowDown'
          ? 1
          : key === 'PageUp'
            ? -pageSize
            : key === 'PageDown'
              ? pageSize
              : null;

    if (lineDelta === null) return;

    event.preventDefault();
    event.stopPropagation();
    if (!geometry.disabled) onScrollLines(lineDelta);
  };

  return (
    <div className="mobile-terminal-scrollbar" aria-hidden={false}>
      <div
        ref={railRef}
        className="mobile-terminal-scrollbar__rail"
        style={{ width: '24px' }}
        role="scrollbar"
        tabIndex={0}
        aria-label="Terminal output scroll position"
        aria-orientation="vertical"
        aria-controls={terminalId}
        aria-valuemin={0}
        aria-valuemax={geometry.maximumTop}
        aria-valuenow={clampedCurrentTop}
        aria-disabled={geometry.disabled}
        onPointerDown={handleRailPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        onKeyDown={handleKeyDown}
      >
        <div
          data-part="thumb"
          className="mobile-terminal-scrollbar__thumb"
          style={{
            top: `${geometry.thumbOffsetPx}px`,
            height: `${geometry.thumbHeightPx}px`,
          }}
          onPointerDown={handleThumbPointerDown}
        />
      </div>
    </div>
  );
}

