import { useEffect } from 'react';
import {
  resolveEffectiveTheme,
  type SystemPref,
} from '../lib/resolveEffectiveTheme';

/**
 * Read the current OS-level color-scheme signal as a tri-state value.
 * Browsers expose three states via media queries: `light`, `dark`, and
 * `no-preference` (the user has expressed neither). The latter matches
 * the spec's tri-state `SystemPref` and lets us draw a clean line
 * between "user wants light" and "user has no preference, fall back to
 * light".
 */
function readSystemPref(): SystemPref {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'no-preference';
  }
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  return 'no-preference';
}

/**
 * Sync the user's theme preference (and, when set to `system`, the OS
 * preferred-color-scheme) to CSS classes on `<html>`. Sets BOTH `.dark`
 * (legacy Tailwind variants) and `.theme-light` (new light-palette
 * overrides) so the two never coexist. Mirrors the original effect that
 * lived inline in App.tsx — extracted for SRP under Task #724.
 *
 * Projection logic lives in `src/lib/resolveEffectiveTheme.ts` (spec
 * §5.3.7 PR-7), which models the OS signal as the tri-state
 * `light | dark | no-preference` and returns the effective rendered
 * theme.
 */
export function useThemeEffect(theme: 'light' | 'dark' | 'system'): void {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const systemPref = readSystemPref();
      const effective = resolveEffectiveTheme(systemPref, theme);
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
