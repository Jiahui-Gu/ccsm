// Window-control IPC handlers. Extracted from electron/main.ts (Task #742
// Phase B).
//
// Pure passthroughs — every handler routes to the BrowserWindow that owns
// the calling webContents. The custom title-bar buttons in the renderer
// invoke these. Kept separate from systemIpc because the surface is small,
// well-defined, and likely to grow if multi-window lands.

import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { WINDOW_CHANNELS } from '../shared/ipcChannels';

export interface WindowIpcDeps {
  ipcMain: IpcMain;
}

export function registerWindowIpc(deps: WindowIpcDeps): void {
  const { ipcMain } = deps;
  ipcMain.handle(WINDOW_CHANNELS.minimize, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });
  ipcMain.handle(WINDOW_CHANNELS.toggleMaximize, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle(WINDOW_CHANNELS.close, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  ipcMain.handle(WINDOW_CHANNELS.isMaximized, (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false;
  });
}
