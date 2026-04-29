import { useEffect } from 'react';
import { resolveEffectiveTheme } from '../stores/slices/appearanceSlice';

/**
 * Sync the user's theme preference (and, when set to `system`, the OS
 * preferred-color-scheme) to CSS classes on `<html>`. Sets BOTH `.dark`
 * (legacy Tailwind variants) and `.theme-light` (new light-palette
 * overrides) so the two never coexist. Mirrors the original effect that
 * lived inline in App.tsx — extracted for SRP under Task #724.
 */
export function useThemeEffect(theme: 'light' | 'dark' | 'system'): void {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const osPrefersDark =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      const effective = resolveEffectiveTheme(theme, osPrefersDark);
      root.classList.toggle('dark', effective === 'dark');
      root.classList.toggle('theme-light', effective === 'light');
      root.dataset.theme = effective;
    };
    apply();
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}
