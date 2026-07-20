import { contextBridge, ipcRenderer } from 'electron';
import type { MobileRemoteStatus } from '../../remote/mobileRemoteController';
import { MOBILE_REMOTE_CHANNELS } from '../../shared/ipcChannels';

const api = {
  getStatus: (): Promise<MobileRemoteStatus> =>
    ipcRenderer.invoke(MOBILE_REMOTE_CHANNELS.getStatus),
  getPairingUrl: (): Promise<string | null> =>
    ipcRenderer.invoke(MOBILE_REMOTE_CHANNELS.getPairingUrl),
  pause: (): Promise<void> => ipcRenderer.invoke(MOBILE_REMOTE_CHANNELS.pause),
  resume: (): Promise<void> => ipcRenderer.invoke(MOBILE_REMOTE_CHANNELS.resume),
  rotate: (): Promise<void> => ipcRenderer.invoke(MOBILE_REMOTE_CHANNELS.rotate),
  onStatus: (handler: (status: MobileRemoteStatus) => void): (() => void) => {
    const listener = (_event: unknown, status: MobileRemoteStatus) => handler(status);
    ipcRenderer.on(MOBILE_REMOTE_CHANNELS.status, listener);
    return () => ipcRenderer.removeListener(MOBILE_REMOTE_CHANNELS.status, listener);
  },
};

export type CCSMMobileRemoteAPI = typeof api;

export function installCcsmMobileRemoteBridge(): void {
  contextBridge.exposeInMainWorld('ccsmMobileRemote', api);
}
