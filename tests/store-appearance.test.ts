import { describe, it, expect } from 'vitest';
import { useStore } from '../src/stores/store';

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

  it('setDensity writes and setTheme writes', () => {
    useStore.getState().setDensity('compact');
    expect(useStore.getState().density).toBe('compact');
    useStore.getState().setTheme('light');
    expect(useStore.getState().theme).toBe('light');
  });

  it('setSidebarWidthPct clamps to [0.12, 0.5]', () => {
    useStore.getState().setSidebarWidthPct(0.3);
    expect(useStore.getState().sidebarWidthPct).toBeCloseTo(0.3);
    useStore.getState().setSidebarWidthPct(0.01);
    expect(useStore.getState().sidebarWidthPct).toBe(0.12);
    useStore.getState().setSidebarWidthPct(0.9);
    expect(useStore.getState().sidebarWidthPct).toBe(0.5);
  });
});
