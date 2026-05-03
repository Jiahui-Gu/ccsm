import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

// Wave 0c (#217): renderer surface removed (the ipcMain.handle layer + the
// `webContents.send` broadcasts in this file were deleted).
//
// Wave 0e (#247): the renderer surface is BACK, but split out per spec
// ch08 §3.1 — the `ipcMain.handle('updates:*', ...)` registrations and
// the `webContents.send('updates:status' / 'update:downloaded', ...)`
// broadcasts now live in `electron/ipc-allowlisted/updater-ipc.ts` (an
// allowlisted file under `tools/.no-ipc-allowlist`). This file remains
// IPC-free; it owns the autoUpdater event wiring + status state machine,
// exposes hooks (`getUpdaterStatus`, `triggerUpdaterCheck`,
// `{is,set}AutoUpdaterCheckEnabled`) the IPC layer calls, and invokes
// the `broadcast*` callbacks supplied by the IPC layer to push status
// changes to the renderer.
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

// Optional broadcast hooks — wired by `electron/ipc-allowlisted/updater-ipc.ts`
// when the IPC layer is registered. Kept as nullable callbacks so this
// module stays runnable in unit tests that don't install the IPC half.
let onStatusChanged: ((s: UpdateStatus) => void) | null = null;
let onUpdateDownloadedHook: ((info: { version: string }) => void) | null = null;

// 4 hours. Electron-updater recommends not checking more often than hourly;
// 4h is a reasonable default that keeps users on the latest signed build
// without hammering GitHub releases.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function record(status: UpdateStatus): void {
  lastStatus = status;
  // Push to renderer when the IPC layer has wired its broadcast hook.
  // Keeping the hook nullable lets unit tests run without the IPC half.
  onStatusChanged?.(status);
}

/**
 * Wave 0e (#247): the IPC-allowlisted layer calls this to inject its
 * `broadcastUpdateStatus` / `broadcastUpdateDownloaded` callbacks so the
 * autoUpdater event listeners installed below can push status changes
 * to the renderer without this file importing `webContents` (forbidden
 * outside the allowlisted set per spec ch08 §5h.1 rule 4).
 */
export function setUpdaterBroadcastHooks(hooks: {
  onStatusChanged: (s: UpdateStatus) => void;
  onUpdateDownloaded: (info: { version: string }) => void;
}): void {
  onStatusChanged = hooks.onStatusChanged;
  onUpdateDownloadedHook = hooks.onUpdateDownloaded;
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
  autoUpdater.on('update-downloaded', (info) => {
    record({ kind: 'downloaded', version: info.version });
    onUpdateDownloadedHook?.({ version: info.version });
  });
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

/**
 * Trigger a one-shot update check on demand (drives the renderer's
 * "Check for updates" button via `electron/ipc-allowlisted/updater-ipc.ts`).
 * Resolves once `autoUpdater.checkForUpdates()` settles; the real status
 * lands via the autoUpdater event listeners and reaches the renderer
 * through the broadcast hook above.
 */
export async function triggerUpdaterCheck(): Promise<void> {
  await safeCheck();
}

/** Read the current periodic-auto-check enable flag (renderer Settings). */
export function isAutoUpdaterCheckEnabled(): boolean {
  return autoCheckEnabled;
}

/**
 * Toggle the periodic auto-check loop. Persistence lives in the renderer
 * (Settings store) for v0.3 and is replayed at boot via the IPC layer; this
 * module just owns the setInterval lifecycle.
 */
export function setAutoUpdaterCheckEnabled(enabled: boolean): void {
  autoCheckEnabled = enabled;
  if (enabled) {
    startPeriodicChecks();
  } else {
    stopPeriodicChecks();
  }
}

// Exposed for tests — lets them reset module state between cases.
export function __resetUpdaterForTests(): void {
  installed = false;
  autoCheckEnabled = true;
  lastStatus = { kind: 'idle' };
  onStatusChanged = null;
  onUpdateDownloadedHook = null;
  stopPeriodicChecks();
}
