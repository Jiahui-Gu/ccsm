import { useEffect, type RefObject } from 'react';
import { getTerm, getFit, getActiveSid } from './xtermSingleton';

/**
 * ResizeObserver hook: observes `hostRef` and, after an 80ms debounce,
 * runs `fit.fit()` on the singleton terminal and pushes the new
 * cols/rows to the active PTY via `window.ccsmPty.resize`. No-op if
 * the singleton hasn't initialised yet or no session is attached.
 */
export function useTerminalResize(hostRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const term = getTerm();
        const fit = getFit();
        const activeSid = getActiveSid();
        if (!term || !fit || !activeSid) return;
        try {
          fit.fit();
          const { cols, rows } = term;
          window.ccsmPty?.resize(activeSid, cols, rows);
        } catch (e) {
          console.warn('[TerminalPane] fit failed', e);
        }
      }, 80);
    });
    ro.observe(host);
    return () => {
      if (debounce) clearTimeout(debounce);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
