// `window.ccsm` — v0.3 wave-1 thin bridge. The only surfaces here are the
// ones that CANNOT live behind the daemon's loopback HTTP boundary:
//
//   1. `getDaemonPort()` — synchronous-ish accessor for the loopback port
//      the daemon child bound to. Returns `null` until the spawn promise
//      in main resolves; renderer is expected to poll/await before fetching
//      against it. Wire is `ipcRenderer.invoke('daemon:getPort')`, not
//      `process.versions` or any other mainworld leak — preload stays the
//      single source of IPC channel knowledge.
//   2. `pickCwd()` — OS folder picker. `dialog.showOpenDialog` needs the
//      requesting BrowserWindow as its parent so the modal attribution is
//      correct, which the daemon (a plain Node process with no window
//      handle) cannot provide.
//   3. `userHome()` — synchronous Node `os.homedir()` lookup. Kept on the
//      IPC side so the renderer doesn't have to wait for the daemon port
//      to be known just to seed its initial cwd default.
//   4. updater channels — electron-updater drives signed-installer side
//      effects from inside the Electron process; wrapping it over HTTP
//      would put a privileged install path on a loopback socket.
//
// Everything else (db / sessions / pty / notify / session titles / i18n /
// import scan / userCwds / paths:exist / window controls) moved to the
// daemon's HTTP API. The renderer fetches `http://127.0.0.1:<port>/...`
// using the port returned by `getDaemonPort()`.
//
// Task #628 (A2) — additionally expose the 25 daemon-backed methods that
// the renderer-side `window-ccsm-shim` provides, so wave B1 can delete the
// shim and let the renderer call `window.ccsm.*` directly. To avoid
// breaking the shim BEFORE B1 lands, we install `window.ccsm` via
// `Object.defineProperty` with `configurable: true` (NOT
// `contextBridge.exposeInMainWorld`, which produces a non-configurable
// binding the shim cannot redefine). This requires `sandbox: false` on
// the BrowserWindow (already configured in electron/window/createWindow.ts).
//
// The 25 methods are gated behind the env flag `CCSM_PRELOAD_SOURCE`
// (default OFF). With the flag OFF, the bridge exposes only the original
// 6 IPC-only methods, and the renderer-side shim still wins via
// `Object.defineProperty(window, 'ccsm', { configurable: true, ... })`.
// Wave B1 will (a) flip the flag default to ON and (b) delete the shim.

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

const NOOP_UNSUBSCRIBE = (): void => {};

// Helper: POST `/api/<path>` with `{args:[...]}` envelope, return the
// `result` field (mirrors the `daemon-client.ts` envelope used by the
// renderer-side shim — same daemon routes, same wire format).
function callDaemonMethod<T>(path: string, args: unknown[]): Promise<T> {
  return daemonFetch<{ result: T } | undefined>(`/api/${path}`, {
    json: { args },
  }).then((res) => (res ? (res.result as T) : (undefined as T)));
}

// `loadState` returns string|null directly via the `result` field.
function makeMethod<T>(path: string) {
  return (...args: unknown[]): Promise<T> => callDaemonMethod<T>(path, args);
}

// `saveState` daemon route returns `{ ok: true } | { ok: false; error }`
// inside `result`. The pre-v0.3 IPC contract is `Promise<void>` that
// throws on failure — call sites in src/stores/persist.ts await it for
// persist-failure error propagation. Mirror the shim's unwrap-and-throw
// so the preload-source path matches the shim path byte-for-byte.
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
}

// The 25 daemon-backed methods. Mirrors src/lib/window-ccsm-shim.ts's
// buildShim() — same paths, same shapes. Pre-resolved `platform` is
// fetched lazily on first read via a sync-ish accessor: see comment on
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
     * Pre-resolved at preload load time when possible. Until the daemon
     * answers, falls back to a `process.platform`-style guess so the
     * sync render-time read in src/components/DragRegion never sees
     * `undefined`. The shim does the same trick.
     */
    platform: Platform;
  };
} {
  // Best-effort sync platform — preload runs in the Electron renderer
  // process, where `process.platform` is the real OS. We still kick off
  // an async daemon fetch to keep parity with the shim's behavior, but
  // for the preload-source path the sync value is already correct on
  // first paint (no daemon round-trip needed).
  const syncPlatform = ((): Platform => {
    if (typeof process !== 'undefined' && process.platform) {
      return process.platform as Platform;
    }
    return 'win32';
  })();

  return {
    loadState: makeMethod<string | null>('db/load'),
    saveState: saveStateMethod,
    i18n: {
      getSystemLocale: makeMethod<string | undefined>('i18n/getSystemLocale'),
      // Fire-and-forget event channel — matches the shim's daemonEvent
      // signature (POST /api/event/set-language with {args:[lang]}).
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
      // Daemon route is /api/app/userCwds/* — see daemon/api/data.ts and
      // the matching comment in the shim.
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
      // Push channels are stubs — daemon has no SSE→renderer channel for
      // these in v0.3. Wave 2 will wire them; until then return a no-op
      // unsubscribe so call sites stay alive.
      onMaximizedChanged: () => NOOP_UNSUBSCRIBE,
      onBeforeHide: () => NOOP_UNSUBSCRIBE,
      onAfterShow: () => NOOP_UNSUBSCRIBE,
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
};

/**
 * Build the full surface exposed on `window.ccsm`. With the
 * `CCSM_PRELOAD_SOURCE` env flag OFF (default), this is exactly the
 * original 6-method IPC-only surface — the renderer's window-ccsm-shim
 * still owns the 25 daemon-backed methods. With the flag ON, we merge
 * the daemon-backed implementations in so the shim becomes redundant
 * (B1 will delete it).
 */
export function buildCcsmCoreApi(): typeof ipcOnlyApi & Partial<ReturnType<typeof buildDaemonMethods>> {
  if (preloadSourceEnabled()) {
    return { ...ipcOnlyApi, ...buildDaemonMethods() };
  }
  return { ...ipcOnlyApi };
}

/**
 * Read the preload-source env flag. Exposed for tests so they can flip
 * the flag deterministically (env vars set in vi.stubEnv don't reach
 * `process.env` reliably across module-graph boundaries; export the
 * accessor so the test can spy on it).
 */
export function preloadSourceEnabled(): boolean {
  if (typeof process === 'undefined' || !process.env) return false;
  return process.env.CCSM_PRELOAD_SOURCE === '1';
}

export type CCSMAPI = ReturnType<typeof buildCcsmCoreApi>;

/**
 * Install `window.ccsm`. Uses `Object.defineProperty` with
 * `configurable: true` (NOT `contextBridge.exposeInMainWorld`) so the
 * renderer-side window-ccsm-shim can still redefine the binding while
 * B1 hasn't deleted the shim yet.
 *
 * Requires `sandbox: false` on the host BrowserWindow — already
 * configured in electron/window/createWindow.ts.
 *
 * Falls back to `contextBridge.exposeInMainWorld` only if `window` is
 * not directly accessible (defensive — should never happen with
 * sandbox:false, but `contextBridge` is the historically-correct path
 * and worth keeping as a safety net).
 */
export function installCcsmCoreBridge(): void {
  const api = buildCcsmCoreApi();
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'ccsm', {
      value: api,
      writable: false,
      configurable: true,
      enumerable: false,
    });
    return;
  }
  contextBridge.exposeInMainWorld('ccsm', api);
}
