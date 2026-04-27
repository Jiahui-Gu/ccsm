import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveTheme,
  legacyFontSizeToPx,
  pxToLegacyFontSize,
  sanitizeFontSizePx,
  sanitizeSidebarWidth,
  resolvePersistedSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
} from '../src/stores/store';

describe('resolveEffectiveTheme', () => {
  it('dark selection is always dark regardless of OS', () => {
    expect(resolveEffectiveTheme('dark', true)).toBe('dark');
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
  });

  it('light selection is always light regardless of OS', () => {
    expect(resolveEffectiveTheme('light', true)).toBe('light');
    expect(resolveEffectiveTheme('light', false)).toBe('light');
  });

  it('system follows OS: dark when osPrefersDark=true', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
  });

  it('system follows OS: light when osPrefersDark=false', () => {
    expect(resolveEffectiveTheme('system', false)).toBe('light');
  });
});

describe('font size migration', () => {
  it('maps legacy enum to px (md → 14 is the new default)', () => {
    expect(legacyFontSizeToPx('sm')).toBe(12);
    expect(legacyFontSizeToPx('md')).toBe(14);
    expect(legacyFontSizeToPx('lg')).toBe(16);
  });

  it('round-trips px → legacy → px for endpoint stops', () => {
    expect(legacyFontSizeToPx(pxToLegacyFontSize(12))).toBe(12);
    expect(legacyFontSizeToPx(pxToLegacyFontSize(16))).toBe(16);
  });

  it('pxToLegacyFontSize buckets middle values into md', () => {
    expect(pxToLegacyFontSize(13)).toBe('md');
    expect(pxToLegacyFontSize(14)).toBe('md');
    expect(pxToLegacyFontSize(15)).toBe('md');
  });

  it('sanitizeFontSizePx accepts every official stop', () => {
    for (const n of [12, 13, 14, 15, 16] as const) {
      expect(sanitizeFontSizePx(n)).toBe(n);
    }
  });

  it('sanitizeFontSizePx coerces garbage to default 14', () => {
    expect(sanitizeFontSizePx('huge')).toBe(14);
    expect(sanitizeFontSizePx(null)).toBe(14);
    expect(sanitizeFontSizePx(99)).toBe(14);
    expect(sanitizeFontSizePx(NaN)).toBe(14);
  });
});

describe('sidebar width sanitize', () => {
  it('passes through in-range pixel values, rounding fractions', () => {
    expect(sanitizeSidebarWidth(260)).toBe(260);
    expect(sanitizeSidebarWidth(312.6)).toBe(313);
  });

  it('clamps below min and above max', () => {
    expect(sanitizeSidebarWidth(0)).toBe(SIDEBAR_WIDTH_MIN);
    expect(sanitizeSidebarWidth(50)).toBe(SIDEBAR_WIDTH_MIN);
    expect(sanitizeSidebarWidth(9999)).toBe(SIDEBAR_WIDTH_MAX);
  });

  it('falls back to default when value is non-numeric', () => {
    expect(sanitizeSidebarWidth(NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(sanitizeSidebarWidth('25%')).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(sanitizeSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
});

describe('resolvePersistedSidebarWidth', () => {
  it('prefers a persisted px value', () => {
    expect(resolvePersistedSidebarWidth({ sidebarWidth: 320 })).toBe(320);
  });

  it('clamps a persisted px value out of range', () => {
    expect(resolvePersistedSidebarWidth({ sidebarWidth: 50 })).toBe(SIDEBAR_WIDTH_MIN);
    expect(resolvePersistedSidebarWidth({ sidebarWidth: 9999 })).toBe(SIDEBAR_WIDTH_MAX);
  });

  it('migrates legacy sidebarWidthPct to px using window width', () => {
    const winWidth = typeof window !== 'undefined' ? window.innerWidth : 1440;
    const expected = Math.min(
      SIDEBAR_WIDTH_MAX,
      Math.max(SIDEBAR_WIDTH_MIN, Math.round(0.22 * winWidth))
    );
    expect(resolvePersistedSidebarWidth({ sidebarWidthPct: 0.22 })).toBe(expected);
  });

  it('returns the default when nothing is persisted', () => {
    expect(resolvePersistedSidebarWidth({})).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
});
