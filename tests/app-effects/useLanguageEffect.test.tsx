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

  it('is a no-op when the preload bridge is missing: setLanguage never called', () => {
    // Capture the spy reference first, then delete the bridge. The hook
    // optional-chains through `window.ccsm?.i18n?.setLanguage`, so the
    // captured spy should never be invoked after the delete.
    const capturedSpy = setLanguage;
    delete (window as unknown as { ccsm?: unknown }).ccsm;
    const { rerender, unmount } = renderHook(
      ({ lang }: { lang: string }) => useLanguageEffect(lang as 'en' | 'zh'),
      { initialProps: { lang: 'en' } }
    );
    expect(capturedSpy).not.toHaveBeenCalled();
    rerender({ lang: 'zh' });
    expect(capturedSpy).not.toHaveBeenCalled();
    unmount();
    expect(capturedSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when ccsm.i18n is missing (partial bridge)', () => {
    (window as unknown as { ccsm: unknown }).ccsm = {};
    renderHook(() => useLanguageEffect('en'));
    expect(setLanguage).not.toHaveBeenCalled();
  });
});
