// v0.3 wave 1 — `window.ccsm` compatibility shim over the daemon HTTP
// API. The 25-ish renderer call sites keep using `window.ccsm.X(...)`
// unchanged; under the hood every method now POSTs to the daemon at
// `http://127.0.0.1:<port>/api/...` (see `daemon-client.ts` for the
// envelope).
//
// Mapping rule (matches `daemon-client.ts`'s convention):
//   `window.ccsm.X(...)`              → POST /api/X
//   `window.ccsm.window.minimize()`    → POST /api/window/minimize
//   `window.ccsm.userCwds.get()`       → POST /api/userCwds/get
//   `window.ccsm.i18n.setLanguage(l)`  → POST /api/i18n/setLanguage
//
// Two awkward spots that fetch alone can't cover:
//
// 1. SYNC PROPERTY: `window.ccsm.window.platform` is read during React
//    render (`<DragRegion style={{ height: ...platform === 'darwin' ? 40 : 8 }} />`)
//    so we cannot return a Promise. We pre-fetch the platform string in
//    `installCcsmShim()` BEFORE React mounts and bake it into the shim
//    object as a plain string. If the daemon is offline at boot we fall
//    back to `navigator.platform`-derived guess so the renderer doesn't
//    crash on first paint.
//
// 2. EVENT SUBSCRIPTIONS: `onUpdateStatus`, `onUpdateDownloaded`,
//    `onMaximizedChanged`, `onBeforeHide`, `onAfterShow`. v0.3 has no
//    daemon→renderer push channel yet (wave 2 will add SSE / WS), so for
//    now these install no-op handlers and return a no-op unsubscribe.
//    The renderer continues to function — Updates pane just shows the
//    last-seen status, window-controls maximize button doesn't auto-flip
//    (user can click again). Documented in PR body so the wave 2 dev
//    knows to wire these.

import { daemonInvoke, daemonEvent } from './daemon-client';
import { init as initDaemonPort } from './daemon-port';
import type { UpdateStatus } from '../global';

// Re-declared here (instead of importing the global Window typing) so
// `daemon-client.ts` and the global ambient type can co-exist without
// circular imports. The shape matches `global.d.ts`'s `window.ccsm` type
// as it stood before the v0.3 refactor; consumers see the same surface.

export type Platform =
  | 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku'
  | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';

export interface CcsmApi {
  loadState: (key: string) => Promise<string | null>;
  saveState: (key: string, value: string) => Promise<void>;
  i18n: {
    getSystemLocale: () => Promise<string | undefined>;
    setLanguage: (l: 'en' | 'zh') => void;
  };
  getVersion: () => Promise<string>;
  scanImportable: () => Promise<
    Array<{ sessionId: string; cwd: string; title: string; mtime: number; projectDir: string; model: string | null }>
  >;
  recentCwds: () => Promise<string[]>;
  userHome: () => Promise<string>;
  userCwds: {
    get: () => Promise<string[]>;
    push: (p: string) => Promise<string[]>;
  };
  pickCwd: (defaultPath?: string) => Promise<string | null>;
  defaultModel: () => Promise<string | null>;
  pathsExist: (paths: string[]) => Promise<Record<string, boolean>>;
  updatesStatus: () => Promise<UpdateStatus>;
  updatesCheck: () => Promise<UpdateStatus>;
  updatesDownload: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  updatesInstall: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  updatesGetAutoCheck: () => Promise<boolean>;
  updatesSetAutoCheck: (enabled: boolean) => Promise<boolean>;
  onUpdateStatus: (handler: (s: UpdateStatus) => void) => () => void;
  onUpdateDownloaded: (handler: (info: { version: string }) => void) => () => void;
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizedChanged: (handler: (max: boolean) => void) => () => void;
    onBeforeHide: (handler: (info: { durationMs: number }) => void) => () => void;
    onAfterShow: (handler: () => void) => () => void;
    /** Pre-resolved at shim install time (sync read in render). */
    platform: Platform;
  };
}

const NOOP_UNSUBSCRIBE = (): void => {};

function guessPlatform(): Platform {
  // Best-effort fallback for when the daemon isn't reachable at boot.
  // Renderer only branches on === 'darwin' today, so the worst case is
  // showing the Windows-style 8px drag strip on macOS until the daemon
  // comes online and the user reloads.
  const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
  if (/Mac/i.test(ua)) return 'darwin';
  if (/Win/i.test(ua)) return 'win32';
  if (/Linux/i.test(ua)) return 'linux';
  return 'win32';
}

function buildShim(platform: Platform): CcsmApi {
  // Method helpers — close over the daemon path so call sites stay flat.
  // We type each helper through the CcsmApi interface (the unknown→T
  // cast is the bridge between the dynamic envelope and the static
  // type). Keep the casts in one place; never sprinkle them at call sites.
  const m = <T>(path: string) => (...args: unknown[]): Promise<T> =>
    daemonInvoke(path, args) as Promise<T>;

  // saveState daemon route returns `{ ok: true } | { ok: false; error: string }`
  // verbatim (see daemon/api/data.ts safeSaveState). The v0.2 preload
  // bridge guaranteed `Promise<void>` that throws on `{ ok: false }`, and
  // call sites in src/stores/persist.ts rely on `await saveState()` to
  // propagate persist failures via thrown errors. The generic `m<void>`
  // helper would resolve to the `{ ok }` discriminant and silently lose
  // failures (data-loss regression). Unwrap-and-throw here keeps the
  // outward contract identical to the v0.2 bridge.
  const saveStateInvoke = async (key: string, value: string): Promise<void> => {
    const res = (await daemonInvoke('db/save', [key, value])) as
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
  };

  return {
    loadState: m<string | null>('db/load'),
    saveState: saveStateInvoke,
    i18n: {
      getSystemLocale: m<string | undefined>('i18n/getSystemLocale'),
      setLanguage: (l: 'en' | 'zh') => {
        // Fire-and-forget event (matches the original ipcRenderer.send
        // shape — preload had setLanguage as a one-way send, not invoke).
        void daemonEvent('set-language', [l]);
      },
    },
    getVersion: m<string>('getVersion'),
    scanImportable: m<
      Array<{ sessionId: string; cwd: string; title: string; mtime: number; projectDir: string; model: string | null }>
    >('scanImportable'),
    recentCwds: m<string[]>('recentCwds'),
    userHome: m<string>('userHome'),
    userCwds: {
      // Daemon registers these under /api/app/userCwds/* (see
      // daemon/api/data.ts). The shim previously called /api/userCwds/*
      // which 404s — same drift class as loadState/saveState.
      get: m<string[]>('app/userCwds/get'),
      push: m<string[]>('app/userCwds/push'),
    },
    pickCwd: m<string | null>('pickCwd'),
    defaultModel: m<string | null>('defaultModel'),
    pathsExist: m<Record<string, boolean>>('pathsExist'),
    updatesStatus: m<UpdateStatus>('updatesStatus'),
    updatesCheck: m<UpdateStatus>('updatesCheck'),
    updatesDownload: m<{ ok: true } | { ok: false; reason: string }>('updatesDownload'),
    updatesInstall: m<{ ok: true } | { ok: false; reason: string }>('updatesInstall'),
    updatesGetAutoCheck: m<boolean>('updatesGetAutoCheck'),
    updatesSetAutoCheck: m<boolean>('updatesSetAutoCheck'),
    // Event subscriptions are stubs in v0.3 (no push channel yet).
    // See module header for the wave-2 follow-up.
    onUpdateStatus: () => NOOP_UNSUBSCRIBE,
    onUpdateDownloaded: () => NOOP_UNSUBSCRIBE,
    window: {
      minimize: m<void>('window/minimize'),
      toggleMaximize: m<boolean>('window/toggleMaximize'),
      close: m<void>('window/close'),
      isMaximized: m<boolean>('window/isMaximized'),
      onMaximizedChanged: () => NOOP_UNSUBSCRIBE,
      onBeforeHide: () => NOOP_UNSUBSCRIBE,
      onAfterShow: () => NOOP_UNSUBSCRIBE,
      platform,
    },
  };
}

/**
 * Install `window.ccsm` before React mounts.
 *
 * Resolution order:
 *   1. Kick off daemon-port discovery (`__getDaemonPort()`).
 *   2. Pre-fetch `/api/window/platform` so the sync property read in
 *      render gives a real value.
 *   3. If either step fails (daemon offline at boot), install the shim
 *      anyway with a guessed platform — every async method will throw
 *      `daemon offline: ...` on first call (consistent error surface),
 *      and the renderer mounts without crashing.
 */
export async function installCcsmShim(): Promise<void> {
  let platform: Platform;
  try {
    await initDaemonPort();
    const p = (await daemonInvoke('window/platform', [])) as unknown;
    platform = (typeof p === 'string' ? p : guessPlatform()) as Platform;
  } catch {
    platform = guessPlatform();
  }
  const shim = buildShim(platform);
  // Install non-enumerable so devtools console reads cleanly and so
  // accidental `Object.assign(window, ...)` callers don't clobber it.
  Object.defineProperty(window, 'ccsm', {
    value: shim,
    writable: false,
    configurable: true,
    enumerable: false,
  });
}
