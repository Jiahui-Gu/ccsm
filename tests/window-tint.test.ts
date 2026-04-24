import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WINDOW_TINT_PRESETS,
  DEFAULT_WINDOW_TINT,
  isWindowTint,
  loadWindowTint,
  saveWindowTint,
  getWindowId,
  tintCssVar,
} from '../src/lib/windowTint';

// jsdom gives us a real window/localStorage/sessionStorage. Wipe between
// tests so per-window-id minting and persistence are deterministic.
beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('window tint presets', () => {
  it('exposes none plus six named hues', () => {
    expect(WINDOW_TINT_PRESETS).toEqual([
      'none',
      'slate',
      'sky',
      'mint',
      'amber',
      'rose',
      'violet',
    ]);
  });

  it("default is 'none'", () => {
    expect(DEFAULT_WINDOW_TINT).toBe('none');
  });

  it('isWindowTint accepts presets and rejects everything else', () => {
    for (const p of WINDOW_TINT_PRESETS) expect(isWindowTint(p)).toBe(true);
    expect(isWindowTint('purple')).toBe(false);
    expect(isWindowTint('')).toBe(false);
    expect(isWindowTint(null)).toBe(false);
    expect(isWindowTint(undefined)).toBe(false);
    expect(isWindowTint(7)).toBe(false);
    expect(isWindowTint({})).toBe(false);
  });

  it('tintCssVar maps named tints to CSS vars and none to null', () => {
    expect(tintCssVar('none')).toBeNull();
    expect(tintCssVar('sky')).toBe('var(--color-tint-sky)');
    expect(tintCssVar('rose')).toBe('var(--color-tint-rose)');
  });
});

describe('per-window id', () => {
  it('mints a stable id and reuses it within a window', () => {
    const a = getWindowId();
    const b = getWindowId();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
    expect(window.sessionStorage.getItem('ccsm:windowId')).toBe(a);
  });

  it('a fresh sessionStorage means a fresh id (mimics a new window)', () => {
    const first = getWindowId();
    window.sessionStorage.clear();
    const second = getWindowId();
    expect(second).not.toBe(first);
  });
});

describe('tint persistence', () => {
  it("loadWindowTint defaults to 'none' when nothing is stored", () => {
    expect(loadWindowTint()).toBe('none');
  });

  it('round-trips through save/load', () => {
    saveWindowTint('sky');
    expect(loadWindowTint()).toBe('sky');
    saveWindowTint('amber');
    expect(loadWindowTint()).toBe('amber');
  });

  it("saving 'none' clears the storage entry rather than persisting it", () => {
    saveWindowTint('mint');
    const id = getWindowId();
    expect(window.localStorage.getItem(`ccsm:windowTint:${id}`)).toBe('mint');
    saveWindowTint('none');
    expect(window.localStorage.getItem(`ccsm:windowTint:${id}`)).toBeNull();
    expect(loadWindowTint()).toBe('none');
  });

  it('rejects bogus persisted values and falls back to the default', () => {
    const id = getWindowId();
    window.localStorage.setItem(`ccsm:windowTint:${id}`, 'plaid');
    expect(loadWindowTint()).toBe('none');
  });

  it('saveWindowTint dispatches an in-window change event', () => {
    const handler = vi.fn();
    window.addEventListener('ccsm:windowTintChange', handler);
    saveWindowTint('violet');
    expect(handler).toHaveBeenCalledTimes(1);
    const ev = handler.mock.calls[0][0] as CustomEvent;
    expect(ev.detail).toBe('violet');
    window.removeEventListener('ccsm:windowTintChange', handler);
  });

  it('isolates one window from another (different ids → different keys)', () => {
    saveWindowTint('rose');
    const idA = getWindowId();
    expect(window.localStorage.getItem(`ccsm:windowTint:${idA}`)).toBe('rose');

    // Simulate a second window: fresh sessionStorage mints a new id, and
    // its load must NOT see window A's choice.
    window.sessionStorage.clear();
    expect(loadWindowTint()).toBe('none');
    const idB = getWindowId();
    expect(idB).not.toBe(idA);

    // Window A's persisted value is still present under its own key.
    expect(window.localStorage.getItem(`ccsm:windowTint:${idA}`)).toBe('rose');
  });
});
