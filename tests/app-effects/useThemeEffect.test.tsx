import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useThemeEffect } from '../../src/app-effects/useThemeEffect';

describe('useThemeEffect', () => {
  let mqlListeners: Array<(ev: MediaQueryListEvent) => void>;
  let mql: MediaQueryList;
  let matchesValue: boolean;

  beforeEach(() => {
    mqlListeners = [];
    matchesValue = false;
    mql = {
      get matches() {
        return matchesValue;
      },
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn(
        (_evt: string, cb: (ev: MediaQueryListEvent) => void) => {
          mqlListeners.push(cb);
        }
      ),
      removeEventListener: vi.fn(
        (_evt: string, cb: (ev: MediaQueryListEvent) => void) => {
          mqlListeners = mqlListeners.filter((x) => x !== cb);
        }
      ),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mql)
    );
    // jsdom on Window
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => mql,
    });
    document.documentElement.className = '';
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies dark class for dark theme', () => {
    renderHook(() => useThemeEffect('dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('theme-light')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('applies theme-light class for light theme', () => {
    renderHook(() => useThemeEffect('light'));
    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('subscribes to matchMedia change events when theme is system, and unsubscribes on unmount', () => {
    matchesValue = true;
    const { unmount } = renderHook(() => useThemeEffect('system'));
    expect(mql.addEventListener).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    unmount();
    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('does NOT subscribe to matchMedia for explicit (non-system) themes', () => {
    renderHook(() => useThemeEffect('light'));
    expect(mql.addEventListener).not.toHaveBeenCalled();
  });
});
