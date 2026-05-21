// Pins the preload entry point. The 5 `install*` calls are independent
// (order is preserved for diff clarity, not correctness) — but if a
// future refactor drops one of them, the corresponding `window.ccsm*`
// surface goes silently missing in the renderer with no compiler signal.
// The Sentry preload import must also stay first so error capture is
// armed before any bridge runs (its initializer hooks into webContents).

import { describe, it, expect, vi } from 'vitest';

const {
  installCore,
  installPty,
  installSession,
  installNotify,
  installSessionTitles,
  sentryLoaded,
} = vi.hoisted(() => ({
  installCore: vi.fn(),
  installPty: vi.fn(),
  installSession: vi.fn(),
  installNotify: vi.fn(),
  installSessionTitles: vi.fn(),
  sentryLoaded: vi.fn(),
}));

vi.mock('@sentry/electron/preload', () => {
  sentryLoaded();
  return {};
});
vi.mock('../ccsmCore', () => ({ installCcsmCoreBridge: installCore }));
vi.mock('../ccsmPty', () => ({ installCcsmPtyBridge: installPty }));
vi.mock('../ccsmSession', () => ({
  installCcsmSessionBridge: installSession,
}));
vi.mock('../ccsmNotify', () => ({
  installCcsmNotifyBridge: installNotify,
}));
vi.mock('../ccsmSessionTitles', () => ({
  installCcsmSessionTitlesBridge: installSessionTitles,
}));

describe('preload/index entry point', () => {
  it('loads sentry/preload and invokes every install function exactly once', async () => {
    await import('../../index');

    expect(sentryLoaded).toHaveBeenCalledTimes(1);
    expect(installCore).toHaveBeenCalledTimes(1);
    expect(installPty).toHaveBeenCalledTimes(1);
    expect(installSession).toHaveBeenCalledTimes(1);
    expect(installNotify).toHaveBeenCalledTimes(1);
    expect(installSessionTitles).toHaveBeenCalledTimes(1);
  });
});
