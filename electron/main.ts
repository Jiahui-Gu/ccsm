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
// What was removed (Task #566 — wave-1 B; Task #580 — wave-2 D):
//   * register{Db,Session,System,Window,Utility}Ipc — the underlying
//     handlers + business modules they call (db / sessionWatcher / ptyHost
//     / notify pipeline / sessionTitles / prefs) were physically moved
//     into daemon/ during wave-2 A/B/C, and the parked legacy tree under
//     electron/__legacy_to_delete__/ was deleted in wave-2 D.
//   * notify pipeline + ptyHost + sessionWatcher boot — these run inside
//     the daemon now. Renderer reaches them over HTTP, not IPC.

import { app, BrowserWindow, ipcMain, dialog, type Tray } from 'electron';
import * as os from 'os';
import * as path from 'path';
import {
  runAbiSelfHeal,
  defaultProbeBetterSqlite3,
  defaultRunRebuild,
} from './abi-self-heal';
import { buildTrayIcon } from './branding/icon';
import { createWindow as createMainWindowFactory } from './window/createWindow';
import { notifyCloseActionFromRenderer } from './window/createWindow';
import { createHardFailScreen } from './window/createHardFailScreen';
import { createTray, type TrayController } from './tray/createTray';
import {
  spawnDaemon,
  getDaemonPort,
  killDaemon,
  DaemonHardFailError,
  DaemonSpawnTimeoutError,
  DaemonSpawnError,
} from './daemon-spawner';

// safety net — escaped main-proc rejections kill app on Node 20+ default
// (audit tech-debt-03-errors.md risk #2).
process.on('unhandledRejection', (reason, _promise) => {
  console.error('[main] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});

// Wave-2 A: Sentry init moved into the daemon (daemon/startup/data.ts) since
// the modules sentry's beforeSend consults (prefs/crashReporting → db) now
// live there. The renderer-side @sentry/electron preload is independent and
// continues to wire itself in via electron/preload.

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

// ─────────────────── ABI self-heal (Task #641 Layer 3) ────────────────────
// Run BEFORE app.whenReady so that if better-sqlite3 was compiled against
// the host Node ABI instead of Electron's (the dogfood #575 root cause), we
// rebuild + relaunch BEFORE spawning the daemon (which would crash on its
// first `require('better-sqlite3')`). One-shot guard inside runAbiSelfHeal
// prevents an infinite loop if the rebuild itself can't fix things.
//
// In packaged builds with devDeps stripped we degrade to a no-op (rebuild
// bin missing); the L1+L2 storage banner from #639 then surfaces the real
// state to the user.
function selfHealOrRelaunch(): void {
  // Use a stable, well-known sub-dir under the OS userData root. We can't
  // call app.getPath('userData') here yet (app may not be ready on first
  // entry on some platforms — relying on app.name is fine because Electron
  // initializes the path resolver at process start). Wrap in try so a
  // probe/rebuild failure never blocks the app from at least attempting to
  // boot — the daemon banner will tell the user something is wrong.
  try {
    let userDataDir: string;
    try {
      userDataDir = app.getPath('userData');
    } catch {
      // Fallback for the rare case Electron's path resolver isn't ready yet:
      // use os.tmpdir() so the marker still works (it's only a one-shot loop
      // guard, not user data).
      userDataDir = path.join(os.tmpdir(), 'ccsm-abi-self-heal');
    }
    const result = runAbiSelfHeal({
      userDataDir,
      appRoot: app.getAppPath(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      probeBetterSqlite3: defaultProbeBetterSqlite3,
      runRebuild: defaultRunRebuild,
    });
    if (result.kind === 'healed') {
      console.log('[main] ABI self-heal succeeded — relaunching to load fresh native binding');
      app.relaunch();
      app.exit(0);
      return;
    }
    if (result.kind === 'rebuild-failed' || result.kind === 'already-tried') {
      // Don't kill the app — let it try to boot. The daemon-init banner
      // (#639 L1) will surface the storage failure to the user with a
      // precise reason.
      console.warn(`[main] ABI self-heal could not auto-fix (${result.kind}) — continuing boot; daemon banner will surface the failure`);
    }
  } catch (err) {
    // Self-heal must never throw past this boundary — a bug in the heal
    // path can't be allowed to brick the app.
    console.error('[main] ABI self-heal threw unexpectedly (ignoring, continuing boot):', err);
  }
}
selfHealOrRelaunch();

// Install the hidden Edit-role accelerator menu at module load so
// copy/paste etc. work before app.whenReady. Re-run on locale change.
applyAppMenuLocale();

let trayController: TrayController | null = null;
let isQuitting = false;

// Task #639 — last known runtime storage-health snapshot from the daemon.
// Cached so a renderer that loads AFTER a runtime push (e.g. a recreated
// window after close-to-tray) can synchronously fetch the failure state
// via the `storage:getHealth` IPC handler below. `null` = no runtime
// failure pushed (treated as "ok" by the renderer).
//
// Note: STARTUP-time storage failure no longer flows through this path.
// It now goes through the daemon ready protocol — daemon exits 1, parent
// shows the hard-fail screen, the main React app never mounts. See
// daemon/startup/data.ts and createHardFailScreen.ts.
let lastKnownStorageHealth: { ok: boolean; reason?: string } | null = null;

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

  // Task #639 — single ready-signal invariant: spawnDaemon resolves ONLY
  // when the daemon emitted PORT, which (per the new ready protocol)
  // implies all critical startup modules initialised cleanly. If it
  // rejects with DaemonHardFailError (critical module like initDb threw,
  // daemon process.exit(1)) or DaemonSpawnTimeoutError (10s no PORT,
  // SIGKILLed), we MUST NOT createWindow — instead show the hard-fail
  // startup screen so the user can't reach the main React app and create
  // work that won't persist. This is the v0.3 ship-blocker fix for the
  // dogfood-575 silent-data-loss P0.
  //
  // Wave-2 A: inject the host-process facts the daemon would otherwise need
  // electron APIs to discover. The daemon's db.ts reads CCSM_USER_DATA_DIR
  // for the SQLite file location (so prod data lands in the same per-user
  // dir electron uses), and sentry/init.ts reads CCSM_APP_VERSION /
  // CCSM_IS_PACKAGED for release tagging + dev/prod environment.
  process.env.CCSM_USER_DATA_DIR = app.getPath('userData');
  process.env.CCSM_APP_VERSION = app.getVersion();
  process.env.CCSM_IS_PACKAGED = app.isPackaged ? '1' : '0';

  let daemonReady = false;
  try {
    await spawnDaemon();
    daemonReady = true;
  } catch (err) {
    daemonReady = false;
    let reason: string;
    let detail: string | undefined;
    if (err instanceof DaemonHardFailError) {
      reason = `Daemon failed to start (exit code ${err.exitCode}). A critical component could not initialise.`;
      detail = err.stderrTail;
    } else if (err instanceof DaemonSpawnTimeoutError) {
      reason = `Daemon did not respond within ${err.timeoutMs}ms. The startup process may be stuck.`;
      detail = undefined;
    } else if (err instanceof DaemonSpawnError) {
      reason = `Daemon spawn failed (${err.kind}): ${err.message}`;
      detail = typeof err.detail.stderrTail === 'string' ? (err.detail.stderrTail as string) : undefined;
    } else {
      reason = `Daemon failed to start: ${err instanceof Error ? err.message : String(err)}`;
      detail = undefined;
    }
    console.error('[main] daemon failed to start, rendering hard-fail screen:', err);
    // Show the static error screen and DO NOT createWindow / ensureTray.
    // The main React app never mounts, no group/session UI is reachable,
    // no IPC is wired except daemon:getPort (which returns null safely).
    createHardFailScreen({ reason, detail });
  }

  // Wave-2-C: subscribe to the daemon's notify SSE so OS notifications and
  // taskbar flashes fire in main (the daemon owns the decider; main owns
  // the OS-side sinks). Survives daemon restarts via internal reconnect.
  // Only wire if daemon is actually up — no point opening a SSE to a
  // dead loopback.
  if (daemonReady) {
    installNotifySinkConsumer();
  }

  registerCwdPickerIpc();
  installUpdaterIpc();

  if (daemonReady) {
    createWindow();
    ensureTray();
  }
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

// Task #639 — synchronous storage-health snapshot. The renderer's
// useStorageHealthBridge hook calls this on mount so a window created
// after the initial spawn-time fanout still picks up the failure state
// without waiting for a second push. Returns null when the probe has
// never reported (treated as "ok / unknown" by the renderer).
ipcMain.handle('storage:getHealth', () => lastKnownStorageHealth);

// Renderer-side `window.ccsm.saveState('closeAction', value)` calls this
// IPC right after the daemon write succeeds so main's in-memory close-action
// cache stays in lock-step with persisted state. Without this the cache
// only refreshes on next app launch and the close handler picks the stale
// branch (Task #636 — tray/close-dialog e2e baseline-red).
ipcMain.handle('main:notifyCloseAction', (_e, raw: unknown) => {
  notifyCloseActionFromRenderer(raw);
});
