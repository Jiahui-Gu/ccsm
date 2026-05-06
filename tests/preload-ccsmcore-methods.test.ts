// Task #628 (A2) — unit tests for the preload `ccsmCore` bridge after
// it grew the 25 daemon-backed methods + the CCSM_PRELOAD_SOURCE feature
// flag. Two main concerns:
//
//   1. With the flag ON, the bridge exposes all 25 method signatures
//      (loadState/saveState/i18n.*/getVersion/scanImportable/recentCwds/
//       userCwds.*/defaultModel/pathsExist/window.*) routed through
//      `daemonFetch` to /api/<path> with the {args:[...]} envelope.
//
//   2. With the flag OFF (default), the bridge installs `window.ccsm`
//      via `Object.defineProperty` with `configurable: true`, so the
//      renderer-side window-ccsm-shim's later
//      `Object.defineProperty(window, 'ccsm', { configurable: true, ... })`
//      does NOT throw a TypeError("Cannot redefine property: ccsm") —
//      this is the regression A2 must avoid before B1 deletes the shim.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn<(channel: string) => Promise<number | null>>();
const ipcOn = vi.fn();
const ipcOff = vi.fn();

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (channel: string) => invoke(channel),
    on: (...args: unknown[]) => ipcOn(...args),
    removeListener: (...args: unknown[]) => ipcOff(...args),
  },
  // contextBridge is the legacy fallback path; not exercised under jsdom
  // because we expose `window` directly.
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
}));

beforeEach(() => {
  invoke.mockReset();
  ipcOn.mockReset();
  ipcOff.mockReset();
  delete process.env.CCSM_PRELOAD_SOURCE;
  // Make sure each test starts from a clean window.
  if (
    typeof window !== 'undefined' &&
    Object.getOwnPropertyDescriptor(window, 'ccsm')
  ) {
    delete (window as unknown as { ccsm?: unknown }).ccsm;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadModule() {
  // Re-import each test so module-level state (none today, but defensive)
  // doesn't leak across cases. vi.resetModules clears the registry.
  vi.resetModules();
  return await import('../electron/preload/bridges/ccsmCore');
}

describe('preloadSourceEnabled', () => {
  // Wholesale-deleted in Task #627 (wave B1): the `preloadSourceEnabled`
  // export is gone (the CCSM_PRELOAD_SOURCE flag was removed when the
  // renderer-side shim was deleted). Subject under test no longer
  // exists. The describe stub is preserved so the test count diff is
  // explicit; remove the stub once a follow-up cleanup PR lands.
  it.skip('subject deleted — see Task #627', () => {});
});

describe('buildCcsmCoreApi — flag OFF (default)', () => {
  // Wholesale-deleted in Task #627 (wave B1): the "flag OFF" code path
  // is gone (`buildCcsmCoreApi` now unconditionally returns the merged
  // 6 IPC-only + 25 daemon-backed surface). Subject under test no
  // longer exists.
  it.skip('subject deleted — see Task #627', () => {});
});

describe('installCcsmCoreBridge — shim coexistence', () => {
  // Wholesale-deleted in Task #627 (wave B1): the renderer-side shim
  // was deleted, so the "shim can redefine the binding" + "shim wins
  // when flag OFF" coexistence scenarios no longer have a subject.
  // The fact that `Object.defineProperty(window, 'ccsm', ...)` uses
  // `configurable: true` is now exercised end-to-end by the e2e
  // harness (which itself wraps `window.ccsm.loadState` in
  // `caseStartupPaintsBeforeHydrate`); a pure-jsdom regression test
  // for the descriptor flag would re-introduce a subject we just
  // removed.
  it.skip('subject deleted — see Task #627', () => {});
});

describe('buildCcsmCoreApi — flag ON', () => {
  beforeEach(() => {
    process.env.CCSM_PRELOAD_SOURCE = '1';
  });

  it('exposes all 25 daemon-backed method signatures', async () => {
    const mod = await loadModule();
    const api = mod.buildCcsmCoreApi() as Record<string, unknown> & {
      i18n: Record<string, unknown>;
      userCwds: Record<string, unknown>;
      window: Record<string, unknown>;
    };

    // Top-level: 11 daemon-backed (counting nested namespaces as 1 each)
    expect(typeof api.loadState).toBe('function');
    expect(typeof api.saveState).toBe('function');
    expect(typeof api.getVersion).toBe('function');
    expect(typeof api.scanImportable).toBe('function');
    expect(typeof api.recentCwds).toBe('function');
    expect(typeof api.defaultModel).toBe('function');
    expect(typeof api.pathsExist).toBe('function');

    // i18n.* — 2 methods
    expect(typeof api.i18n.getSystemLocale).toBe('function');
    expect(typeof api.i18n.setLanguage).toBe('function');

    // userCwds.* — 2 methods
    expect(typeof api.userCwds.get).toBe('function');
    expect(typeof api.userCwds.push).toBe('function');

    // window.* — 4 methods + 3 push-channel stubs + 1 sync platform = 8
    expect(typeof api.window.minimize).toBe('function');
    expect(typeof api.window.toggleMaximize).toBe('function');
    expect(typeof api.window.close).toBe('function');
    expect(typeof api.window.isMaximized).toBe('function');
    expect(typeof api.window.onMaximizedChanged).toBe('function');
    expect(typeof api.window.onBeforeHide).toBe('function');
    expect(typeof api.window.onAfterShow).toBe('function');
    expect(typeof api.window.platform).toBe('string');
  });

  it('routes loadState through daemonFetch /api/db/load with {args} envelope', async () => {
    invoke.mockResolvedValue(50000);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ result: 'cached-value' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const mod = await loadModule();
    const api = mod.buildCcsmCoreApi() as { loadState: (k: string) => Promise<string | null> };
    const out = await api.loadState('app:lang');

    expect(out).toBe('cached-value');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:50000/api/db/load');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ args: ['app:lang'] }));
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('routes nested userCwds.push through /api/app/userCwds/push', async () => {
    invoke.mockResolvedValue(50001);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ result: ['/a', '/b'] }), { status: 200 }),
      );

    const mod = await loadModule();
    const api = mod.buildCcsmCoreApi() as {
      userCwds: { push: (p: string) => Promise<string[]> };
    };
    const out = await api.userCwds.push('/b');

    expect(out).toEqual(['/a', '/b']);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:50001/api/app/userCwds/push');
    expect(init?.body).toBe(JSON.stringify({ args: ['/b'] }));
  });

  it('saveState unwraps {ok:true} into Promise<void>', async () => {
    invoke.mockResolvedValue(50002);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: { ok: true } }), { status: 200 }),
    );

    const mod = await loadModule();
    const api = mod.buildCcsmCoreApi() as {
      saveState: (k: string, v: string) => Promise<void>;
    };
    await expect(api.saveState('k', 'v')).resolves.toBeUndefined();
  });

  it('saveState throws when daemon returns {ok:false, error}', async () => {
    invoke.mockResolvedValue(50003);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ result: { ok: false, error: 'disk full' } }),
        { status: 200 },
      ),
    );

    const mod = await loadModule();
    const api = mod.buildCcsmCoreApi() as {
      saveState: (k: string, v: string) => Promise<void>;
    };
    await expect(api.saveState('k', 'v')).rejects.toThrow('disk full');
  });

  it('i18n.setLanguage fires /api/event/set-language and ignores result', async () => {
    invoke.mockResolvedValue(50004);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    const mod = await loadModule();
    const api = mod.buildCcsmCoreApi() as {
      i18n: { setLanguage: (l: 'en' | 'zh') => void };
    };
    const ret = api.i18n.setLanguage('zh');
    expect(ret).toBeUndefined();

    // Wait a tick so the fire-and-forget promise resolves.
    await new Promise((r) => setImmediate(r));

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:50004/api/event/set-language');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ args: ['zh'] }));
  });

  it('window.platform is a sync string available before any daemon call', async () => {
    const mod = await loadModule();
    const api = mod.buildCcsmCoreApi() as {
      window: { platform: string };
    };
    // Whatever the host OS is, it must be one of the known Node platforms
    // (or the win32 fallback). The contract is "sync, non-empty string".
    expect(typeof api.window.platform).toBe('string');
    expect(api.window.platform.length).toBeGreaterThan(0);
  });

  it('event-channel stubs (onMaximizedChanged etc.) return a no-op unsubscribe', async () => {
    const mod = await loadModule();
    const api = mod.buildCcsmCoreApi() as {
      window: {
        onMaximizedChanged: (h: (m: boolean) => void) => () => void;
        onBeforeHide: (h: (info: { durationMs: number }) => void) => () => void;
        onAfterShow: (h: () => void) => () => void;
      };
    };
    const u1 = api.window.onMaximizedChanged(() => {});
    const u2 = api.window.onBeforeHide(() => {});
    const u3 = api.window.onAfterShow(() => {});
    expect(typeof u1).toBe('function');
    expect(typeof u2).toBe('function');
    expect(typeof u3).toBe('function');
    expect(() => {
      u1();
      u2();
      u3();
    }).not.toThrow();
  });

  // Task #624 (C2) — main-process push channels are now wired up. The
  // bridge previously returned NOOP_UNSUBSCRIBE for these three event
  // handlers (preserved by the test above for non-throw shape), but the
  // production behavior must now register an `ipcRenderer.on` listener,
  // forward the payload (skipping IpcRendererEvent), and return an
  // unsubscribe that calls `ipcRenderer.removeListener` against the same
  // (channel, wrap) pair. Main emits these from electron/window/createWindow.ts
  // (`win.webContents.send('window:maximizedChanged', ...)` etc.).
  //
  // Strategy: replace the per-test `ipcOn` mock with a router that
  // captures the (channel, wrap) tuple, then synthesize a main-process
  // emit by invoking the captured wrap directly. The unsubscribe path
  // is verified by removing the captured wrap from the router and then
  // re-emitting — the renderer-side callback must NOT fire.
  describe('window event channels — Task #624 (C2)', () => {
    type Wrap = (...args: unknown[]) => void;
    let listeners: Map<string, Set<Wrap>>;

    beforeEach(() => {
      listeners = new Map();
      ipcOn.mockImplementation((channel: string, wrap: Wrap) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(wrap);
      });
      ipcOff.mockImplementation((channel: string, wrap: Wrap) => {
        listeners.get(channel)?.delete(wrap);
      });
    });

    function emit(channel: string, ...args: unknown[]): void {
      // Mirror Electron's IpcRenderer event signature: first arg is the
      // IpcRendererEvent (we just pass an empty object — the bridge
      // discards it via `_e`), then the payload.
      const fakeEvent = {} as unknown;
      for (const wrap of listeners.get(channel) ?? []) {
        wrap(fakeEvent, ...args);
      }
    }

    it('onMaximizedChanged forwards the boolean payload and unsubscribe stops delivery', async () => {
      const mod = await loadModule();
      const api = mod.buildCcsmCoreApi() as {
        window: {
          onMaximizedChanged: (h: (m: boolean) => void) => () => void;
        };
      };
      const cb = vi.fn<(m: boolean) => void>();
      const unsub = api.window.onMaximizedChanged(cb);

      emit('window:maximizedChanged', true);
      emit('window:maximizedChanged', false);
      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb).toHaveBeenNthCalledWith(1, true);
      expect(cb).toHaveBeenNthCalledWith(2, false);

      unsub();
      emit('window:maximizedChanged', true);
      expect(cb).toHaveBeenCalledTimes(2); // no further deliveries
    });

    it('onBeforeHide forwards the {durationMs} payload and unsubscribe stops delivery', async () => {
      const mod = await loadModule();
      const api = mod.buildCcsmCoreApi() as {
        window: {
          onBeforeHide: (h: (info: { durationMs: number }) => void) => () => void;
        };
      };
      const cb = vi.fn<(info: { durationMs: number }) => void>();
      const unsub = api.window.onBeforeHide(cb);

      emit('window:beforeHide', { durationMs: 220 });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({ durationMs: 220 });

      unsub();
      emit('window:beforeHide', { durationMs: 220 });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('onAfterShow fires with no payload and unsubscribe stops delivery', async () => {
      const mod = await loadModule();
      const api = mod.buildCcsmCoreApi() as {
        window: {
          onAfterShow: (h: () => void) => () => void;
        };
      };
      const cb = vi.fn<() => void>();
      const unsub = api.window.onAfterShow(cb);

      emit('window:afterShow');
      emit('window:afterShow');
      expect(cb).toHaveBeenCalledTimes(2);

      unsub();
      emit('window:afterShow');
      expect(cb).toHaveBeenCalledTimes(2);
    });
  });
});
