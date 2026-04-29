// Tests for createBadgeSink's `enabled` policy flag (Task #819).
//
// The flag was hoisted out of a hard-coded `BADGE_DISABLED = true` const
// inside the sink so the policy lives at the construction site (#667 /
// chore #534). These tests pin both branches of the gate so a future flip
// at main.ts can't silently regress.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `app.setBadgeCount` is the simplest leaf to assert against because it
// runs on every non-win32 platform. We mock the whole electron surface the
// sink imports — nativeImage just has to round-trip, and BrowserWindow /
// Tray come from the deps the test passes in.
const setBadgeCount = vi.fn<(n: number) => void>();
const setOverlayIcon = vi.fn();
const setTrayImage = vi.fn();

vi.mock('electron', () => {
  return {
    app: {
      setBadgeCount: (n: number) => setBadgeCount(n),
    },
    BrowserWindow: class {},
    nativeImage: {
      createFromBuffer: () => ({}),
    },
  };
});

import { createBadgeSink, type BadgeSinkDeps } from '../badgeSink';
import { BadgeManager } from '../../badgeStore';

function makeDeps(overrides: Partial<BadgeSinkDeps> = {}): BadgeSinkDeps {
  return {
    getTray: () => null,
    getBaseTrayImage: () =>
      ({
        toBitmap: () => Buffer.alloc(16 * 16 * 4),
        getSize: () => ({ width: 16, height: 16 }),
      }) as unknown as Electron.NativeImage,
    getWindows: () => [],
    ...overrides,
  };
}

describe('createBadgeSink — enabled policy', () => {
  beforeEach(() => {
    setBadgeCount.mockClear();
    setOverlayIcon.mockClear();
    setTrayImage.mockClear();
  });

  it('enabled defaults to false: store changes do NOT touch OS chrome', () => {
    const store = new BadgeManager();
    createBadgeSink(store, makeDeps());
    store.incrementSid('s1');
    store.incrementSid('s1');
    expect(setBadgeCount).not.toHaveBeenCalled();
  });

  it('enabled=false explicit: same no-op behavior', () => {
    const store = new BadgeManager();
    createBadgeSink(store, makeDeps({ enabled: false }));
    store.incrementSid('s1');
    store.clearAll();
    expect(setBadgeCount).not.toHaveBeenCalled();
  });

  it('enabled=true: forwards every total to app.setBadgeCount on non-win32', () => {
    // The sink's win32 branch goes through Tray + setOverlayIcon; we pin
    // the simpler app.setBadgeCount branch by faking platform=darwin for
    // the duration of this test. process.platform is read inside `apply`,
    // so it's safe to redefine before the change emits.
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const store = new BadgeManager();
      createBadgeSink(store, makeDeps({ enabled: true }));

      store.incrementSid('s1');
      store.incrementSid('s2');
      store.clearAll();

      // 1, 2, 0 — exact sequence proves the gate is open AND that totals
      // are forwarded verbatim (no intermediate transformation).
      expect(setBadgeCount.mock.calls.map((c) => c[0])).toEqual([1, 2, 0]);
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it('dispose() detaches the listener regardless of enabled state', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const store = new BadgeManager();
      const sink = createBadgeSink(store, makeDeps({ enabled: true }));
      store.incrementSid('s1');
      expect(setBadgeCount).toHaveBeenCalledTimes(1);

      sink.dispose();
      store.incrementSid('s2');
      // No additional OS call after dispose.
      expect(setBadgeCount).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });
});
