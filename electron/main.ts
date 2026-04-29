import * as Sentry from '@sentry/electron/main';
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, ipcMain, shell, type MenuItemConstructorOptions } from 'electron';
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

// Reads the user's opt-out preference for crash reporting from app_state.
// Returns false when the row is missing or the read errors — i.e. reporting
// is opt-OUT, default ON. We swallow errors here because Sentry's beforeSend
// is on the hot error path; failing closed (silently sending) is preferable
// to dropping a crash because the DB happened to be locked.
//
// Sentry's beforeSend runs on the hot error path, so we cache the value in
// a module-scope variable after the first read. The `db:save` handler below
// invalidates the cache when the renderer writes the `crashReportingOptOut`
// key, so the toggle in Settings still takes effect immediately.
const CRASH_OPT_OUT_KEY = 'crashReportingOptOut';
let _crashOptOutCached: boolean | undefined;
function loadCrashReportingOptOut(): boolean {
  if (_crashOptOutCached !== undefined) return _crashOptOutCached;
  try {
    const raw = loadState(CRASH_OPT_OUT_KEY);
    const value = raw != null && (raw === 'true' || raw === '1');
    _crashOptOutCached = value;
    return value;
  } catch {
    return false;
  }
}

// Crash reporting is OFF by default unless the operator plugs in a DSN
// via `SENTRY_DSN` at launch time. We intentionally do NOT ship a hardcoded
// project DSN in the open-source repo: self-hosters would otherwise send
// crashes to the maintainer's Sentry project with no opt-in. If you are
// building a fork, pass `SENTRY_DSN=https://...@your-project` to the app.
const SENTRY_DSN = process.env.SENTRY_DSN?.trim() || undefined;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: app.getVersion(),
    environment: app.isPackaged ? 'prod' : 'dev',
    sendDefaultPii: false,
    beforeSend(event) {
      try {
        const optOut = loadCrashReportingOptOut();
        if (optOut) return null;
      } catch {
        /* fall through, send anyway */
      }
      return event;
    },
  });
} else {
  console.info('[sentry] SENTRY_DSN not set — crash reporting disabled.');
}
import { installUpdaterIpc } from './updater';
import {
  scanImportableSessions,
  type ScannableSession,
} from './import-scanner';
import { listModelsFromSettings, readDefaultModelFromSettings } from './agent/list-models-from-settings';
import { registerPtyHostIpc, killAllPtySessions } from './ptyHost';
import { sessionWatcher } from './sessionWatcher';
import { installNotifyBridge } from './notify';
import { BadgeManager } from './notify/badge';
import {
  getSessionTitle,
  renameSessionTitle,
  listProjectSummaries,
  enqueuePendingRename,
  flushPendingRename,
} from './sessionTitles';

// ─────────────────────── IPC security helpers ────────────────────────────
//
// Filter renderer-supplied filesystem paths before any `fs.*` call. UNC paths
// (`\\server\share\...` or `//server/share/...`) MUST be rejected on Windows:
// node's fs will dutifully reach out over SMB to fetch the file, and on
// Windows that handshake leaks the user's NTLM hash to whatever host the
// renderer named. (CRITICAL — even a single innocuous-looking `existsSync`
// call against a chosen UNC target is a credential-leak primitive.)
//
// We also require absolute paths because every renderer caller already
// passes absolute paths (cwds, persisted disk locations, etc.); a relative
// path here is always a sign of a confused or malicious caller.
function isSafePath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    path.isAbsolute(p) &&
    !p.startsWith('\\\\') &&
    !p.startsWith('//')
  );
}

// Expand a leading `~` / `~/` / `~\` to the user's home directory. Used by
// `paths:exist` to normalize persisted cwds before the safety check. Inlined
// here after the `electron/agent/sessions.ts` deletion (W3.5c) — it was the
// only non-deleted consumer of the old `resolveCwd` helper.
function resolveCwd(cwd: string): string {
  if (cwd === '~') return os.homedir();
  if (cwd.startsWith('~/') || cwd.startsWith('~\\')) return path.join(os.homedir(), cwd.slice(2));
  return cwd;
}

// Defense-in-depth: every IPC handler that takes a privileged action should
// first confirm the message originated from our top-level renderer frame. A
// compromised iframe (e.g. via a future webview, or a misconfigured CSP)
// can otherwise call into ipcMain with the same `e.sender`. Pairs with the
// `setWindowOpenHandler({ action: 'deny' })` and `will-navigate` blocks
// installed in createWindow().
function fromMainFrame(e: Electron.IpcMainInvokeEvent): boolean {
  return e.senderFrame === e.sender.mainFrame;
}

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

// Close-button preference: 'ask' shows a one-time dialog the first time the
// user clicks the X (defaulting on Windows/Linux), 'tray' silently minimizes
// to the tray (mac default — matches OS red-light convention), 'quit' really
// quits. Persisted in app_state under key `closeAction` so the choice
// survives restart. Read synchronously inside win.on('close') because the
// close event itself is sync; the SQLite read is a single point lookup
// (sub-millisecond) so the cost is negligible vs. the visible click latency.
type CloseAction = 'ask' | 'tray' | 'quit';
const CLOSE_ACTION_KEY = 'closeAction';
function getCloseAction(): CloseAction {
  try {
    const raw = loadState(CLOSE_ACTION_KEY);
    if (raw === 'ask' || raw === 'tray' || raw === 'quit') return raw;
  } catch {
    /* fall through to default */
  }
  return process.platform === 'darwin' ? 'tray' : 'ask';
}
function setCloseAction(value: CloseAction): void {
  try {
    saveState(CLOSE_ACTION_KEY, value);
  } catch (err) {
    console.warn('[main] setCloseAction failed', err);
  }
}

// Notification mute preference. Persisted in app_state under
// `notifyEnabled` (default true → notifications on). Cached in main-process
// memory so the per-event check in the notify bridge stays cheap; the
// `db:save` handler invalidates the cache when the renderer writes the key
// so the Settings toggle takes effect without a restart. Mirrors the
// `closeAction` / `crashReportingOptOut` patterns above.
const NOTIFY_ENABLED_KEY = 'notifyEnabled';
let _notifyEnabledCached: boolean | undefined;
function loadNotifyEnabled(): boolean {
  if (_notifyEnabledCached !== undefined) return _notifyEnabledCached;
  try {
    const raw = loadState(NOTIFY_ENABLED_KEY);
    // Default ON: missing row OR any non-explicit-off value → notifications fire.
    const value = raw == null ? true : !(raw === 'false' || raw === '0');
    _notifyEnabledCached = value;
    return value;
  } catch {
    return true;
  }
}

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

// ───────────── user-owned cwd list (ccsm's own LRU) ─────────────
//
// The new-session default cwd is the LRU head (the user's most-recently
// picked cwd) when present, falling back to `os.homedir()` when the LRU
// is empty (fresh install). The recent list shown in the StatusBar cwd
// popover is a user-owned LRU that only the user can extend (by
// explicitly picking a non-default cwd). Persisted in the
// `app_state` SQLite table under key `userCwds` as a JSON string list.
//
// Reads return `[homedir()]` when the list is empty so the popover always has
// at least the home entry. Writes are LRU (newest first) with case-insensitive
// path-normalised dedupe and a hard cap of 20 entries.

const USER_CWDS_KEY = 'userCwds';
const USER_CWDS_MAX = 20;

function normalizeCwd(p: string): string {
  // Trim trailing slashes/backslashes; leave the rest of the path raw so we
  // don't accidentally break Windows drive-letter semantics. Comparison below
  // also lower-cases for dedupe on case-insensitive filesystems.
  return p.replace(/[\\/]+$/, '');
}

function readUserCwds(): string[] {
  try {
    const raw = loadState(USER_CWDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string' && !!p);
  } catch {
    return [];
  }
}

function writeUserCwds(list: string[]): void {
  try {
    saveState(USER_CWDS_KEY, JSON.stringify(list.slice(0, USER_CWDS_MAX)));
  } catch (err) {
    console.warn('[main] writeUserCwds failed', err);
  }
}

function getUserCwds(): string[] {
  const list = readUserCwds();
  const home = os.homedir();
  // Spec: "永远至少有 home" — home must always be present in the recent list,
  // even after the user has explicitly picked other cwds. We append home at
  // the tail if it isn't already in the user list, so the home entry stays
  // available as a fallback target without bumping it back to the head.
  if (list.length === 0) return [home];
  const lower = home.toLowerCase();
  if (list.some((p) => p.toLowerCase() === lower)) return list;
  return [...list, home];
}

function pushUserCwd(p: string): string[] {
  const norm = normalizeCwd(p);
  if (!norm) return readUserCwds();
  const cur = readUserCwds();
  // Case-insensitive dedupe (Windows + macOS default fs).
  const lower = norm.toLowerCase();
  const without = cur.filter((x) => x.toLowerCase() !== lower);
  const next = [norm, ...without].slice(0, USER_CWDS_MAX);
  writeUserCwds(next);
  return next;
}

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

// Right-click context menu for the renderer — Copy/Cut/Paste/Select All,
// contextually enabled based on selection + editable state. Attached per
// window in createMainWindow().
function installContextMenu(win: BrowserWindow) {
  win.webContents.on('context-menu', (_e, params) => {
    const { selectionText, editFlags, isEditable } = params;
    const hasSelection = !!selectionText && selectionText.trim().length > 0;
    const items: MenuItemConstructorOptions[] = [];
    if (isEditable) {
      items.push({ role: 'cut', enabled: !!editFlags.canCut });
    }
    items.push({ role: 'copy', enabled: hasSelection && !!editFlags.canCopy });
    if (isEditable) {
      items.push({ role: 'paste', enabled: !!editFlags.canPaste });
    }
    items.push({ type: 'separator' }, { role: 'selectAll', enabled: !!editFlags.canSelectAll });
    const menu = Menu.buildFromTemplate(items);
    menu.popup({ window: win });
  });
}

function createWindow() {
  // E2E hidden mode: when CCSM_E2E_HIDDEN=1 the window is created
  // at position (-32000, -32000) — far outside any monitor's visible
  // area on every common multi-monitor layout. The window IS shown
  // (show:true) so Chromium runs at full speed: rAF at 60Hz (no
  // background throttling), full layout/paint, focus delivery, and
  // CSS transitions all behave identically to a normal visible
  // window. Probes that exercise hover / drag / autoFocus / drop
  // animations all pass without per-probe opt-outs.
  //
  // Why not show:false: Chromium aggressively throttles offscreen
  // renderers down to ~1Hz rAF even with paintWhenInitiallyHidden
  // and webContents.setBackgroundThrottling(false). dnd-kit's
  // 150ms dropAnimation never completes; the DragOverlay sticks
  // in the DOM after pointerup; subsequent drags hit the orphaned
  // overlay instead of their real target. Off-screen-positioned
  // windows ARE Chromium-visible and therefore fully active.
  //
  // Devs running a single probe by hand without the env still get
  // a normal centered visible window for debugging.
  const hiddenForE2E = process.env.CCSM_E2E_HIDDEN === '1';
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    x: hiddenForE2E ? -32000 : undefined,
    y: hiddenForE2E ? -32000 : undefined,
    show: true,
    // Hide from Windows taskbar / Alt-Tab when running e2e so the
    // user can't see a "ccsm" entry while a probe batch is in
    // flight. Doesn't affect Chromium's "is the window active"
    // signal, so rAF / focus / animations stay un-throttled.
    skipTaskbar: hiddenForE2E,
    // Solid app background — we deliver depth via layered surfaces in CSS,
    // not via Mica/transparency. The user explicitly does not want to see
    // the desktop through the window.
    backgroundColor: '#0B0B0C',
    // macOS: hiddenInset titlebar with native traffic lights.
    // Windows: fully frameless — we self-draw the three controls inside
    //   the right pane (see WindowControls).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 14 } }
      : { titleBarStyle: 'hidden' as const, frame: false }),
    // Windows 11: ask DWM to round the outer corners so the window edge
    //   matches the radii of our internal panels. Without this the window
    //   is a sharp rectangle and rounded interior surfaces look clipped
    //   where they meet it. Ignored on <Win11.
    roundedCorners: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Hidden-mode animation correctness: Chromium throttles rAF
      // for offscreen / hidden windows down to ~1Hz. dnd-kit's
      // dropAnimation (150ms) and other CSS transitions then never
      // complete, the DragOverlay element stays in the DOM after
      // pointerup, and subsequent drags hit the leftover overlay
      // instead of their real target. backgroundThrottling:false
      // forces Chromium to run rAF at full speed even when the
      // BrowserWindow is hidden.
      backgroundThrottling: false,
      // CCSM_E2E_HIDDEN=1 also strips the DevTools surface entirely so
      // probes cannot accidentally pop a DevTools window (any explicit
      // openDevTools() call below is a no-op once this is false).
      devTools: !hiddenForE2E,
      // sandbox:true is the recommended Electron baseline (forces the
      // preload into a Chromium sandbox where Node built-ins are
      // unavailable), but our preload's `require('@sentry/electron/preload')`
      // can't be resolved by the sandboxed preload's restricted require —
      // it only follows relative paths and a small whitelist. Enabling it
      // results in: "Error: module not found: @sentry/electron/preload"
      // and `window.ccsm` is never installed.
      //
      // Followup: bundle preload through webpack (or vendor the sentry
      // preload into electron/) so the require resolves at build time, then
      // flip this back to true. Tracked separately to keep this PR scoped
      // to the IPC hardening fixes that don't require a build-pipeline
      // change.
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.setMenuBarVisibility(false);

  // Block the renderer from spawning new BrowserWindows. We have no use
  // case for window.open(); a successful call would create a popup with
  // our preload attached.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Block in-window navigation away from our renderer origin. The renderer
  // should never navigate; all external links go through `shell:openExternal`
  // (which itself filters to http(s) only).
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const u = new URL(url);
      const devPort = process.env.CCSM_DEV_PORT || '4100';
      const allowed =
        u.origin === `http://localhost:${devPort}` ||
        u.origin === 'http://localhost:4100' ||
        u.protocol === 'file:';
      if (!allowed) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });

  if (isDev) {
    const port = process.env.CCSM_DEV_PORT || '4100';
    win.loadURL(`http://localhost:${port}`);
    if (!hiddenForE2E) win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Hidden-mode focus priming: a window with show:false never receives
  // OS focus, so document.hasFocus() in the renderer would stay false
  // and autoFocus on freshly-mounted alertdialog buttons would no-op.
  // Calling webContents.focus() sets Chromium-level focus on the
  // renderer regardless of the OS surface state — the renderer then
  // observes focused === true and autoFocus / focus-trap behaviors
  // match a normal visible window. We also disable background
  // throttling at the webContents level (belt-and-suspenders alongside
  // webPreferences.backgroundThrottling:false above) so rAF runs at
  // full speed and CSS transitions / dnd-kit drop animations complete.
  if (hiddenForE2E) {
    try { win.webContents.focus(); } catch { /* ignore */ }
    try { win.webContents.setBackgroundThrottling(false); } catch { /* ignore */ }
  }
  installContextMenu(win);

  // Window-level lifecycle bookkeeping. (The pre-PR-8 ttyd-exit fan-out
  // bound a renderer here via `bindCliBridgeSender`; ptyHost now reaches
  // attached webContents directly through their per-session attach map,
  // so no explicit binding step is needed.)
  win.on('show', () => {
    // Reset the renderer's fade-opacity in case the window was just
    // restored after a fade-to-hide (see `window:beforeHide` below).
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('window:afterShow');
    }
  });

  win.on('focus', () => {
    clearBadgeForActiveIfFocused();
  });

  const emitMax = () => win.webContents.send('window:maximizedChanged', win.isMaximized());
  win.on('maximize', emitMax);
  win.on('unmaximize', emitMax);

  // Close-button behaviour. Three modes — see getCloseAction() above:
  //   'quit' → don't preventDefault; let the window close, fall through to
  //            window-all-closed → before-quit → app exit.
  //   'tray' → preventDefault + fade-to-hide (the original behaviour).
  //   'ask'  → preventDefault + native dialog with a "Don't ask again"
  //            checkbox; on confirm we persist the choice via setCloseAction
  //            so the next click goes straight to that branch.
  // The `isQuitting` short-circuit at the top stays so explicit quit paths
  // (tray menu Quit, app.before-quit safety net, electron-builder updater)
  // bypass everything.
  //
  // Fade-to-hide: before actually calling `win.hide()` we send a
  // `window:beforeHide` event so the renderer can run a short opacity
  // fade-out. `HIDE_FADE_MS` matches `DURATION.standard` (180ms) from the
  // shared motion tokens — kept short so closing still feels responsive.
  // Guarded by `fadePending` so repeated Ctrl+W presses don't stack timers.
  const HIDE_FADE_MS = 180;
  let fadePending = false;
  const fadeThenHide = () => {
    if (fadePending) return;
    fadePending = true;
    try {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('window:beforeHide', { durationMs: HIDE_FADE_MS });
      }
    } catch {
      /* renderer unreachable — fall through to immediate hide */
    }
    setTimeout(() => {
      fadePending = false;
      if (win.isDestroyed()) return;
      win.hide();
    }, HIDE_FADE_MS);
  };
  win.on('close', (e) => {
    if (isQuitting) return;
    const pref = getCloseAction();
    if (pref === 'quit') {
      isQuitting = true;
      return;
    }
    e.preventDefault();
    if (pref === 'tray') {
      fadeThenHide();
      return;
    }
    // pref === 'ask': prompt once. Showing the dialog is async, but
    // preventDefault has already kept the window alive; we run the dialog
    // and act on the user's choice in the resolved promise.
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const i18n = require('./i18n') as typeof import('./i18n');
      let result: { response: number; checkboxChecked: boolean };
      try {
        result = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: [i18n.tCloseDialog('tray'), i18n.tCloseDialog('quit')],
          defaultId: 0,
          cancelId: 0,
          message: i18n.tCloseDialog('message'),
          detail: i18n.tCloseDialog('detail'),
          checkboxLabel: i18n.tCloseDialog('dontAskAgain'),
          checkboxChecked: false,
        });
      } catch (err) {
        console.warn('[main] close-action dialog failed; falling back to tray', err);
        fadeThenHide();
        return;
      }
      const choice: CloseAction = result.response === 0 ? 'tray' : 'quit';
      if (result.checkboxChecked) setCloseAction(choice);
      if (choice === 'tray') {
        fadeThenHide();
      } else {
        isQuitting = true;
        app.quit();
      }
    })();
  });

  // After the window is shown again (tray click, dock click on macOS) the
  // renderer's opacity may still be 0 from the previous fade-out. The
  // existing `win.on('show')` handler above dispatches `window:afterShow`
  // to reset it.
}

let tray: Tray | null = null;
let isQuitting = false;
let badgeManager: BadgeManager | null = null;

function getTrayBaseImage() {
  return buildTrayIcon();
}

function clearBadgeForActiveIfFocused() {
  if (!badgeManager) return;
  const w = BrowserWindow.getAllWindows()[0];
  const focused = !!(w && !w.isDestroyed() && w.isFocused());
  if (!focused) return;
  if (!activeSidFromRenderer) return;
  badgeManager.clearSid(activeSidFromRenderer);
}

function buildTrayIcon() {
  // #608: previously a flat 16×16 white-on-transparent square — invisible on
  // light tray backgrounds and read as "pure white" on dark ones, with no
  // brand affordance either way. Render a colored disc with a "C" mark so
  // the tray icon is recognizable on both light and dark Windows tray
  // backgrounds without shipping a binary asset. Procedural pixels keep the
  // app icon-asset-free (no asar packaging changes needed).
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  // Brand accent (warm orange) — readable on both white and black tray bgs.
  // Hex 0xE07A3F = oklch(~0.68 0.16 50). Same family as --accent in the UI.
  const FG_R = 0xe0, FG_G = 0x7a, FG_B = 0x3f;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size / 2;          // 8
  const rInner = rOuter - 3;        // 5 — leaves a 3px ring as the "C" body
  const arcGapHalf = 2.2;           // half-height (px) of the right-side gap that opens the C
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;
      // Default transparent.
      buf[i + 0] = 0;
      buf[i + 1] = 0;
      buf[i + 2] = 0;
      buf[i + 3] = 0;
      // Inside the ring band?
      if (d <= rOuter - 0.25 && d >= rInner) {
        // Punch out a gap on the right side to form the open mouth of "C".
        const inGap = dx > 0 && Math.abs(dy) <= arcGapHalf;
        if (inGap) continue;
        // Soft 1px outer edge for AA.
        let alpha = 255;
        if (d > rOuter - 1.25) {
          const t = Math.max(0, Math.min(1, (rOuter - 0.25) - d));
          alpha = Math.round(255 * t);
        }
        buf[i + 0] = FG_R;
        buf[i + 1] = FG_G;
        buf[i + 2] = FG_B;
        buf[i + 3] = alpha;
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function applyTrayLocale() {
  if (!tray) return;
  // Local require keeps the import graph linear (see the longer comment
  // near the `ccsm:set-language` handler below).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const i18n = require('./i18n') as typeof import('./i18n');
  tray.setToolTip(i18n.tTray('tooltip'));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: i18n.tTray('show'), click: showTrayWindow },
      { type: 'separator' },
      {
        label: i18n.tTray('quit'),
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function showTrayWindow() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function ensureTray() {
  if (tray) return tray;
  tray = new Tray(buildTrayIcon());
  tray.on('click', showTrayWindow);
  tray.on('double-click', showTrayWindow);
  applyTrayLocale();
  return tray;
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
        _crashOptOutCached = undefined;
      }
      // Same idea for the notification mute toggle — invalidate so the next
      // sessionWatcher event reads the fresh value.
      if (key === NOTIFY_ENABLED_KEY) {
        _notifyEnabledCached = undefined;
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
    clearBadgeForActiveIfFocused();
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

  // Desktop notification bridge — fires OS toasts on session 'idle' /
  // 'requires_action' transitions, with global-mute + active-window +
  // active-sid suppression and per-sid 5s dedupe. See electron/notify.
  badgeManager = new BadgeManager({
    getTray: () => tray,
    getBaseTrayImage: getTrayBaseImage,
    getWindows: () => BrowserWindow.getAllWindows(),
  });
  installNotifyBridge({
    sessionWatcher,
    getMainWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    isMutedFn: () => !loadNotifyEnabled(),
    getActiveSidFn: () => activeSidFromRenderer,
    getNameFn: (sid) => sessionNamesFromRenderer.get(sid) ?? null,
    isWindowFocusedFn: () => {
      const w = BrowserWindow.getAllWindows()[0];
      return !!(w && !w.isDestroyed() && w.isFocused());
    },
    onNotified: (sid) => {
      badgeManager?.incrementSid(sid);
    },
  });

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
