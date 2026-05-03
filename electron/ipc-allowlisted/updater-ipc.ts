// electron/ipc-allowlisted/updater-ipc.ts
//
// In-app updater IPC channels — `updates:status`, `updates:check`,
// `updates:download`, `updates:install`, `updates:getAutoCheck`,
// `updates:setAutoCheck`, plus the main → renderer push channels
// `updates:status` and `update:downloaded`. Per spec ch08 §3.1 these
// are sanctioned `ipcMain.handle` channels exempt from `lint:no-ipc`:
// `electron-updater`'s `autoUpdater` API is Electron-process-bound
// (requires Electron main; not available in the renderer or daemon),
// and the renderer Settings → Updates pane needs a status surface +
// user-driven check/download/install controls.
//
// SRP shape:
//   * SINK side: each `ipcMain.handle` writes through to `electron/updater.ts`'s
//     getUpdaterStatus() / safeCheck() / autoUpdater.downloadUpdate() /
//     autoUpdater.quitAndInstall().
//   * PRODUCER side: the autoUpdater event listeners installed by
//     `electron/updater.ts::installUpdater()` invoke `broadcastUpdateStatus`
//     here to push status changes to every attached webContents (and the
//     `update-downloaded` listener invokes `broadcastUpdateDownloaded`).
//
// Wave 0c (#953) deleted the IPC + broadcast halves entirely; this file
// reintroduces them under the §3.1 allowlist for v0.3 ship. The push side
// uses `webContents.send` only for the allowlisted channel names — that
// is the ONE sanctioned use of `webContents.send` outside the transport
// bridge (per spec ch08 §5h.1 rule 4).
//
// Allowlist: this file is enumerated in `tools/.no-ipc-allowlist` and is
// the ONLY non-test consumer of `ipcMain` / `webContents.send` for the
// `updates:*` + `update:*` channel cluster.

import { BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import {
  getUpdaterStatus,
  setAutoUpdaterCheckEnabled,
  isAutoUpdaterCheckEnabled,
  triggerUpdaterCheck,
  type UpdateStatus,
} from '../updater';

let registered = false;

/**
 * Send a payload to every attached BrowserWindow. The renderer's
 * `onUpdateStatus` / `onUpdateDownloaded` handlers subscribe via
 * `ipcRenderer.on(channel, ...)`; we fan out across all webContents so
 * multi-window setups (none today, but the BrowserWindow factory is
 * already plural) all see the same updater state.
 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // Ignore send failures on closing windows; the renderer-side
      // subscription will be torn down by its own React effect cleanup.
    }
  }
}

export function broadcastUpdateStatus(status: UpdateStatus): void {
  broadcast('updates:status', status);
}

export function broadcastUpdateDownloaded(info: { version: string }): void {
  broadcast('update:downloaded', info);
}

/**
 * Register the `updates:*` + `update:downloaded` IPC handlers.
 * Idempotent. Caller must also call `installUpdater()` from
 * `electron/updater.ts` so the `autoUpdater` event listeners that drive
 * `broadcastUpdateStatus` / `broadcastUpdateDownloaded` are wired up.
 */
export function registerUpdaterIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('updates:status', (): UpdateStatus => getUpdaterStatus());

  ipcMain.handle('updates:check', async (): Promise<UpdateStatus> => {
    await triggerUpdaterCheck();
    return getUpdaterStatus();
  });

  ipcMain.handle(
    'updates:download',
    async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
      try {
        await autoUpdater.downloadUpdate();
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  );

  ipcMain.handle(
    'updates:install',
    (): { ok: true } | { ok: false; reason: string } => {
      try {
        // `quitAndInstall(isSilent, isForceRunAfter)` — silent install +
        // run after the update is applied. Matches the v0.2 behaviour.
        autoUpdater.quitAndInstall(true, true);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  );

  ipcMain.handle('updates:getAutoCheck', (): boolean =>
    isAutoUpdaterCheckEnabled(),
  );

  ipcMain.handle(
    'updates:setAutoCheck',
    (_event, enabled: boolean): boolean => {
      setAutoUpdaterCheckEnabled(!!enabled);
      return isAutoUpdaterCheckEnabled();
    },
  );
}

/** Test seam: tear down handlers + reset module flag. */
export function __resetUpdaterIpcForTests(): void {
  if (!registered) return;
  for (const channel of [
    'updates:status',
    'updates:check',
    'updates:download',
    'updates:install',
    'updates:getAutoCheck',
    'updates:setAutoCheck',
  ]) {
    ipcMain.removeHandler(channel);
  }
  registered = false;
}
