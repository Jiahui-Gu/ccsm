import '@sentry/electron/preload';
import { contextBridge, ipcRenderer, clipboard, type IpcRendererEvent } from 'electron';
import type {
  ConnectionInfo,
  OpenSettingsResult,
  DiscoveredModel,
} from '../src/shared/ipc-types';

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

  connection: {
    read: (): Promise<ConnectionInfo> => ipcRenderer.invoke('connection:read'),
    openSettingsFile: (): Promise<OpenSettingsResult> =>
      ipcRenderer.invoke('connection:openSettingsFile'),
  },

  models: {
    list: (): Promise<DiscoveredModel[]> => ipcRenderer.invoke('models:list'),
  },
};

contextBridge.exposeInMainWorld('ccsm', api);

export type CCSMAPI = typeof api;

// ─────────────────────────── cliBridge ───────────────────────────────────
//
// Per-session ttyd lifecycle. Worker 2 will consume this surface from the
// renderer to mount a `<iframe src="http://127.0.0.1:<port>">` per active
// session. Exposed under a separate `window.ccsmCliBridge` namespace
// (rather than merged into `api` above) so Worker 3's deletion of the
// in-process SDK IPC stays a clean, isolated diff. We can fold this into
// the main `ccsm` namespace once the SDK runner is gone.

type CliBridgeOpenResult =
  | { ok: true; port: number; sid: string }
  | { ok: false; error: string };

type CliBridgeKillResult =
  | { ok: true; killed: boolean }
  | { ok: false; error: string };

type CliBridgeAvailability = { available: true; path: string } | { available: false };

type TtydExitEvent = {
  sessionId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
};

const cliBridge = {
  openTtydForSession: (sessionId: string, cwd: string): Promise<CliBridgeOpenResult> =>
    ipcRenderer.invoke('cliBridge:openTtydForSession', sessionId, cwd),
  resumeSession: (sessionId: string, cwd: string, sid: string): Promise<CliBridgeOpenResult> =>
    ipcRenderer.invoke('cliBridge:resumeSession', sessionId, cwd, sid),
  killTtydForSession: (sessionId: string): Promise<CliBridgeKillResult> =>
    ipcRenderer.invoke('cliBridge:killTtydForSession', sessionId),
  getTtydForSession: (sessionId: string): Promise<{ port: number; sid: string } | null> =>
    ipcRenderer.invoke('cliBridge:getTtydForSession', sessionId),
  checkClaudeAvailable: (opts?: { force?: boolean }): Promise<CliBridgeAvailability> =>
    ipcRenderer.invoke('cliBridge:checkClaudeAvailable', opts ?? {}),
  onTtydExit: (handler: (e: TtydExitEvent) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: TtydExitEvent) => handler(payload);
    ipcRenderer.on('cliBridge:ttyd-exit', wrap);
    return () => ipcRenderer.removeListener('cliBridge:ttyd-exit', wrap);
  },
};

contextBridge.exposeInMainWorld('ccsmCliBridge', cliBridge);

export type CCSMCliBridgeAPI = typeof cliBridge;

// ─────────────────────────── ccsmPty ─────────────────────────────────────
//
// In-process node-pty bridge that replaces the ttyd HTTP/WebSocket detour.
// Exposed under `window.ccsmPty` in parallel with `window.ccsmCliBridge`
// during the migration; PR-8 deletes the old ttyd surface once every
// renderer call site has moved over.
//
// `onData` / `onExit` use a listener-set fan-out pattern (see spike
// `xterm-attach/src/preload.cjs`) so multiple subscribers can attach
// without each registering its own ipcRenderer listener — important
// because every TerminalPane mount would otherwise leak a handler on
// the single shared 'pty:data' channel.

type PtyDataPayload = { sid: string; chunk: string };
type PtyExitPayload = {
  sessionId: string;
  code: number | null;
  signal: number | null;
};

const ptyDataListeners = new Set<(e: PtyDataPayload) => void>();
const ptyExitListeners = new Set<(e: PtyExitPayload) => void>();

ipcRenderer.on('pty:data', (_e: IpcRendererEvent, payload: PtyDataPayload) => {
  for (const cb of ptyDataListeners) {
    try {
      cb(payload);
    } catch (err) {
      console.error('[ccsmPty] onData listener threw', err);
    }
  }
});

ipcRenderer.on('pty:exit', (_e: IpcRendererEvent, payload: PtyExitPayload) => {
  for (const cb of ptyExitListeners) {
    try {
      cb(payload);
    } catch (err) {
      console.error('[ccsmPty] onExit listener threw', err);
    }
  }
});

const ccsmPty = {
  list: (): Promise<unknown> => ipcRenderer.invoke('pty:list'),
  spawn: (sid: string, cwd: string): Promise<unknown> =>
    ipcRenderer.invoke('pty:spawn', sid, cwd),
  attach: (sid: string): Promise<unknown> => ipcRenderer.invoke('pty:attach', sid),
  detach: (sid: string): Promise<void> => ipcRenderer.invoke('pty:detach', sid),
  input: (sid: string, data: string): Promise<void> =>
    ipcRenderer.invoke('pty:input', sid, data),
  resize: (sid: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('pty:resize', sid, cols, rows),
  kill: (sid: string): Promise<unknown> => ipcRenderer.invoke('pty:kill', sid),
  get: (sid: string): Promise<unknown> => ipcRenderer.invoke('pty:get', sid),
  onData: (cb: (e: PtyDataPayload) => void): (() => void) => {
    ptyDataListeners.add(cb);
    return () => {
      ptyDataListeners.delete(cb);
    };
  },
  onExit: (cb: (e: PtyExitPayload) => void): (() => void) => {
    ptyExitListeners.add(cb);
    return () => {
      ptyExitListeners.delete(cb);
    };
  },
  clipboard: {
    readText: (): string => clipboard.readText(),
    writeText: (text: string): void => clipboard.writeText(text),
  },
};

contextBridge.exposeInMainWorld('ccsmPty', ccsmPty);

export type CCSMPtyAPI = typeof ccsmPty;
