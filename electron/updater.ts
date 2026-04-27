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
let autoCheckEnabled = true;
let periodicHandle: ReturnType<typeof setInterval> | null = null;

// 4 hours. Electron-updater recommends not checking more often than hourly;
// 4h is a reasonable default that keeps users on the latest signed build
// without hammering GitHub releases.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Named event channels — requested in the release infra spec in addition to
// the aggregated `updates:status` channel. Keeping both channels is cheap and
// makes renderer code (e.g. "show a toast on downloaded") trivial.
const CHAN_AVAILABLE = 'update:available';
const CHAN_DOWNLOADED = 'update:downloaded';
const CHAN_ERROR = 'update:error';
const CHAN_STATUS = 'updates:status';

function sendAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function broadcast(status: UpdateStatus): void {
  lastStatus = status;
  sendAll(CHAN_STATUS, status);
  // Fan out to the specific channels too so renderer listeners that only
  // care about one transition don't have to switch on kind themselves.
  if (status.kind === 'available') {
    sendAll(CHAN_AVAILABLE, { version: status.version, releaseDate: status.releaseDate });
  } else if (status.kind === 'downloaded') {
    sendAll(CHAN_DOWNLOADED, { version: status.version });
  } else if (status.kind === 'error') {
    sendAll(CHAN_ERROR, { message: status.message });
  }
}

/**
 * Safe wrapper around autoUpdater.checkForUpdates() that handles the three
 * common failure modes without crashing: not packaged (dev), network error,
 * and missing update metadata (running a build before the first release).
 */
async function safeCheck(): Promise<void> {
  if (!app.isPackaged) {
    broadcast({ kind: 'not-available', version: app.getVersion() });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    broadcast({ kind: 'error', message: (e as Error).message });
  }
}

function startPeriodicChecks(): void {
  if (periodicHandle) return;
  if (!autoCheckEnabled) return;
  if (!app.isPackaged) return;
  // Node's setInterval returns NodeJS.Timeout; Electron's `app` prevents
  // premature quit while timers are pending. .unref() so it doesn't keep
  // the event loop alive during shutdown.
  periodicHandle = setInterval(() => {
    void safeCheck();
  }, CHECK_INTERVAL_MS);
  (periodicHandle as unknown as { unref?: () => void }).unref?.();
}

function stopPeriodicChecks(): void {
  if (periodicHandle) {
    clearInterval(periodicHandle);
    periodicHandle = null;
  }
}

export function installUpdaterIpc(): void {
  if (installed) return;
  installed = true;

  // electron-updater is noisy by default; quiet it down — we surface state
  // through our own channel.
  autoUpdater.autoDownload = true;
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
    if (!app.isPackaged) {
      const status: UpdateStatus = { kind: 'not-available', version: app.getVersion() };
      broadcast(status);
      return status;
    }
    try {
      const res = await autoUpdater.checkForUpdates();
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
    // Defense-in-depth: refuse to call quitAndInstall unless we've
    // actually broadcast a `downloaded` event. Without this guard a
    // misbehaving renderer (e.g. the user clicking the persistent toast
    // after a stale state, or a future bug that wires the install button
    // to a non-downloaded state) can trigger autoUpdater.quitAndInstall()
    // mid-download — electron-updater handles that by force-killing the
    // app, which the user reads as a crash. Returning `not-ready` lets
    // the renderer surface a sane "still downloading" message instead.
    if (lastStatus.kind !== 'downloaded') {
      return { ok: false as const, reason: 'not-ready' as const };
    }
    // quitAndInstall: (isSilent, isForceRunAfter). We want a visible installer
    // on Windows (isSilent=false) and to relaunch after install on all OSes.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true as const };
  });

  ipcMain.handle('updates:getAutoCheck', () => autoCheckEnabled);
  ipcMain.handle('updates:setAutoCheck', (_e, enabled: boolean) => {
    autoCheckEnabled = !!enabled;
    if (autoCheckEnabled) {
      startPeriodicChecks();
      void safeCheck();
    } else {
      stopPeriodicChecks();
    }
    return autoCheckEnabled;
  });

  // Check once on ready + every 4h thereafter.
  void safeCheck();
  startPeriodicChecks();
}

// Exposed for tests — lets them reset module state between cases.
export function __resetUpdaterForTests(): void {
  installed = false;
  autoCheckEnabled = true;
  lastStatus = { kind: 'idle' };
  stopPeriodicChecks();
}
