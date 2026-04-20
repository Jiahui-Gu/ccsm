import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';

// All status updates flow through one channel so the renderer doesn't have to
// subscribe to N separate event names. The shape mirrors electron-updater's
// own emitter so future fields land naturally.
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

let lastStatus: UpdateStatus = { kind: 'idle' };
let installed = false;

function broadcast(status: UpdateStatus): void {
  lastStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updates:status', status);
  }
}

export function installUpdaterIpc(): void {
  if (installed) return;
  installed = true;

  // electron-updater is noisy by default; quiet it down — we surface state
  // through our own channel.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => broadcast({ kind: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    broadcast({
      kind: 'available',
      version: info.version,
      releaseDate: info.releaseDate
    })
  );
  autoUpdater.on('update-not-available', (info) =>
    broadcast({ kind: 'not-available', version: info.version })
  );
  autoUpdater.on('download-progress', (p) =>
    broadcast({
      kind: 'downloading',
      percent: p.percent,
      transferred: p.transferred,
      total: p.total
    })
  );
  autoUpdater.on('update-downloaded', (info) =>
    broadcast({ kind: 'downloaded', version: info.version })
  );
  autoUpdater.on('error', (err) =>
    broadcast({ kind: 'error', message: err?.message ?? String(err) })
  );

  ipcMain.handle('updates:status', () => lastStatus);

  ipcMain.handle('updates:check', async () => {
    // In development the autoUpdater throws because there's no app-update.yml.
    // Returning a synthetic "not-available" keeps the Settings UI behaving
    // sanely without forcing the renderer to special-case dev mode.
    if (!app.isPackaged) {
      const status: UpdateStatus = { kind: 'not-available', version: app.getVersion() };
      broadcast(status);
      return status;
    }
    try {
      const res = await autoUpdater.checkForUpdates();
      // checkForUpdates resolves before update-available fires for the first
      // time on a cold check; rely on the event broadcaster to push the real
      // status. Returning lastStatus is best-effort.
      void res;
      return lastStatus;
    } catch (e) {
      const status: UpdateStatus = { kind: 'error', message: (e as Error).message };
      broadcast(status);
      return status;
    }
  });

  ipcMain.handle('updates:download', async () => {
    if (!app.isPackaged) return { ok: false, reason: 'not-packaged' as const };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, reason: (e as Error).message };
    }
  });

  ipcMain.handle('updates:install', () => {
    if (!app.isPackaged) return { ok: false as const, reason: 'not-packaged' as const };
    // quitAndInstall: true (silent run-after install) is too aggressive for
    // MVP — the user just clicked a button, they expect the install dialog.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true as const };
  });
}
