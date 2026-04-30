// UT for src/store/preferences.ts — focuses on the bits not exercised by
// `language-switch.test.tsx` (which only covers `setLanguage`):
//   * `hydrateSystemLocale` honors the user's explicit pref AND derives a
//     resolved language from the supplied system locale when pref=system.
//   * `setLanguage` updates `resolvedLanguage` for both system + explicit
//     prefs (regression hook for #210-class issues where `resolvedLanguage`
//     could go stale relative to `language`).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { act } from '@testing-library/react';
import { initI18n } from '../src/i18n';
import { usePreferences } from '../src/store/preferences';

initI18n('en');

const ORIGINAL_LANG = navigator.language;
function setNavigatorLanguage(value: string | undefined) {
  Object.defineProperty(navigator, 'language', {
    configurable: true,
    get: () => value,
  });
}

beforeEach(() => {
  // Reset to a deterministic baseline so order-of-test independence holds.
  setNavigatorLanguage('en-US');
  act(() => usePreferences.getState().setLanguage('en'));
});

afterAll(() => {
  Object.defineProperty(navigator, 'language', {
    configurable: true,
    get: () => ORIGINAL_LANG,
  });
});

describe('usePreferences', () => {
  describe('setLanguage()', () => {
    it('explicit "zh" sets resolvedLanguage to zh', () => {
      act(() => usePreferences.getState().setLanguage('zh'));
      expect(usePreferences.getState().language).toBe('zh');
      expect(usePreferences.getState().resolvedLanguage).toBe('zh');
    });

    it('explicit "en" sets resolvedLanguage to en (even if navigator says zh)', () => {
      setNavigatorLanguage('zh-CN');
      act(() => usePreferences.getState().setLanguage('en'));
      expect(usePreferences.getState().resolvedLanguage).toBe('en');
    });

    it('"system" derives resolvedLanguage from navigator.language', () => {
      setNavigatorLanguage('zh-TW');
      act(() => usePreferences.getState().setLanguage('system'));
      expect(usePreferences.getState().language).toBe('system');
      expect(usePreferences.getState().resolvedLanguage).toBe('zh');

      setNavigatorLanguage('fr-FR');
      act(() => usePreferences.getState().setLanguage('system'));
      expect(usePreferences.getState().resolvedLanguage).toBe('en');
    });
  });

  describe('hydrateSystemLocale()', () => {
    it('updates resolvedLanguage when pref=system', () => {
      act(() => usePreferences.getState().setLanguage('system'));
      act(() => usePreferences.getState().hydrateSystemLocale('zh-CN'));
      expect(usePreferences.getState().resolvedLanguage).toBe('zh');

      act(() => usePreferences.getState().hydrateSystemLocale('en-US'));
      expect(usePreferences.getState().resolvedLanguage).toBe('en');
    });

    it('does NOT overwrite explicit user choice (pref="en", locale=zh)', () => {
      act(() => usePreferences.getState().setLanguage('en'));
      act(() => usePreferences.getState().hydrateSystemLocale('zh-CN'));
      // language stays explicit
      expect(usePreferences.getState().language).toBe('en');
      // resolvedLanguage tracks the explicit pref, not the system locale
      expect(usePreferences.getState().resolvedLanguage).toBe('en');
    });

    it('treats undefined locale as English fallback when pref=system', () => {
      act(() => usePreferences.getState().setLanguage('system'));
      act(() => usePreferences.getState().hydrateSystemLocale(undefined));
      expect(usePreferences.getState().resolvedLanguage).toBe('en');
    });
  });
});
