import { describe, it, expect } from 'vitest';
import {
  createAppearanceSlice,
  legacyFontSizeToPx,
  pxToLegacyFontSize,
  sanitizeFontSizePx,
  sanitizeSidebarWidth,
  resolvePersistedSidebarWidth,
  resolveEffectiveTheme,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
} from '../../../src/stores/slices/appearanceSlice';
import type { RootStore } from '../../../src/stores/slices/types';

// Lightweight harness: feed the slice a `set`/`get` pair backed by a plain
// object. Every action mutates the harness state so we can assert on it.
function harness() {
  let state: Partial<RootStore> = {};
  const set = (
    partial: Partial<RootStore> | ((s: RootStore) => Partial<RootStore> | RootStore)
  ) => {
    const patch = typeof partial === 'function' ? partial(state as RootStore) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state as RootStore;
  const slice = createAppearanceSlice(set, get);
  // Seed state with the slice's own defaults, exactly as Zustand's create()
  // does when spreading the slice into the root store.
  state = { ...state, ...slice };
  return { state: () => state, slice, set, get };
}

describe('appearanceSlice', () => {
  it('initial state matches expected defaults', () => {
    const h = harness();
    const s = h.state();
    expect(s.theme).toBe('system');
    expect(s.fontSize).toBe('md');
    expect(s.fontSizePx).toBe(14);
    expect(s.sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(s.sidebarCollapsed).toBe(false);
    expect(s.tutorialSeen).toBe(false);
  });

  it('setTheme writes', () => {
    const h = harness();
    h.slice.setTheme('dark');
    expect(h.state().theme).toBe('dark');
  });

  it('setFontSize keeps px in sync', () => {
    const h = harness();
    h.slice.setFontSize('sm');
    expect(h.state().fontSizePx).toBe(12);
    h.slice.setFontSize('lg');
    expect(h.state().fontSizePx).toBe(16);
    h.slice.setFontSize('md');
    expect(h.state().fontSizePx).toBe(14);
  });

  it('setFontSizePx keeps legacy enum in sync', () => {
    const h = harness();
    h.slice.setFontSizePx(12);
    expect(h.state().fontSize).toBe('sm');
    h.slice.setFontSizePx(16);
    expect(h.state().fontSize).toBe('lg');
    h.slice.setFontSizePx(13);
    expect(h.state().fontSize).toBe('md');
    h.slice.setFontSizePx(15);
    expect(h.state().fontSize).toBe('md');
  });

  it('setSidebarWidth clamps to [200, 480]', () => {
    const h = harness();
    h.slice.setSidebarWidth(312);
    expect(h.state().sidebarWidth).toBe(312);
    h.slice.setSidebarWidth(50);
    expect(h.state().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
    h.slice.setSidebarWidth(9999);
    expect(h.state().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
  });

  it('resetSidebarWidth restores the default', () => {
    const h = harness();
    h.slice.setSidebarWidth(400);
    h.slice.resetSidebarWidth();
    expect(h.state().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it('toggleSidebar flips the flag', () => {
    const h = harness();
    expect(h.state().sidebarCollapsed).toBe(false);
    h.slice.toggleSidebar();
    expect(h.state().sidebarCollapsed).toBe(true);
    h.slice.toggleSidebar();
    expect(h.state().sidebarCollapsed).toBe(false);
  });

  it('setSidebarCollapsed writes', () => {
    const h = harness();
    h.slice.setSidebarCollapsed(true);
    expect(h.state().sidebarCollapsed).toBe(true);
  });

  it('markTutorialSeen latches true', () => {
    const h = harness();
    h.slice.markTutorialSeen();
    expect(h.state().tutorialSeen).toBe(true);
  });
});

describe('appearance helpers (pure)', () => {
  it('legacyFontSizeToPx maps sm/md/lg', () => {
    expect(legacyFontSizeToPx('sm')).toBe(12);
    expect(legacyFontSizeToPx('md')).toBe(14);
    expect(legacyFontSizeToPx('lg')).toBe(16);
  });

  it('pxToLegacyFontSize buckets edges', () => {
    expect(pxToLegacyFontSize(12)).toBe('sm');
    expect(pxToLegacyFontSize(13)).toBe('md');
    expect(pxToLegacyFontSize(14)).toBe('md');
    expect(pxToLegacyFontSize(15)).toBe('md');
    expect(pxToLegacyFontSize(16)).toBe('lg');
  });

  it('sanitizeFontSizePx accepts valid stops, defaults to 14', () => {
    expect(sanitizeFontSizePx(12)).toBe(12);
    expect(sanitizeFontSizePx(15)).toBe(15);
    expect(sanitizeFontSizePx(99)).toBe(14);
    expect(sanitizeFontSizePx('big')).toBe(14);
    expect(sanitizeFontSizePx(undefined)).toBe(14);
  });

  it('sanitizeSidebarWidth clamps and rounds', () => {
    expect(sanitizeSidebarWidth(312.4)).toBe(312);
    expect(sanitizeSidebarWidth(-100)).toBe(SIDEBAR_WIDTH_MIN);
    expect(sanitizeSidebarWidth(99999)).toBe(SIDEBAR_WIDTH_MAX);
    expect(sanitizeSidebarWidth('garbage')).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  it('resolvePersistedSidebarWidth prefers px', () => {
    expect(resolvePersistedSidebarWidth({ sidebarWidth: 333 })).toBe(333);
  });

  it('resolvePersistedSidebarWidth falls back to legacy pct', () => {
    const win = (globalThis as unknown as { window?: { innerWidth: number } }).window;
    if (win) win.innerWidth = 1000;
    expect(resolvePersistedSidebarWidth({ sidebarWidthPct: 0.25 })).toBe(250);
  });

  it('resolveEffectiveTheme honors explicit + system', () => {
    expect(resolveEffectiveTheme('light', false)).toBe('light');
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
    expect(resolveEffectiveTheme('system', false)).toBe('light');
  });
});
