import { useEffect, type RefObject } from 'react';
import { getTerm, getFit, getActiveSid, getSnapshotReplay } from './xtermSingleton';

/**
 * ResizeObserver hook: observes `hostRef` and, after an 80ms debounce,
 * runs `fit.fit()` on the singleton terminal and pushes the new
 * cols/rows to the active PTY via `window.ccsmPty.resize`. No-op if
 * the singleton hasn't initialised yet or no session is attached.
 *
 * L4 PR-D (#866): after the backend resize IPC settles (which resizes
 * BOTH the PTY and the headless source-of-truth buffer — the latter
 * triggers xterm's reflow on the cell grid), invoke the
 * snapshot-replay handler installed by `usePtyAttach`. The replay
 * resets the visible xterm and re-writes from the freshly-reflowed
 * headless snapshot, so the user sees a correctly-wrapped buffer
 * WITHOUT depending on claude voluntarily repainting (claude's TUI
 * is alt-screen and does not repaint on SIGWINCH unless input
 * arrives — same root cause as #852). PTY resize still propagates so
 * subsequent claude output is sized correctly.
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
          // Backend resize first — `lifecycle.resize` resizes both the
          // pty and the headless mirror. The headless reflow is what we
          // re-snapshot from in the next step.
          const resizePromise = window.ccsmPty?.resize(activeSid, cols, rows);
          // L4 PR-D (#866): replay from the reflowed headless buffer
          // after the backend resize settles. The replay is best-effort —
          // a failure here leaves the visible xterm with the pre-reflow
          // grid; the next live chunk from claude will still write
          // correctly because the pty IS resized.
          const replay = getSnapshotReplay();
          if (replay) {
            const p = resizePromise && typeof (resizePromise as Promise<void>).then === 'function'
              ? (resizePromise as Promise<void>)
              : Promise.resolve();
            void p
              .then(() => replay())
              .catch((e) => console.warn('[TerminalPane] resize replay failed', e));
          }
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
