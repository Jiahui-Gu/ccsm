import { useEffect } from 'react';

/**
 * Mirror the renderer's resolved language to main so OS-level surfaces
 * (tray menu, future native notifications) can localize. Companion to
 * the locale-hydration effect in App.tsx; extracted to its own hook for
 * SRP under Task #724.
 *
 * No-op when the preload bridge is missing (test/storybook).
 */
export function useLanguageEffect(resolvedLanguage: 'en' | 'zh'): void {
  useEffect(() => {
    window.ccsm?.i18n?.setLanguage(resolvedLanguage);
  }, [resolvedLanguage]);
}
