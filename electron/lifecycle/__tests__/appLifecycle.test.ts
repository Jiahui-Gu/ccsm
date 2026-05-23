import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { App } from 'electron';

// Mock electron — appLifecycle.ts top-level imports `Menu` and
// `BrowserWindow`, which would trigger "Electron failed to install
// correctly" on the lint+test runner (no electron binary on CI). We
// control the spies via the mock factory and read them back via
// vi.mocked() / the module-level handles in tests.
vi.mock('electron', () => {
  const buildFromTemplate = vi.fn(() => ({ items: [] }));
  const setApplicationMenu = vi.fn();
  // Mutable window list — tests push fake windows in via __setWindows.
  // Each fake exposes a `hide` spy so we can assert the graceful quit
  // path hid every live window before kicking off the flush.
  const windows: Array<{ hide: ReturnType<typeof vi.fn> }> = [];
  return {
    Menu: { buildFromTemplate, setApplicationMenu },
    BrowserWindow: {
      getAllWindows: () => windows,
      __setWindows: (list: Array<{ hide: ReturnType<typeof vi.fn> }>) => {
        windows.length = 0;
        windows.push(...list);
      },
    },
    app: { getPath: vi.fn(() => '/tmp/logs') },
    shell: { openPath: vi.fn(async () => '') },
  };
});

// Mock the log module to avoid pulling in electron-log (which requires
// the electron binary). appLifecycle imports getLogLevel / getLogFilePath
// to render the Help submenu — stub them with deterministic values.
vi.mock('../../shared/log', () => ({
  getLogLevel: () => 'info',
  setLogLevel: vi.fn(),
  getLogFilePath: () => '/tmp/logs/main.log',
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), event: vi.fn() },
}));

// applyAppMenuLocale uses a dynamic `require('../i18n')` to dodge a
// circular-import edge in the production graph. vitest's vi.mock only
// intercepts ESM `import`, NOT Node-native CJS require — and Node's CJS
// resolver can't find the .ts source on its own. Patch the CJS require
// to short-circuit any '../i18n' lookup with our deterministic stub.
// MUST be restored in afterAll: vitest's default per-file isolation hides
// the leak today, but if anyone flips to `pool: 'threads'` + `isolate: false`
// an un-restored patch would bleed into sibling test files (e.g. anything
// that itself does `require('../i18n')`) and surface as mysterious failures.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('node:module') as typeof import('node:module');
const ModuleProto = (Module as unknown as { prototype: { require: (id: string) => unknown } })
  .prototype;
const originalRequire = ModuleProto.require;
ModuleProto.require = function patchedRequire(this: NodeJS.Module, id: string) {
  if (id === '../i18n') {
    return { tMenu: (key: string) => `MENU_${key}` };
  }
  return originalRequire.call(this, id);
};

afterAll(() => {
  ModuleProto.require = originalRequire;
});

import { Menu, BrowserWindow } from 'electron';
import {
  applyAppMenuLocale,
  registerLifecycleHandlers,
  __resetFlushingForQuitForTests,
  type LifecycleDeps,
} from '../appLifecycle';

// Test-only handle on the BrowserWindow mock for pushing fake windows in.
const setMockWindows = (
  list: Array<{ hide: ReturnType<typeof vi.fn> }>,
): void => {
  (BrowserWindow as unknown as {
    __setWindows: (l: Array<{ hide: ReturnType<typeof vi.fn> }>) => void;
  }).__setWindows(list);
};

type EventName = 'before-quit' | 'window-all-closed' | 'activate';

interface FakeApp {
  on: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  /** invoke a registered listener for a given event. Returns the synthetic
   *  event object so tests can inspect preventDefault state. */
  fire: (event: EventName) => { defaultPrevented: boolean };
}

function createFakeApp(): FakeApp {
  const handlers = new Map<EventName, (ev: { preventDefault: () => void }) => void>();
  const on = vi.fn((event: EventName, cb: (ev: { preventDefault: () => void }) => void) => {
    handlers.set(event, cb);
  });
  // `quit()` re-fires `before-quit` (mirrors Electron's real behavior so
  // the second-pass / `flushingForQuit` latch test is faithful).
  const quit = vi.fn(() => {
    const cb = handlers.get('before-quit');
    if (cb) {
      const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      cb(ev);
    }
  });
  return {
    on,
    quit,
    fire: (event) => {
      const cb = handlers.get(event);
      if (!cb) throw new Error(`no handler registered for ${event}`);
      const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      cb(ev);
      return ev;
    },
  };
}

function buildDeps(overrides: Partial<LifecycleDeps> = {}): {
  deps: LifecycleDeps;
  fakeApp: FakeApp;
  spies: {
    setIsQuitting: ReturnType<typeof vi.fn>;
    killAllPtySessions: ReturnType<typeof vi.fn>;
    closeDb: ReturnType<typeof vi.fn>;
    createWindow: ReturnType<typeof vi.fn>;
    disposeNotifyPipeline: ReturnType<typeof vi.fn>;
  };
  state: { isQuitting: boolean; windowCount: number };
} {
  const fakeApp = createFakeApp();
  const state = { isQuitting: false, windowCount: 0 };
  const setIsQuitting = vi.fn((v: boolean) => {
    state.isQuitting = v;
  });
  const killAllPtySessions = vi.fn(() => Promise.resolve());
  const closeDb = vi.fn();
  const createWindow = vi.fn();
  const disposeNotifyPipeline = vi.fn();
  const deps: LifecycleDeps = {
    app: fakeApp as unknown as App,
    getIsQuitting: () => state.isQuitting,
    setIsQuitting,
    killAllPtySessions,
    closeDb,
    createWindow,
    getWindowCount: () => state.windowCount,
    disposeNotifyPipeline,
    ...overrides,
  };
  return {
    deps,
    fakeApp,
    spies: {
      setIsQuitting,
      killAllPtySessions,
      closeDb,
      createWindow,
      disposeNotifyPipeline,
    },
    state,
  };
}

describe('applyAppMenuLocale', () => {
  beforeEach(() => {
    vi.mocked(Menu.buildFromTemplate).mockClear();
    vi.mocked(Menu.setApplicationMenu).mockClear();
  });

  it('builds the menu (Edit accelerators + Help submenu) and installs it', () => {
    applyAppMenuLocale();
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
  });

  it('uses the localized "Edit" label from i18n.tMenu', () => {
    applyAppMenuLocale();
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0];
    // Edit + Help → 2 top-level entries.
    expect(template).toHaveLength(2);
    expect(template[0].label).toBe('MENU_edit');
    expect(template[1].label).toBe('Help');
  });

  it('omits paste from the submenu (terminal pane installs its own handler)', () => {
    applyAppMenuLocale();
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0];
    const submenu = template[0].submenu as Array<{ role?: string; type?: string }>;
    const roles = submenu.map((item) => item.role).filter(Boolean);
    expect(roles).not.toContain('paste');
    // sanity-check the roles we DO want survive the rebuild
    expect(roles).toEqual(
      expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'selectAll']),
    );
  });

  it('rebuilds the menu on every call (locale change re-runs)', () => {
    applyAppMenuLocale();
    applyAppMenuLocale();
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(2);
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(2);
  });
});

describe('registerLifecycleHandlers', () => {
  it('registers listeners for before-quit, window-all-closed, and activate', () => {
    const { deps, fakeApp } = buildDeps();
    registerLifecycleHandlers(deps);
    const events = fakeApp.on.mock.calls.map((c) => c[0]);
    expect(events).toEqual(
      expect.arrayContaining(['before-quit', 'window-all-closed', 'activate']),
    );
    expect(fakeApp.on).toHaveBeenCalledTimes(3);
  });

  describe('before-quit', () => {
    beforeEach(() => {
      __resetFlushingForQuitForTests();
      setMockWindows([]);
    });

    it('flips isQuitting to true', () => {
      const { deps, fakeApp, spies, state } = buildDeps();
      registerLifecycleHandlers(deps);
      fakeApp.fire('before-quit');
      expect(spies.setIsQuitting).toHaveBeenCalledWith(true);
      expect(state.isQuitting).toBe(true);
    });

    it('hides every live BrowserWindow immediately (UX: app appears to quit instantly)', () => {
      const w1 = { hide: vi.fn() };
      const w2 = { hide: vi.fn() };
      setMockWindows([w1, w2]);
      const { deps, fakeApp } = buildDeps();
      registerLifecycleHandlers(deps);
      fakeApp.fire('before-quit');
      expect(w1.hide).toHaveBeenCalledTimes(1);
      expect(w2.hide).toHaveBeenCalledTimes(1);
    });

    it('preventDefaults the first before-quit so the async flush can run', () => {
      const { deps, fakeApp } = buildDeps();
      registerLifecycleHandlers(deps);
      const ev = fakeApp.fire('before-quit');
      expect(ev.defaultPrevented).toBe(true);
    });

    it('awaits killAllPtySessions then re-fires app.quit() to complete the quit', async () => {
      let resolveKill!: () => void;
      const killAllPtySessions = vi.fn(
        () => new Promise<void>((r) => { resolveKill = r; }),
      );
      const { deps, fakeApp, spies } = buildDeps({ killAllPtySessions });
      registerLifecycleHandlers(deps);

      fakeApp.fire('before-quit');
      expect(killAllPtySessions).toHaveBeenCalledTimes(1);
      // disposeNotifyPipeline + app.quit() must NOT have fired yet — the
      // flush is still in flight.
      expect(spies.disposeNotifyPipeline).not.toHaveBeenCalled();
      expect(fakeApp.quit).not.toHaveBeenCalled();

      // Resolve the kill and let the async chain drain.
      resolveKill();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(spies.disposeNotifyPipeline).toHaveBeenCalledTimes(1);
      // app.quit() re-fired — our fake re-enters before-quit, which now
      // takes the flushingForQuit=true fast path and does NOT re-invoke
      // killAllPtySessions.
      expect(fakeApp.quit).toHaveBeenCalledTimes(1);
      expect(killAllPtySessions).toHaveBeenCalledTimes(1);
    });

    it('second before-quit (flushingForQuit=true) does NOT preventDefault, does NOT re-invoke killAll', async () => {
      const { deps, fakeApp, spies } = buildDeps();
      registerLifecycleHandlers(deps);

      // First pass: kicks off async flush.
      fakeApp.fire('before-quit');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // First pass + re-fired pass from app.quit() inside the async chain.
      expect(spies.killAllPtySessions).toHaveBeenCalledTimes(1);
      expect(fakeApp.quit).toHaveBeenCalledTimes(1);

      // A user-triggered third before-quit (e.g. tray Quit pressed twice)
      // should pass through without re-running the graceful path.
      const ev = fakeApp.fire('before-quit');
      expect(ev.defaultPrevented).toBe(false);
      expect(spies.killAllPtySessions).toHaveBeenCalledTimes(1);
    });

    it('disposes the notify pipeline after killAll resolves', async () => {
      const { deps, fakeApp, spies } = buildDeps();
      registerLifecycleHandlers(deps);
      fakeApp.fire('before-quit');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(spies.disposeNotifyPipeline).toHaveBeenCalledTimes(1);
    });

    it('does not throw when disposeNotifyPipeline is omitted (early-failure path)', async () => {
      const { deps, fakeApp } = buildDeps({ disposeNotifyPipeline: undefined });
      registerLifecycleHandlers(deps);
      expect(() => fakeApp.fire('before-quit')).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    it('swallows killAllPtySessions rejections (best-effort cleanup) and still disposes + quits', async () => {
      const { deps, fakeApp, spies } = buildDeps({
        killAllPtySessions: vi.fn(() => Promise.reject(new Error('pty reap blew up'))),
      });
      registerLifecycleHandlers(deps);
      expect(() => fakeApp.fire('before-quit')).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(spies.disposeNotifyPipeline).toHaveBeenCalledTimes(1);
      expect(fakeApp.quit).toHaveBeenCalledTimes(1);
    });

    it('swallows disposeNotifyPipeline errors and still quits', async () => {
      const { deps, fakeApp } = buildDeps({
        disposeNotifyPipeline: vi.fn(() => {
          throw new Error('dispose blew up');
        }),
      });
      registerLifecycleHandlers(deps);
      expect(() => fakeApp.fire('before-quit')).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fakeApp.quit).toHaveBeenCalledTimes(1);
    });

    it('survives a throwing BrowserWindow.hide() — flush still runs', async () => {
      const wOK = { hide: vi.fn() };
      const wBad = { hide: vi.fn(() => { throw new Error('detached'); }) };
      setMockWindows([wBad, wOK]);
      const { deps, fakeApp, spies } = buildDeps();
      registerLifecycleHandlers(deps);
      expect(() => fakeApp.fire('before-quit')).not.toThrow();
      // OK window still hidden even though the bad one threw.
      expect(wOK.hide).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(spies.killAllPtySessions).toHaveBeenCalledTimes(1);
    });
  });

  describe('window-all-closed', () => {
    it('quits and closes db when isQuitting is already true', () => {
      const { deps, fakeApp, spies, state } = buildDeps();
      state.isQuitting = true;
      registerLifecycleHandlers(deps);
      fakeApp.fire('window-all-closed');
      expect(spies.closeDb).toHaveBeenCalledTimes(1);
      expect(fakeApp.quit).toHaveBeenCalledTimes(1);
    });

    it('does NOT quit when isQuitting is false (tray-resident behavior)', () => {
      const { deps, fakeApp, spies, state } = buildDeps();
      state.isQuitting = false;
      registerLifecycleHandlers(deps);
      fakeApp.fire('window-all-closed');
      expect(spies.closeDb).not.toHaveBeenCalled();
      expect(fakeApp.quit).not.toHaveBeenCalled();
    });

    it('reads the live isQuitting flag (not a snapshot at registration time)', () => {
      const { deps, fakeApp, spies, state } = buildDeps();
      // register while isQuitting=false, then flip before firing the event
      registerLifecycleHandlers(deps);
      state.isQuitting = true;
      fakeApp.fire('window-all-closed');
      expect(spies.closeDb).toHaveBeenCalledTimes(1);
      expect(fakeApp.quit).toHaveBeenCalledTimes(1);
    });
  });

  describe('activate', () => {
    it('spawns a new window when no windows exist', () => {
      const { deps, fakeApp, spies, state } = buildDeps();
      state.windowCount = 0;
      registerLifecycleHandlers(deps);
      fakeApp.fire('activate');
      expect(spies.createWindow).toHaveBeenCalledTimes(1);
    });

    it('does NOT spawn a window when one already exists', () => {
      const { deps, fakeApp, spies, state } = buildDeps();
      state.windowCount = 1;
      registerLifecycleHandlers(deps);
      fakeApp.fire('activate');
      expect(spies.createWindow).not.toHaveBeenCalled();
    });
  });
});
