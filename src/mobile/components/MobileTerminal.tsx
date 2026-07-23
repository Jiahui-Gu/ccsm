import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';

import { MobileTerminalScrollbar } from './MobileTerminalScrollbar';
import {
  createMobileTerminalAdapter,
  type MobileTerminalAdapter,
  type TerminalViewportAnchor,
  type TerminalViewportState,
} from '../mobileTerminalAdapter';
import type { TerminalRenderBatch } from '../mobileRemoteStore';

const DEFAULT_VIEWPORT_STATE: TerminalViewportState = {
  geometry: null,
  contentWidthPx: 0,
  scroll: { maximumTop: 0, currentTop: 0, visibleRows: 30 },
};

export type MobileTerminalAdapterFactory = (
  element: HTMLElement,
) => MobileTerminalAdapter;

export type MobileTerminalProps = {
  sid: string | null;
  batch: TerminalRenderBatch | null;
  onConsumed: (id: number) => void;
  adapterRef: MutableRefObject<MobileTerminalAdapter | null>;
  createAdapter?: MobileTerminalAdapterFactory;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function maxHorizontalOffset(viewport: HTMLDivElement): number {
  return Math.max(0, viewport.scrollWidth - viewport.clientWidth);
}

function finitePositive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function withHorizontalOffset(
  anchor: TerminalViewportAnchor,
  horizontalOffsetPx: number,
): TerminalViewportAnchor {
  return {
    ...anchor,
    horizontalOffsetPx,
  };
}

function canonicalColsFromBatch(batch: TerminalRenderBatch): number | null {
  for (let index = batch.effects.length - 1; index >= 0; index -= 1) {
    const effect = batch.effects[index];
    if (effect?.type === 'installSnapshot') return effect.geometry.cols;
  }
  return null;
}

function bottomAnchor(canonicalCols: number): TerminalViewportAnchor {
  return {
    mode: 'bottom',
    horizontalOffsetPx: 0,
    canonicalCols,
  };
}

export function MobileTerminal({
  sid,
  batch,
  onConsumed,
  adapterRef,
  createAdapter = createMobileTerminalAdapter,
}: MobileTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const activeSidRef = useRef<string | null>(sid);
  const sidChangedRef = useRef(false);
  const lastAppliedBatchIdRef = useRef(0);
  const anchorBySidRef = useRef(new Map<string, TerminalViewportAnchor>());
  const desiredHorizontalOffsetRef = useRef(0);
  const [viewportState, setViewportState] = useState<TerminalViewportState>(DEFAULT_VIEWPORT_STATE);
  const [viewportClientWidthPx, setViewportClientWidthPx] = useState(0);
  const [showLeftEdgeAffordance, setShowLeftEdgeAffordance] = useState(false);

  const readHorizontalOffset = (): number => {
    const viewport = viewportRef.current;
    if (!viewport) return 0;
    const measurableExtent = viewport.scrollWidth > 0 && viewport.clientWidth > 0;
    const maximumLeft = measurableExtent ? maxHorizontalOffset(viewport) : Number.MAX_SAFE_INTEGER;
    return clamp(viewport.scrollLeft, 0, maximumLeft);
  };

  const captureHorizontalOffset = (): void => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const clamped = readHorizontalOffset();
    desiredHorizontalOffsetRef.current = clamped;
    if (sid) {
      const existing = anchorBySidRef.current.get(sid);
      if (existing) {
        anchorBySidRef.current.set(sid, withHorizontalOffset(existing, clamped));
      }
    }
    const measurableExtent = viewport.scrollWidth > 0 && viewport.clientWidth > 0;
    const maximumLeft = measurableExtent ? maxHorizontalOffset(viewport) : 0;
    setShowLeftEdgeAffordance((measurableExtent && maximumLeft > 0) || clamped > 0);
  };

  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const adapter = createAdapter(hostRef.current);
    adapterRef.current = adapter;
    setViewportState(adapter.getViewportState());
    const unsubscribe = adapter.subscribeViewport((state) => {
      setViewportState(state);
    });
    return () => {
      unsubscribe();
      adapterRef.current = null;
      adapter.dispose();
    };
  }, [adapterRef, createAdapter]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver !== 'function') return;
    let previousWidth = viewport.clientWidth;
    setViewportClientWidthPx(previousWidth);
    const observer = new ResizeObserver(() => {
      const nextWidth = viewport.clientWidth;
      if (nextWidth === previousWidth) return;
      previousWidth = nextWidth;
      setViewportClientWidthPx(nextWidth);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const previousSid = activeSidRef.current;
    if (previousSid === sid) return;
    sidChangedRef.current = true;
    const adapter = adapterRef.current;
    if (previousSid && adapter) {
      const horizontalOffsetPx = readHorizontalOffset();
      anchorBySidRef.current.set(previousSid, adapter.captureAnchor(horizontalOffsetPx));
    }
    activeSidRef.current = sid;
    const restored = sid ? anchorBySidRef.current.get(sid) : undefined;
    desiredHorizontalOffsetRef.current = restored?.horizontalOffsetPx ?? 0;
  }, [adapterRef, sid]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (viewport.scrollWidth <= 0 || viewport.clientWidth <= 0) {
      setShowLeftEdgeAffordance(desiredHorizontalOffsetRef.current > 0);
      return;
    }
    const maximumLeft = maxHorizontalOffset(viewport);
    const clamped = clamp(desiredHorizontalOffsetRef.current, 0, maximumLeft);
    if (viewport.scrollLeft !== clamped) viewport.scrollLeft = clamped;
    desiredHorizontalOffsetRef.current = clamped;
    if (sid) {
      const existing = anchorBySidRef.current.get(sid);
      if (existing) {
        anchorBySidRef.current.set(sid, withHorizontalOffset(existing, clamped));
      }
    }
    setShowLeftEdgeAffordance(maximumLeft > 0 || clamped > 0);
  }, [sid, viewportClientWidthPx, viewportState.contentWidthPx, viewportState.geometry?.cols]);

  useLayoutEffect(() => {
    if (!batch || !sid || batch.sid !== sid || batch.id <= lastAppliedBatchIdRef.current) return;
    const adapter = adapterRef.current;
    if (!adapter) return;

    const existingAnchor = anchorBySidRef.current.get(sid);
    if (!sidChangedRef.current && existingAnchor) {
      const horizontalOffsetPx = readHorizontalOffset();
      anchorBySidRef.current.set(sid, adapter.captureAnchor(horizontalOffsetPx));
    }

    const canonicalCols =
      canonicalColsFromBatch(batch) ??
      viewportState.geometry?.cols ??
      anchorBySidRef.current.get(sid)?.canonicalCols ??
      0;
    const anchor = anchorBySidRef.current.get(sid) ?? bottomAnchor(canonicalCols);
    adapter.apply(batch.effects, anchor);
    sidChangedRef.current = false;
    lastAppliedBatchIdRef.current = batch.id;
    anchorBySidRef.current.set(sid, anchor);
    desiredHorizontalOffsetRef.current = anchor.horizontalOffsetPx;
    onConsumed(batch.id);
  }, [adapterRef, batch, onConsumed, sid, viewportState.geometry?.cols]);

  const gridWidthPx = finitePositive(viewportState.contentWidthPx);

  return (
    <div
      className={`mobile-terminal${showLeftEdgeAffordance ? ' mobile-terminal--left-edge-affordance-visible' : ''}`}
      aria-label="Terminal viewport"
    >
      <div className="mobile-terminal__left-edge-affordance" aria-hidden="true" />
      <div
        ref={viewportRef}
        className="mobile-terminal__viewport"
        onScroll={captureHorizontalOffset}
      >
        <div
          id="phone-terminal-output"
          ref={hostRef}
          className="mobile-terminal__grid"
          aria-label="Terminal output"
          style={gridWidthPx === null ? undefined : { width: `${gridWidthPx}px` }}
        />
      </div>
      <MobileTerminalScrollbar
        terminalId="phone-terminal-output"
        metrics={viewportState.scroll}
        onScrollToLine={(line) => adapterRef.current?.scrollToLine(line)}
        onScrollLines={(lines) => adapterRef.current?.scrollLines(lines)}
      />
    </div>
  );
}
