import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveTheme,
  legacyFontSizeToPx,
  pxToLegacyFontSize,
  sanitizeFontSizePx,
  sanitizeDensity,
  sanitizeSidebarWidthPct,
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

describe('density sanitize', () => {
  it('passes through valid values', () => {
    expect(sanitizeDensity('compact')).toBe('compact');
    expect(sanitizeDensity('normal')).toBe('normal');
    expect(sanitizeDensity('comfortable')).toBe('comfortable');
  });

  it('coerces invalid to normal (default)', () => {
    expect(sanitizeDensity('weird')).toBe('normal');
    expect(sanitizeDensity(undefined)).toBe('normal');
    expect(sanitizeDensity(42)).toBe('normal');
  });
});

describe('sidebar width sanitize', () => {
  it('passes through in-range fractions', () => {
    expect(sanitizeSidebarWidthPct(0.22)).toBeCloseTo(0.22);
    expect(sanitizeSidebarWidthPct(0.4)).toBeCloseTo(0.4);
  });

  it('clamps below min and above max', () => {
    expect(sanitizeSidebarWidthPct(0.0)).toBe(0.12);
    expect(sanitizeSidebarWidthPct(0.95)).toBe(0.5);
  });

  it('falls back to default when value is non-numeric', () => {
    expect(sanitizeSidebarWidthPct(NaN)).toBeCloseTo(0.22);
    expect(sanitizeSidebarWidthPct('25%')).toBeCloseTo(0.22);
  });
});
