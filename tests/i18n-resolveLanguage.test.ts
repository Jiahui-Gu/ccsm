// UT for src/i18n/index.ts — focused on the pure `resolveLanguage` mapper.
// `initI18n` and `applyLanguage` are exercised indirectly by every component
// test that calls `useTranslation`, but `resolveLanguage` has no direct
// coverage. It's the deterministic "stored preference + system locale →
// resolved language" function that both the renderer and the main process
// rely on staying consistent.
import { describe, it, expect } from 'vitest';
import { resolveLanguage, SUPPORTED_LANGUAGES } from '../src/i18n';

describe('resolveLanguage()', () => {
  describe('explicit pref always wins', () => {
    it.each(['en', 'zh'] as const)('pref=%s returns %s regardless of locale', (pref) => {
      expect(resolveLanguage(pref, 'en-US')).toBe(pref);
      expect(resolveLanguage(pref, 'zh-CN')).toBe(pref);
      expect(resolveLanguage(pref, undefined)).toBe(pref);
      expect(resolveLanguage(pref, '')).toBe(pref);
    });
  });

  describe('pref=system → derive from locale', () => {
    it('locale starting with "zh" resolves to zh', () => {
      expect(resolveLanguage('system', 'zh')).toBe('zh');
      expect(resolveLanguage('system', 'zh-CN')).toBe('zh');
      expect(resolveLanguage('system', 'zh-TW')).toBe('zh');
      expect(resolveLanguage('system', 'ZH-CN')).toBe('zh'); // case-insensitive
    });

    it('any other locale falls back to en', () => {
      expect(resolveLanguage('system', 'en')).toBe('en');
      expect(resolveLanguage('system', 'en-US')).toBe('en');
      expect(resolveLanguage('system', 'fr-FR')).toBe('en');
      expect(resolveLanguage('system', 'ja-JP')).toBe('en');
    });

    it('undefined / empty locale falls back to en', () => {
      expect(resolveLanguage('system', undefined)).toBe('en');
      expect(resolveLanguage('system', '')).toBe('en');
    });
  });

  it('SUPPORTED_LANGUAGES contains exactly en + zh', () => {
    expect([...SUPPORTED_LANGUAGES].sort()).toEqual(['en', 'zh']);
  });
});
