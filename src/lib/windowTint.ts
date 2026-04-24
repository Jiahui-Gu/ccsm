/**
 * Per-window tint setting (UI-10c).
 *
 * When the user runs more than one CCSM window at the same time (a
 * thing per-instance hotkey/exit-anim work in #213 enabled), it can be hard
 * to tell at a glance which window is which. This module gives each window
 * an opt-in faint accent tint applied to the title-bar drag strip — purely
 * a *visual* aid, never the sole signal (the window title still shows the
 * active session).
 *
 * Scope decisions:
 *
 *   - Per-window-instance, NOT global. We deliberately do NOT persist this
 *     in the main zustand store: that one round-trips through the shared
 *     userData db which every BrowserWindow shares, so a global setter
 *     would paint every window the same color and defeat the feature.
 *
 *   - Per-window identity. The app today only ever creates a single
 *     BrowserWindow per Electron process (see `electron/main.ts ::
 *     createWindow`), so "per window" effectively means "per OS process".
 *     We mint a stable id at first read using `sessionStorage` — it
 *     survives a renderer reload but resets when the window itself closes
 *     (or a fresh process is launched), which matches the user's mental
 *     model of "this window".
 *
 *   - Persistence. The active tint is keyed by the per-window id and
 *     stored in localStorage so a renderer reload (devtools, hot-reload)
 *     keeps the choice. localStorage is shared across windows in the same
 *     userData dir, but the per-window key namespacing keeps choices
 *     isolated, and stale entries from prior windows naturally fall out of
 *     use because the next window mints a fresh id.
 *
 *   - A11y. Tint is intentionally low-opacity (≈8%) and rides on top of
 *     the existing chrome — it never replaces a label. The 2px accent bar
 *     at the very top of the strip is a secondary visual cue, but the
 *     window title (set elsewhere via the OS) remains the load-bearing
 *     identifier.
 */

import { useEffect, useState } from 'react';

/** Stable list of preset tints. `none` means "no tint" (the default). */
export const WINDOW_TINT_PRESETS = [
  'none',
  'slate',
  'sky',
  'mint',
  'amber',
  'rose',
  'violet',
] as const;

export type WindowTint = typeof WINDOW_TINT_PRESETS[number];

export const DEFAULT_WINDOW_TINT: WindowTint = 'none';

const SESSION_KEY = 'ccsm:windowId';
const TINT_KEY_PREFIX = 'ccsm:windowTint:';

/** Same shape as `crypto.randomUUID` falls back to when crypto is missing. */
function mintId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `w-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/**
 * Read or mint the per-window id. Stored in `sessionStorage` so it survives
 * a renderer reload but is naturally fresh on each new BrowserWindow /
 * Electron process. SSR-safe: returns a static id if `sessionStorage` is
 * unavailable (test/server) so callers don't crash.
 */
export function getWindowId(): string {
  if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
    return 'ssr';
  }
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing && existing.length > 0) return existing;
    const fresh = mintId();
    window.sessionStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    // Some sandboxed environments throw on storage access. Fall back to a
    // process-local id so the app still renders.
    return 'unavailable';
  }
}

function tintStorageKey(windowId: string): string {
  return `${TINT_KEY_PREFIX}${windowId}`;
}

/** Validate a stored value before trusting it. */
export function isWindowTint(v: unknown): v is WindowTint {
  return typeof v === 'string' && (WINDOW_TINT_PRESETS as readonly string[]).includes(v);
}

/** Read the persisted tint for the current window, or the default. */
export function loadWindowTint(): WindowTint {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return DEFAULT_WINDOW_TINT;
  }
  try {
    const raw = window.localStorage.getItem(tintStorageKey(getWindowId()));
    return isWindowTint(raw) ? raw : DEFAULT_WINDOW_TINT;
  } catch {
    return DEFAULT_WINDOW_TINT;
  }
}

/** Persist + broadcast a tint change to every subscriber in this window. */
export function saveWindowTint(tint: WindowTint): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return;
  }
  try {
    if (tint === DEFAULT_WINDOW_TINT) {
      window.localStorage.removeItem(tintStorageKey(getWindowId()));
    } else {
      window.localStorage.setItem(tintStorageKey(getWindowId()), tint);
    }
  } catch {
    /* ignore — quota errors are non-fatal for a cosmetic preference */
  }
  // Notify in-window subscribers. We use a CustomEvent on the window so the
  // settings dialog and the drag-region overlay stay in sync without
  // standing up a full pub/sub system. localStorage's `storage` event only
  // fires on OTHER documents, never the one that wrote — hence the manual
  // dispatch.
  try {
    window.dispatchEvent(new CustomEvent<WindowTint>('ccsm:windowTintChange', { detail: tint }));
  } catch {
    /* ignore */
  }
}

/**
 * React hook: returns `[tint, setTint]` for the current window. Subscribes
 * to in-window changes so flipping the setting in one place repaints every
 * consumer (drag region, future debug overlays, etc.).
 */
export function useWindowTint(): [WindowTint, (next: WindowTint) => void] {
  const [tint, setTint] = useState<WindowTint>(() => loadWindowTint());

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<WindowTint>).detail;
      if (isWindowTint(detail)) setTint(detail);
    };
    window.addEventListener('ccsm:windowTintChange', onChange);
    return () => window.removeEventListener('ccsm:windowTintChange', onChange);
  }, []);

  return [tint, (next) => {
    saveWindowTint(next);
    // Also update locally — the event roundtrip is async-ish in some
    // browsers and we want React state to settle this tick.
    setTint(next);
  }];
}

/**
 * The CSS custom property name for a tint. `none` returns null so callers
 * can branch off rather than apply `var(--color-tint-none)` (which doesn't
 * exist).
 */
export function tintCssVar(tint: WindowTint): string | null {
  if (tint === 'none') return null;
  return `var(--color-tint-${tint})`;
}
