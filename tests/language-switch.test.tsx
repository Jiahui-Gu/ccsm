// Switching language through the preferences store must propagate to the
// i18next instance — otherwise the Settings dropdown is purely cosmetic.
import { describe, it, expect, beforeAll } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { initI18n } from '../src/i18n';
import { useTranslation } from '../src/i18n/useTranslation';
import { usePreferences } from '../src/store/preferences';

beforeAll(() => {
  initI18n('en');
});

describe('language switch', () => {
  it('changing the store preference flips t() output', async () => {
    // Start in English.
    act(() => usePreferences.getState().setLanguage('en'));
    const { result, rerender } = renderHook(() => useTranslation('chat'));
    expect(result.current.t('sendButton')).toBe('Send');

    // Switch to Chinese; rerender to pick up the new language event.
    await act(async () => {
      usePreferences.getState().setLanguage('zh');
    });
    rerender();
    expect(result.current.t('sendButton')).toBe('发送');

    // And back, to verify it isn't a one-way door.
    await act(async () => {
      usePreferences.getState().setLanguage('en');
    });
    rerender();
    expect(result.current.t('sendButton')).toBe('Send');
  });
});
