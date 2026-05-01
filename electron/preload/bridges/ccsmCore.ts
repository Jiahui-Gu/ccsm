// `window.ccsm` — the catch-all "core" bridge: app-state persistence
// (db:load/save), i18n, version, importable-session scan, recent/user
// cwds, path existence, updater, and window controls. Originally lived
// inline in `electron/preload.ts`; extracted in #769 (SRP wave-2 PR-A)
// without behavioral change.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

const api = {
  loadState: (key: string): Promise<string | null> => ipcRenderer.invoke('db:load', key),
  // The IPC handler returns a `{ok}` shape so it never crosses the IPC
  // boundary as a thrown Error (Electron surfaces those as ugly stack
  // dumps in the renderer console). We unwrap here and re-throw on
  // failure so the existing `.catch(onPersistError)` callers in
  // src/stores/persist.ts and src/stores/drafts.ts actually fire — a
  // resolved `{ok:false}` would otherwise slip past `.catch` silently
  // and produce data loss with zero renderer signal.
  saveState: async (key: string, value: string): Promise<void> => {
    const result = (await ipcRenderer.invoke('db:save', key, value)) as
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

  updatesStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:status'),
  updatesCheck: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:check'),
  updatesDownload: (): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('updates:download'),
  updatesInstall: (): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('updates:install'),
  updatesGetAutoCheck: (): Promise<boolean> => ipcRenderer.invoke('updates:getAutoCheck'),
  updatesSetAutoCheck: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('updates:setAutoCheck', enabled),

  /**
   * Phase 4 crash observability — surface the most recent on-disk incident
   * to the Settings page so the user can re-upload via "Send last crash
   * report". Returns `null` when no incident exists. `alreadySent` is true
   * when a `.uploaded` marker is present in the incident dir (so the UI
   * disables the button to prevent double-send).
   */
  crash: {
    getLastIncident: (): Promise<{
      id: string;
      dirName: string;
      ts: string;
      surface: string;
      alreadySent: boolean;
    } | null> => ipcRenderer.invoke('crash:get-last-incident'),
    sendLastIncident: (): Promise<{ ok: true; eventId?: string } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('crash:send-last-incident'),
    /**
     * Phase 5 — renderer error forwarder. Renderer hooks window.onerror /
     * window.onunhandledrejection and forwards each event to the main-process
     * collector, which records a `surface: 'renderer'` incident on disk
     * (always) and forwards via Sentry (consent-gated, phase 4).
     *
     * The IPC is rate-limited at the main side (≤10/min per renderer process)
     * so a tight error loop can't fill the disk. Excess events are silently
     * dropped; the dropped count is folded into the next accepted incident.
     */
    reportRendererError: (report: {
      error: { name?: string; message: string; stack?: string };
      source: string;
      url?: string;
    }): Promise<{ accepted: boolean; reason?: string }> =>
      ipcRenderer.invoke('crash:report-renderer-error', report),
  },
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

  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggleMaximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChanged: (handler: (max: boolean) => void): (() => void) => {
      const wrap = (_e: IpcRendererEvent, max: boolean) => handler(max);
      ipcRenderer.on('window:maximizedChanged', wrap);
      return () => ipcRenderer.removeListener('window:maximizedChanged', wrap);
    },
    onBeforeHide: (
      handler: (info: { durationMs: number }) => void
    ): (() => void) => {
      const wrap = (_e: IpcRendererEvent, payload: { durationMs: number }) =>
        handler(payload);
      ipcRenderer.on('window:beforeHide', wrap);
      return () => ipcRenderer.removeListener('window:beforeHide', wrap);
    },
    onAfterShow: (handler: () => void): (() => void) => {
      const wrap = () => handler();
      ipcRenderer.on('window:afterShow', wrap);
      return () => ipcRenderer.removeListener('window:afterShow', wrap);
    },
    platform: process.platform
  },
};

export type CCSMAPI = typeof api;

export function installCcsmCoreBridge(): void {
  contextBridge.exposeInMainWorld('ccsm', api);
}
