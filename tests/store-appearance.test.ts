import { describe, it, expect } from 'vitest';
import { useStore } from '../src/stores/store';
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
} from '../src/stores/slices/appearanceSlice';

describe('appearance setters', () => {
  it('setFontSizePx updates both px and legacy enum', () => {
    useStore.getState().setFontSizePx(12);
    expect(useStore.getState().fontSizePx).toBe(12);
    expect(useStore.getState().fontSize).toBe('sm');
    useStore.getState().setFontSizePx(16);
    expect(useStore.getState().fontSize).toBe('lg');
    useStore.getState().setFontSizePx(14);
    expect(useStore.getState().fontSize).toBe('md');
  });

  it('legacy setFontSize keeps new px in sync', () => {
    useStore.getState().setFontSize('sm');
    expect(useStore.getState().fontSizePx).toBe(12);
    useStore.getState().setFontSize('lg');
    expect(useStore.getState().fontSizePx).toBe(16);
  });

  it('setTheme writes', () => {
    useStore.getState().setTheme('light');
    expect(useStore.getState().theme).toBe('light');
  });

  it('setSidebarWidth clamps to [200, 480] px', () => {
    useStore.getState().setSidebarWidth(312);
    expect(useStore.getState().sidebarWidth).toBe(312);
    useStore.getState().setSidebarWidth(50);
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
    useStore.getState().setSidebarWidth(9999);
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
  });

  it('resetSidebarWidth restores the default', () => {
    useStore.getState().setSidebarWidth(400);
    useStore.getState().resetSidebarWidth();
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
});
