import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PermissionMode, AgentMessage } from './agent/sessions';

type StartOpts = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  endpointId?: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
};

type StartResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      errorCode?: 'CLAUDE_NOT_FOUND' | 'CWD_MISSING';
      searchedPaths?: string[];
    };

type AgentEvent = { sessionId: string; message: AgentMessage };
type AgentExit = { sessionId: string; error?: string };
type AgentPermissionRequest = {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
};

type EndpointKind =
  | 'anthropic'
  | 'openai-compat'
  | 'ollama'
  | 'bedrock'
  | 'vertex'
  | 'unknown';
type EndpointStatus = 'ok' | 'error' | 'unchecked';
type DiscoverySource = 'probe' | 'listed' | 'manual';
type EndpointRow = {
  id: string;
  name: string;
  baseUrl: string;
  kind: EndpointKind;
  isDefault: boolean;
  lastStatus: EndpointStatus;
  lastError: string | null;
  lastRefreshedAt: number | null;
  createdAt: number;
  updatedAt: number;
  detectedKind: EndpointKind | null;
  manualModelIds: string[];
};
type ModelRow = {
  id: string;
  endpointId: string;
  modelId: string;
  displayName: string | null;
  discoveredAt: number;
  source: DiscoverySource;
  existsConfirmed: boolean;
};
type EndpointWithModels = EndpointRow & { models: ModelRow[] };
type TestConnectionResult =
  | { ok: true }
  | { ok: false; status?: number; error: string };
type RefreshResult =
  | {
      ok: true;
      count: number;
      detectedKind: EndpointKind;
      sourceStats: Record<DiscoverySource, number>;
    }
  | { ok: false; error: string; status?: number };
type CreateMessageResult =
  | { ok: true; text: string }
  | { ok: false; status?: number; error: string };

type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

type CliInstallHints = {
  os: string;
  arch: string;
  commands: {
    native?: string;
    packageManager?: string;
    npm: string;
  };
  docsUrl: string;
};

type CliRetryResult =
  | { found: true; path: string; version: string | null }
  | { found: false; searchedPaths: string[] };

type CliSetBinaryResult =
  | { ok: true; version: string | null }
  | { ok: false; error: string };

const api = {
  loadState: (key: string): Promise<string | null> => ipcRenderer.invoke('db:load', key),
  saveState: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('db:save', key, value),
  // i18n: renderer reads OS locale to seed its "system" preference, and
  // pushes the resolved UI language to main so OS notifications match.
  // Lives under `i18n` to keep the bridge surface organised; renderer
  // accesses via `window.agentory.i18n.*`.
  i18n: {
    getSystemLocale: (): Promise<string | undefined> =>
      ipcRenderer.invoke('agentory:get-system-locale'),
    setLanguage: (lang: 'en' | 'zh'): void => {
      ipcRenderer.send('agentory:set-language', lang);
    }
  },
  loadMessages: (sessionId: string): Promise<unknown[]> =>
    ipcRenderer.invoke('db:loadMessages', sessionId),
  saveMessages: (sessionId: string, blocks: Array<{ id: string; kind: string }>): Promise<void> =>
    ipcRenderer.invoke('db:saveMessages', sessionId, blocks),
  getDataDir: (): Promise<string> => ipcRenderer.invoke('app:getDataDir'),
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),

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
  agentSetPermissionMode: (sessionId: string, mode: PermissionMode): Promise<boolean> =>
    ipcRenderer.invoke('agent:setPermissionMode', sessionId, mode),
  agentSetModel: (sessionId: string, model?: string): Promise<boolean> =>
    ipcRenderer.invoke('agent:setModel', sessionId, model),
  agentClose: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('agent:close', sessionId),
  agentResolvePermission: (
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny'
  ): Promise<boolean> =>
    ipcRenderer.invoke('agent:resolvePermission', sessionId, requestId, decision),
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
  onAgentPermissionRequest: (handler: (e: AgentPermissionRequest) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: AgentPermissionRequest) => handler(payload);
    ipcRenderer.on('agent:permissionRequest', wrap);
    return () => ipcRenderer.removeListener('agent:permissionRequest', wrap);
  },

  scanImportable: (): Promise<
    Array<{ sessionId: string; cwd: string; title: string; mtime: number; projectDir: string }>
  > => ipcRenderer.invoke('import:scan'),

  /**
   * Most-recently-used cwds derived from the eager scan that runs on app
   * `ready`. Returns immediately from cache after the first scan completes;
   * the call itself is cheap (no fs work in the renderer round-trip).
   * Empty array means the scan is still in flight or `~/.claude/projects`
   * has nothing usable.
   */
  recentCwds: (): Promise<string[]> => ipcRenderer.invoke('import:recentCwds'),

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

  pr: {
    preflight: (cwd: string | null | undefined): Promise<unknown> =>
      ipcRenderer.invoke('pr:preflight', cwd),
    create: (args: {
      cwd: string;
      branch: string;
      base: string;
      title: string;
      body: string;
      draft: boolean;
    }): Promise<unknown> => ipcRenderer.invoke('pr:create', args),
    checks: (cwd: string, number: number): Promise<unknown> =>
      ipcRenderer.invoke('pr:checks', cwd, number)
  },

  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('shell:openExternal', url),

  notify: (payload: {
    sessionId: string;
    title: string;
    body?: string;
    eventType?: 'permission' | 'question' | 'turn_done' | 'test';
    silent?: boolean;
  }): Promise<boolean> => ipcRenderer.invoke('notification:show', payload),
  onNotificationFocus: (handler: (sessionId: string) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, sessionId: string) => handler(sessionId);
    ipcRenderer.on('notification:focusSession', wrap);
    return () => ipcRenderer.removeListener('notification:focusSession', wrap);
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
    platform: process.platform
  },

  endpoints: {
    list: (): Promise<EndpointRow[]> => ipcRenderer.invoke('endpoints:list'),
    add: (input: {
      name: string;
      baseUrl: string;
      kind?: EndpointKind;
      apiKey?: string;
      isDefault?: boolean;
    }): Promise<EndpointRow> => ipcRenderer.invoke('endpoints:add', input),
    update: (
      id: string,
      patch: {
        name?: string;
        baseUrl?: string;
        apiKey?: string | null;
        isDefault?: boolean;
        kind?: EndpointKind;
      }
    ): Promise<EndpointRow | null> => ipcRenderer.invoke('endpoints:update', id, patch),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('endpoints:remove', id),
    testConnection: (args: { baseUrl: string; apiKey: string }): Promise<TestConnectionResult> =>
      ipcRenderer.invoke('endpoints:testConnection', args),
    refreshModels: (id: string): Promise<RefreshResult> =>
      ipcRenderer.invoke('endpoints:refreshModels', id),
    setManualModels: (id: string, ids: string[]): Promise<EndpointRow | null> =>
      ipcRenderer.invoke('endpoints:setManualModels', id, ids),
    createMessage: (args: {
      endpointId: string;
      model: string;
      maxTokens?: number;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      system?: string;
    }): Promise<CreateMessageResult> =>
      ipcRenderer.invoke('endpoints:createMessage', args),
  },

  models: {
    listByEndpoint: (id: string): Promise<ModelRow[]> =>
      ipcRenderer.invoke('models:listByEndpoint', id),
    listAll: (): Promise<EndpointWithModels[]> => ipcRenderer.invoke('models:listAll'),
  },

  cli: {
    getInstallHints: (): Promise<CliInstallHints> => ipcRenderer.invoke('cli:getInstallHints'),
    browseBinary: (): Promise<string | null> => ipcRenderer.invoke('cli:browseBinary'),
    setBinaryPath: (p: string): Promise<CliSetBinaryResult> =>
      ipcRenderer.invoke('cli:setBinaryPath', p),
    openDocs: (): Promise<boolean> => ipcRenderer.invoke('cli:openDocs'),
    retryDetect: (): Promise<CliRetryResult> => ipcRenderer.invoke('cli:retryDetect'),
  },
};

contextBridge.exposeInMainWorld('agentory', api);

export type AgentoryAPI = typeof api;
