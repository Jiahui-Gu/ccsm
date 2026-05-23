// `window.ccsm` — the catch-all "core" bridge: app-state persistence
// (db:load/save), i18n, version, importable-session scan, recent/user
// cwds, path existence, updater, and window controls. Originally lived
// inline in `electron/preload.ts`; extracted in #769 (SRP wave-2 PR-A)
// without behavioral change.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  DB_CHANNELS,
  UPDATE_CHANNELS,
  UPDATES_CHANNELS,
  WINDOW_CHANNELS,
} from '../../shared/ipcChannels';

type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

const api = {
  loadState: (key: string): Promise<string | null> => ipcRenderer.invoke(DB_CHANNELS.load, key),
  // The IPC handler returns a `{ok}` shape so it never crosses the IPC
  // boundary as a thrown Error (Electron surfaces those as ugly stack
  // dumps in the renderer console). We unwrap here and re-throw on
  // failure so the existing `.catch(onPersistError)` callers in
  // src/stores/persist.ts and src/stores/drafts.ts actually fire — a
  // resolved `{ok:false}` would otherwise slip past `.catch` silently
  // and produce data loss with zero renderer signal.
  saveState: async (key: string, value: string): Promise<void> => {
    const result = (await ipcRenderer.invoke(DB_CHANNELS.save, key, value)) as
      | { ok: true }
      | { ok: false; error: string };
    if (!result.ok) {
      throw new Error(result.error);
    }
  },
  // i18n: renderer reads OS locale to seed its "system" preference, and
  // pushes the resolved UI language to main so OS notifications match.
  // Lives under `i18n` to keep the bridge surface organised; renderer
  // accesses via `window.ccsm.i18n.*`.
  i18n: {
    getSystemLocale: (): Promise<string | undefined> =>
      ipcRenderer.invoke('ccsm:get-system-locale'),
    setLanguage: (lang: 'en' | 'zh'): void => {
      ipcRenderer.send('ccsm:set-language', lang);
    }
  },
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),

  scanImportable: (): Promise<
    Array<{ sessionId: string; cwd: string; title: string; mtime: number; projectDir: string; model: string | null }>
  > => ipcRenderer.invoke('import:scan'),

  /**
   * Most-recently-used cwds shown in the StatusBar cwd popover. Sourced from
   * the ccsm-owned LRU (`app:userCwds`), NOT from CLI JSONL scans — the user's
   * CLI history is not their ccsm working-set. Always includes the user's
   * home directory as a fallback so the list is never empty on a fresh
   * install. Use `userCwds.push` to extend the list when the user explicitly
   * picks a non-default cwd.
   */
  recentCwds: (): Promise<string[]> => ipcRenderer.invoke('import:recentCwds'),

  /**
   * Path to the user's home directory (`os.homedir()` on the main process).
   * Used as the always-true default cwd for new sessions, regardless of CLI
   * history. Resolved once at boot and cached in the renderer store.
   */
  userHome: (): Promise<string> => ipcRenderer.invoke('app:userHome'),

  /**
   * ccsm-owned LRU of cwds the user has explicitly chosen. Persisted in the
   * `app_state` SQLite table; capped at 20 entries. The default-cwd source for
   * new sessions is `userHome()` — this list only seeds the popover's recent
   * column.
   */
  userCwds: {
    get: (): Promise<string[]> => ipcRenderer.invoke('app:userCwds:get'),
    push: (p: string): Promise<string[]> =>
      ipcRenderer.invoke('app:userCwds:push', p),
  },

  /**
   * Open the OS folder picker so the user can choose a working directory
   * for a new session. Returns the picked absolute path on success, or
   * `null` when the user cancelled. Backs the cwd popover's "Browse..."
   * button (#628) — prior to this IPC the button was a no-op (just closed
   * the popover), causing user-picked cwds to silently fall back to home.
   */
  pickCwd: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('cwd:pick', { defaultPath }),

  /**
   * The user's CLI default-model preference, read directly from
   * `~/.claude/settings.json`'s `model` field. Seeds the new-session model
   * picker so ccsm matches whatever the user already configured for the
   * standalone CLI. Returns null when the field is unset, the file is
   * missing, or it can't be parsed — caller falls back to the SDK default.
   */
  defaultModel: (): Promise<string | null> => ipcRenderer.invoke('settings:defaultModel'),

  /**
   * Best-effort batched existence check. Returns a map keyed by the input
   * path; permission errors and ENOENT both map to `false`. Used by the
   * renderer's hydration migration to flag sessions whose persisted `cwd`
   * was deleted between runs.
   */
  pathsExist: (paths: string[]): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('paths:exist', paths),

  /**
   * Open an external URL in the user's default browser. Backs the
   * Ctrl/Cmd-click handler installed on xterm's WebLinksAddon — the only
   * production caller. The main process enforces a strict http(s) scheme
   * whitelist (see `electron/ipc/utilityIpc.ts:isAllowedExternalUrl`) so
   * malicious PTY output cannot smuggle `file://` / `javascript:` /
   * `data:` URIs through `shell.openExternal`. Returns `true` when the OS
   * accepted the open, `false` when the URL was rejected by the whitelist
   * or `shell.openExternal` threw.
   */
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('ccsm:openExternal', url),

  updatesStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(UPDATES_CHANNELS.status),
  updatesCheck: (): Promise<UpdateStatus> => ipcRenderer.invoke(UPDATES_CHANNELS.check),
  updatesDownload: (): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke(UPDATES_CHANNELS.download),
  updatesInstall: (): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke(UPDATES_CHANNELS.install),
  updatesGetAutoCheck: (): Promise<boolean> => ipcRenderer.invoke(UPDATES_CHANNELS.getAutoCheck),
  updatesSetAutoCheck: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke(UPDATES_CHANNELS.setAutoCheck, enabled),
  onUpdateStatus: (handler: (s: UpdateStatus) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: UpdateStatus) => handler(payload);
    ipcRenderer.on(UPDATES_CHANNELS.status, wrap);
    return () => ipcRenderer.removeListener(UPDATES_CHANNELS.status, wrap);
  },
  onUpdateDownloaded: (handler: (info: { version: string }) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: { version: string }) => handler(payload);
    ipcRenderer.on(UPDATE_CHANNELS.downloaded, wrap);
    return () => ipcRenderer.removeListener(UPDATE_CHANNELS.downloaded, wrap);
  },

  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(WINDOW_CHANNELS.minimize),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(WINDOW_CHANNELS.toggleMaximize),
    close: (): Promise<void> => ipcRenderer.invoke(WINDOW_CHANNELS.close),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(WINDOW_CHANNELS.isMaximized),
    onMaximizedChanged: (handler: (max: boolean) => void): (() => void) => {
      const wrap = (_e: IpcRendererEvent, max: boolean) => handler(max);
      ipcRenderer.on(WINDOW_CHANNELS.maximizedChanged, wrap);
      return () => ipcRenderer.removeListener(WINDOW_CHANNELS.maximizedChanged, wrap);
    },
    onBeforeHide: (
      handler: (info: { durationMs: number }) => void
    ): (() => void) => {
      const wrap = (_e: IpcRendererEvent, payload: { durationMs: number }) =>
        handler(payload);
      ipcRenderer.on(WINDOW_CHANNELS.beforeHide, wrap);
      return () => ipcRenderer.removeListener(WINDOW_CHANNELS.beforeHide, wrap);
    },
    onAfterShow: (handler: () => void): (() => void) => {
      const wrap = () => handler();
      ipcRenderer.on(WINDOW_CHANNELS.afterShow, wrap);
      return () => ipcRenderer.removeListener(WINDOW_CHANNELS.afterShow, wrap);
    },
    /**
     * Main fires `window:askCloseAction` when the user clicks the window X
     * (or Ctrl+W / menu Close) AND their close-action preference is 'ask'.
     * Renderer opens the in-app CloseActionDialog with the supplied labels
     * (translated on main, passed through to keep the renderer i18n catalog
     * free of duplicate strings) and the request id, then calls
     * `resolveCloseAction` with the user's choice. Replaces the native
     * `dialog.showMessageBox` window (#1253).
     *
     * If no resolveCloseAction call arrives within 10s, main falls back to
     * hide-to-tray without persisting a pref. See `CLOSE_ASK_TIMEOUT_MS`.
     */
    onAskCloseAction: (
      handler: (payload: {
        requestId: string;
        labels: {
          message: string;
          detail: string;
          tray: string;
          quit: string;
          cancel: string;
          dontAskAgain: string;
        };
      }) => void,
    ): (() => void) => {
      const wrap = (
        _e: IpcRendererEvent,
        payload: {
          requestId: string;
          labels: {
            message: string;
            detail: string;
            tray: string;
            quit: string;
            cancel: string;
            dontAskAgain: string;
          };
        },
      ) => handler(payload);
      ipcRenderer.on(WINDOW_CHANNELS.askCloseAction, wrap);
      return () => ipcRenderer.removeListener(WINDOW_CHANNELS.askCloseAction, wrap);
    },
    /**
     * Renderer's reply to the latest `window:askCloseAction` ping. The
     * requestId pairs the reply with main's in-flight ask so a stale
     * reply from a previous (timed-out) ask is ignored. `'cancel'` never
     * persists, even when `dontAskAgain` is true — see
     * `decideCloseAction` in electron/window/createWindow.ts.
     *
     * Uses `send` (one-way) rather than `invoke` because main does not
     * need to ack; main acts on the choice unilaterally.
     */
    resolveCloseAction: (payload: {
      requestId: string;
      choice: 'tray' | 'quit' | 'cancel';
      dontAskAgain: boolean;
    }): void => {
      ipcRenderer.send(WINDOW_CHANNELS.resolveCloseAction, payload);
    },
    platform: process.platform
  },

  /**
   * Renderer-readable feature flag snapshot. Read once at preload init from
   * `process.env` (the preload script runs in a node-capable context).
   * Used by `src/terminal/*` to select between the legacy cold-only
   * xterm path (default) and the per-session warm-xterm path (PR #25)
   * when `CCSM_WARM_XTERM=1` is set. Static booleans only — no methods,
   * no dynamic re-reads.
   */
  featureFlags: {
    warmXterm: process.env.CCSM_WARM_XTERM === '1',
    /**
     * Optional integer override for the warm-xterm LRU cap. Parsed
     * permissively: `Number()` + clamp to [1, 100]; falsy / NaN returns
     * `null` so the consumer falls back to its hard-coded default (20).
     */
    warmXtermCap: (() => {
      const raw = process.env.CCSM_WARM_XTERM_CAP;
      if (!raw) return null;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return null;
      return Math.min(100, Math.max(1, Math.floor(n)));
    })(),
  },
};

export type CCSMAPI = typeof api;

export function installCcsmCoreBridge(): void {
  contextBridge.exposeInMainWorld('ccsm', api);
}
