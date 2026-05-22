import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { App } from 'electron';

// Mock electron — appLifecycle.ts top-level imports `Menu`, which would
// trigger "Electron failed to install correctly" on the lint+test runner
// (no electron binary on CI). We control the spies via the mock factory
// and read them back via vi.mocked() in tests.
vi.mock('electron', () => {
  const buildFromTemplate = vi.fn(() => ({ items: [] }));
  const setApplicationMenu = vi.fn();
  return {
    Menu: { buildFromTemplate, setApplicationMenu },
  };
});

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

import { Menu } from 'electron';
import {
  applyAppMenuLocale,
  registerLifecycleHandlers,
  type LifecycleDeps,
} from '../appLifecycle';

type EventName = 'before-quit' | 'window-all-closed' | 'activate';

interface FakeApp {
  on: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  /** invoke a registered listener for a given event; for `before-quit` we
   *  pass an Event-like object with a `preventDefault` spy so tests can
   *  assert the async-cleanup gate fired (and inspect re-quit re-entry). */
  fire: (event: EventName, arg?: { preventDefault: () => void }) => void;
}

function createFakeApp(): FakeApp {
  const handlers = new Map<EventName, (arg?: unknown) => void>();
  const on = vi.fn((event: EventName, cb: (arg?: unknown) => void) => {
    handlers.set(event, cb);
  });
  const quit = vi.fn();
  return {
    on,
    quit,
    fire: (event, arg) => {
      const cb = handlers.get(event);
      if (!cb) throw new Error(`no handler registered for ${event}`);
      cb(arg);
    },
  };
}

/** Build a fake Electron Event with a preventDefault spy. */
function fakeEvent(): { preventDefault: ReturnType<typeof vi.fn> } {
  return { preventDefault: vi.fn() };
}

/** Drain pending microtasks so awaited async work inside the before-quit
 *  handler settles before assertions. We use multiple `await` cycles because
 *  the handler chains `await killAllPtySessions()` → optional dispose →
 *  `app.quit()`; one microtask tick isn't enough. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

function buildDeps(overrides: Partial<LifecycleDeps> = {}): {
  deps: LifecycleDeps;
  fakeApp: FakeApp;
  spies: {
    setIsQuitting: ReturnType<typeof vi.fn>;
    // killAllPtySessions returns Promise<void> in production so the
    // before-quit handler can await the parallel taskkill fanout.
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

  it('builds a hidden Edit-role accelerator menu and installs it', () => {
    applyAppMenuLocale();
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
  });

  it('uses the localized "Edit" label from i18n.tMenu', () => {
    applyAppMenuLocale();
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0];
    expect(template).toHaveLength(1);
    expect(template[0].label).toBe('MENU_edit');
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
    it('flips isQuitting to true', () => {
      const { deps, fakeApp, spies, state } = buildDeps();
      registerLifecycleHandlers(deps);
      fakeApp.fire('before-quit', fakeEvent());
      expect(spies.setIsQuitting).toHaveBeenCalledWith(true);
      expect(state.isQuitting).toBe(true);
    });

    it('preventDefaults the sync quit so async cleanup can run before exit', () => {
      const { deps, fakeApp } = buildDeps();
      registerLifecycleHandlers(deps);
      const ev = fakeEvent();
      fakeApp.fire('before-quit', ev);
      // First-pass before-quit MUST block Electron's sync teardown — otherwise
      // the process exits before killAllPtySessions's parallel taskkill
      // fanout has a chance to complete, leaving orphan claude.exe children
      // on Windows and freezing the visible UI for N × taskkill latency.
      expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('reaps pty sessions', async () => {
      const { deps, fakeApp, spies } = buildDeps();
      registerLifecycleHandlers(deps);
      fakeApp.fire('before-quit', fakeEvent());
      await flushAsync();
      expect(spies.killAllPtySessions).toHaveBeenCalledTimes(1);
    });

    it('re-invokes app.quit() after async cleanup settles (second-pass exit)', async () => {
      const { deps, fakeApp, spies } = buildDeps();
      registerLifecycleHandlers(deps);
      fakeApp.fire('before-quit', fakeEvent());
      // Sync: not yet — we're still awaiting killAllPtySessions().
      expect(fakeApp.quit).not.toHaveBeenCalled();
      await flushAsync();
      // Async: cleanup done → handler re-fires quit so Electron exits cleanly.
      expect(fakeApp.quit).toHaveBeenCalledTimes(1);
      expect(spies.killAllPtySessions).toHaveBeenCalledTimes(1);
    });

    it('does NOT loop forever — re-entry on the quit-driven before-quit is a pass-through', async () => {
      const { deps, fakeApp, spies } = buildDeps();
      registerLifecycleHandlers(deps);
      // First-pass: starts cleanup, preventDefaults.
      const ev1 = fakeEvent();
      fakeApp.fire('before-quit', ev1);
      await flushAsync();
      expect(ev1.preventDefault).toHaveBeenCalledTimes(1);
      expect(fakeApp.quit).toHaveBeenCalledTimes(1);
      // Simulate Electron firing before-quit again from the internal
      // `app.quit()` we just dispatched. Guard MUST let it through —
      // no second preventDefault, no second cleanup.
      const ev2 = fakeEvent();
      fakeApp.fire('before-quit', ev2);
      await flushAsync();
      expect(ev2.preventDefault).not.toHaveBeenCalled();
      expect(spies.killAllPtySessions).toHaveBeenCalledTimes(1);
      // The pass-through doesn't re-invoke app.quit either (else infinite loop)
      expect(fakeApp.quit).toHaveBeenCalledTimes(1);
    });

    it('disposes the notify pipeline when present', async () => {
      const { deps, fakeApp, spies } = buildDeps();
      registerLifecycleHandlers(deps);
      fakeApp.fire('before-quit', fakeEvent());
      await flushAsync();
      expect(spies.disposeNotifyPipeline).toHaveBeenCalledTimes(1);
    });

    it('does not throw when disposeNotifyPipeline is omitted (early-failure path)', async () => {
      const { deps, fakeApp } = buildDeps({ disposeNotifyPipeline: undefined });
      registerLifecycleHandlers(deps);
      expect(() => fakeApp.fire('before-quit', fakeEvent())).not.toThrow();
      await expect(flushAsync()).resolves.toBeUndefined();
    });

    it('swallows killAllPtySessions rejections (best-effort cleanup) and still proceeds to quit', async () => {
      const { deps, fakeApp, spies } = buildDeps({
        killAllPtySessions: vi.fn(() => Promise.reject(new Error('pty reap blew up'))),
      });
      registerLifecycleHandlers(deps);
      fakeApp.fire('before-quit', fakeEvent());
      await flushAsync();
      // disposeNotifyPipeline still runs even if kill rejected
      expect(spies.disposeNotifyPipeline).toHaveBeenCalledTimes(1);
      // app.quit still re-fires so the process actually exits
      expect(fakeApp.quit).toHaveBeenCalledTimes(1);
    });

    it('swallows synchronous killAllPtySessions throws too', async () => {
      const { deps, fakeApp, spies } = buildDeps({
        killAllPtySessions: vi.fn(() => {
          throw new Error('pty reap sync blew up');
        }),
      });
      registerLifecycleHandlers(deps);
      expect(() => fakeApp.fire('before-quit', fakeEvent())).not.toThrow();
      await flushAsync();
      expect(spies.disposeNotifyPipeline).toHaveBeenCalledTimes(1);
      expect(fakeApp.quit).toHaveBeenCalledTimes(1);
    });

    it('swallows disposeNotifyPipeline errors', async () => {
      const { deps, fakeApp } = buildDeps({
        disposeNotifyPipeline: vi.fn(() => {
          throw new Error('dispose blew up');
        }),
      });
      registerLifecycleHandlers(deps);
      expect(() => fakeApp.fire('before-quit', fakeEvent())).not.toThrow();
      await flushAsync();
      expect(fakeApp.quit).toHaveBeenCalledTimes(1);
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
