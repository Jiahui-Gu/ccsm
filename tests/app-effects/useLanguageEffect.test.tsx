import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLanguageEffect } from '../../src/app-effects/useLanguageEffect';

describe('useLanguageEffect', () => {
  let setLanguage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setLanguage = vi.fn();
    (window as unknown as { ccsm: unknown }).ccsm = {
      i18n: { setLanguage, getSystemLocale: vi.fn() },
    };
  });

  afterEach(() => {
    delete (window as unknown as { ccsm?: unknown }).ccsm;
  });

  it('forwards the resolved language to main on mount', () => {
    renderHook(() => useLanguageEffect('en'));
    expect(setLanguage).toHaveBeenCalledWith('en');
  });

  it('re-fires when the language changes', () => {
    const { rerender } = renderHook(
      ({ lang }: { lang: string }) => useLanguageEffect(lang),
      { initialProps: { lang: 'en' } }
    );
    expect(setLanguage).toHaveBeenLastCalledWith('en');
    rerender({ lang: 'zh' });
    expect(setLanguage).toHaveBeenLastCalledWith('zh');
    expect(setLanguage).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when the preload bridge is missing', () => {
    delete (window as unknown as { ccsm?: unknown }).ccsm;
    expect(() => renderHook(() => useLanguageEffect('en'))).not.toThrow();
  });
});
