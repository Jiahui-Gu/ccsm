// Main process entry point. Thin orchestrator: lifecycle hookups + the
// cross-cutting glue (notify pipeline, ptyHost lifecycle, sessionWatcher)
// that doesn't fit any single SRP module.
//
// SRP map (Task #731 / #742 refactor):
//   * electron/prefs/*           — closeAction / crashReporting / notifyEnabled
//                                  / userCwds preference modules.
//   * electron/security/*        — path safety guards.
//   * electron/sentry/*          — crash reporting init + opt-out.
//   * electron/window/*          — BrowserWindow factory + close choreography.
//   * electron/tray/*            — Tray icon + locale-aware menu.
//   * electron/lifecycle/*       — applyAppMenuLocale + app.on(...) glue
//                                  + single-instance lock.
//   * electron/notify/bootstrap/ — notify pipeline construction + producer
//                                  subscriptions (PTY, focus/blur, unwatched).
//   * electron/testHooks         — CCSM_NOTIFY_TEST_HOOK-gated probe seams.
//
// Wave 0b (#216) state:
//   * The v0.2 `electron/ipc/*` register*Ipc handlers, the preload bridges,
//     and the renderer-pushed sid/name mirrors are gone (pure delete; no
//     replacement on this surface). Wave 0c will rewire the renderer to talk
//     to the daemon over Connect-RPC; Wave 1 will move the ptyHost / notify
//     producers to the daemon. Until then THIS ELECTRON APP IS NOT RUNNABLE
//     end-to-end — it boots, opens a window, and the renderer has no IPC
//     surface to call. The notify pipeline is still constructed so its
//     focus/blur + unwatched producers continue to fire (badge + dispose
//     are kept live so Wave 0c can drop the daemon-sourced name/active-sid
//     wiring straight in without a refactor).
//
// What still lives here:
//   * Cross-module shared state (isQuitting, badgeManager, notifyPipeline).
//   * The createWindow / ensureTray thin wrappers that close over that
//     state for the dependency bags.
//   * The `app.whenReady()` body that wires every subsystem together
//     (db init, notify pipeline construction, sessionWatcher, eager scans).
import { app, BrowserWindow, session, type Tray } from 'electron';
import { initDb, closeDb } from './db';
import { installClipboardPermissionHandlers } from './security/clipboardPermission';
import { buildTrayIcon } from './branding/icon';
import { initSentry } from './sentry/init';
import { createWindow as createMainWindowFactory } from './window/createWindow';
import { createTray, type TrayController } from './tray/createTray';

// safety net — escaped main-proc rejections kill app on Node 20+ default
// (audit tech-debt-03-errors.md risk #2). Registered BEFORE app.whenReady so
// any throw during bootstrap (initSentry, db open) lands in the logger
// instead of silently terminating the process. We deliberately do NOT call
// app.exit() — preserves current default-throw behavior in tests and mirrors
// the renderer's "log + degrade" stance. TODO: forward to Sentry once
// main-process Sentry transport is wired (currently renderer-only per audit).
process.on('unhandledRejection', (reason, _promise) => {
  console.error('[main] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});

// Sentry init reads SENTRY_DSN and wires up beforeSend → opt-out check. The
// init is idempotent and a no-op when no DSN is set.
initSentry();

import { killAllPtySessions } from '../packages/daemon/src/ptyHost';
import { configureSessionWatcher } from './sessionWatcher';
import { BadgeManager } from './notify/badge';
import {
  installNotifyPipelineWithProducers,
  type NotifyPipeline,
} from './notify/bootstrap/installPipeline';
import {
  getSessionTitle,
  flushPendingRename,
} from './sessionTitles';
import { loadNotifyEnabled, subscribeNotifyEnabledInvalidation } from './prefs/notifyEnabled';
import { subscribeCrashReportingInvalidation } from './prefs/crashReporting';
import { BadgeController } from './badgeController';
import {
  applyAppMenuLocale,
  registerLifecycleHandlers,
} from './lifecycle/appLifecycle';
import { acquireSingleInstanceLock } from './lifecycle/singleInstance';
import { installEarlyTestHooks, installLateTestHooks } from './testHooks';
// Wave 0e (#247): the spec ch08 §3.1 allowlisted IPC channels — folder
// picker + in-app updater. Both surfaces are FROZEN at v0.3 ship; adding
// channels requires a §3.1 amendment. See electron/ipc-allowlisted/.
import { registerFolderPickerIpc } from './ipc-allowlisted/folder-picker';
import {
  registerUpdaterIpc,
  broadcastUpdateStatus,
  broadcastUpdateDownloaded,
} from './ipc-allowlisted/updater-ipc';
import { installUpdater, setUpdaterBroadcastHooks } from './updater';

// `app.isPackaged` is the canonical "are we shipping" signal. The
// `CCSM_PROD_BUNDLE=1` env var lets E2E probes force-load the production
// bundle from `dist/renderer/index.html` even though we're invoked via
// `electron .`, so they don't require a running webpack-dev-server.
const isDev = !app.isPackaged && process.env.CCSM_PROD_BUNDLE !== '1';

// Acquire the single-instance lock + register the second-instance focus
// handler. See electron/lifecycle/singleInstance for the rationale.
acquireSingleInstanceLock();

// Test seam: when CCSM_NOTIFY_TEST_HOOK is set, expose an empty names map +
// pipeline diag flag on globalThis so harness e2e probes can inspect them
// without an extra IPC surface. The map is kept as a placeholder that Wave
// 0c will repopulate from a daemon-sourced name stream; until then it stays
// empty (probes already tolerate missing entries).
const sessionNamesPlaceholder = new Map<string, string>();
installEarlyTestHooks(sessionNamesPlaceholder);

// Install the hidden Edit-role accelerator menu at module load so
// copy/paste etc. work before app.whenReady. Re-run on locale change.
applyAppMenuLocale();

// Window + tray construction live in dedicated SRP modules
// (electron/window/createWindow, electron/tray/createTray). Both take a
// small dependency bag so main.ts retains ownership of the cross-module
// shared state (isQuitting, the badgeController).
let trayController: TrayController | null = null;
let isQuitting = false;
let badgeManager: BadgeManager | null = null;
let notifyPipeline: NotifyPipeline | null = null;
let notifyPipelineDispose: (() => void) | null = null;
const badgeController = new BadgeController(() => badgeManager);

function getTrayBaseImage() {
  return buildTrayIcon();
}

function isMainWindowFocused(): boolean {
  const w = BrowserWindow.getAllWindows()[0];
  return !!(w && !w.isDestroyed() && w.isFocused());
}

function createWindow(): BrowserWindow {
  return createMainWindowFactory({
    isDev,
    // Wave 0b: the v0.2 IPC layer is gone, so main no longer mirrors the
    // renderer's active sid. Wave 0c will source this from the daemon.
    getActiveSid: () => null,
    onFocusChange: (info) => badgeController.onFocusChange(info),
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

// Suppress unused-warning until Wave 0c wires applyTrayLocale into the
// daemon-driven locale stream.
void applyTrayLocale;

app.whenReady().then(() => {
  // On Windows, set a stable AppUserModelID so the OS attributes the app to
  // its taskbar / Start Menu entry instead of generic "electron.exe".
  if (process.platform === 'win32') {
    // Dual-install (#891): the dev variant ships as productName "CCSM Dev"
    // and must use a distinct AUMID so its taskbar / toast attribution
    // doesn't collide with a co-installed prod build.
    const isDevVariant = app.getName().includes('Dev');
    const aumid = isDevVariant ? 'com.ccsm.app.dev' : 'com.ccsm.app';
    app.setAppUserModelId(aumid);
  }

  initDb(app.getPath('userData'));
  installClipboardPermissionHandlers(session.defaultSession);
  // Wave 0e (#247): wire the spec ch08 §3.1 allowlisted IPC surfaces.
  // ORDER MATTERS — the broadcast hooks must be registered BEFORE
  // installUpdater() so the autoUpdater event listeners installed by
  // installUpdater can push status to the renderer via the hooks. The
  // folder-picker handler has no main-side producer side; one
  // `ipcMain.handle` registration is enough.
  registerFolderPickerIpc();
  registerUpdaterIpc();
  setUpdaterBroadcastHooks({
    onStatusChanged: broadcastUpdateStatus,
    onUpdateDownloaded: broadcastUpdateDownloaded,
  });
  installUpdater();

  // Wire prefs cache invalidation to the stateSavedBus. With v0.2 db:save
  // IPC gone (Wave 0b), no producer currently fires the bus — but the
  // subscriptions are cheap and Wave 0c will re-attach a daemon-driven
  // producer, so leaving the wiring live avoids a churn revert later.
  subscribeCrashReportingInvalidation();
  subscribeNotifyEnabledInvalidation();

  // Wire the sessionWatcher singleton's production callbacks. The watcher
  // module-graph stays free of any reverse import to sessionTitles (#690
  // follow-up to #536) — it boots with noop defaults and main.ts injects
  // the real getSessionTitle / flushPendingRename here.
  configureSessionWatcher({
    fetchTitle: getSessionTitle,
    flushRename: flushPendingRename,
  });

  // ─────────────────────── notify pipeline (Phase C, #689) ───────────────
  // BadgeManager is bumped via `onNotified` to update the tray/dock badge.
  // The pipeline + its producer subscriptions (PTY, focus/blur, unwatched)
  // live in electron/notify/bootstrap/installPipeline so main.ts only owns
  // the cross-module fan-out (badge, IPC signal forwarding).
  badgeManager = new BadgeManager({
    getTray: () => getTray(),
    getBaseTrayImage: getTrayBaseImage,
    getWindows: () => BrowserWindow.getAllWindows(),
    // OS-visible taskbar overlay + tray composite suppressed at MVP because
    // the count was incorrect (#667 / chore #534). The internal store keeps
    // running so e2e probes can still verify the notify bridge fires. Flip
    // to true once the count derivation is fixed; no other call sites need
    // to change.
    enabled: false,
  });

  const installed = installNotifyPipelineWithProducers({
    isGlobalMutedFn: () => !loadNotifyEnabled(),
    // Wave 0b: no renderer-pushed name mirror anymore. Wave 0c will swap
    // this out for a daemon-sourced lookup.
    getNameFn: (_sid) => null,
    onNotified: (sid) => {
      badgeManager?.incrementSid(sid);
    },
    // audit #876 H2: drop the sid's unread counter when the session is
    // unwatched (PTY exit / kill). Without this the badgeStore.unread map
    // accumulated entries forever — every notified sid stayed counted for
    // the app lifetime even after the session was deleted.
    onUnwatchedSid: (sid) => {
      badgeManager?.clearSid(sid);
    },
  });
  const pipelineInstance = installed.pipeline;
  // Hoist into the module-level holder so future producers (Wave 0c daemon
  // wire-up) can reach the pipeline.
  notifyPipeline = pipelineInstance;
  // Tear down the pipeline + its app-level listeners on real quit. Without
  // this, the focus/blur + sessionWatcher 'unwatched' subscriptions plus
  // any still-active flash timers leak past the pipeline lifetime — visible
  // in long-running tests / HMR (audit #876 cluster 1.14 + 3.8 / Task #884).
  notifyPipelineDispose = installed.dispose;

  installLateTestHooks({
    getBadgeManager: () => badgeManager,
    pipelineInstance,
  });

  createWindow();
  ensureTray();

  // Touch the badge controller + active-window focus check so the unused
  // bindings don't fail strict typecheck while Wave 0c is pending.
  void isMainWindowFocused;
  void notifyPipeline;
});

registerLifecycleHandlers({
  app,
  getIsQuitting: () => isQuitting,
  setIsQuitting: (v) => {
    isQuitting = v;
  },
  killAllPtySessions,
  closeDb,
  createWindow: () => {
    createWindow();
  },
  getWindowCount: () => BrowserWindow.getAllWindows().length,
  disposeNotifyPipeline: () => notifyPipelineDispose?.(),
});
