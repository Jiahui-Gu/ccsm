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

// ─────────────────────────── ccsmPty ─────────────────────────────────────
//
// In-process node-pty bridge that replaces the ttyd HTTP/WebSocket detour.
// Exposed under `window.ccsmPty`. Folded the former `window.ccsmCliBridge`
// surface (just `checkClaudeAvailable`) in PR-8 — there is now a single
// CLI host namespace.
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

type CheckClaudeAvailableResult =
  | { available: true; path: string }
  | { available: false };

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
  checkClaudeAvailable: (opts?: { force?: boolean }): Promise<CheckClaudeAvailableResult> =>
    ipcRenderer.invoke('pty:checkClaudeAvailable', opts ?? {}),
};

contextBridge.exposeInMainWorld('ccsmPty', ccsmPty);

export type CCSMPtyAPI = typeof ccsmPty;

// ─────────────────────────── ccsmSession ─────────────────────────────────
//
// Per-session state signal sourced from the JSONL tail-watcher
// (electron/sessionWatcher). Forwarded over the `session:state` IPC
// channel as `{sid, state: 'idle' | 'running' | 'requires_action'}` and
// fan-ed out here to all renderer subscribers (Sidebar today; ccsm-notify
// integration tomorrow). Mirrors the listener-set fan-out pattern used
// for ccsmPty.onData / onExit so multiple subscribers don't each register
// an ipcRenderer listener on the same channel.

export type SessionState = 'idle' | 'running' | 'requires_action';
type SessionStatePayload = { sid: string; state: SessionState };
type SessionActivatePayload = { sid: string };
type SessionTitlePayload = { sid: string; title: string };

const sessionStateListeners = new Set<(e: SessionStatePayload) => void>();
const sessionActivateListeners = new Set<(e: SessionActivatePayload) => void>();
const sessionTitleListeners = new Set<(e: SessionTitlePayload) => void>();

ipcRenderer.on('session:state', (_e: IpcRendererEvent, payload: SessionStatePayload) => {
  for (const cb of sessionStateListeners) {
    try {
      cb(payload);
    } catch (err) {
      console.error('[ccsmSession] onState listener threw', err);
    }
  }
});

// Title pushes from main: sourced by the JSONL tail-watcher
// (electron/sessionWatcher) when the SDK-derived `summary` for a session
// changes. Renderer subscribes via `window.ccsmSession.onTitle` and pipes
// into the store's `_applyExternalTitle` action.
ipcRenderer.on('session:title', (_e: IpcRendererEvent, payload: SessionTitlePayload) => {
  for (const cb of sessionTitleListeners) {
    try {
      cb(payload);
    } catch (err) {
      console.error('[ccsmSession] onTitle listener threw', err);
    }
  }
});

// Main pushes `session:activate` when the user clicks a desktop notification.
// Renderer subscribes via `window.ccsmSession.onActivate` and calls its
// `selectSession(sid)` so the chosen session lands focused.
ipcRenderer.on('session:activate', (_e: IpcRendererEvent, payload: SessionActivatePayload) => {
  for (const cb of sessionActivateListeners) {
    try {
      cb(payload);
    } catch (err) {
      console.error('[ccsmSession] onActivate listener threw', err);
    }
  }
});

const ccsmSession = {
  onState: (cb: (e: SessionStatePayload) => void): (() => void) => {
    sessionStateListeners.add(cb);
    return () => {
      sessionStateListeners.delete(cb);
    };
  },
  onActivate: (cb: (e: SessionActivatePayload) => void): (() => void) => {
    sessionActivateListeners.add(cb);
    return () => {
      sessionActivateListeners.delete(cb);
    };
  },
  onTitle: (cb: (e: SessionTitlePayload) => void): (() => void) => {
    sessionTitleListeners.add(cb);
    return () => {
      sessionTitleListeners.delete(cb);
    };
  },
  // Renderer pushes its active session id to main so the notify bridge can
  // suppress toasts for the session the user is currently viewing. Fire on
  // every selectSession; main caches the latest value.
  setActive: (sid: string | null): void => {
    ipcRenderer.send('session:setActive', sid ?? '');
  },
};

contextBridge.exposeInMainWorld('ccsmSession', ccsmSession);

export type CCSMSessionAPI = typeof ccsmSession;

// ─────────────────────────── ccsmSessionTitles ───────────────────────────
//
// Thin renderer-side bridge to the main-process `electron/sessionTitles`
// module, which wraps `@anthropic-ai/claude-agent-sdk`'s
// `getSessionInfo` / `renameSession` / `listSessions`. The substrate
// concerns (per-sid serialization, 2s TTL cache, ENOENT classification,
// pending-rename queue) live entirely on the main side; the renderer only
// sees a flat get/rename/listForProject surface. Wired in PR2 by the
// `renameSession` store action; consumed in PR3 by the watcher and PR4 by
// launch-time backfill.

type SessionTitleSummary = {
  summary: string | null;
  mtime: number | null;
};

type SessionTitleRenameResult =
  | { ok: true }
  | { ok: false; reason: 'no_jsonl' | 'sdk_threw'; message?: string };

type SessionTitleProjectEntry = {
  sid: string;
  summary: string | null;
  mtime: number;
};

const ccsmSessionTitles = {
  get: (sid: string, dir?: string): Promise<SessionTitleSummary> =>
    ipcRenderer.invoke('sessionTitles:get', sid, dir),
  rename: (
    sid: string,
    title: string,
    dir?: string
  ): Promise<SessionTitleRenameResult> =>
    ipcRenderer.invoke('sessionTitles:rename', sid, title, dir),
  listForProject: (projectKey: string): Promise<SessionTitleProjectEntry[]> =>
    ipcRenderer.invoke('sessionTitles:listForProject', projectKey),
};

contextBridge.exposeInMainWorld('ccsmSessionTitles', ccsmSessionTitles);

export type CCSMSessionTitlesAPI = typeof ccsmSessionTitles;
