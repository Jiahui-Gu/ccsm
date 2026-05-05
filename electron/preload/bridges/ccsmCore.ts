// `window.ccsm` — v0.3 wave-1 thin bridge. The only surfaces here are the
// ones that CANNOT live behind the daemon's loopback HTTP boundary:
//
//   1. `getDaemonPort()` — synchronous-ish accessor for the loopback port
//      the daemon child bound to. Returns `null` until the spawn promise
//      in main resolves; renderer is expected to poll/await before fetching
//      against it. Wire is `ipcRenderer.invoke('daemon:getPort')`, not
//      `process.versions` or any other mainworld leak — preload stays the
//      single source of IPC channel knowledge.
//   2. `pickCwd()` — OS folder picker. `dialog.showOpenDialog` needs the
//      requesting BrowserWindow as its parent so the modal attribution is
//      correct, which the daemon (a plain Node process with no window
//      handle) cannot provide.
//   3. `userHome()` — synchronous Node `os.homedir()` lookup. Kept on the
//      IPC side so the renderer doesn't have to wait for the daemon port
//      to be known just to seed its initial cwd default.
//   4. updater channels — electron-updater drives signed-installer side
//      effects from inside the Electron process; wrapping it over HTTP
//      would put a privileged install path on a loopback socket.
//
// Everything else (db / sessions / pty / notify / session titles / i18n /
// import scan / userCwds / paths:exist / window controls) moved to the
// daemon's HTTP API. The renderer fetches `http://127.0.0.1:<port>/...`
// using the port returned by `getDaemonPort()`.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

const api = {
  /**
   * Resolved loopback port for the daemon child spawned by main.
   * Returns `null` while the spawn promise is still in flight or after
   * the daemon has died. Renderer should poll this from a single place
   * (the boot-time hydration store) and re-poll on null instead of
   * calling it from every fetch site.
   */
  getDaemonPort: (): Promise<number | null> =>
    ipcRenderer.invoke('daemon:getPort'),

  /**
   * Open the OS folder picker so the user can choose a working directory.
   * Returns the picked absolute path on success, or `null` when the user
   * cancelled. Anchored on the requesting BrowserWindow so the dialog is
   * modal to the right surface.
   */
  pickCwd: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('cwd:pick', { defaultPath }),

  /**
   * Path to the user's home directory (`os.homedir()` on the main process).
   * Used as the always-true default cwd for new sessions.
   */
  userHome: (): Promise<string> => ipcRenderer.invoke('app:userHome'),

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
  onUpdateDownloaded: (handler: (info: { version: string }) => void): (() => void) => {
    const wrap = (_e: IpcRendererEvent, payload: { version: string }) => handler(payload);
    ipcRenderer.on('update:downloaded', wrap);
    return () => ipcRenderer.removeListener('update:downloaded', wrap);
  },
};

export type CCSMAPI = typeof api;

export function installCcsmCoreBridge(): void {
  contextBridge.exposeInMainWorld('ccsm', api);
}
