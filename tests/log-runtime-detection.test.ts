// Regression test for the renderer-logger silent-drop bug.
//
// Bug: under contextIsolation:true + nodeIntegration:false (ccsm's config),
// the renderer has no `window.process` and webpack's polyfilled module-scope
// `process` lacks `process.versions.electron`. The old detection therefore
// returned `false` for every renderer build, `loadElog()` short-circuited to
// a no-op stub, and every `log.event(...)` / `log.warn(...)` call was silently
// discarded — empirically confirmed by an extended dogfood session producing
// a logs/main.log containing only the per-file header.
//
// Fix: probe `navigator.userAgent` for `Electron/<version>` first (the UA
// substring is appended unconditionally by Electron regardless of isolation/
// sandbox flags), then fall through to `process.versions.electron` for the
// main-process path. `detectElectronRuntime` is exported as a pure helper
// taking injectable deps so we can exercise all four runtime quadrants here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectElectronRuntime } from '../src/shared/log';

describe('detectElectronRuntime', () => {
  it('returns true when navigator.userAgent contains "Electron/<version>"', () => {
    expect(
      detectElectronRuntime({
        navigator: {
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ccsm/0.2.7 Chrome/130.0.0.0 Electron/41.3.0 Safari/537.36',
        },
        process: undefined,
      }),
    ).toBe(true);
  });

  it('falls through to process.versions.electron when UA does not contain Electron/', () => {
    // Plain Chrome UA — no "Electron/" substring. Falls through to module process.
    const plainChromeUA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    expect(
      detectElectronRuntime({
        navigator: { userAgent: plainChromeUA },
        process: { versions: {} },
      }),
    ).toBe(false);
    expect(
      detectElectronRuntime({
        navigator: { userAgent: plainChromeUA },
        process: { versions: { electron: '41.3.0' } },
      }),
    ).toBe(true);
  });

  it('returns true when process.versions.electron is set but navigator is absent (main-process path)', () => {
    expect(
      detectElectronRuntime({
        navigator: undefined,
        process: { versions: { electron: '41.3.0' } },
      }),
    ).toBe(true);
  });

  it('returns false when neither signal is present (plain Node, no UA)', () => {
    expect(
      detectElectronRuntime({
        navigator: undefined,
        process: { versions: {} },
      }),
    ).toBe(false);
    expect(
      detectElectronRuntime({
        navigator: undefined,
        process: undefined,
      }),
    ).toBe(false);
  });

  it('treats a non-string userAgent as absent and falls through to process', () => {
    // Defensive: some embedded contexts expose navigator without userAgent.
    expect(
      detectElectronRuntime({
        navigator: {} as { userAgent?: string },
        process: { versions: { electron: '41.3.0' } },
      }),
    ).toBe(true);
    expect(
      detectElectronRuntime({
        navigator: {} as { userAgent?: string },
        process: { versions: {} },
      }),
    ).toBe(false);
  });
});

// `loadElog` is module-private, so we verify the VITEST short-circuit by its
// observable effect: under VITEST=true the back-compat shims still console-
// log, but `log.event` / `log.info` route through the no-op stub and produce
// no thrown errors even when called repeatedly. The structured paths must
// remain inert in tests regardless of UA, preserving the test-isolation
// contract documented at the top of src/shared/log.ts.
describe('loadElog under VITEST', () => {
  const originalUA = globalThis.navigator?.userAgent;
  const originalVitest = process.env.VITEST;

  beforeEach(() => {
    process.env.VITEST = 'true';
  });

  afterEach(() => {
    if (originalVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
    // Restore UA if a test overrode it.
    if (originalUA !== undefined && globalThis.navigator) {
      Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: originalUA,
        configurable: true,
      });
    }
  });

  it('returns the no-op stub regardless of UA (preserves test isolation)', async () => {
    // Force an Electron-looking UA — detection should still be true, but
    // the VITEST short-circuit must prevent electron-log from being loaded.
    if (globalThis.navigator) {
      Object.defineProperty(globalThis.navigator, 'userAgent', {
        value: 'jsdom Electron/41.3.0 vitest',
        configurable: true,
      });
    }
    // Re-import with a fresh module registry so module-load-time detection
    // sees the patched UA. The structured `event` call must not throw and
    // must not attempt to load electron-log/renderer (which would crash
    // under jsdom — see the module header comment).
    vi.resetModules();
    const mod = await import('../src/shared/log');
    expect(() => mod.log.event('test.probe', { detail: 'inert' })).not.toThrow();
    expect(() => mod.log.warn('test', 'msg')).not.toThrow();
    expect(() => mod.log.error('test', 'msg')).not.toThrow();
  });
});
