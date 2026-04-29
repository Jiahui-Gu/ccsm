import { useEffect } from 'react';

/**
 * Locale: ask main for the OS locale, feed it into the preferences store
 * so a "system" preference resolves correctly. Falls back to navigator.
 *
 * Extracted from App.tsx for SRP under Task #758 Phase C. The hydrator
 * action is injected so the hook stays pure and testable.
 */
export function useHydrateSystemLocale(
  hydrateSystemLocale: (locale: string | undefined) => void
): void {
  useEffect(() => {
    let cancelled = false;
    const bridge = window.ccsm;
    void (async () => {
      let locale: string | undefined;
      try {
        locale = await bridge?.i18n?.getSystemLocale();
      } catch {
        locale = undefined;
      }
      if (cancelled) return;
      hydrateSystemLocale(
        locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined)
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrateSystemLocale]);
}
