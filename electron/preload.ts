import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

type StartOpts = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
};

type StartResult = { ok: true } | { ok: false; error: string };

type AgentEvent = { sessionId: string; message: SDKMessage };
type AgentExit = { sessionId: string; error?: string };

const api = {
  loadState: (key: string): Promise<string | null> => ipcRenderer.invoke('db:load', key),
  saveState: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('db:save', key, value),
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
  onAgentEvent: (handler: (e: AgentEvent) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: AgentEvent) => handler(payload);
    ipcRenderer.on('agent:event', wrap);
    return () => ipcRenderer.removeListener('agent:event', wrap);
  },
  onAgentExit: (handler: (e: AgentExit) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: AgentExit) => handler(payload);
    ipcRenderer.on('agent:exit', wrap);
    return () => ipcRenderer.removeListener('agent:exit', wrap);
  }
};

contextBridge.exposeInMainWorld('agentory', api);

export type AgentoryAPI = typeof api;
