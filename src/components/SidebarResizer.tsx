import React, { useCallback, useRef } from 'react';
import {
  useStore,
  sanitizeSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX
} from '../stores/store';
import { useTranslation } from '../i18n/useTranslation';

/**
 * 4px wide draggable handle between Sidebar and main pane.
 *
 *  - Pointer drag updates `sidebarWidth` (px), clamped to [200, 480].
 *  - Double-click resets to the default width.
 *  - Keyboard accessible (#263): tabbable, ArrowLeft/Right resize by 8px,
 *    Shift+Arrow by 32px, Home/End snap to min/max, Enter/Esc blur.
 *  - Listeners attach on `pointerdown` and detach on `pointerup`/`pointercancel`
 *    so we never leak.
 *  - Body cursor + select are locked during drag so the cursor doesn't flicker
 *    over child elements and text doesn't get accidentally selected.
 */
export const SIDEBAR_RESIZER_STEP = 8;
export const SIDEBAR_RESIZER_STEP_LARGE = 32;

export function SidebarResizer() {
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const resetSidebarWidth = useStore((s) => s.resetSidebarWidth);
  const dragging = useRef(false);
  const { t } = useTranslation('sidebar');

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

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const current = useStore.getState().sidebarWidth;
      const step = e.shiftKey ? SIDEBAR_RESIZER_STEP_LARGE : SIDEBAR_RESIZER_STEP;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          setSidebarWidth(sanitizeSidebarWidth(current - step));
          break;
        case 'ArrowRight':
          e.preventDefault();
          setSidebarWidth(sanitizeSidebarWidth(current + step));
          break;
        case 'Home':
          e.preventDefault();
          setSidebarWidth(SIDEBAR_WIDTH_MIN);
          break;
        case 'End':
          e.preventDefault();
          setSidebarWidth(SIDEBAR_WIDTH_MAX);
          break;
        case 'Enter':
        case 'Escape':
          e.preventDefault();
          (e.currentTarget as HTMLDivElement).blur();
          break;
        default:
          break;
      }
    },
    [setSidebarWidth]
  );

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('resizerAriaLabel')}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuenow={sidebarWidth}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={resetSidebarWidth}
      title={t('resizerTooltip', { default: SIDEBAR_WIDTH_DEFAULT })}
      className="pane-resize-handle focus-ring shrink-0"
    />
  );
}
