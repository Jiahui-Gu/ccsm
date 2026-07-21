import type { IpcMain } from 'electron';
import type {
  MobileRemoteController,
  MobileRemoteStatus,
} from '../remote/mobileRemoteController';
import { MOBILE_REMOTE_CHANNELS } from '../shared/ipcChannels';

const UNAVAILABLE_STATUS: MobileRemoteStatus = {
  kind: 'unavailable',
  reason: 'relay-not-configured',
};

export function registerMobileRemoteIpc({
  ipcMain,
  getController,
}: {
  ipcMain: IpcMain;
  getController: () => MobileRemoteController | null;
}): void {
  ipcMain.handle(MOBILE_REMOTE_CHANNELS.getStatus, (_event, ...args: unknown[]) => {
    if (args.length !== 0) return UNAVAILABLE_STATUS;
    return getController()?.getStatus() ?? UNAVAILABLE_STATUS;
  });
  ipcMain.handle(MOBILE_REMOTE_CHANNELS.getPairingUrl, (_event, ...args: unknown[]) => {
    if (args.length !== 0) return null;
    return getController()?.getPairingUrl() ?? null;
  });
  ipcMain.handle(MOBILE_REMOTE_CHANNELS.pause, (_event, ...args: unknown[]) => {
    if (args.length !== 0) return;
    getController()?.pause();
  });
  ipcMain.handle(MOBILE_REMOTE_CHANNELS.resume, (_event, ...args: unknown[]) => {
    if (args.length !== 0) return;
    getController()?.resume();
  });
  ipcMain.handle(MOBILE_REMOTE_CHANNELS.rotate, (_event, ...args: unknown[]) => {
    if (args.length !== 0) return;
    return getController()?.rotate();
  });
}
