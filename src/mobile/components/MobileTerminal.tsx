// React lifecycle wrapper around the long-lived, read-only xterm adapter
// (`createMobileTerminalAdapter`). Renders a single host `div` and owns the
// adapter's create/apply/dispose lifecycle; it never manages keyboard focus
// itself — the terminal stays read/scroll/select/copy only.
//
// The adapter is created exactly once per mount (keyed only by stable adapter
// dependencies, never by `batch`), and disposed exactly once on unmount.
// Each numbered `TerminalRenderBatch` is
// applied at most once, in `useLayoutEffect` so the DOM reflects new PTY
// output before the browser paints, and `onConsumed` is only called after a
// successful `apply`.
//
// Both the adapter-creation effect and the batch-application effect are
// `useLayoutEffect`, and the adapter-creation one is declared FIRST. React
// runs same-phase effects (all `useLayoutEffect`s before any `useEffect`) in
// declaration order within a component, so this guarantees the adapter
// exists in `adapterRef` before the batch effect runs in the very same
// commit — including the first mount, when `batch` can already be non-null
// (e.g. a snapshot batch queued by the store before this component ever
// rendered). Using `useEffect` for adapter creation would defer it until
// after paint, one tick later than the batch effect, silently dropping
// whatever batch was already queued on that first render.

import { useLayoutEffect, useRef, type MutableRefObject } from 'react';

import {
  createMobileTerminalAdapter,
  type MobileTerminalAdapter,
} from '../mobileTerminalAdapter';
import type { TerminalRenderBatch } from '../mobileRemoteStore';

export type MobileTerminalAdapterFactory = (
  element: HTMLElement,
) => MobileTerminalAdapter;

export type MobileTerminalProps = {
  batch: TerminalRenderBatch | null;
  onConsumed: (id: number) => void;
  adapterRef: MutableRefObject<MobileTerminalAdapter | null>;
  // Test seam: inject a fake adapter factory for component tests instead of
  // unsafely mocking the `@xterm/xterm` module. Defaults to the real
  // adapter at runtime.
  createAdapter?: MobileTerminalAdapterFactory;
};

export function MobileTerminal({
  batch,
  onConsumed,
  adapterRef,
  createAdapter = createMobileTerminalAdapter,
}: MobileTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const lastAppliedBatch = useRef(0);

  // Declared before the batch-application effect below so the adapter is
  // guaranteed to exist in `adapterRef` by the time that effect runs in the
  // same commit (see the module doc above) — order matters here.
  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const adapter = createAdapter(hostRef.current);
    adapterRef.current = adapter;
    return () => {
      adapterRef.current = null;
      adapter.dispose();
    };
  }, [adapterRef, createAdapter]);

  useLayoutEffect(() => {
    if (!batch || batch.id <= lastAppliedBatch.current || !adapterRef.current) return;
    adapterRef.current.apply(batch.effects);
    lastAppliedBatch.current = batch.id;
    onConsumed(batch.id);
  }, [adapterRef, batch, onConsumed]);

  return <div ref={hostRef} className="mobile-terminal" aria-label="Terminal output" />;
}
