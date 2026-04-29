import { app, BrowserWindow, Menu, dialog, ipcMain, shell, type Tray } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  initDb,
  loadState,
  saveState,
  closeDb,
} from './db';
import { validateSaveStateInput } from './db-validate';
import { buildTrayIcon } from './branding/icon';
import { initSentry } from './sentry/init';
import { createWindow as createMainWindowFactory } from './window/createWindow';
import { createTray, type TrayController } from './tray/createTray';
import {
  CRASH_OPT_OUT_KEY,
  invalidateCrashReportingCache,
} from './prefs/crashReporting';

// Sentry init reads SENTRY_DSN and wires up beforeSend → opt-out check. The
// init is idempotent and a no-op when no DSN is set.
initSentry();
import { installUpdaterIpc } from './updater';
import {
  scanImportableSessions,
  type ScannableSession,
} from './import-scanner';
import { listModelsFromSettings, readDefaultModelFromSettings } from './agent/list-models-from-settings';
import { registerPtyHostIpc, killAllPtySessions, onPtyData } from './ptyHost';
import { sessionWatcher, configureSessionWatcher } from './sessionWatcher';
import { installNotifyPipeline } from './notify/sinks/pipeline';
import { BadgeManager } from './notify/badge';
import {
  getSessionTitle,
  renameSessionTitle,
  listProjectSummaries,
  enqueuePendingRename,
  flushPendingRename,
} from './sessionTitles';
import { getUserCwds, pushUserCwd } from './prefs/userCwds';
import {
  NOTIFY_ENABLED_KEY,
  loadNotifyEnabled,
  invalidateNotifyEnabledCache,
} from './prefs/notifyEnabled';
import { isSafePath, resolveCwd, fromMainFrame } from './security/ipcGuards';
import { BadgeController } from './badgeController';

// `app.isPackaged` is the canonical "are we shipping" signal. The
// `CCSM_PROD_BUNDLE=1` env var lets E2E probes force-load the production
// bundle from `dist/renderer/index.html` even though we're invoked via
// `electron .`, so they don't require a running webpack-dev-server.
const isDev = !app.isPackaged && process.env.CCSM_PROD_BUNDLE !== '1';

// Single-instance lock — the actual zombie-source plug. The custom title-bar
// "X" button hides the window into the tray (intentional, see win.on('close')
// below); subsequent double-clicks of the desktop icon would otherwise spawn
// a brand-new main process every time, leaving the prior one alive and
// hidden. Calling this at module load (before app.whenReady) ensures the
// second instance bails out before it can build any window.
//
// Skipped under E2E so probe runs that spawn the app multiple times in
// parallel (each with their own CCSM_TMP_HOME / CLAUDE_CONFIG_DIR) don't
// collide on the global lock and exit unexpectedly.
const skipSingleInstanceLock =
  process.env.CCSM_E2E_HIDDEN === '1' || process.env.CCSM_E2E_NO_SINGLE_INSTANCE === '1';
if (!skipSingleInstanceLock) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    process.exit(0);
  }
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      if (!w.isVisible()) w.show();
      w.focus();
    }
  });
}

// Close-button preference is owned by `./prefs/closeAction` (parser, getter,
// setter). The choice is read inside win.on('close') below; the IPC db:save
// handler above does not need a cache invalidation hook because closeAction
// goes through setCloseAction directly.

// Notification mute preference is owned by `./prefs/notifyEnabled`. The
// db:save handler invalidates the cache when the renderer writes the key so
// the Settings toggle takes effect without a restart.

// Renderer pushes its current `activeId` here over IPC whenever it changes
// (selectSession etc.). Main mirrors it so the notify bridge can suppress
// toasts for the session the user is already looking at without a
// synchronous round-trip to read renderer state.
let activeSidFromRenderer: string | null = null;

// Same pattern as activeSidFromRenderer: the renderer pushes its session-name
// map here so the notify bridge can label toasts with the user-visible name
// (custom rename or SDK auto-summary) instead of the bare sid UUID. Keeping
// this in main avoids a synchronous IPC round-trip from the notify event
// path; the renderer keeps it warm by sending 'session:setName' on every
// rename / external-title update / new-session creation.
const sessionNamesFromRenderer = new Map<string, string>();

// Test seam: when CCSM_NOTIFY_TEST_HOOK is set, expose the names map on
// globalThis so harness e2e probes can inspect it without an extra IPC
// surface. Off by default; production never reads CCSM_NOTIFY_TEST_HOOK.
if (process.env.CCSM_NOTIFY_TEST_HOOK) {
  (globalThis as unknown as { __ccsmSessionNamesFromRenderer?: Map<string, string> }).__ccsmSessionNamesFromRenderer = sessionNamesFromRenderer;
}


//
// The CLI transcripts under ~/.claude/projects can run into hundreds of
// files; the head-parse is fast per file but the cumulative latency makes
// the ImportDialog's "Scanning…" state visible for several seconds on cold
// open. We kick off the scan eagerly at app `ready` and serve cached
// results to renderers, refreshing in the background on each request so
// newly-recorded sessions show up without a manual reload.
//
// `recentCwds` is now derived from the ccsm-owned user-cwds list (see
// `app:userCwds:get`/`app:userCwds:push` below), NOT from CLI JSONL scans —
// the user's CLI history is *not* their ccsm working-set. Default cwd is
// always `os.homedir()`; the recent list grows only when the user explicitly
// picks a non-default cwd inside ccsm.
let importableCache: ScannableSession[] = [];
let importablePending: Promise<ScannableSession[]> | null = null;

function refreshImportableCache(): Promise<ScannableSession[]> {
  if (importablePending) return importablePending;
  importablePending = scanImportableSessions()
    .then((rows) => {
      importableCache = rows;
      return rows;
    })
    .catch((err) => {
      console.warn('[main] scanImportableSessions failed', err);
      return importableCache;
    })
    .finally(() => {
      importablePending = null;
    }) as Promise<ScannableSession[]>;
  return importablePending;
}

async function getImportableSessions(): Promise<ScannableSession[]> {
  // If we have a hot cache, serve it instantly and refresh in the background
  // so the next call sees fresher data. On cold cache (eager-load not done
  // yet) await the in-flight (or new) scan so the renderer never gets [].
  if (importableCache.length > 0) {
    void refreshImportableCache();
    return importableCache;
  }
  return refreshImportableCache();
}

// User-owned cwd LRU is owned by `./prefs/userCwds`. The IPC handlers
// `app:userCwds:get` / `app:userCwds:push` / `import:recentCwds` below call
// `getUserCwds()` / `pushUserCwd()` directly — see that module for the
// LRU/dedupe/cap rules and the home-fallback contract.

// We don't want a visible File/Edit/View menu bar — CCSM is a single-
// window tool and those menus add noise. But on Windows/Linux, setting the
// app menu to null also removes the built-in Edit-role accelerators
// (Ctrl+C / Ctrl+V / Ctrl+X / Ctrl+A / Ctrl+Z), which makes chat content
// feel "not copyable". Install a minimal, hidden app menu whose only job
// is to carry those accelerators, and hide the menu bar so it's not
// visible. On macOS, the default app menu already handles this.
//
// Wrapped in a function so language switches via `ccsm:set-language` can
// rebuild the menu with the localized "Edit" label (mirrors the
// `applyTrayLocale()` pattern below). The submenu items use Electron
// `role`s and are localized by the OS automatically.
function applyAppMenuLocale() {
  // Local require keeps the import graph linear (see the longer comment
  // near the `ccsm:set-language` handler below).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const i18n = require('./i18n') as typeof import('./i18n');
  const accelMenu = Menu.buildFromTemplate([
    {
      label: i18n.tMenu('edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ]);
  Menu.setApplicationMenu(accelMenu);
}
applyAppMenuLocale();

// Window + tray construction live in dedicated SRP modules:
//   * `./window/createWindow`  — BrowserWindow factory + close/focus/maximize
//                                event wiring + context menu install.
//   * `./tray/createTray`      — Tray icon, click handlers, locale-aware menu.
//
// Both take a small dependency bag so main.ts retains ownership of the
// cross-module shared state (`isQuitting`, the active-sid mirror, the
// badgeController). The thin wrappers below close over those module-level
// `let`s so the call sites elsewhere in this file (`app.activate`,
// `ccsm:set-language`, etc.) remain a single zero-arg call.

let trayController: TrayController | null = null;
let isQuitting = false;
let badgeManager: BadgeManager | null = null;
let notifyPipeline: ReturnType<typeof installNotifyPipeline> | null = null;
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
    app.setAppUserModelId('com.ccsm.app');
  }

  initDb();

  ipcMain.handle('db:load', (_e, key: string) => loadState(key));
  // Cap renderer-supplied state values. Mirrors the per-block cap in
  // db:saveMessages but tighter (1 MB vs 1 MB-per-block × N blocks): a
  // single app_state row holds drafts/persist snapshots that should never
  // approach this size — if one does, it's a bug in the persister and we
  // refuse to commit it rather than silently growing the WAL. Validation
  // logic lives in `./db-validate` so it's unit-testable without IPC.
  ipcMain.handle(
    'db:save',
    (
      e,
      key: string,
      value: string
    ): { ok: true } | { ok: false; error: string } => {
      if (!fromMainFrame(e)) return { ok: false, error: 'rejected' };
      const v = validateSaveStateInput(key, value);
      if (!v.ok) {
        if (v.error === 'value_too_large') {
          console.warn(
            `[main] db:save rejecting oversized value (${(value as string).length} bytes) for key=${key}`
          );
        }
        return v;
      }
      saveState(key, value);
      // Invalidate Sentry's cached opt-out so the toggle in Settings takes
      // effect on the next error without an app restart.
      if (key === CRASH_OPT_OUT_KEY) {
        invalidateCrashReportingCache();
      }
      // Same idea for the notification mute toggle — invalidate so the next
      // sessionWatcher event reads the fresh value.
      if (key === NOTIFY_ENABLED_KEY) {
        invalidateNotifyEnabledCache();
      }
      return { ok: true };
    }
  );
  // Session message history is no longer persisted by ccsm — the CLI writes
  // every frame to `~/.claude/projects/<key>/<sid>.jsonl`. Previous
  // `db:loadMessages` / `db:saveMessages` IPC + SQLite `messages` table were
  // a redundant secondary copy.

  // i18n: renderer mirrors the resolved UI language to main so OS
  // notifications use it. Renderer also asks main for the OS locale at
  // boot to seed the "system" preference. Imports at the top of the file
  // would create a circular ts-tree edge with electron/i18n.ts; doing the
  // require here keeps the import graph linear.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const i18n = require('./i18n') as typeof import('./i18n');
  ipcMain.handle('ccsm:get-system-locale', () => {
    try {
      return app.getLocale();
    } catch {
      return undefined;
    }
  });
  ipcMain.on('ccsm:set-language', (_e, lang: unknown) => {
    if (lang === 'en' || lang === 'zh') {
      i18n.setMainLanguage(lang);
      // Tray menu / tooltip + app accelerator menu are built once on app
      // ready; rebuild both so a language switch from Settings is reflected
      // immediately (Edit label, tray show/quit, tooltip).
      applyTrayLocale();
      applyAppMenuLocale();
    }
  });
  // Seed the active language from the OS at boot, before any window is
  // created — first notification fires with the right copy even if the
  // renderer hasn't dispatched yet.
  try {
    i18n.setMainLanguage(i18n.resolveSystemLanguage(app.getLocale()));
    // Rebuild the app menu now that the seed has flipped the active
    // language; otherwise the top-level `applyAppMenuLocale()` call left
    // it stuck on English.
    applyAppMenuLocale();
  } catch {
    /* ignore — falls through to the default 'en' */
  }

  // Connection + models IPC. Single source of truth = ~/.claude/settings.json
  // (+ ANTHROPIC_* env vars). Users edit via `claude /config` or by hand;
  // CCSM does not let them edit the connection here.
  ipcMain.handle('connection:read', () => {
    const env = process.env;
    let settingsModel: string | null = null;
    let settingsBaseUrl: string | null = null;
    let settingsAuthToken = false;
    try {
      const file = path.join(os.homedir(), '.claude', 'settings.json');
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as { model?: unknown; env?: Record<string, unknown> };
      if (typeof parsed.model === 'string') settingsModel = parsed.model;
      const sEnv = parsed.env && typeof parsed.env === 'object' ? parsed.env : null;
      if (sEnv) {
        if (typeof sEnv.ANTHROPIC_BASE_URL === 'string') settingsBaseUrl = sEnv.ANTHROPIC_BASE_URL;
        if (typeof sEnv.ANTHROPIC_AUTH_TOKEN === 'string' || typeof sEnv.ANTHROPIC_API_KEY === 'string') {
          settingsAuthToken = true;
        }
      }
    } catch {
      // Missing / malformed — fall through to env-only view.
    }
    const baseUrl = settingsBaseUrl ?? env.ANTHROPIC_BASE_URL ?? null;
    const model = settingsModel ?? env.ANTHROPIC_MODEL ?? null;
    const hasAuthToken =
      settingsAuthToken ||
      !!env.ANTHROPIC_AUTH_TOKEN?.trim() ||
      !!env.ANTHROPIC_API_KEY?.trim();
    return { baseUrl, model, hasAuthToken };
  });
  ipcMain.handle('connection:openSettingsFile', async (e) => {
    if (!fromMainFrame(e)) return { ok: false, error: 'rejected' };
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    // shell.openPath returns '' on success, error string on failure. If the
    // file does not exist, create an empty stub so the editor opens cleanly.
    if (!fs.existsSync(file)) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{}\n', 'utf8');
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const result = await shell.openPath(file);
    return result === '' ? { ok: true } : { ok: false, error: result };
  });
  ipcMain.handle('models:list', async () => {
    const res = await listModelsFromSettings();
    return res.models;
  });
  ipcMain.handle('app:getVersion', () => app.getVersion());

  // ─────────────────────── sessionTitles bridge ──────────────────────────
  // Thin wrapper around the SDK's getSessionInfo / renameSession /
  // listSessions, with per-sid serialization, 2s TTL cache, and error
  // normalization living in `./sessionTitles`. Renderer accesses via
  // `window.ccsmSessionTitles.{get,rename,listForProject}`.
  ipcMain.handle('sessionTitles:get', (_e, sid: string, dir?: string) =>
    getSessionTitle(sid, dir)
  );
  ipcMain.handle(
    'sessionTitles:rename',
    (_e, sid: string, title: string, dir?: string) =>
      renameSessionTitle(sid, title, dir)
  );
  ipcMain.handle('sessionTitles:listForProject', (_e, projectKey: string) =>
    listProjectSummaries(projectKey)
  );
  // Pending-rename queue. Renderer enqueues when SDK reports `no_jsonl`
  // (rename happened before the first message flushed the JSONL file). PR3's
  // sessionWatcher is the only production caller of `flushPending` — it
  // fires when the watcher first sees the JSONL appear. Exposed here so the
  // renderer's store action can reach the in-memory queue that lives in
  // `electron/sessionTitles`.
  ipcMain.handle(
    'sessionTitles:enqueuePending',
    (_e, sid: string, title: string, dir?: string) => {
      enqueuePendingRename(sid, title, dir);
    }
  );
  ipcMain.handle('sessionTitles:flushPending', (_e, sid: string) =>
    flushPendingRename(sid)
  );

  ipcMain.handle('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });
  ipcMain.handle('window:toggleMaximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  ipcMain.handle('window:isMaximized', (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false;
  });

  ipcMain.handle('import:scan', () => getImportableSessions());
  // Recent cwd list shown in the StatusBar cwd popover. Sourced from the
  // ccsm-owned LRU (NOT from CLI JSONL scans). Always includes home as a
  // fallback so the list is never empty.
  ipcMain.handle('import:recentCwds', () => getUserCwds());
  ipcMain.handle('app:userCwds:get', () => getUserCwds());
  ipcMain.handle('app:userCwds:push', (e, p: unknown) => {
    if (!fromMainFrame(e)) return getUserCwds();
    if (typeof p !== 'string') return getUserCwds();
    return pushUserCwd(p);
  });
  ipcMain.handle('app:userHome', () => os.homedir());
  // OS folder picker for the cwd popover's "Browse..." button. Returns the
  // chosen absolute path on success, or null when the user cancelled or no
  // window is available. Anchored on the requesting BrowserWindow so the
  // dialog is modal to the right surface (relevant when devtools are popped
  // out into their own window). Bug #628: prior to this handler the Browse
  // button was a no-op (just closed the popover) and users picking a cwd
  // via Browse silently fell through to the LRU/home default — matching
  // the dogfood report "在特定目录创建session，创建出来的session仍然在home目录".
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
  // The new-session default model comes straight from the user's CLI
  // settings.json — same source the CLI itself reads for `--model`. Replaces
  // the old `import:topModel` frequency-vote IPC (PR #369), which produced
  // model ids that weren't always in the picker list.
  ipcMain.handle('settings:defaultModel', async () => {
    try {
      return await readDefaultModelFromSettings();
    } catch {
      return null;
    }
  });
  ipcMain.handle(
    'paths:exist',
    // Batched best-effort existence probe for arbitrary filesystem paths.
    // The renderer uses this on hydration to flag sessions whose persisted
    // `cwd` was deleted between runs (typical worktree-cleanup victim — see
    // PR #104). Returned map is keyed by the input path; missing paths and
    // permission errors both map to `false` (we don't surface the distinction
    // — for the migration's purpose they're equivalent: don't auto-spawn).
    (_e, inputPaths: unknown) => {
    const list = Array.isArray(inputPaths)
      ? inputPaths.filter((p): p is string => typeof p === 'string')
      : [];
    const out: Record<string, boolean> = {};
    for (const p of list) {
      // Reject UNC + non-absolute paths BEFORE touching fs. On Windows,
      // `fs.existsSync('\\\\server\\share\\probe')` triggers an SMB lookup
      // and leaks the user's NTLM hash to the named host. We map any unsafe
      // path to `false` so the renderer's hydration migration treats it as
      // "missing cwd" — exactly the desired behaviour. resolveCwd is still
      // applied so `~`-prefixed cwds are expanded before the safety check.
      try {
        const resolved = resolveCwd(p);
        if (!isSafePath(resolved)) {
          out[p] = false;
          continue;
        }
        out[p] = fs.existsSync(resolved);
      } catch {
        out[p] = false;
      }
    }
    return out;
    }
  );

  // ─────────────────────── disk-based slash commands ──────────────────────
  //
  // commands:list / files:list / shell:openExternal handlers were removed in
  // PR-B (dead code sweep) — the renderer no longer consumes them. The
  // commands-loader module is still imported by tests and may be re-wired
  // when the picker is reinstated; the file walk in `files:list` would need
  // re-derivation if/when the @file mention picker comes back.

  // ─────────── CLI wizard IPC removed (PR-I) ───────────
  // The first-run "find your claude binary" UI was deleted because CCSM
  // now ships the Claude binary inside the installer (PR-B). All
  // `cli:getInstallHints` / `cli:browseBinary` / `cli:setBinaryPath` /
  // `cli:openDocs` / `cli:retryDetect` handlers were removed — when the
  // SDK throws `ClaudeNotFoundError` the renderer surfaces the
  // installer-corrupt banner via the `CLAUDE_NOT_FOUND` errorCode that
  // `electron/agent/manager.ts` still emits.

  // Memory (CLAUDE.md) editor IPC removed in PR-B (dead code sweep) — no
  // renderer caller. The `electron/memory` module is still kept for its
  // unit tests and may be re-wired when a memory editor UI returns.

  // notification:show / notify:availability / notify:setRuntimeState handlers
  // and the entire electron/notify* subsystem were removed in the cleanup PR
  // that retired the dead notify code. The renderer never had a production
  // caller for `dispatchNotification`; under the new ttyd architecture the
  // event source has shifted, so the next notification implementation will
  // start fresh rather than retro-fitting the old toast pipeline.

  installUpdaterIpc();

  // Wire the sessionWatcher singleton's production callbacks. The watcher
  // module-graph stays free of any reverse import to sessionTitles (#690
  // follow-up to #536) — it boots with noop defaults and main.ts injects
  // the real `getSessionTitle` / `flushPendingRename` here, before
  // ptyHost (which is the only production caller of startWatching) is
  // registered.
  configureSessionWatcher({
    fetchTitle: getSessionTitle,
    flushRename: flushPendingRename,
  });

  // Register ptyHost IPC (in-process node-pty path that replaced ttyd).
  // Owns per-session pty lifecycle, attach/detach, snapshot serialization,
  // and the `claude` CLI availability probe (folded in from the deleted
  // cliBridge module — see ptyHost/index.ts pty:checkClaudeAvailable).
  registerPtyHostIpc(ipcMain, () => BrowserWindow.getAllWindows()[0] ?? null);

  // Renderer mirrors its active session id here so the notify bridge can
  // suppress toasts for the session the user is currently viewing. Plain
  // `ipcMain.on` (no reply); the renderer fires this on every selectSession.
  ipcMain.on('session:setActive', (e, sid: unknown) => {
    if (!fromMainFrame(e)) return;
    activeSidFromRenderer = typeof sid === 'string' && sid.length > 0 ? sid : null;
    badgeController.onFocusChange({ focused: isMainWindowFocused(), activeSid: activeSidFromRenderer });
    // Notify pipeline (Phase C, #689) — keep ctx.activeSid in sync. Do NOT
    // count a sidebar switch as user input: clicking a session in the
    // sidebar is a navigation gesture, not user-typed input, and feeding
    // it into Rule 1 would mute legitimate idle/waiting toasts for 60s
    // every time the user merely opens the session (#715). Real user
    // input is signalled separately via the `notify:userInput` IPC
    // (PTY input + send-message + new/import/resume).
    notifyPipeline?.setActiveSid(activeSidFromRenderer);
  });

  // Explicit "user touched this session" IPC — fired by the renderer on
  // new-session create / import / resume, in addition to the implicit
  // setActive trigger above. Decouples Rule 1's intent (the user just
  // initiated this session) from the active-sid bookkeeping (which can
  // happen for non-user-driven reasons, e.g. activate-on-toast-click).
  ipcMain.on('notify:userInput', (e, sid: unknown) => {
    if (!fromMainFrame(e)) return;
    if (typeof sid !== 'string' || sid.length === 0) return;
    notifyPipeline?.markUserInput(sid);
  });

  // Renderer pushes the user-visible name for a sid so notify toasts can
  // show "my-feature-branch" instead of the UUID. Empty/missing name clears
  // the entry (renderer signals "no longer have a name"). Same security
  // posture as session:setActive — main-frame only.
  ipcMain.on('session:setName', (e, payload: unknown) => {
    if (!fromMainFrame(e)) return;
    if (!payload || typeof payload !== 'object') return;
    const { sid, name } = payload as { sid?: unknown; name?: unknown };
    if (typeof sid !== 'string' || sid.length === 0) return;
    if (typeof name === 'string' && name.length > 0) {
      sessionNamesFromRenderer.set(sid, name);
    } else {
      sessionNamesFromRenderer.delete(sid);
    }
  });

  // ─────────────────────── notify pipeline (Phase C, #689) ───────────────────
  //
  // Single toast producer. Architecture:
  //   producer  : ptyHost.onData → OscTitleSniffer (#688)
  //   decider   : notifyDecider.decide(event, ctx) (#687)
  //   sinks     : toastSink (Electron Notification) + flashSink (renderer push)
  //
  // BadgeManager is bumped via `onNotified` to update the tray/dock badge.
  badgeManager = new BadgeManager({
    getTray: () => getTray(),
    getBaseTrayImage: getTrayBaseImage,
    getWindows: () => BrowserWindow.getAllWindows(),
  });

  // Notify pipeline diag counters are gated behind `globalThis.__ccsmDebug`
  // (#713). Production never carries them; e2e probes that consume diag via
  // the test-hook seam need them on. Set the flag here so it's live before
  // installNotifyPipeline reads it.
  if (process.env.CCSM_NOTIFY_TEST_HOOK) {
    (globalThis as unknown as Record<string, unknown>).__ccsmDebug = true;
  }

  const pipelineInstance = installNotifyPipeline({
    getMainWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    isGlobalMutedFn: () => !loadNotifyEnabled(),
    getNameFn: (sid) => sessionNamesFromRenderer.get(sid) ?? null,
    onNotified: (sid) => {
      badgeManager?.incrementSid(sid);
    },
  });
  // Hoist into the module-level holder so the IPC handlers above (registered
  // earlier in app.whenReady) can reach the pipeline. The handlers run later
  // (on actual IPC dispatch), so the forward reference is safe — they use
  // the optional-chained `notifyPipeline?.` form because the holder is null
  // until this assignment lands.
  notifyPipeline = pipelineInstance;

  // Wire OSC sniffer producer: every PTY chunk feeds the sniffer.
  onPtyData((sid, chunk) => {
    pipelineInstance.feedChunk(sid, chunk);
  });

  // Focus/blur producer: the decider needs `ctx.focused` to differentiate
  // foreground (Rules 2/3/4) from background (Rule 5). Subscribe at the app
  // level so we cover both windows being created later and existing ones.
  app.on('browser-window-focus', () => {
    pipelineInstance.setFocused(true);
  });
  app.on('browser-window-blur', () => {
    // browser-window-blur fires per-window. With only one BrowserWindow this
    // is equivalent to "ccsm is no longer focused"; if multi-window lands
    // we'd need to count instead. Until then, treat blur as defocus.
    const anyFocused = BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isFocused(),
    );
    pipelineInstance.setFocused(anyFocused);
  });

  // Drop sniffer/ctx state when a session is unwatched (PTY exit). The
  // existing 'unwatched' emitter is reused so we don't add another teardown
  // path.
  sessionWatcher.on('unwatched', (evt: { sid?: unknown }) => {
    if (!evt || typeof evt.sid !== 'string' || evt.sid.length === 0) return;
    pipelineInstance.forgetSid(evt.sid);
  });

  if (process.env.CCSM_NOTIFY_TEST_HOOK) {
    (globalThis as unknown as Record<string, unknown>).__ccsmNotifyPipeline = {
      // Test seam — assert on internal Ctx shape from probes that need to
      // verify rule firing (not just the final toast/flash output).
      ctx: () => {
        const i = pipelineInstance._internals();
        return {
          focused: i.ctx.focused,
          activeSid: i.ctx.activeSid,
          lastUserInputTs: Object.fromEntries(i.ctx.lastUserInputTs),
          runStartTs: Object.fromEntries(i.ctx.runStartTs),
          mutedSids: Array.from(i.ctx.mutedSids),
          lastFiredTs: Object.fromEntries(i.ctx.lastFiredTs),
          diag: i.diag,
        };
      },
      markUserInput: (sid: string) => pipelineInstance.markUserInput(sid),
    };
  }

  // Legacy `installNotifyBridge` + `titleStateBridge` were removed in #718.
  // The Phase A/B/C pipeline above is the single toast producer; sidebar
  // status flows through the separate `sessionWatcher`-driven channel.

  if (process.env.CCSM_NOTIFY_TEST_HOOK) {
    (globalThis as unknown as Record<string, unknown>).__ccsmBadgeDebug = {
      getTotal: () => badgeManager?.getTotal() ?? 0,
      clearAll: () => badgeManager?.clearAll(),
    };
  }

  // Dev-only `globalThis.__ccsmDebug` backdoor was removed alongside the
  // notify subsystem cleanup — its only members exposed the dead notify /
  // notify-bootstrap modules. Re-add a fresh seam if a future probe needs
  // main-process internals via `app.evaluate`.
  if (process.env.CCSM_NOTIFY_TEST_HOOK) {
    // E2E diagnostic seam — only when the notify test-hook env is set, so
    // production never carries this. Lets the harness inspect watcher state
    // and JSONL paths via electronApp.evaluate without needing access to
    // main's CommonJS `require` (Playwright's evaluate runs in a Function
    // wrapper where `require` isn't in scope).
    (globalThis as unknown as Record<string, unknown>).__ccsmTestDebug = {
      getLastEmittedForSid: (sid: string) =>
        sessionWatcher.getLastEmittedForTest(sid),
      env: () => ({
        CCSM_CLAUDE_CONFIG_DIR: process.env.CCSM_CLAUDE_CONFIG_DIR ?? null,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
        HOME: process.env.HOME ?? null,
        USERPROFILE: process.env.USERPROFILE ?? null,
      }),
      jsonl: () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = require('node:fs');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const path = require('node:path');
          const root =
            process.env.CCSM_CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR;
          const projDir = root ? path.join(root, 'projects') : null;
          if (!projDir || !fs.existsSync(projDir))
            return { projDir, exists: false };
          const projects = fs.readdirSync(projDir);
          return projects.map((p: string) => {
            const dir = path.join(projDir, p);
            try {
              const files = fs.readdirSync(dir).map((f: string) => {
                const fp = path.join(dir, f);
                let size = -1;
                let tail = '';
                try {
                  size = fs.statSync(fp).size;
                  if (size > 0 && f.endsWith('.jsonl')) {
                    const buf = Buffer.alloc(Math.min(size, 4000));
                    const fd = fs.openSync(fp, 'r');
                    try {
                      fs.readSync(
                        fd,
                        buf,
                        0,
                        buf.length,
                        Math.max(0, size - buf.length),
                      );
                      tail = buf.toString('utf8');
                    } finally {
                      fs.closeSync(fd);
                    }
                  }
                } catch {
                  /* */
                }
                return { f, size, tail };
              });
              return { project: p, files };
            } catch (e) {
              return { project: p, err: String(e) };
            }
          });
        } catch (e) {
          return `err: ${String(e)}`;
        }
      },
    };
  }

  createWindow();
  ensureTray();

  // Eager-load CLI transcripts so ImportDialog has data the moment the user
  // opens it. Fire-and-forget; refreshImportableCache logs its own errors and
  // stores [] on failure so the dialog gracefully degrades.
  void refreshImportableCache();
});

app.on('before-quit', () => {
  isQuitting = true;
  // Reap any live node-pty children spawned through ptyHost. Idempotent;
  // critical on Windows where conpty can otherwise leak the claude child
  // past Electron quit.
  try {
    killAllPtySessions();
  } catch {
    /* ignore — best-effort cleanup on quit */
  }
});

app.on('window-all-closed', () => {
  // Tray-resident: do NOT quit on Windows when the window closes; the user
  // explicitly chose minimize-to-tray. Real quit goes through tray Quit /
  // Ctrl-Q.
  if (isQuitting) {
    closeDb();
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
