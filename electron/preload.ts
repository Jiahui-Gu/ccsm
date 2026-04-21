import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PermissionMode, AgentMessage } from './agent/sessions';

type StartOpts = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
};

type StartResult = { ok: true } | { ok: false; error: string };

type AgentEvent = { sessionId: string; message: AgentMessage };
type AgentExit = { sessionId: string; error?: string };
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
  saveState: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('db:save', key, value),
  loadMessages: (sessionId: string): Promise<unknown[]> =>
    ipcRenderer.invoke('db:loadMessages', sessionId),
  saveMessages: (sessionId: string, blocks: Array<{ id: string; kind: string }>): Promise<void> =>
    ipcRenderer.invoke('db:saveMessages', sessionId, blocks),
  getDataDir: (): Promise<string> => ipcRenderer.invoke('app:getDataDir'),
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  getApiKey: (): Promise<string> => ipcRenderer.invoke('keychain:getApiKey'),
  setApiKey: (value: string): Promise<boolean> => ipcRenderer.invoke('keychain:setApiKey', value),
  hasEncryption: (): Promise<boolean> => ipcRenderer.invoke('keychain:hasEncryption'),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),

  agentStart: (sessionId: string, opts: StartOpts): Promise<StartResult> =>
    ipcRenderer.invoke('agent:start', sessionId, opts),
  agentSend: (sessionId: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke('agent:send', sessionId, text),
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

  notify: (payload: { sessionId: string; title: string; body?: string }): Promise<boolean> =>
    ipcRenderer.invoke('notification:show', payload),
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
  onUpdateStatus: (handler: (s: UpdateStatus) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: UpdateStatus) => handler(payload);
    ipcRenderer.on('updates:status', wrap);
    return () => ipcRenderer.removeListener('updates:status', wrap);
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
  }
};

contextBridge.exposeInMainWorld('agentory', api);

export type AgentoryAPI = typeof api;
