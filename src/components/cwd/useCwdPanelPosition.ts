import type React from 'react';
import { useLayoutEffect, useState } from 'react';

// Minimum panel width — must match the `min-w-[320px]` Tailwind class on the
// rendered panel. We clamp the computed `left` so popovers anchored close to
// the right edge of the screen never overflow off-screen.
const PANEL_MIN_WIDTH = 320;
const VIEWPORT_PADDING = 8;

export type PanelPosition = { top: number; left: number };

/**
 * Controlled-mode panel positioning. We compute screen coords from the
 * external anchor's bounding rect on every open + on resize/scroll while
 * open. Returns `null` until measured — caller should defer rendering the
 * panel in controlled mode until a position is available, otherwise an
 * unpositioned static block briefly pushes neighboring layout.
 *
 * Returned position is intended to be used as `position: 'fixed'` so the
 * panel escapes any clipping ancestors (sidebar uses `overflow:hidden` +
 * `backdrop-filter` which together would clip a non-portaled fixed
 * descendant — see PR #598).
 */
export function useCwdPanelPosition(
  anchorRef:
    | React.RefObject<HTMLElement>
    | React.RefObject<HTMLElement | null>
    | null
    | undefined,
  open: boolean,
  enabled: boolean
): PanelPosition | null {
  const [panelPos, setPanelPos] = useState<PanelPosition | null>(null);

  useLayoutEffect(() => {
    if (!enabled || !open) return;
    const anchor = anchorRef?.current;
    if (!anchor) return;
    const recompute = () => {
      const r = anchor.getBoundingClientRect();
      const top = r.bottom + 4;
      const maxLeft = window.innerWidth - PANEL_MIN_WIDTH - VIEWPORT_PADDING;
      const left = Math.max(VIEWPORT_PADDING, Math.min(r.left, maxLeft));
      setPanelPos({ top, left });
    };
    recompute();
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
      setPanelPos(null);
    };
  }, [anchorRef, enabled, open]);

  return panelPos;
}
