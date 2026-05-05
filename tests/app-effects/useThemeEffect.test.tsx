import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useThemeEffect } from '../../src/app-effects/useThemeEffect';
import {
  resolveEffectiveTheme,
  type SystemPref,
  type UserOverride,
} from '../../src/lib/resolveEffectiveTheme';

/**
 * Tri-state OS signal scaffold: jsdom doesn't natively answer
 * `prefers-color-scheme` queries, so we install a `matchMedia` shim that
 * reflects an explicit `systemPref` ('light' | 'dark' | 'no-preference').
 */
type MqlEntry = {
  list: MediaQueryList;
  listeners: Array<(ev: MediaQueryListEvent) => void>;
  setMatches: (v: boolean) => void;
};

function installMatchMedia(systemPref: SystemPref): {
  darkMql: MqlEntry;
  lightMql: MqlEntry;
  setSystemPref: (next: SystemPref) => void;
} {
  const make = (
    media: string,
    initialMatches: boolean
  ): MqlEntry => {
    let matches = initialMatches;
    const listeners: Array<(ev: MediaQueryListEvent) => void> = [];
    const list = {
      get matches() {
        return matches;
      },
      media,
      addEventListener: vi.fn(
        (_evt: string, cb: (ev: MediaQueryListEvent) => void) => {
          listeners.push(cb);
        }
      ),
      removeEventListener: vi.fn(
        (_evt: string, cb: (ev: MediaQueryListEvent) => void) => {
          const idx = listeners.indexOf(cb);
          if (idx >= 0) listeners.splice(idx, 1);
        }
      ),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
    return {
      list,
      listeners,
      setMatches: (v: boolean) => {
        matches = v;
      },
    };
  };

  const darkMql = make(
    '(prefers-color-scheme: dark)',
    systemPref === 'dark'
  );
  const lightMql = make(
    '(prefers-color-scheme: light)',
    systemPref === 'light'
  );

  const matchMedia = vi.fn((q: string) => {
    if (q.includes('dark')) return darkMql.list;
    if (q.includes('light')) return lightMql.list;
    return darkMql.list;
  });
  vi.stubGlobal('matchMedia', matchMedia);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia,
  });

  const setSystemPref = (next: SystemPref) => {
    darkMql.setMatches(next === 'dark');
    lightMql.setMatches(next === 'light');
    // Notify subscribers (the hook only attaches to the dark MQL).
    const ev = { matches: next === 'dark' } as MediaQueryListEvent;
    for (const cb of darkMql.listeners) cb(ev);
  };

  return { darkMql, lightMql, setSystemPref };
}

describe('resolveEffectiveTheme (lib) — 6 combos (systemPref x userOverride)', () => {
  // Spec §5.3.7 PR-7: system{light, dark, no-preference} x override{light,
  // dark, system} = 9 cells, but the explicit override branches collapse
  // by systemPref so the spec calls them "6 combos" once you fold the
  // override-wins cells. We assert all 9 cells explicitly to lock the
  // truth table.
  const cases: Array<{
    systemPref: SystemPref;
    userOverride: UserOverride;
    expected: 'light' | 'dark';
  }> = [
    // userOverride === 'light' -> always light (3 cells, override wins)
    { systemPref: 'light', userOverride: 'light', expected: 'light' },
    { systemPref: 'dark', userOverride: 'light', expected: 'light' },
    { systemPref: 'no-preference', userOverride: 'light', expected: 'light' },
    // userOverride === 'dark' -> always dark (3 cells, override wins)
    { systemPref: 'light', userOverride: 'dark', expected: 'dark' },
    { systemPref: 'dark', userOverride: 'dark', expected: 'dark' },
    { systemPref: 'no-preference', userOverride: 'dark', expected: 'dark' },
    // userOverride === 'system' -> follow OS, no-preference defaults to light
    { systemPref: 'light', userOverride: 'system', expected: 'light' },
    { systemPref: 'dark', userOverride: 'system', expected: 'dark' },
    { systemPref: 'no-preference', userOverride: 'system', expected: 'light' },
  ];

  for (const c of cases) {
    it(`systemPref=${c.systemPref} x userOverride=${c.userOverride} -> ${c.expected}`, () => {
      expect(resolveEffectiveTheme(c.systemPref, c.userOverride)).toBe(
        c.expected
      );
    });
  }
});

describe('useThemeEffect', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies dark class for dark theme', () => {
    installMatchMedia('no-preference');
    renderHook(() => useThemeEffect('dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('theme-light')).toBe(
      false
    );
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('applies theme-light class for light theme', () => {
    installMatchMedia('no-preference');
    renderHook(() => useThemeEffect('light'));
    expect(document.documentElement.classList.contains('theme-light')).toBe(
      true
    );
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('subscribes to matchMedia change events when theme is system, and unsubscribes on unmount', () => {
    const { darkMql } = installMatchMedia('dark');
    const { unmount } = renderHook(() => useThemeEffect('system'));
    expect(darkMql.list.addEventListener).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    unmount();
    expect(darkMql.list.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('does NOT subscribe to matchMedia for explicit (non-system) themes', () => {
    const { darkMql } = installMatchMedia('no-preference');
    renderHook(() => useThemeEffect('light'));
    expect(darkMql.list.addEventListener).not.toHaveBeenCalled();
  });

  // 6-combo end-to-end coverage through the hook (DOM side-effects).
  // Mirrors the pure-fn truth table above to make sure the hook actually
  // reads the tri-state OS signal correctly via matchMedia.
  const hookCases: Array<{
    systemPref: SystemPref;
    userOverride: 'light' | 'dark' | 'system';
    expectDark: boolean;
    expectLight: boolean;
    expectDataTheme: 'light' | 'dark';
  }> = [
    {
      systemPref: 'light',
      userOverride: 'system',
      expectDark: false,
      expectLight: true,
      expectDataTheme: 'light',
    },
    {
      systemPref: 'dark',
      userOverride: 'system',
      expectDark: true,
      expectLight: false,
      expectDataTheme: 'dark',
    },
    {
      systemPref: 'no-preference',
      userOverride: 'system',
      expectDark: false,
      expectLight: true,
      expectDataTheme: 'light',
    },
    {
      systemPref: 'dark',
      userOverride: 'light',
      expectDark: false,
      expectLight: true,
      expectDataTheme: 'light',
    },
    {
      systemPref: 'light',
      userOverride: 'dark',
      expectDark: true,
      expectLight: false,
      expectDataTheme: 'dark',
    },
    {
      systemPref: 'no-preference',
      userOverride: 'dark',
      expectDark: true,
      expectLight: false,
      expectDataTheme: 'dark',
    },
  ];

  for (const c of hookCases) {
    it(`hook: systemPref=${c.systemPref} x userOverride=${c.userOverride} -> data-theme=${c.expectDataTheme}`, () => {
      installMatchMedia(c.systemPref);
      renderHook(() => useThemeEffect(c.userOverride));
      expect(document.documentElement.classList.contains('dark')).toBe(
        c.expectDark
      );
      expect(document.documentElement.classList.contains('theme-light')).toBe(
        c.expectLight
      );
      expect(document.documentElement.dataset.theme).toBe(c.expectDataTheme);
    });
  }

  it('reacts to OS preference flip while in system mode', () => {
    const { setSystemPref } = installMatchMedia('light');
    renderHook(() => useThemeEffect('system'));
    expect(document.documentElement.dataset.theme).toBe('light');
    setSystemPref('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('theme-light')).toBe(
      false
    );
  });
});
