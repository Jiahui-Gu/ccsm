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

import { app, BrowserWindow, ipcMain, type Tray } from 'electron';
import { initDb, closeDb } from './db';
import { buildTrayIcon } from './branding/icon';
import { initSentry } from './sentry/init';
import { initLog, log, normalizeError, syncPersistedLevelFromDb } from './shared/log';
import { createWindow as createMainWindowFactory } from './window/createWindow';
import { installContextMenuSuppressIpc } from './window/contextMenu';
import { createTray, type TrayController } from './tray/createTray';

// Initialize structured logger before anything else. Idempotent; safe to
// call pre-`app.whenReady` because the file path is resolved lazily on the
// first write (electron-log's `transports.file.resolvePathFn`).
initLog();

// safety net — escaped main-proc rejections kill app on Node 20+ default
// (audit tech-debt-03-errors.md risk #2). Registered BEFORE app.whenReady so
// any throw during bootstrap (initSentry, IPC registration, db open) lands
// in the logger instead of silently terminating the process. We deliberately
// do NOT call app.exit() — preserves current default-throw behavior in tests
// and mirrors the renderer's "log + degrade" stance.
//
// We ALSO mirror the full reason + stack to stderr directly. The structured
// `log.error` call routes through electron-log's console transport, which
// formats records as `[level] [tag] msg` and elides the structured `fields`
// object — so a real crash showed up in `npm run dev` as a single useless
// line `[error] [main] unhandledRejection` with no error message, no stack,
// and no clue what code path threw. Direct console.error keeps the file sink
// + Sentry pipeline intact while giving the dev terminal the actual stack so
// the next regression is debuggable in one pass instead of requiring a
// diagnostic shim to be added by the engineer chasing the bug.
process.on('unhandledRejection', (reason, _promise) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[main] unhandledRejection:', err);
  log.error('main', 'unhandledRejection', { error: normalizeError(err) });
});
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
  log.error('main', 'uncaughtException', { error: normalizeError(err) });
});

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
import { subscribeScrollbackInvalidation } from './prefs/scrollback';
import { subscribeVoiceTierInvalidation } from './prefs/voiceTier';
import { BadgeController } from './badgeController';
import { registerDbIpc } from './ipc/dbIpc';
import { registerSystemIpc } from './ipc/systemIpc';
import { registerSessionIpc } from './ipc/sessionIpc';
import { registerWindowIpc } from './ipc/windowIpc';
import { registerVoiceIpc } from './ipc/voiceIpc';
import { warmUpTranscriber } from './voice/warmup';
import { startMobileRemoteServer } from './remote/mobileRemoteServer';
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

// npm-run-dev (scripts/dev-electron.mjs) sets CCSM_DEV=1. Override
// app.getName() so Windows tasklist / Alt-Tab / Task Manager all surface
// "CCSM (dev)" instead of bare "CCSM" — without this the dev process
// and a co-running installed CCSM.exe are visually indistinguishable,
// and accidental `taskkill /IM CCSM.exe` kills the user's working
// session. Must run BEFORE app.whenReady() so any `app.getPath()` /
// userData / logs / sessionData derived from app name resolve to the
// renamed dir from the very first call. The packaged-dev variant
// (productName "CCSM Dev") already gets a distinct name from
// electron-builder; this branch covers the unpackaged dev case.
if (process.env.CCSM_DEV === '1' && !app.getName().includes('Dev')) {
  app.setName('CCSM (dev)');
}

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
let mobileRemoteServer: { close: () => void } | null = null;
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
    ipcMain,
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
    // doesn't collide with a co-installed prod build. The unpackaged
    // npm-run-dev case (CCSM_DEV=1) also gets its own AUMID so the
    // taskbar groups dev and prod separately.
    const isDevVariant = app.getName().includes('Dev') || app.getName().includes('(dev)');
    const aumid = isDevVariant ? 'com.ccsm.app.dev' : 'com.ccsm.app';
    app.setAppUserModelId(aumid);
  }

  initDb();

  // initLog() ran at module-load (before app.whenReady) when db wasn't yet
  // open, so it could only see `CCSM_LOG_LEVEL` or the `info` default. Now
  // that the db is up, re-read the persisted choice and (if it differs)
  // apply + rebuild the menu so Help → Set Log Level shows the correct
  // radio checkmark on first paint. Cold review finding #3c / #9.
  if (syncPersistedLevelFromDb()) {
    applyAppMenuLocale();
  }

  // ─────────────────────────── IPC registration ──────────────────────────
  // Wire prefs cache invalidation to the stateSavedBus BEFORE registering
  // the db:save handler so the very first renderer-driven save (e.g. an
  // auto-persisted setting on first paint) reaches the cache subscribers.
  // See `tech-debt-12-functional-core.md` leak #5 / Task #818.
  subscribeCrashReportingInvalidation();
  subscribeNotifyEnabledInvalidation();
  subscribeScrollbackInvalidation();
  subscribeVoiceTierInvalidation();
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
  registerVoiceIpc({ ipcMain });

  // Best-effort: warm the whisper exe/DLLs/model into the OS page cache a few
  // seconds after launch so the user's first voice transcription isn't slowed
  // by a cold disk read. Delayed so it doesn't compete with window paint / DB /
  // IPC setup for I/O during the startup-critical window. Fire-and-forget.
  setTimeout(() => {
    void warmUpTranscriber();
  }, 3000);

  // Process-wide IPC for the terminal pane's `onContextMenu` handler to
  // ask main to skip the native context menu for one upcoming click.
  // Registered here (alongside the other IPC handlers) rather than in
  // `createWindow` because the channel is window-agnostic — see
  // `installContextMenuSuppressIpc` in electron/window/createWindow.ts.
  installContextMenuSuppressIpc(ipcMain);

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

  mobileRemoteServer = startMobileRemoteServer();

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
  disposeNotifyPipeline: () => {
    // Each disposer is wrapped in its own try/catch so a throw from one
    // (e.g. mobileRemoteServer.close() on an already-closed server) does
    // NOT skip the rest. The original audit #876 cluster 1.14 fix
    // (notifyPipelineDispose) depends on running unconditionally — without
    // isolation a node fs error in the http close path would silently
    // resurrect the focus/blur + sessionWatcher 'unwatched' leak past
    // quit. Order is preserved: server close before clearing the handle
    // before pipeline disposal.
    try {
      mobileRemoteServer?.close();
    } catch (err) {
      console.warn('[main] disposer mobileRemoteServer.close threw', err);
    }
    try {
      mobileRemoteServer = null;
    } catch (err) {
      console.warn('[main] disposer clear mobileRemoteServer threw', err);
    }
    try {
      notifyPipelineDispose?.();
    } catch (err) {
      console.warn('[main] disposer notifyPipelineDispose threw', err);
    }
  },
});
