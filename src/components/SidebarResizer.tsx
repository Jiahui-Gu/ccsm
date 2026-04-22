import React, { useCallback, useRef } from 'react';
import {
  useStore,
  sanitizeSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX
} from '../stores/store';

/**
 * 4px wide draggable handle between Sidebar and main pane.
 *
 *  - Pointer drag updates `sidebarWidth` (px), clamped to [200, 480].
 *  - Double-click resets to the default width.
 *  - Listeners attach on `pointerdown` and detach on `pointerup`/`pointercancel`
 *    so we never leak.
 *  - Body cursor + select are locked during drag so the cursor doesn't flicker
 *    over child elements and text doesn't get accidentally selected.
 */
export function SidebarResizer() {
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const resetSidebarWidth = useStore((s) => s.resetSidebarWidth);
  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = useStore.getState().sidebarWidth;
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      dragging.current = true;

      const move = (ev: PointerEvent) => {
        setSidebarWidth(sanitizeSidebarWidth(startWidth + (ev.clientX - startX)));
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousSelect;
        dragging.current = false;
      };

      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    },
    [setSidebarWidth]
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuenow={sidebarWidth}
      onPointerDown={onPointerDown}
      onDoubleClick={resetSidebarWidth}
      title={`Drag to resize · double-click to reset (${SIDEBAR_WIDTH_DEFAULT}px)`}
      className="group/resizer relative w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-border-strong active:bg-accent transition-colors duration-150 select-none"
    />
  );
}
