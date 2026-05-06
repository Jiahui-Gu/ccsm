// `window.ccsm` — v0.3 wave-B1 single-source preload bridge. The renderer
// no longer carries a `window-ccsm-shim` (deleted in Task #627); every
// `window.ccsm.X(...)` call site is served by this preload module:
//
//   * 6 IPC-only methods (`getDaemonPort`, `pickCwd`, `userHome`, and the
//     `updates*` family + `onUpdate*` push channels) — these surfaces
//     CANNOT live behind the daemon's loopback HTTP boundary because they
//     need the BrowserWindow handle (`pickCwd` modal anchor), the main
//     process's `os.homedir()` lookup (`userHome`), or electron-updater's
//     signed-installer side effects (`updates*`).
//
//   * 25 daemon-backed methods (`loadState`, `saveState`, `i18n.*`,
//     `getVersion`, `scanImportable`, `recentCwds`, `userCwds.*`,
//     `defaultModel`, `pathsExist`, `window.*`) — proxied through
//     `daemonFetch` to `http://127.0.0.1:<port>/api/<path>` with the
//     `{args:[...]}` envelope agreed with the daemon router.
//
// Installation contract: we install `window.ccsm` via
// `Object.defineProperty` with `configurable: true` (NOT
// `contextBridge.exposeInMainWorld`, which produces a non-configurable
// binding that breaks tests / harness wrap helpers). This requires
// `sandbox: false` on the BrowserWindow (already configured in
// `electron/window/createWindow.ts`).
//
// Wave history:
//   * A1 (#629, merged): added the lazy daemon-port cache + daemonFetch
//     helper underneath this bridge.
//   * A2 (#628, merged): grew the 25 daemon-backed methods behind the
//     `CCSM_PRELOAD_SOURCE` env flag (default OFF) so the renderer-side
//     shim still won at runtime while the preload-source path was being
//     tested.
//   * B1 (this PR, #627): deleted the renderer shim and removed the
//     `CCSM_PRELOAD_SOURCE` flag — the 25 methods are now unconditionally
//     exposed and `window.ccsm` is single-sourced from preload.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { daemonFetch } from './_daemon';

type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

type Platform =
  | 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku'
  | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';

// Helper: POST `/api/<path>` with `{args:[...]}` envelope, return the
// `result` field. Same wire format as the (now-deleted) renderer shim's
// daemonInvoke helper — kept identical so the daemon router doesn't need
// to know which side is calling.
function callDaemonMethod<T>(path: string, args: unknown[]): Promise<T> {
  return daemonFetch<{ result: T } | undefined>(`/api/${path}`, {
    json: { args },
  }).then((res) => (res ? (res.result as T) : (undefined as T)));
}

// `loadState` returns string|null directly via the `result` field.
function makeMethod<T>(path: string) {
  return (...args: unknown[]): Promise<T> => callDaemonMethod<T>(path, args);
}

// Task #633 (B1-FIX) — harness-only loadState delay seam.
//
// Background: the e2e case `startup-paints-before-hydrate` needs to extend
// the renderer's hydrated=false window long enough to observe the sidebar
// skeleton paint. Pre-B1 the harness monkey-patched `window.ccsm.loadState`
// from the renderer side, but B1 deleted the renderer shim and switched to
// `contextBridge.exposeInMainWorld`, which freezes the renderer-side handle
// (function properties cannot be reassigned across the world boundary).
// The next attempted workaround — wrapping `window.fetch` from a Playwright
// `addInitScript` — also doesn't work: `addInitScript` injects into the
// renderer's main world, but `daemonFetch` runs in the preload's isolated
// world, so its `fetch` call never hits the wrap.
//
// The clean answer is a preload-side test seam: read
// `CCSM_HARNESS_LOAD_STATE_DELAY_MS` at preload load time, and have
// `loadState` honor that delay before issuing the daemon call. The
// harness-runner sets this env via per-case `launchEnv` on a relaunched
// electron, so only the case that needs the delay pays for it. Production
// renderers never see the env so the path is a strict no-op there.
function readInitialLoadStateDelayMs(): number {
  const raw = process.env.CCSM_HARNESS_LOAD_STATE_DELAY_MS;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
const loadStateDelayMs = readInitialLoadStateDelayMs();

function loadStateMethod(key: string): Promise<string | null> {
  if (loadStateDelayMs > 0) {
    return new Promise<void>((r) => setTimeout(r, loadStateDelayMs)).then(() =>
      callDaemonMethod<string | null>('db/load', [key]),
    );
  }
  return callDaemonMethod<string | null>('db/load', [key]);
}

// `saveState` daemon route returns `{ ok: true } | { ok: false; error }`
// inside `result`. The pre-v0.3 IPC contract is `Promise<void>` that
// throws on failure — call sites in src/stores/persist.ts await it for
// persist-failure error propagation. Unwrap-and-throw here keeps the
// outward contract identical to the v0.2 IPC bridge.
async function saveStateMethod(key: string, value: string): Promise<void> {
  const res = (await callDaemonMethod('db/save', [key, value])) as
    | { ok: true }
    | { ok: false; error: string }
    | undefined
    | null;
  if (!res || (res as { ok: boolean }).ok !== true) {
    const errMsg =
      res && (res as { ok: false; error?: string }).error
        ? (res as { ok: false; error: string }).error
        : 'saveState failed';
    throw new Error(errMsg);
  }
  // Task #636 — keep main's close-action cache in sync with the daemon.
  // `win.on('close')` reads the preference SYNCHRONOUSLY (Electron's close
  // event has no `await`), so without this nudge a renderer-side change
  // only takes effect on next app launch — and the e2e tray/close-dialog
  // cases share an electron, so the second case sees the first case's
  // stale cache and fires the wrong branch. Fire-and-forget: a missed
  // notify just falls back to the on-startup cache prime, which is the
  // pre-v0.3 behaviour. Only piggy-back for keys main actually mirrors.
  if (key === 'closeAction') {
    void ipcRenderer.invoke('main:notifyCloseAction', value).catch(() => {
      /* best-effort */
    });
  }
}

// The 25 daemon-backed methods. Same paths and shapes as the v0.2 IPC
// surface they replaced. Pre-resolved `platform` is read synchronously
// from `process.platform` at preload-load time: see comment on
// `windowApi.platform` below.
function buildDaemonMethods(): {
  loadState: (key: string) => Promise<string | null>;
  saveState: (key: string, value: string) => Promise<void>;
  i18n: {
    getSystemLocale: () => Promise<string | undefined>;
    setLanguage: (l: 'en' | 'zh') => void;
  };
  getVersion: () => Promise<string>;
  scanImportable: () => Promise<
    Array<{
      sessionId: string;
      cwd: string;
      title: string;
      mtime: number;
      projectDir: string;
      model: string | null;
    }>
  >;
  recentCwds: () => Promise<string[]>;
  userCwds: {
    get: () => Promise<string[]>;
    push: (p: string) => Promise<string[]>;
  };
  defaultModel: () => Promise<string | null>;
  pathsExist: (paths: string[]) => Promise<Record<string, boolean>>;
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizedChanged: (handler: (max: boolean) => void) => () => void;
    onBeforeHide: (handler: (info: { durationMs: number }) => void) => () => void;
    onAfterShow: (handler: () => void) => () => void;
    /**
     * Pre-resolved at preload load time. Read synchronously inside
     * `<DragRegion />` render so we cannot return a Promise here. The
     * preload runs in the Electron renderer process where
     * `process.platform` is the real OS, so no daemon round-trip is
     * needed for the sync value to be correct on first paint.
     */
    platform: Platform;
  };
} {
  // Best-effort sync platform — preload runs in the Electron renderer
  // process, where `process.platform` is the real OS. No async fetch
  // needed; the sync value is already correct on first paint.
  const syncPlatform = ((): Platform => {
    if (typeof process !== 'undefined' && process.platform) {
      return process.platform as Platform;
    }
    return 'win32';
  })();

  return {
    loadState: loadStateMethod,
    saveState: saveStateMethod,
    i18n: {
      getSystemLocale: makeMethod<string | undefined>('i18n/getSystemLocale'),
      // Fire-and-forget event channel — POST /api/event/set-language
      // with `{args:[lang]}`. Matches the v0.2 IPC `setLanguage` send.
      setLanguage: (l: 'en' | 'zh'): void => {
        void daemonFetch('/api/event/set-language', { json: { args: [l] } }).catch(
          () => {
            /* fire-and-forget */
          },
        );
      },
    },
    getVersion: makeMethod<string>('getVersion'),
    scanImportable: makeMethod<
      Array<{
        sessionId: string;
        cwd: string;
        title: string;
        mtime: number;
        projectDir: string;
        model: string | null;
      }>
    >('scanImportable'),
    recentCwds: makeMethod<string[]>('recentCwds'),
    userCwds: {
      // Daemon route is /api/app/userCwds/* — see daemon/api/data.ts.
      get: makeMethod<string[]>('app/userCwds/get'),
      push: makeMethod<string[]>('app/userCwds/push'),
    },
    defaultModel: makeMethod<string | null>('defaultModel'),
    pathsExist: makeMethod<Record<string, boolean>>('pathsExist'),
    window: {
      minimize: makeMethod<void>('window/minimize'),
      toggleMaximize: makeMethod<boolean>('window/toggleMaximize'),
      close: makeMethod<void>('window/close'),
      isMaximized: makeMethod<boolean>('window/isMaximized'),
      // Task #624 (C2) — main-process IPC push channels. Main emits these
      // via `win.webContents.send(...)` from `electron/window/createWindow.ts`:
      //   * 'window:maximizedChanged' (boolean) — on win.maximize/unmaximize
      //   * 'window:beforeHide' ({ durationMs }) — before fade-out + hide
      //   * 'window:afterShow' (no payload) — after the show animation
      // The bridge wraps each handler so we hide the IpcRendererEvent from
      // the renderer-side callback contract (matches `onUpdateStatus` /
      // `onUpdateDownloaded` above), and returns a strict-removeListener
      // unsubscribe so the renderer can detach without leaking.
      onMaximizedChanged: (handler: (max: boolean) => void): (() => void) => {
        const wrap = (_e: IpcRendererEvent, max: boolean): void => handler(max);
        ipcRenderer.on('window:maximizedChanged', wrap);
        return (): void => {
          ipcRenderer.removeListener('window:maximizedChanged', wrap);
        };
      },
      onBeforeHide: (handler: (info: { durationMs: number }) => void): (() => void) => {
        const wrap = (_e: IpcRendererEvent, info: { durationMs: number }): void =>
          handler(info);
        ipcRenderer.on('window:beforeHide', wrap);
        return (): void => {
          ipcRenderer.removeListener('window:beforeHide', wrap);
        };
      },
      onAfterShow: (handler: () => void): (() => void) => {
        const wrap = (_e: IpcRendererEvent): void => handler();
        ipcRenderer.on('window:afterShow', wrap);
        return (): void => {
          ipcRenderer.removeListener('window:afterShow', wrap);
        };
      },
      platform: syncPlatform,
    },
  };
}

const ipcOnlyApi = {
  /**
   * Resolved loopback port for the daemon child spawned by main.
   * Returns `null` while the spawn promise is still in flight or after
   * the daemon has died. Renderer should poll this from a single place
   * (the boot-time hydration store) and re-poll on null instead of
   * calling it from every fetch site.
   */
  getDaemonPort: (): Promise<number | null> =>
    ipcRenderer.invoke('daemon:getPort'),

  /**
   * Open the OS folder picker so the user can choose a working directory.
   * Returns the picked absolute path on success, or `null` when the user
   * cancelled. Anchored on the requesting BrowserWindow so the dialog is
   * modal to the right surface.
   */
  pickCwd: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('cwd:pick', { defaultPath }),

  /**
   * Path to the user's home directory (`os.homedir()` on the main process).
   * Used as the always-true default cwd for new sessions.
   */
  userHome: (): Promise<string> => ipcRenderer.invoke('app:userHome'),

  updatesStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:status'),
  updatesCheck: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:check'),
  updatesDownload: (): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('updates:download'),
  updatesInstall: (): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('updates:install'),
  updatesGetAutoCheck: (): Promise<boolean> => ipcRenderer.invoke('updates:getAutoCheck'),
  updatesSetAutoCheck: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('updates:setAutoCheck', enabled),
  onUpdateStatus: (handler: (s: UpdateStatus) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: UpdateStatus) => handler(payload);
    ipcRenderer.on('updates:status', wrap);
    return () => ipcRenderer.removeListener('updates:status', wrap);
  },
  onUpdateDownloaded: (handler: (info: { version: string }) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: { version: string }) => handler(payload);
    ipcRenderer.on('update:downloaded', wrap);
    return () => ipcRenderer.removeListener('update:downloaded', wrap);
  },

  // Task #639 — daemon storage health surface. Pull (`getStorageHealth`)
  // returns the last known snapshot from main's spawn-time probe; null
  // means the probe never reported (treated as "ok / unknown" by the
  // bridge). Push (`onStorageHealth`) fires when main re-fans the
  // snapshot. The renderer's useStorageHealthBridge hook calls both on
  // mount: pull for the synchronous initial paint (so a re-mounted
  // window picks up an earlier failure without race), subscribe for
  // late arrivals.
  getStorageHealth: (): Promise<{ ok: boolean; reason?: string } | null> =>
    ipcRenderer.invoke('storage:getHealth'),
  onStorageHealth: (
    handler: (h: { ok: boolean; reason?: string }) => void,
  ): (() => void) => {
    const wrap = (
      _e: IpcRendererEvent,
      payload: { ok: boolean; reason?: string },
    ): void => handler(payload);
    ipcRenderer.on('storage:health', wrap);
    return (): void => {
      ipcRenderer.removeListener('storage:health', wrap);
    };
  },
};

/**
 * Build the full `window.ccsm` surface — 6 IPC-only methods merged with
 * the 25 daemon-backed methods. Wave B1 (Task #627) removed the
 * `CCSM_PRELOAD_SOURCE` env flag: the daemon-backed methods are now
 * unconditionally exposed because the renderer-side shim that used to
 * serve them is gone.
 */
export function buildCcsmCoreApi(): typeof ipcOnlyApi & ReturnType<typeof buildDaemonMethods> {
  return { ...ipcOnlyApi, ...buildDaemonMethods() };
}

export type CCSMAPI = ReturnType<typeof buildCcsmCoreApi>;

/**
 * Install `window.ccsm` for the renderer.
 *
 * **Why contextBridge, not `Object.defineProperty(window, ...)`**: the
 * BrowserWindow is created with `contextIsolation: true` (see
 * `electron/window/createWindow.ts`). Under context isolation, the
 * preload script's `window` is a separate JavaScript world from the
 * renderer's main world — defining `window.ccsm` here only attaches it
 * to the isolated world the renderer can't see. `contextBridge.
 * exposeInMainWorld` is the only Electron-supported channel that
 * crosses worlds.
 *
 * Side effect: contextBridge deep-clones plain values across the world
 * boundary and proxies functions; the renderer-side handle is frozen,
 * so test harnesses can no longer reassign individual methods (e.g.
 * `window.ccsm.loadState = wrapped`). Harnesses that need to inject
 * latency now wrap at the daemon boundary instead.
 *
 * Falls back to `Object.defineProperty(window, ...)` for the jsdom unit
 * tests where `contextBridge.exposeInMainWorld` is mocked but no real
 * isolated world exists.
 */
export function installCcsmCoreBridge(): void {
  const api = buildCcsmCoreApi();
  // Prefer contextBridge — the only world-crossing channel under
  // contextIsolation:true (which is the production webPreferences).
  try {
    contextBridge.exposeInMainWorld('ccsm', api);
    return;
  } catch {
    /* fall through to direct attach (jsdom / test environments) */
  }
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'ccsm', {
      value: api,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  }
}
