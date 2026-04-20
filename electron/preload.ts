import { contextBridge, ipcRenderer } from 'electron';

const api = {
  loadState: (key: string): Promise<string | null> => ipcRenderer.invoke('db:load', key),
  saveState: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('db:save', key, value)
};

contextBridge.exposeInMainWorld('agentory', api);

export type AgentoryAPI = typeof api;
