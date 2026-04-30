import { useEffect } from 'react';
import { DURATION, EASING } from '../lib/motion';

/**
 * Exit animation (UI-10 / #213):
 * When the user closes the window (Ctrl+W, X button) the Electron main
 * process hides-to-tray instead of destroying. It sends
 * `window:beforeHide` with a duration first so we can fade the whole
 * document out, then hides ~180ms later — giving the user a graceful
 * exit rather than an abrupt disappearance. On restore, `window:afterShow`
 * resets opacity. Uses the shared motion tokens (DURATION.standard /
 * EASING.exit) for consistency with the rest of the app.
 *
 * Implementation note: drives `document.documentElement.style.opacity`
 * directly instead of wrapping the React tree in a `<motion.div>` — a
 * root-level wrapper would be invasive and risk layout regressions,
 * while this approach is zero-DOM, zero-rerender, and survives when
 * React state is about to be torn down.
 *
 * Extracted from App.tsx for SRP under Task #758 Phase C.
 */
export function useExitAnimation(): void {
  useEffect(() => {
    const bridge = window.ccsm?.window;
    if (!bridge?.onBeforeHide || !bridge?.onAfterShow) return;
    const root = document.documentElement;
    const transition = `opacity ${DURATION.standard}s cubic-bezier(${EASING.exit.join(',')})`;
    const offHide = bridge.onBeforeHide(() => {
      root.style.transition = transition;
      root.style.opacity = '0';
    });
    const offShow = bridge.onAfterShow(() => {
      root.style.transition = transition;
      root.style.opacity = '1';
    });
    return () => {
      offHide();
      offShow();
      root.style.transition = '';
      root.style.opacity = '';
    };
  }, []);
}
