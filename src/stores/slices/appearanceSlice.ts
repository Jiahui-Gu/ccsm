// Appearance slice: theme, font size, sidebar width.
// Owns the persistence helpers (`sanitize*`, `resolvePersistedSidebarWidth`,
// `legacyFontSizeToPx`, `pxToLegacyFontSize`, `resolveEffectiveTheme`)
// because both the slice's setters and `hydrateStore()` in `store.ts`
// share them. The store re-exports the helpers for existing call sites.

import type {
  FontSize,
  FontSizePx,
  Theme,
  RootStore,
  SetFn,
  GetFn,
} from './types';

/** Map the legacy `sm`/`md`/`lg` enum to the numeric pixel scale. The old
 * values kept only three stops (12/13/14); the new slider exposes 12–16.
 * `md` → 14 intentionally (new default), not 13 — we're rebalancing the
 * whole scale to match Inter's optical size sweet spot. */
export function legacyFontSizeToPx(v: FontSize): FontSizePx {
  switch (v) {
    case 'sm': return 12;
    case 'md': return 14;
    case 'lg': return 16;
  }
}

/** Inverse — used when the user drags the new slider and we want the legacy
 * `fontSize` field to stay consistent (older code paths still read it). */
export function pxToLegacyFontSize(px: FontSizePx): FontSize {
  if (px <= 12) return 'sm';
  if (px >= 16) return 'lg';
  return 'md';
}

export function sanitizeFontSizePx(raw: unknown): FontSizePx {
  const n = typeof raw === 'number' ? Math.round(raw) : NaN;
  if (n === 12 || n === 13 || n === 14 || n === 15 || n === 16) return n;
  return 14;
}

export const SIDEBAR_WIDTH_DEFAULT = 260;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;

export function sanitizeSidebarWidth(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(n)));
}

export function resolvePersistedSidebarWidth(persisted: {
  sidebarWidth?: number;
  sidebarWidthPct?: number;
}): number {
  if (typeof persisted.sidebarWidth === 'number') {
    return sanitizeSidebarWidth(persisted.sidebarWidth);
  }
  if (typeof persisted.sidebarWidthPct === 'number') {
    const winWidth =
      typeof window !== 'undefined' && Number.isFinite(window.innerWidth)
        ? window.innerWidth
        : 1440;
    return sanitizeSidebarWidth(persisted.sidebarWidthPct * winWidth);
  }
  return SIDEBAR_WIDTH_DEFAULT;
}

/** Resolve `theme` + OS signal to the actual rendered theme. Exported so
 * tests can lock OS state. `osPrefersDark` is the value of
 * `matchMedia('(prefers-color-scheme: dark)').matches` at call time. */
export function resolveEffectiveTheme(
  theme: Theme,
  osPrefersDark: boolean
): 'light' | 'dark' {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  return osPrefersDark ? 'dark' : 'light';
}

export type AppearanceSlice = Pick<
  RootStore,
  | 'sidebarWidth'
  | 'theme'
  | 'fontSize'
  | 'fontSizePx'
  | 'setTheme'
  | 'setFontSize'
  | 'setFontSizePx'
  | 'setSidebarWidth'
  | 'resetSidebarWidth'
>;

export function createAppearanceSlice(set: SetFn, _get: GetFn): AppearanceSlice {
  return {
    // initial state
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    theme: 'system',
    fontSize: 'md',
    fontSizePx: 14,

    // actions
    setTheme: (theme) => set({ theme }),
    setFontSize: (fontSize) =>
      set({ fontSize, fontSizePx: legacyFontSizeToPx(fontSize) }),
    setFontSizePx: (fontSizePx) =>
      set({ fontSizePx, fontSize: pxToLegacyFontSize(fontSizePx) }),
    setSidebarWidth: (px) => set({ sidebarWidth: sanitizeSidebarWidth(px) }),
    resetSidebarWidth: () => set({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT }),
  };
}
