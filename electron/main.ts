// Main process entry point. Thin orchestrator: imports + register*Ipc()
// + lifecycle hookups + the cross-cutting glue (notify pipeline, ptyHost,
// sessionWatcher) that doesn't fit any single SRP module.
//
// SRP map (Task #731 / #742 refactor):
//   * electron/prefs/*           — closeAction / crashReporting / notifyEnabled
//                                  / userCwds preference modules.
//   * electron/security/*        — IPC sender + path safety guards.
//   * electron/sentry/*          — crash reporting init + opt-out.
//   * electron/window/*          — BrowserWindow factory + close choreography.
//   * electron/tray/*            — Tray icon + locale-aware menu.
//   * electron/ipc/*             — register*Ipc handlers, one per domain.
//   * electron/lifecycle/*       — applyAppMenuLocale + app.on(...) glue
//                                  + single-instance lock.
//   * electron/notify/bootstrap/ — notify pipeline construction + producer
//                                  subscriptions (PTY, focus/blur, unwatched).
//   * electron/testHooks         — CCSM_NOTIFY_TEST_HOOK-gated probe seams.
//
// What still lives here:
//   * Cross-module shared state (isQuitting, badgeManager, notifyPipeline,
//     activeSidFromRenderer, sessionNamesFromRenderer).
//   * The createWindow / ensureTray thin wrappers that close over that
//     state for the dependency bags.
//   * The `app.whenReady()` body that wires every subsystem together
//     (db init, register*Ipc calls, notify pipeline construction, ptyHost,
//     sessionWatcher, eager scans).

import { app, BrowserWindow, crashReporter, ipcMain, type Tray } from 'electron';
import * as path from 'node:path';
import { initDb, closeDb } from './db';
import { buildTrayIcon } from './branding/icon';
import { initSentry } from './sentry/init';
import { createWindow as createMainWindowFactory } from './window/createWindow';
import { createTray, type TrayController } from './tray/createTray';
import { startCrashCollector } from './crash/collector';
import { resolveCrashRoot } from './crash/incident-dir';
import { wireCrashHandlers } from './main-crash-wiring';

// Phase 1 crash observability (spec §5.1, plan Task 2):
//   * crashReporter.start with empty submitURL + uploadToServer:false enables
//     Electron's native minidump generation into the staging dir without any
//     network upload. The collector adopts dmps from staging into the
//     incident dir on the next recordIncident call.
//   * resolveCrashRoot picks %LOCALAPPDATA%\CCSM\crashes (win32) /
//     ~/Library/Application Support/CCSM/crashes (darwin) /
//     ~/.local/share/CCSM/crashes (linux).
//   * wireCrashHandlers installs uncaughtException + unhandledRejection that
//     route through the collector, replacing the prior console.error-only
//     handlers so every escaped throw leaves a recoverable artifact.
const crashRoot = resolveCrashRoot();
const dmpStaging = path.join(crashRoot, '_dmp-staging');

crashReporter.start({ submitURL: '', uploadToServer: false, compress: true });
app.setPath('crashDumps', dmpStaging);

const crashCollector = startCrashCollector({
  crashRoot,
  dmpStaging,
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron ?? 'unknown',
});

wireCrashHandlers({ collector: crashCollector, processRef: process });

app.on('render-process-gone', (_e, _webContents, details) => {
  crashCollector.recordIncident({
    surface: 'renderer',
    error: { message: `render-process-gone: ${details.reason}`, name: details.reason },
    exitCode: details.exitCode ?? null,
  });
});

app.on('child-process-gone', (_e, details) => {
  crashCollector.recordIncident({
    surface: details.type === 'GPU' ? 'gpu' : 'helper',
    error: { message: `child-process-gone: ${details.type} ${details.reason}`, name: details.reason },
    exitCode: details.exitCode ?? null,
  });
});

// Best-effort retention pruning at boot.
try { crashCollector.pruneRetention({ maxCount: 20, maxAgeDays: 30 }); } catch {}

// Exposed for supervisor wiring (Task 4) and downstream IPC fan-out.
export function emitDaemonCrash(payload: { incidentId: string; exitCode: number | null; signal: string | null; bootNonce?: string; markerPresent: boolean }): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('ccsm:daemon-crash', payload);
  }
}

export { crashCollector };

// Sentry init reads SENTRY_DSN and wires up beforeSend → opt-out check. The
// init is idempotent and a no-op when no DSN is set.
initSentry();

import { installUpdaterIpc } from './updater';
import { registerPtyHostIpc, killAllPtySessions } from './ptyHost';
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
import { registerDbIpc } from './ipc/dbIpc';
import { registerSystemIpc } from './ipc/systemIpc';
import { registerSessionIpc } from './ipc/sessionIpc';
import { registerWindowIpc } from './ipc/windowIpc';
import { registerCrashIncidentsIpc } from './ipc/crashIncidents';
import { subscribeCrashConsentInvalidation } from './prefs/crashConsent';
import {
  registerUtilityIpc,
  primeImportableCache,
} from './ipc/utilityIpc';
import {
  applyAppMenuLocale,
  registerLifecycleHandlers,
} from './lifecycle/appLifecycle';
import { acquireSingleInstanceLock } from './lifecycle/singleInstance';
import { installEarlyTestHooks, installLateTestHooks } from './testHooks';

// `app.isPackaged` is the canonical "are we shipping" signal. The
// `CCSM_PROD_BUNDLE=1` env var lets E2E probes force-load the production
// bundle from `dist/renderer/index.html` even though we're invoked via
// `electron .`, so they don't require a running webpack-dev-server.
const isDev = !app.isPackaged && process.env.CCSM_PROD_BUNDLE !== '1';

// Acquire the single-instance lock + register the second-instance focus
// handler. See electron/lifecycle/singleInstance for the rationale.
acquireSingleInstanceLock();

// Renderer pushes its current `activeId` here over IPC whenever it changes
// (selectSession etc.). Main mirrors it so the notify bridge can suppress
// toasts for the session the user is already looking at without a
// synchronous round-trip to read renderer state.
let activeSidFromRenderer: string | null = null;

// Same pattern as activeSidFromRenderer: the renderer pushes its session-name
// map here so the notify bridge can label toasts with the user-visible name
// (custom rename or SDK auto-summary) instead of the bare sid UUID.
const sessionNamesFromRenderer = new Map<string, string>();

// Test seam: when CCSM_NOTIFY_TEST_HOOK is set, expose the names map +
// pipeline diag flag on globalThis so harness e2e probes can inspect them
// without an extra IPC surface. Off by default; production never reads
// CCSM_NOTIFY_TEST_HOOK. Late-binding seams that depend on the notify
// pipeline are installed inside app.whenReady via installLateTestHooks.
installEarlyTestHooks(sessionNamesFromRenderer);

// Install the hidden Edit-role accelerator menu at module load so
// copy/paste etc. work before app.whenReady. Re-run on locale change.
applyAppMenuLocale();

// Window + tray construction live in dedicated SRP modules
// (electron/window/createWindow, electron/tray/createTray). Both take a
// small dependency bag so main.ts retains ownership of the cross-module
// shared state (isQuitting, the active-sid mirror, the badgeController).
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
    getActiveSid: () => activeSidFromRenderer,
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

  initDb();

  // ─────────────────────────── IPC registration ──────────────────────────
  // Wire prefs cache invalidation to the stateSavedBus BEFORE registering
  // the db:save handler so the very first renderer-driven save (e.g. an
  // auto-persisted setting on first paint) reaches the cache subscribers.
  // See `tech-debt-12-functional-core.md` leak #5 / Task #818.
  subscribeCrashReportingInvalidation();
  subscribeCrashConsentInvalidation();
  subscribeNotifyEnabledInvalidation();
  // Order is significant for systemIpc: it seeds the active i18n language
  // from the OS locale, so any subsequent producer that calls i18n.t()
  // sees the correct active language.
  registerDbIpc({ ipcMain });
  registerSystemIpc({
    ipcMain,
    app,
    applyAppMenuLocale,
    applyTrayLocale,
  });
  registerSessionIpc({
    ipcMain,
    setActiveSid: (sid) => {
      activeSidFromRenderer = sid;
    },
    onActiveSidChanged: (sid) => {
      badgeController.onFocusChange({
        focused: isMainWindowFocused(),
        activeSid: sid,
      });
      // Notify pipeline (Phase C, #689) — keep ctx.activeSid in sync.
      notifyPipeline?.setActiveSid(sid);
    },
    setSessionName: (sid, name) => {
      if (name) sessionNamesFromRenderer.set(sid, name);
      else sessionNamesFromRenderer.delete(sid);
    },
    markUserInput: (sid) => {
      notifyPipeline?.markUserInput(sid);
    },
  });
  registerWindowIpc({ ipcMain });
  registerUtilityIpc({ ipcMain });
  registerCrashIncidentsIpc({ ipcMain });

  installUpdaterIpc();

  // Wire the sessionWatcher singleton's production callbacks. The watcher
  // module-graph stays free of any reverse import to sessionTitles (#690
  // follow-up to #536) — it boots with noop defaults and main.ts injects
  // the real getSessionTitle / flushPendingRename here, before ptyHost
  // (the only production caller of startWatching) is registered.
  configureSessionWatcher({
    fetchTitle: getSessionTitle,
    flushRename: flushPendingRename,
  });

  // Register ptyHost IPC (in-process node-pty path that replaced ttyd).
  // Owns per-session pty lifecycle, attach/detach, snapshot serialization,
  // and the `claude` CLI availability probe (folded in from the deleted
  // cliBridge module — see ptyHost/index.ts pty:checkClaudeAvailable).
  registerPtyHostIpc(
    ipcMain,
    () => BrowserWindow.getAllWindows()[0] ?? null,
  );

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
    getNameFn: (sid) => sessionNamesFromRenderer.get(sid) ?? null,
    onNotified: (sid) => {
      badgeManager?.incrementSid(sid);
    },
    // audit #876 H2: drop the sid's unread counter when the session is
    // unwatched (PTY exit / kill). Without this the badgeStore.unread map
    // accumulated entries forever — every notified sid stayed counted for
    // the app lifetime even after the session was deleted.
    onUnwatchedSid: (sid) => {
      badgeManager?.clearSid(sid);
      // audit #876 Item 5: drop the renderer-pushed name mirror too. Without
      // this, every renamed session leaks its entry forever — the map only
      // grew, never shrank, since the IPC handler is the only producer.
      sessionNamesFromRenderer.delete(sid);
    },
  });
  const pipelineInstance = installed.pipeline;
  // Hoist into the module-level holder so the IPC handlers above (registered
  // earlier in app.whenReady) can reach the pipeline. The handlers run later
  // (on actual IPC dispatch), so the forward reference is safe — they use
  // the optional-chained `notifyPipeline?.` form because the holder is null
  // until this assignment lands.
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

  // Eager-load CLI transcripts so ImportDialog has data the moment the user
  // opens it. Fire-and-forget; primeImportableCache logs its own errors and
  // stores [] on failure so the dialog gracefully degrades.
  primeImportableCache();
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
