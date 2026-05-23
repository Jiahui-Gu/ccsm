import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { UPDATE_CHANNELS, UPDATES_CHANNELS } from './shared/ipcChannels';
import { log } from './shared/log';

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

// 1 hour. Matches the hourly release cadence (see
// `.github/workflows/hourly-tag-release.yml`) so an in-app session picks up
// a new build within roughly one polling window of publication. Electron-
// updater docs caution against going below hourly (GitHub Releases is the
// underlying feed and 60+ checks/hr per client is noisy); 1h is the floor.
// Prior value was 4h — that is too coarse for a project that ships a new
// tag every hour, leaving long-running sessions stuck on stale builds.
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Named event channels — requested in the release infra spec in addition to
// the aggregated `updates:status` channel. Keeping both channels is cheap and
// makes renderer code (e.g. "show a toast on downloaded") trivial. See
// `UPDATE_CHANNELS` (singular) in shared/ipcChannels.ts.

function sendAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function broadcast(status: UpdateStatus): void {
  lastStatus = status;
  sendAll(UPDATES_CHANNELS.status, status);
  // Fan out to the specific channels too so renderer listeners that only
  // care about one transition don't have to switch on kind themselves.
  if (status.kind === 'available') {
    sendAll(UPDATE_CHANNELS.available, { version: status.version, releaseDate: status.releaseDate });
  } else if (status.kind === 'downloaded') {
    sendAll(UPDATE_CHANNELS.downloaded, { version: status.version });
  } else if (status.kind === 'error') {
    sendAll(UPDATE_CHANNELS.error, { message: status.message });
  }
}

/**
 * Safe wrapper around autoUpdater.checkForUpdates() that handles the three
 * common failure modes without crashing: not packaged (dev), network error,
 * and missing update metadata (running a build before the first release).
 *
 * Emits `updater.check.start` and `updater.check.result` / `updater.error`
 * probes so the auto-update path is debuggable from main.log (when the file
 * sink is enabled). Without these, a silent "never finds an update" failure
 * mode is invisible to triage — there's no UI surface that lights up when
 * the check itself errors before any IPC event fires.
 */
async function safeCheck(reason: 'startup' | 'poll' | 'manual' | 'toggle'): Promise<void> {
  if (!app.isPackaged) {
    broadcast({ kind: 'not-available', version: app.getVersion() });
    return;
  }
  const currentVersion = app.getVersion();
  log.event('updater.check.start', { reason, currentVersion });
  try {
    const res = await autoUpdater.checkForUpdates();
    // electron-updater returns `null` if a check is already in progress; in
    // that case treat as a no-op result rather than a phantom "no update".
    const latestVersion = res?.updateInfo?.version;
    const releaseDate = res?.updateInfo?.releaseDate;
    const available =
      typeof latestVersion === 'string' && latestVersion !== currentVersion;
    log.event('updater.check.result', {
      reason,
      currentVersion,
      latestVersion: typeof latestVersion === 'string' ? latestVersion : undefined,
      releaseDate: typeof releaseDate === 'string' ? releaseDate : undefined,
      available,
    });
  } catch (e) {
    const err = e as Error & { code?: string };
    log.event('updater.error', {
      reason,
      currentVersion,
      code: err?.code,
    });
    broadcast({ kind: 'error', message: err?.message ?? String(err) });
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
    void safeCheck('poll');
  }, CHECK_INTERVAL_MS);
  (periodicHandle as unknown as { unref?: () => void }).unref?.();
  log.event('updater.poll.scheduled', { intervalMs: CHECK_INTERVAL_MS });
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

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // electron-updater is noisy on stdout by default; route its internal
  // diagnostics through our structured logger so the records land in
  // main.log (when the file sink is enabled) under tag `electron-updater`.
  // Previously this was set to `null`, which silenced electron-updater
  // entirely — making "updater not detecting releases" an invisible failure
  // mode with zero log evidence to triage from.
  autoUpdater.logger = {
    info: (m: unknown) => log.info('electron-updater', String(m)),
    warn: (m: unknown) => log.warn('electron-updater', String(m)),
    error: (m: unknown) => log.error('electron-updater', String(m)),
    debug: (m: unknown) => log.debug('electron-updater', String(m)),
  } as unknown as typeof autoUpdater.logger;

  // Dual-install (#891): the dev variant pulls GitHub pre-releases so we can
  // ship release candidates / dogfood builds without affecting prod users
  // (prod's autoUpdater leaves allowPrerelease=false, so it skips them).
  // No early return — dev MUST exercise the full updater flow to validate it.
  if (app.getName().includes('Dev')) {
    autoUpdater.allowPrerelease = true;
  }

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
  autoUpdater.on('error', (err) => {
    // Mirror the autoUpdater error to a structured probe so main.log shows
    // the failure. The `electron-updater` logger above ALSO records it, but
    // that record is a free-form string from the library; the probe gives
    // us a stable event name to grep for during triage.
    const e = err as Error & { code?: string };
    log.event('updater.error', {
      reason: 'emit',
      currentVersion: app.getVersion(),
      code: e?.code,
    });
    broadcast({ kind: 'error', message: err?.message ?? String(err) });
  });

  ipcMain.handle(UPDATES_CHANNELS.status, () => lastStatus);

  ipcMain.handle(UPDATES_CHANNELS.check, async () => {
    if (!app.isPackaged) {
      const status: UpdateStatus = { kind: 'not-available', version: app.getVersion() };
      broadcast(status);
      return status;
    }
    // Reuse safeCheck so the manual path emits the same probes as the
    // periodic / startup paths — one log signature to triage from.
    await safeCheck('manual');
    return lastStatus;
  });

  ipcMain.handle(UPDATES_CHANNELS.download, async () => {
    if (!app.isPackaged) return { ok: false, reason: 'not-packaged' as const };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, reason: (e as Error).message };
    }
  });

  ipcMain.handle(UPDATES_CHANNELS.install, () => {
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
    // quitAndInstall: (isSilent, isForceRunAfter). With NSIS oneClick=true the
    // installer runs without UI; pair with isSilent=true so electron-updater
    // doesn't pop a redundant progress window. isForceRunAfter=true relaunches
    // CCSM after install on all OSes — VSCode-style restart-to-update.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ok: true as const };
  });

  ipcMain.handle(UPDATES_CHANNELS.getAutoCheck, () => autoCheckEnabled);
  ipcMain.handle(UPDATES_CHANNELS.setAutoCheck, (_e, enabled: boolean) => {
    autoCheckEnabled = !!enabled;
    if (autoCheckEnabled) {
      startPeriodicChecks();
      void safeCheck('toggle');
    } else {
      stopPeriodicChecks();
    }
    return autoCheckEnabled;
  });

  // Check once on ready + every hour thereafter.
  void safeCheck('startup');
  startPeriodicChecks();
}

// Exposed for tests — lets them reset module state between cases.
export function __resetUpdaterForTests(): void {
  installed = false;
  autoCheckEnabled = true;
  lastStatus = { kind: 'idle' };
  stopPeriodicChecks();
}
