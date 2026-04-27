import '@sentry/electron/preload';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PermissionMode, AgentMessage } from './agent/sessions';
import type { StartResult } from './agent/start-result-types';
import type {
  ConnectionInfo,
  OpenSettingsResult,
  DiscoveredModel,
  LoadedCommand,
} from '../src/shared/ipc-types';

type StartOpts = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  /**
   * Pre-allocated session UUID forwarded as the SDK's `sessionId` option so
   * the JSONL transcript filename matches ccsm's internal id. See
   * `src/stores/store.ts` newSessionId() for the rationale and the
   * "no migration for old users" decision.
   */
  sessionId?: string;
  /** Resolved 6-tier effort chip level applied at launch. */
  effortLevel?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};

type AgentEvent = { sessionId: string; message: AgentMessage };
type AgentExit = { sessionId: string; error?: string };
type AgentDiagnostic = {
  sessionId: string;
  level: 'warn' | 'error';
  code: string;
  message: string;
};
type AgentPermissionRequest = {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
};

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
  /**
   * Load a session's message history from the CLI's on-disk JSONL transcript
   * (`~/.claude/projects/<key>/<sid>.jsonl`). Returns a tagged result so the
   * renderer can distinguish "no transcript yet" (e.g. fresh session before
   * the first frame lands) from a real read error. The renderer projects
   * the raw frames through `framesToBlocks` to get its MessageBlock[].
   * Replaces the previous `db:loadMessages` / `db:saveMessages` round-trip
   * which mirrored CLI's transcript into ccsm's SQLite (PR-H removed that
   * redundant copy).
   */
  loadHistory: (
    cwd: string,
    sessionId: string
  ): Promise<
    | { ok: true; frames: unknown[] }
    | { ok: false; error: string; detail?: string }
  > => ipcRenderer.invoke('agent:load-history', cwd, sessionId),
  /**
   * Truncation marker — the user-message hover menu's "Truncate from here"
   * action drops the in-memory transcript at a chosen user block. Persisting
   * the marker in app_state means the truncation survives an app restart:
   * `loadMessages` consults `truncation:get` after re-projecting the JSONL
   * frames and slices to the same point. We deliberately do NOT rewrite the
   * CLI's on-disk JSONL — that's the CLI's data, not ccsm's.
   *
   * `blockId` is the post-projection MessageBlock id (`u-<uuid>` for frames
   * loaded from JSONL). Passing `null` clears the marker — used when the
   * session is rebuilt cleanly (e.g. another full-history send replaces it).
   */
  truncationGet: (
    sessionId: string
  ): Promise<{ blockId: string; truncatedAt: number; userTurnIndex?: number; textPrefix?: string } | null> =>
    ipcRenderer.invoke('truncation:get', sessionId),
  truncationSet: (
    sessionId: string,
    marker: { blockId: string; truncatedAt: number; userTurnIndex?: number; textPrefix?: string } | null
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('truncation:set', sessionId, marker),
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
  saveFile: (
    args: { defaultName?: string; content: string }
  ): Promise<
    { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
  > => ipcRenderer.invoke('dialog:saveFile', args),
  // (#51) Drop tool stdout into an OS temp file and open it in the user's
  // default text editor via shell.openPath.
  toolOpenInEditor: (
    args: { content: string }
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('tool:open-in-editor', args),

  agentStart: (sessionId: string, opts: StartOpts): Promise<StartResult> =>
    ipcRenderer.invoke('agent:start', sessionId, opts),
  agentSend: (sessionId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke('agent:send', sessionId, text),
  /**
   * Send a user message carrying a prebuilt Anthropic content-block array
   * (text + image blocks etc.). Image drop/paste goes through this channel.
   */
  agentSendContent: (sessionId: string, content: unknown[]): Promise<boolean> =>
    ipcRenderer.invoke('agent:sendContent', sessionId, content),
  agentInterrupt: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('agent:interrupt', sessionId),
  /**
   * (#239) Per-tool-use cancel. The renderer calls this when the user clicks
   * the in-block "Cancel" link on a stalled tool. The main-side handler
   * routes through SessionRunner.cancelToolUse which today FALLS BACK to a
   * turn-level interrupt — see the WHY comment in
   * electron/agent/sessions.ts. We pass `toolUseId` anyway so the fallback
   * can be swapped for a true scoped cancel without a renderer change once
   * the SDK exposes one.
   */
  agentCancelToolUse: (args: { sessionId: string; toolUseId: string }): Promise<
    { ok: true } | { ok: false; error: string }
  > => ipcRenderer.invoke('agent:cancelToolUse', args),
  agentSetPermissionMode: (
    sessionId: string,
    mode: PermissionMode
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('agent:setPermissionMode', sessionId, mode),
  agentSetModel: (sessionId: string, model?: string): Promise<boolean> =>
    ipcRenderer.invoke('agent:setModel', sessionId, model),
  /**
   * Push a 6-tier effort chip change into a live session. Main side fans
   * out to two concurrent SDK RPCs (setMaxThinkingTokens + applyFlagSettings).
   * Renderer never has to know about the two-dimension wire shape — it
   * just passes the chip's value.
   */
  agentSetEffort: (
    sessionId: string,
    level: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('agent:setEffort', sessionId, level),
  /**
   * Legacy: push a `max_thinking_tokens` cap into a live session. Kept for
   * the harness probe path that pre-dates the unified chip; new renderer
   * code uses `agentSetEffort`.
   */
  agentSetMaxThinkingTokens: (
    sessionId: string,
    tokens: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('agent:setMaxThinkingTokens', sessionId, tokens),
  agentClose: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('agent:close', sessionId),
  agentResolvePermission: (
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny'
  ): Promise<boolean> =>
    ipcRenderer.invoke('agent:resolvePermission', sessionId, requestId, decision),
  /**
   * Per-hunk partial accept (#251). `acceptedHunks` indices map to
   * `DiffSpec.hunks` from `src/utils/diff.ts`. Empty array => deny.
   * UI follow-up (#TBD) will surface this in PermissionPromptBlock.
   */
  agentResolvePermissionPartial: (
    sessionId: string,
    requestId: string,
    acceptedHunks: number[]
  ): Promise<boolean> =>
    ipcRenderer.invoke('agent:resolvePermissionPartial', sessionId, requestId, acceptedHunks),
  onAgentEvent: (handler: (e: AgentEvent) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: AgentEvent) => handler(payload);
    ipcRenderer.on('agent:event', wrap);
    return () => ipcRenderer.removeListener('agent:event', wrap);
  },
  onAgentExit: (handler: (e: AgentExit) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: AgentExit) => handler(payload);
    ipcRenderer.on('agent:exit', wrap);
    return () => ipcRenderer.removeListener('agent:exit', wrap);
  },
  onAgentDiagnostic: (handler: (e: AgentDiagnostic) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: AgentDiagnostic) => handler(payload);
    ipcRenderer.on('agent:diagnostic', wrap);
    return () => ipcRenderer.removeListener('agent:diagnostic', wrap);
  },
  onAgentPermissionRequest: (handler: (e: AgentPermissionRequest) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: AgentPermissionRequest) => handler(payload);
    ipcRenderer.on('agent:permissionRequest', wrap);
    return () => ipcRenderer.removeListener('agent:permissionRequest', wrap);
  },

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
   * Read the raw frames of an importable session's `.jsonl` transcript so the
   * renderer can hydrate `messagesBySession` immediately on import (otherwise
   * the imported chat looks empty until the user sends a follow-up that
   * triggers `--resume` history replay).
   */
  loadImportHistory: (projectDir: string, sessionId: string): Promise<unknown[]> =>
    ipcRenderer.invoke('import:loadHistory', projectDir, sessionId),

  /**
   * Best-effort batched existence check. Returns a map keyed by the input
   * path; permission errors and ENOENT both map to `false`. Used by the
   * renderer's hydration migration to flag sessions whose persisted `cwd`
   * was deleted between runs.
   */
  pathsExist: (paths: string[]): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('paths:exist', paths),

  memory: {
    read: (p: string): Promise<
      | { ok: true; content: string; exists: boolean }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('memory:read', p),
    write: (p: string, content: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('memory:write', p, content),
    exists: (p: string): Promise<boolean> => ipcRenderer.invoke('memory:exists', p),
    /** Returns the absolute path to ~/.claude/CLAUDE.md (resolved in main). */
    userPath: (): Promise<string> => ipcRenderer.invoke('memory:userPath'),
    /** Returns <cwd>/CLAUDE.md, or null if cwd is empty / not absolute. */
    projectPath: (cwd: string): Promise<string | null> =>
      ipcRenderer.invoke('memory:projectPath', cwd),
  },

  commands: {
    /**
     * Discover slash commands from disk (user / project / plugin markdown).
     * Pass the active session's cwd so project-level `.claude/commands/`
     * can layer on top of user-level definitions.
     */
    list: (cwd: string | null | undefined): Promise<LoadedCommand[]> =>
      ipcRenderer.invoke('commands:list', cwd),
  },

  files: {
    /**
     * Workspace files relative to the session cwd, used by the InputBar's
     * @file mention picker. Returns POSIX-style relative paths so the
     * mention literal stays portable. Heavy directories (node_modules,
     * .git, dist, build, .venv, target, etc.) and hidden entries are
     * pruned in main. See main.ts for caps (5000 entries / depth 12).
     */
    list: (cwd: string | null | undefined): Promise<{ path: string; name: string }[]> =>
      ipcRenderer.invoke('files:list', cwd),
  },

  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('shell:openExternal', url),

  notify: (payload: {
    sessionId: string;
    title: string;
    body?: string;
    eventType?: 'permission' | 'question' | 'turn_done' | 'test';
    silent?: boolean;
    extras?: {
      toastId?: string;
      sessionName?: string;
      groupName?: string;
      toolName?: string;
      toolBrief?: string;
      question?: string;
      selectionKind?: 'single' | 'multi';
      optionCount?: number;
      lastUserMsg?: string;
      lastAssistantMsg?: string;
      elapsedMs?: number;
      toolCount?: number;
      cwd?: string;
    };
  }): Promise<boolean> => ipcRenderer.invoke('notification:show', payload),
  notifyAvailability: (): Promise<{ available: boolean; error: string | null }> =>
    ipcRenderer.invoke('notify:availability'),
  /**
   * Push the renderer's notification runtime state into the main process
   * mirror so the ask-question retry timer (#307) can recheck gates at
   * fire time. Both fields independently optional. Returns `{ok}` mainly
   * for parity with other handlers; renderers fire-and-forget.
   */
  notifySetRuntimeState: (
    patch: { notificationsEnabled?: boolean; activeSessionId?: string | null },
  ): Promise<{ ok: true } | { ok: false }> =>
    ipcRenderer.invoke('notify:setRuntimeState', patch),
  onNotificationFocus: (handler: (sessionId: string) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, sessionId: string) => handler(sessionId);
    ipcRenderer.on('notification:focusSession', wrap);
    return () => ipcRenderer.removeListener('notification:focusSession', wrap);
  },
  /**
   * Wave 1D: notification of a Windows toast button activation routed back
   * from the main process. The action `allow` / `allow-always` / `reject`
   * mirrors the in-app PermissionPromptBlock buttons; the underlying agent
   * permission resolution is performed in main BEFORE this fires, so the
   * renderer just needs to update its store (clear the waiting block and,
   * for `allow-always`, seed `allowAlwaysTools` with the tool name).
   */
  onNotifyToastAction: (
    handler: (e: {
      sessionId: string;
      requestId: string;
      action: 'allow' | 'allow-always' | 'reject' | 'focus';
    }) => void,
  ): (() => void) => {
    const wrap = (
      _e: IpcRendererEvent,
      payload: { sessionId: string; requestId: string; action: 'allow' | 'allow-always' | 'reject' | 'focus' },
    ) => handler(payload);
    ipcRenderer.on('notify:toastAction', wrap);
    return () => ipcRenderer.removeListener('notify:toastAction', wrap);
  },

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
  onUpdateAvailable: (
    handler: (info: { version: string; releaseDate?: string }) => void
  ): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: { version: string; releaseDate?: string }) =>
      handler(payload);
    ipcRenderer.on('update:available', wrap);
    return () => ipcRenderer.removeListener('update:available', wrap);
  },
  onUpdateDownloaded: (handler: (info: { version: string }) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: { version: string }) => handler(payload);
    ipcRenderer.on('update:downloaded', wrap);
    return () => ipcRenderer.removeListener('update:downloaded', wrap);
  },
  onUpdateError: (handler: (info: { message: string }) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: { message: string }) => handler(payload);
    ipcRenderer.on('update:error', wrap);
    return () => ipcRenderer.removeListener('update:error', wrap);
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
  openTtydForSession: (sessionId: string): Promise<CliBridgeOpenResult> =>
    ipcRenderer.invoke('cliBridge:openTtydForSession', sessionId),
  resumeSession: (sessionId: string, sid: string): Promise<CliBridgeOpenResult> =>
    ipcRenderer.invoke('cliBridge:resumeSession', sessionId, sid),
  killTtydForSession: (sessionId: string): Promise<CliBridgeKillResult> =>
    ipcRenderer.invoke('cliBridge:killTtydForSession', sessionId),
  checkClaudeAvailable: (): Promise<CliBridgeAvailability> =>
    ipcRenderer.invoke('cliBridge:checkClaudeAvailable'),
  onTtydExit: (handler: (e: TtydExitEvent) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: TtydExitEvent) => handler(payload);
    ipcRenderer.on('cliBridge:ttyd-exit', wrap);
    return () => ipcRenderer.removeListener('cliBridge:ttyd-exit', wrap);
  },
};

contextBridge.exposeInMainWorld('ccsmCliBridge', cliBridge);

export type CCSMCliBridgeAPI = typeof cliBridge;
