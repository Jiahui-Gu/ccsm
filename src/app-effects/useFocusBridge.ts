import { useEffect } from 'react';

/**
 * Subscribes to the window `focus` event and runs the supplied callback
 * each time ccsm regains OS focus. In App.tsx the production callback
 * clears the active session's attention halo (per the notify spec: the
 * row the user is returning to drops its halo because they're here, the
 * breadcrumb has done its job). Other 'waiting' rows keep the halo
 * until the user actually clicks them.
 *
 * Extracted from App.tsx for SRP under Task #724. The callback is
 * injected (not hardcoded) so the hook stays pure and testable; App.tsx
 * supplies the store-mutating closure at the call site.
 */
export function useFocusBridge(onFocus: () => void): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [onFocus]);
}
