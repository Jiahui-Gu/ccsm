import { describe, it, expect, vi } from 'vitest';

// Mock electron — singleInstance.ts top-level imports `app` and `BrowserWindow`,
// which triggers "Electron failed to install correctly" on the lint+test runner
// (no electron binary available on CI). Default to packaged so the dev-mode
// branch is inert; individual tests override via vi.doMock if they need
// app.isPackaged === false behavior.
vi.mock('electron', () => ({ app: { isPackaged: true } }));

import { shouldSkipSingleInstanceLock } from '../singleInstance';

describe('shouldSkipSingleInstanceLock', () => {
  it('skips when CCSM_E2E_HIDDEN=1', () => {
    expect(
      shouldSkipSingleInstanceLock({ CCSM_E2E_HIDDEN: '1' } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('skips when CCSM_E2E_NO_SINGLE_INSTANCE=1', () => {
    expect(
      shouldSkipSingleInstanceLock({
        CCSM_E2E_NO_SINGLE_INSTANCE: '1',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('does NOT skip in production env (no opt-out vars, packaged)', () => {
    expect(shouldSkipSingleInstanceLock({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('does NOT skip when env vars are present but not "1"', () => {
    expect(
      shouldSkipSingleInstanceLock({
        CCSM_E2E_HIDDEN: '0',
        CCSM_E2E_NO_SINGLE_INSTANCE: 'false',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it('skips when app is unpackaged (dev mode via `npm run dev`)', async () => {
    // Reset module + re-mock electron with isPackaged: false to simulate dev.
    vi.resetModules();
    vi.doMock('electron', () => ({ app: { isPackaged: false } }));
    const { shouldSkipSingleInstanceLock: devFn } = await import(
      '../singleInstance'
    );
    expect(devFn({} as NodeJS.ProcessEnv)).toBe(true);
    vi.doUnmock('electron');
  });
});
