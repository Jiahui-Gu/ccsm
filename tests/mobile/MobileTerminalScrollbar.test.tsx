import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { MobileTerminalScrollbar } from '../../src/mobile/components/MobileTerminalScrollbar';
import {
  calculateScrollbarGeometry,
  lineForTrackOffset,
} from '../../src/mobile/terminalScrollMetrics';

type ScrollMetrics = {
  maximumTop: number;
  currentTop: number;
  visibleRows: number;
};

type ObserverRecord = {
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  target: Element | null;
};

type PointerCaptureShim = {
  setPointerCapture: ReturnType<typeof vi.fn>;
  releasePointerCapture: ReturnType<typeof vi.fn>;
  hasPointerCapture: ReturnType<typeof vi.fn>;
};

const DEFAULT_METRICS: ScrollMetrics = {
  maximumTop: 100,
  currentTop: 20,
  visibleRows: 25,
};

let observerRecords: ObserverRecord[] = [];
const originalResizeObserver = globalThis.ResizeObserver;

function rect(top: number, height: number, width = 24): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function installPointerCaptureShim(rail: HTMLElement): PointerCaptureShim {
  const captured = new Set<number>();
  const setPointerCapture = vi.fn((pointerId: number) => {
    captured.add(pointerId);
  });
  const releasePointerCapture = vi.fn((pointerId: number) => {
    captured.delete(pointerId);
  });
  const hasPointerCapture = vi.fn((pointerId: number) => captured.has(pointerId));

  Object.assign(rail as HTMLElement & Partial<PointerCaptureShim>, {
    setPointerCapture,
    releasePointerCapture,
    hasPointerCapture,
  });

  return { setPointerCapture, releasePointerCapture, hasPointerCapture };
}

function emitRailResize(rail: HTMLElement, height: number): void {
  const record = observerRecords.find((candidate) => candidate.target === rail);
  expect(record).toBeDefined();
  record?.callback(
    [
      {
        target: rail,
        contentRect: rect(0, height),
      } as ResizeObserverEntry,
    ],
    {} as ResizeObserver,
  );
}

function measureRail(rail: HTMLElement, top: number, height: number): void {
  vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue(rect(top, height));
  act(() => {
    emitRailResize(rail, height);
  });
}

function renderScrollbar(metrics: ScrollMetrics = DEFAULT_METRICS) {
  const onScrollToLine = vi.fn();
  const onScrollLines = vi.fn();

  const utils = render(
    <>
      <textarea className="xterm-helper-textarea" aria-label="helper" />
      <MobileTerminalScrollbar
        terminalId="phone-terminal-output"
        metrics={metrics}
        onScrollToLine={onScrollToLine}
        onScrollLines={onScrollLines}
      />
    </>,
  );

  const rail = screen.getByRole('scrollbar', {
    name: /terminal output scroll position/i,
  });
  const thumb = rail.querySelector('[data-part="thumb"]') as HTMLElement;

  return {
    ...utils,
    rail,
    thumb,
    onScrollToLine,
    onScrollLines,
  };
}

describe('MobileTerminalScrollbar', () => {
  beforeEach(() => {
    observerRecords = [];

    class ResizeObserverMock {
      private record: ObserverRecord;

      constructor(callback: ResizeObserverCallback) {
        this.record = {
          callback,
          observe: vi.fn((target: Element) => {
            this.record.target = target;
          }),
          disconnect: vi.fn(),
          target: null,
        };
        observerRecords.push(this.record);
      }

      observe(target: Element): void {
        this.record.observe(target);
      }

      unobserve(): void {}

      disconnect(): void {
        this.record.disconnect();
      }
    }

    (globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver =
      ResizeObserverMock;
  });

  afterEach(() => {
    if (originalResizeObserver) {
      (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
        originalResizeObserver;
    } else {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
    vi.restoreAllMocks();
  });

  it('renders persistent accessible semantics and a disabled full-height thumb', () => {
    const { rail, thumb, onScrollLines, onScrollToLine } = renderScrollbar({
      maximumTop: 0,
      currentTop: 0,
      visibleRows: 25,
    });
    installPointerCaptureShim(rail);
    measureRail(rail, 100, 180);

    expect(rail).toHaveAttribute('aria-orientation', 'vertical');
    expect(rail).toHaveAttribute('aria-controls', 'phone-terminal-output');
    expect(rail).toHaveAttribute('aria-valuemin', '0');
    expect(rail).toHaveAttribute('aria-valuemax', '0');
    expect(rail).toHaveAttribute('aria-valuenow', '0');
    expect(rail).toHaveAttribute('aria-disabled', 'true');
    expect(rail).toHaveAttribute('tabindex', '0');
    expect(thumb.style.height).toBe('180px');

    fireEvent.pointerDown(rail, { pointerId: 9, clientY: 140 });
    fireEvent.keyDown(rail, { key: 'ArrowDown' });

    expect(onScrollToLine).not.toHaveBeenCalled();
    expect(onScrollLines).not.toHaveBeenCalled();
  });

  it('captures track drags, jumps to centered target line, and releases on pointerup', () => {
    const { rail, onScrollToLine } = renderScrollbar();
    const pointer = installPointerCaptureShim(rail);
    measureRail(rail, 100, 200);

    const geometry = calculateScrollbarGeometry(DEFAULT_METRICS, 200);
    const expectedFirst = lineForTrackOffset(80, geometry);

    const pointerDown = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 3,
      clientY: 180,
    });
    const stopPointerDown = vi.fn();
    Object.defineProperty(pointerDown, 'stopPropagation', { value: stopPointerDown });
    rail.dispatchEvent(pointerDown);

    expect(pointer.setPointerCapture).toHaveBeenCalledWith(3);
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(stopPointerDown).toHaveBeenCalled();
    expect(onScrollToLine).toHaveBeenCalledWith(expectedFirst);

    fireEvent.pointerMove(rail, { pointerId: 3, clientY: 260 });
    expect(onScrollToLine).toHaveBeenCalledTimes(2);

    fireEvent.pointerUp(rail, { pointerId: 3 });
    expect(pointer.releasePointerCapture).toHaveBeenCalledWith(3);
    const callsAfterRelease = onScrollToLine.mock.calls.length;
    fireEvent.pointerMove(rail, { pointerId: 3, clientY: 280 });
    expect(onScrollToLine.mock.calls).toHaveLength(callsAfterRelease);
    expect(document.activeElement).not.toHaveClass('xterm-helper-textarea');
  });

  it('starts thumb drag with grabbed offset and avoids an initial jump', () => {
    const metrics: ScrollMetrics = {
      maximumTop: 100,
      currentTop: 40,
      visibleRows: 25,
    };
    const { rail, thumb, onScrollToLine } = renderScrollbar(metrics);
    const pointer = installPointerCaptureShim(rail);
    measureRail(rail, 100, 200);

    const geometry = calculateScrollbarGeometry(metrics, 200);
    const thumbTop = geometry.thumbOffsetPx;
    fireEvent.pointerDown(thumb, {
      pointerId: 5,
      clientY: 100 + thumbTop + 8,
    });

    expect(pointer.setPointerCapture).toHaveBeenCalledWith(5);
    expect(onScrollToLine).not.toHaveBeenCalled();

    fireEvent.pointerMove(rail, {
      pointerId: 5,
      clientY: 100 + thumbTop + 40,
    });

    expect(onScrollToLine).toHaveBeenCalledTimes(1);
    expect(onScrollToLine.mock.calls[0]?.[0]).toBeGreaterThan(metrics.currentTop);
  });

  it('maps keyboard controls, preserves unknown keys, and prevents handled defaults', () => {
    const { rail, onScrollLines, onScrollToLine } = renderScrollbar();
    measureRail(rail, 100, 200);

    const arrowDown = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    const stopArrow = vi.fn();
    Object.defineProperty(arrowDown, 'stopPropagation', { value: stopArrow });
    rail.dispatchEvent(arrowDown);
    expect(onScrollLines).toHaveBeenCalledWith(1);
    expect(arrowDown.defaultPrevented).toBe(true);
    expect(stopArrow).toHaveBeenCalled();

    fireEvent.keyDown(rail, { key: 'ArrowUp' });
    fireEvent.keyDown(rail, { key: 'PageDown' });
    fireEvent.keyDown(rail, { key: 'PageUp' });
    expect(onScrollLines).toHaveBeenNthCalledWith(2, -1);
    expect(onScrollLines).toHaveBeenNthCalledWith(3, DEFAULT_METRICS.visibleRows);
    expect(onScrollLines).toHaveBeenNthCalledWith(4, -DEFAULT_METRICS.visibleRows);

    fireEvent.keyDown(rail, { key: 'Home' });
    fireEvent.keyDown(rail, { key: 'End' });
    expect(onScrollToLine).toHaveBeenNthCalledWith(1, 0);
    expect(onScrollToLine).toHaveBeenNthCalledWith(2, DEFAULT_METRICS.maximumTop);

    const unknown = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    const stopUnknown = vi.fn();
    Object.defineProperty(unknown, 'stopPropagation', { value: stopUnknown });
    rail.dispatchEvent(unknown);

    expect(unknown.defaultPrevented).toBe(false);
    expect(stopUnknown).not.toHaveBeenCalled();
    expect(onScrollLines).toHaveBeenCalledTimes(4);
    expect(onScrollToLine).toHaveBeenCalledTimes(2);
  });

  it('handles pointercancel and lostpointercapture cleanup and disconnects ResizeObserver', () => {
    const { rail, onScrollToLine, unmount } = renderScrollbar();
    const pointer = installPointerCaptureShim(rail);
    measureRail(rail, 10, 220.5);

    fireEvent.pointerDown(rail, { pointerId: 11, clientY: 120 });
    expect(onScrollToLine).toHaveBeenCalledTimes(1);

    fireEvent.pointerCancel(rail, { pointerId: 11 });
    expect(pointer.releasePointerCapture).toHaveBeenCalledWith(11);

    const callCountAfterCancel = onScrollToLine.mock.calls.length;
    fireEvent.pointerMove(rail, { pointerId: 11, clientY: 180 });
    expect(onScrollToLine.mock.calls).toHaveLength(callCountAfterCancel);

    fireEvent.pointerDown(rail, { pointerId: 12, clientY: 150 });
    const callCountBeforeLostCapture = onScrollToLine.mock.calls.length;
    fireEvent(
      rail,
      new PointerEvent('lostpointercapture', { bubbles: true, cancelable: true, pointerId: 12 }),
    );
    fireEvent.pointerMove(rail, { pointerId: 12, clientY: 200 });
    expect(onScrollToLine.mock.calls).toHaveLength(callCountBeforeLostCapture);

    unmount();
    expect(observerRecords[0]?.disconnect).toHaveBeenCalledOnce();
  });
});
