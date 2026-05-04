// electron/ipc-allowlisted/preload-allowlisted.ts
//
// Renderer-side preload bridge for the spec ch08 §3.1 allowlisted IPC
// channels. This is the SOLE preload script the BrowserWindow loads in
// v0.3 — it exposes the small subset of `ipcMain.handle` channels that
// have no daemon equivalent and no browser-API substitute (the OS
// folder picker + the in-app updater UI). All other renderer ↔ main
// communication has either been deleted (Wave 0c) or migrated to
// Connect-RPC over the transport bridge (Wave 0d/1).
//
// Per spec ch08 §3.1 rule 4, `contextBridge.exposeInMainWorld` is NOT
// allowlisted under any circumstance for the descriptor injection
// mechanism (which uses `protocol.handle` instead). This file is the
// ONE sanctioned exception — and only for the channel names enumerated
// in `tools/.no-ipc-allowlist`. A new entry on `window.ccsm` here
// requires a §3.1 amendment + chapter 15 audit row.
//
// Safety: every method routes through `ipcRenderer.invoke` /
// `ipcRenderer.on` against a hard-coded channel name (no string
// concatenation, no dynamic dispatch). The renderer cannot ask this
// bridge for a channel that isn't already on the allowlist.
//
// SRP: this file is a SINK from the renderer's perspective (each method
// is one side effect: invoke an IPC handler) and a PRODUCER for the
// status-push subscriptions (returns an unsubscribe fn so React effect
// cleanup can detach without leaking listeners across HMR).
//
// Allowlist: this file is enumerated in `tools/.no-ipc-allowlist`.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { UpdateStatus } from '../../src/global';

const ccsmAllowlisted = {
  /**
   * Open the OS folder picker for the StatusBar cwd popover's
   * "Browse..." button. Returns the picked absolute path, or `null`
   * when the user cancels.
   */
  pickCwd: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('cwd:pick', defaultPath) as Promise<string | null>,

  /**
   * Running app version (Settings → Updates pane header). Bridges
   * `app.getVersion()` from the main process — Electron-process-bound,
   * so a real IPC hop is required. Sibling of the `updates:*` cluster
   * because the UpdatesPane mount consumes both at once. The type
   * declaration in `src/global.d.ts` previously listed this method but
   * this preload had no exposure, so any production user opening the
   * Updates tab triggered `undefined()` → ErrorBoundary; see PR #991.
   */
  getVersion: (): Promise<string> =>
    ipcRenderer.invoke('updates:getCurrentVersion') as Promise<string>,

  // ─── In-app updater (Settings → Updates pane) ───────────────────────
  updatesStatus: (): Promise<UpdateStatus> =>
    ipcRenderer.invoke('updates:status') as Promise<UpdateStatus>,
  updatesCheck: (): Promise<UpdateStatus> =>
    ipcRenderer.invoke('updates:check') as Promise<UpdateStatus>,
  updatesDownload: (): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('updates:download') as Promise<
      { ok: true } | { ok: false; reason: string }
    >,
  updatesInstall: (): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('updates:install') as Promise<
      { ok: true } | { ok: false; reason: string }
    >,
  updatesGetAutoCheck: (): Promise<boolean> =>
    ipcRenderer.invoke('updates:getAutoCheck') as Promise<boolean>,
  updatesSetAutoCheck: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('updates:setAutoCheck', enabled) as Promise<boolean>,

  /** Subscribe to updater status pushes. Returns an unsubscribe fn. */
  onUpdateStatus: (handler: (s: UpdateStatus) => void): (() => void) => {
    const wrapped = (_event: IpcRendererEvent, status: UpdateStatus) => {
      handler(status);
    };
    ipcRenderer.on('updates:status', wrapped);
    return () => {
      ipcRenderer.removeListener('updates:status', wrapped);
    };
  },

  /** Subscribe to "update downloaded" pushes (renderer can prompt
   *  to install). Returns an unsubscribe fn. */
  onUpdateDownloaded: (
    handler: (info: { version: string }) => void,
  ): (() => void) => {
    const wrapped = (_event: IpcRendererEvent, info: { version: string }) => {
      handler(info);
    };
    ipcRenderer.on('update:downloaded', wrapped);
    return () => {
      ipcRenderer.removeListener('update:downloaded', wrapped);
    };
  },
};

// Renderer accesses this surface via `window.ccsm.pickCwd(...)` /
// `window.ccsm.updatesCheck()` / `window.ccsm.onUpdateStatus(...)` etc.
// The type declaration lives in `src/global.d.ts`.
contextBridge.exposeInMainWorld('ccsm', ccsmAllowlisted);

export type CcsmAllowlisted = typeof ccsmAllowlisted;
