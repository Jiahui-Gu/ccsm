import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

// Wave 0c (#217): renderer surface removed. The shell-only auto-update
// mechanism still runs (periodic check + autoDownload + install on quit),
// but no IPC handlers, no `webContents.send` broadcasts, no renderer
// status channel. v0.4 will reintroduce a renderer-facing surface via the
// daemon-driven RPC layer; until then the updater is a self-contained
// background module that writes its state to `lastStatus` for diagnostics.
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

function record(status: UpdateStatus): void {
  lastStatus = status;
}

/**
 * Safe wrapper around autoUpdater.checkForUpdates() that handles the three
 * common failure modes without crashing: not packaged (dev), network error,
 * and missing update metadata (running a build before the first release).
 */
async function safeCheck(): Promise<void> {
  if (!app.isPackaged) {
    record({ kind: 'not-available', version: app.getVersion() });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    record({ kind: 'error', message: (e as Error).message });
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

/**
 * Initialize the shell-only auto-updater. Wires `electron-updater` event
 * listeners + kicks off the periodic check loop. No renderer surface — the
 * updater downloads in the background and applies on quit.
 */
export function installUpdater(): void {
  if (installed) return;
  installed = true;

  // electron-updater is noisy by default; quiet it down — we keep its state
  // in `lastStatus` for in-process diagnostics only.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  // Dual-install (#891): the dev variant pulls GitHub pre-releases so we can
  // ship release candidates / dogfood builds without affecting prod users
  // (prod's autoUpdater leaves allowPrerelease=false, so it skips them).
  // No early return — dev MUST exercise the full updater flow to validate it.
  if (app.getName().includes('Dev')) {
    autoUpdater.allowPrerelease = true;
  }

  autoUpdater.on('checking-for-update', () => record({ kind: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    record({
      kind: 'available',
      version: info.version,
      releaseDate: info.releaseDate
    })
  );
  autoUpdater.on('update-not-available', (info) =>
    record({ kind: 'not-available', version: info.version })
  );
  autoUpdater.on('download-progress', (p) =>
    record({
      kind: 'downloading',
      percent: p.percent,
      transferred: p.transferred,
      total: p.total
    })
  );
  autoUpdater.on('update-downloaded', (info) =>
    record({ kind: 'downloaded', version: info.version })
  );
  autoUpdater.on('error', (err) =>
    record({ kind: 'error', message: err?.message ?? String(err) })
  );

  // Check once on ready + every 4h thereafter.
  void safeCheck();
  startPeriodicChecks();
}

// Exposed for tests + diagnostics — lets callers read the latest known state
// without subscribing to events.
export function getUpdaterStatus(): UpdateStatus {
  return lastStatus;
}

// Exposed for tests — lets them reset module state between cases.
export function __resetUpdaterForTests(): void {
  installed = false;
  autoCheckEnabled = true;
  lastStatus = { kind: 'idle' };
  stopPeriodicChecks();
}
