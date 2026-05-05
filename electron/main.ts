// Main process entry point. v0.3 wave-1 thin shell:
//   * spawns the daemon child (electron/daemon-spawner.ts) and exposes its
//     loopback port to the renderer via the `getDaemonPort` preload bridge;
//   * keeps only the IPC surfaces the daemon CANNOT serve from a loopback
//     HTTP boundary — the OS folder picker (`cwd:pick`, requires the main
//     window's BrowserWindow as the dialog parent) and electron-updater
//     (signed-installer side-effects must run inside the Electron process);
//   * keeps window / tray / lifecycle / menu wiring (no daemon equivalent);
//   * keeps Sentry init.
//
// What was removed (Task #566 — wave-1 B):
//   * register{Db,Session,System,Window,Utility}Ipc — the underlying
//     handlers + business modules they call (db / sessionWatcher / ptyHost
//     / notify pipeline / sessionTitles / prefs) are wave-2 dev's scope
//     to physically move into daemon/. The legacy ipc/ tree was moved to
//     electron/__legacy_to_delete__/ipc/ and is excluded from build /
//     test / lint until wave-2 deletes it for good.
//   * notify pipeline + ptyHost + sessionWatcher boot — these run inside
//     the daemon now. Renderer reaches them over HTTP, not IPC.
//
// During the wave-1 / wave-2 gap the app will start (daemon spawns, window
// loads, lifecycle hooks fire) but renderer fetches against the daemon
// will 404 because wave-2 hasn't lifted handlers into HTTP routes yet.
// That's expected — the acceptance bar for this PR is "daemon spawns,
// main attaches to its port".

import { app, BrowserWindow, ipcMain, dialog, type Tray } from 'electron';
import * as os from 'os';
import { buildTrayIcon } from './branding/icon';
import { initSentry } from './sentry/init';
import { createWindow as createMainWindowFactory } from './window/createWindow';
import { createTray, type TrayController } from './tray/createTray';
import { spawnDaemon, getDaemonPort, killDaemon } from './daemon-spawner';

// safety net — escaped main-proc rejections kill app on Node 20+ default
// (audit tech-debt-03-errors.md risk #2).
process.on('unhandledRejection', (reason, _promise) => {
  console.error('[main] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});

// Sentry init reads SENTRY_DSN and wires up beforeSend → opt-out check. The
// init is idempotent and a no-op when no DSN is set.
initSentry();

import { installUpdaterIpc } from './updater';
import {
  applyAppMenuLocale,
  registerLifecycleHandlers,
} from './lifecycle/appLifecycle';
import { acquireSingleInstanceLock } from './lifecycle/singleInstance';
import { installNotifySinkConsumer } from './notify/sinkConsumer';

// `app.isPackaged` is the canonical "are we shipping" signal. The
// `CCSM_PROD_BUNDLE=1` env var lets E2E probes force-load the production
// bundle from `dist/renderer/index.html` even though we're invoked via
// `electron .`, so they don't require a running webpack-dev-server.
const isDev = !app.isPackaged && process.env.CCSM_PROD_BUNDLE !== '1';

// Acquire the single-instance lock + register the second-instance focus
// handler. See electron/lifecycle/singleInstance for the rationale.
acquireSingleInstanceLock();

// Install the hidden Edit-role accelerator menu at module load so
// copy/paste etc. work before app.whenReady. Re-run on locale change.
applyAppMenuLocale();

let trayController: TrayController | null = null;
let isQuitting = false;

function getTrayBaseImage() {
  return buildTrayIcon();
}

function createWindow(): BrowserWindow {
  return createMainWindowFactory({
    isDev,
    getIsQuitting: () => isQuitting,
    setIsQuitting: (v) => {
      isQuitting = v;
    },
  });
}

function ensureTray(): TrayController {
  if (trayController) return trayController;
  trayController = createTray({
    createMainWindow: () => {
      createWindow();
    },
    setIsQuitting: (v) => {
      isQuitting = v;
    },
  });
  return trayController;
}

function applyTrayLocale(): void {
  trayController?.applyLocale();
}

function getTray(): Tray | null {
  return trayController?.tray ?? null;
}

// Reference helpers we don't yet wire elsewhere — keep `getTray` /
// `applyTrayLocale` / `getTrayBaseImage` referenced so eslint doesn't
// flag them while the language-set IPC moves into the daemon (wave-2
// will reintroduce a thin tray-locale signal once renderer drives
// locale via HTTP).
void getTray;
void applyTrayLocale;
void getTrayBaseImage;

// ─────────────────────── ipc-allowlisted handlers ──────────────────────────
// Surfaces the daemon (a plain Node process) cannot serve. Kept inline so
// the file makes the shrunken IPC surface obvious at a glance.
//
//   1. `cwd:pick` — `dialog.showOpenDialog` requires a BrowserWindow parent
//      so the OS attributes the modal to the right app surface. The daemon
//      has no window handle.
//   2. `app:userHome` — synchronous Node `os.homedir()` lookup. Could move
//      to the daemon later but keeping it here avoids a renderer round-trip
//      during initial hydration before the daemon port is known.
//   3. updater channels (`updates:*`, `update:*`) — installed via
//      `installUpdaterIpc()` below. electron-updater drives signed-installer
//      side-effects inside the Electron process; wrapping it over HTTP would
//      put a privileged install path on a loopback socket.
function registerCwdPickerIpc(): void {
  ipcMain.handle('cwd:pick', async (e, opts?: { defaultPath?: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return null;
    const defaultPath =
      typeof opts?.defaultPath === 'string' && opts.defaultPath.length > 0
        ? opts.defaultPath
        : os.homedir();
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Pick working directory',
        defaultPath,
        properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      });
      if (result.canceled) return null;
      const picked = result.filePaths[0];
      return typeof picked === 'string' && picked.length > 0 ? picked : null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('app:userHome', () => os.homedir());
}

app.whenReady().then(async () => {
  // On Windows, set a stable AppUserModelID so the OS attributes the app to
  // its taskbar / Start Menu entry instead of generic "electron.exe".
  if (process.platform === 'win32') {
    const isDevVariant = app.getName().includes('Dev');
    const aumid = isDevVariant ? 'com.ccsm.app.dev' : 'com.ccsm.app';
    app.setAppUserModelId(aumid);
  }

  // Spawn the daemon BEFORE creating the window so the preload bridge has
  // a port to expose by the time renderer scripts run. We don't block on
  // `await` for failures fatally — a daemon-failed-to-start surface is the
  // renderer's responsibility (a toast + retry button, wired in wave-1 C).
  spawnDaemon().catch((err) => {
    console.error('[main] daemon failed to start:', err);
  });

  // Wave-2-C: subscribe to the daemon's notify SSE so OS notifications and
  // taskbar flashes fire in main (the daemon owns the decider; main owns
  // the OS-side sinks). Survives daemon restarts via internal reconnect.
  installNotifySinkConsumer();

  registerCwdPickerIpc();
  installUpdaterIpc();

  createWindow();
  ensureTray();
});

registerLifecycleHandlers({
  app,
  getIsQuitting: () => isQuitting,
  setIsQuitting: (v) => {
    isQuitting = v;
  },
  // Wave-1 B: pty / db / notify-pipeline cleanup all moves into the
  // daemon's own shutdown path. Main only kills the daemon child; the
  // daemon is responsible for reaping its own resources on SIGTERM.
  killAllPtySessions: () => {},
  closeDb: () => {},
  disposeNotifyPipeline: () => {},
  killDaemon,
  createWindow: () => {
    createWindow();
  },
  getWindowCount: () => BrowserWindow.getAllWindows().length,
});

// Expose the spawn-resolved port to anyone who needs it inside main (the
// preload bridge reads it via the `getDaemonPort` IPC handler below).
ipcMain.handle('daemon:getPort', () => getDaemonPort());
