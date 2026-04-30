// `useTranslation` is the wrapper around react-i18next. It must:
//   - return both `t` and `i18n` so consumers can read + change language.
//   - actually translate keys against our catalog (no silent passthrough).
import { describe, it, expect, beforeAll } from 'vitest';
import { renderHook } from '@testing-library/react';
import { initI18n } from '../src/i18n';
import { useTranslation } from '../src/i18n/useTranslation';

beforeAll(() => {
  initI18n('en');
});

describe('useTranslation wrapper', () => {
  it('returns t and i18n', () => {
    const { result } = renderHook(() => useTranslation('common'));
    expect(typeof result.current.t).toBe('function');
    expect(result.current.i18n).toBeDefined();
    expect(typeof result.current.i18n.changeLanguage).toBe('function');
  });

  it('translates a known key from the requested namespace', () => {
    const { result } = renderHook(() => useTranslation('common'));
    expect(result.current.t('save')).toBe('Save');
  });
});
