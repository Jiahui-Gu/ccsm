import { useEffect, type RefObject } from 'react';
import { ensureTerminal } from './xtermSingleton';

/**
 * Mount-once hook: instantiates the module-singleton xterm against the
 * provided host div on first render. Idempotent across remounts — calls
 * `ensureTerminal` which itself caches.
 *
 * The singleton (term, addons, key handler, selection→clipboard auto-copy,
 * `window.__ccsmTerm` probe handle) is created lazily inside the effect so
 * we never run xterm constructors at import time (would explode in non-DOM
 * test environments).
 */
export function useXtermSingleton(hostRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    if (!hostRef.current) return;
    ensureTerminal(hostRef.current);
    // hostRef is a stable ref — no deps needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
