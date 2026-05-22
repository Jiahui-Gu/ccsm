// `window.ccsmShell` — small bridge for renderer-driven shell-level UX
// gestures that don't fit `ccsm` (catch-all) or `ccsmPty` (terminal data).
//
// Currently exposes a single one-shot: `suppressContextMenuOnce()`. The
// terminal pane calls this from its renderer-side `onContextMenu` handler
// immediately before its `preventDefault()` returns, so that the
// main-process `webContents.on('context-menu', ...)` listener (installed
// per-window by `installContextMenu` in electron/window/createWindow.ts)
// can step aside and let the renderer handle the click natively
// (copy-on-selection / paste-on-empty) without a popover.
//
// Why a separate bridge: Electron's `webContents.on('context-menu')` fires
// on every renderer right-click regardless of DOM `preventDefault()`. Without
// this one-shot, the terminal's renderer-side handler would race the native
// menu and lose (the OS popup appears on top of any inline action). A
// per-IPC deadline gives main the signal it cannot get from the DOM.

import { contextBridge, ipcRenderer } from 'electron';

const ccsmShell = {
  /** Tell main to skip the very next `context-menu` event on this
   *  WebContents. One-shot — main resets the suppression as soon as the
   *  next event arrives, OR after a short deadline (~100ms) if no event
   *  arrives. Call this immediately BEFORE returning from a renderer
   *  `onContextMenu` handler that handles the click itself. */
  suppressContextMenuOnce: (): void => {
    ipcRenderer.send('shell:suppressContextMenuOnce');
  },
};

export type CCSMShellAPI = typeof ccsmShell;

export function installCcsmShellBridge(): void {
  contextBridge.exposeInMainWorld('ccsmShell', ccsmShell);
}
