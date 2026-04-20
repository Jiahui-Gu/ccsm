import { contextBridge, ipcRenderer } from 'electron';

const api = {
  loadState: (key: string): Promise<string | null> => ipcRenderer.invoke('db:load', key),
  saveState: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('db:save', key, value),
  getDataDir: (): Promise<string> => ipcRenderer.invoke('app:getDataDir'),
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  getApiKey: (): Promise<string> => ipcRenderer.invoke('keychain:getApiKey'),
  setApiKey: (value: string): Promise<boolean> => ipcRenderer.invoke('keychain:setApiKey', value),
  hasEncryption: (): Promise<boolean> => ipcRenderer.invoke('keychain:hasEncryption')
};

contextBridge.exposeInMainWorld('agentory', api);

export type AgentoryAPI = typeof api;
