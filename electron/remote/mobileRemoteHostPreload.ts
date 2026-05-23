// Preload for the hidden V2 mobile-remote host BrowserWindow. Exposes a
// narrow `ccsmRemoteV2` bridge so the page (sandbox=true, no node integration)
// can talk to the Electron main process for PTY ops.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ccsmRemoteV2', {
  // DataChannel -> main: forward parsed messages from the phone.
  send: (msg: unknown) => ipcRenderer.send('remote-v2:dc-recv', msg),
  // main -> DataChannel: subscribe to messages main wants to push to the phone
  // (e.g. snapshot results, sessions.list responses).
  onSend: (cb: (msg: unknown) => void) => {
    ipcRenderer.on('remote-v2:dc-send', (_e, m) => cb(m));
  },
  // main -> DataChannel: pty.data fan-in (one stream, multiplexed by sid).
  onPtyData: (cb: (m: { sid: string; chunk: string }) => void) => {
    ipcRenderer.on('remote-v2:pty-data', (_e, m) => cb(m));
  },
});
