// React lifecycle wrapper around the long-lived, read-only xterm adapter
// (`createMobileTerminalAdapter`). Renders a single host `div` and owns the
// adapter's create/apply/dispose lifecycle; it never manages keyboard focus
// itself — the terminal stays read/scroll/select/copy only.
//
// The adapter is created exactly once per mount (keyed only by the stable
// `onResize` callback identity, not by `batch` or any other prop), and
// disposed exactly once on unmount. Each numbered `TerminalRenderBatch` is
// applied at most once, in `useLayoutEffect` so the DOM reflects new PTY
// output before the browser paints, and `onConsumed` is only called after a
// successful `apply`.

import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';

import {
  createMobileTerminalAdapter,
  type MobileTerminalAdapter,
  type MobileTerminalDimensions,
} from '../mobileTerminalAdapter';
import type { TerminalRenderBatch } from '../mobileRemoteStore';

export type MobileTerminalAdapterFactory = (
  element: HTMLElement,
  options: { onResize: (dimensions: MobileTerminalDimensions) => void },
) => MobileTerminalAdapter;

export type MobileTerminalProps = {
  batch: TerminalRenderBatch | null;
  onResize: (dimensions: MobileTerminalDimensions) => void;
  onConsumed: (id: number) => void;
  adapterRef: MutableRefObject<MobileTerminalAdapter | null>;
  // Test seam: inject a fake adapter factory for component tests instead of
  // unsafely mocking the `@xterm/xterm` module. Defaults to the real
  // adapter at runtime.
  createAdapter?: MobileTerminalAdapterFactory;
};

export function MobileTerminal({
  batch,
  onResize,
  onConsumed,
  adapterRef,
  createAdapter = createMobileTerminalAdapter,
}: MobileTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const lastAppliedBatch = useRef(0);

  useEffect(() => {
    if (!hostRef.current) return;
    const adapter = createAdapter(hostRef.current, { onResize });
    adapterRef.current = adapter;
    return () => {
      adapterRef.current = null;
      adapter.dispose();
    };
  }, [adapterRef, createAdapter, onResize]);

  useLayoutEffect(() => {
    if (!batch || batch.id <= lastAppliedBatch.current || !adapterRef.current) return;
    adapterRef.current.apply(batch.effects);
    lastAppliedBatch.current = batch.id;
    onConsumed(batch.id);
  }, [adapterRef, batch, onConsumed]);

  return <div ref={hostRef} className="mobile-terminal" aria-label="Terminal output" />;
}
