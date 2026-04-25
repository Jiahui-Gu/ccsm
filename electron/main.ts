import * as Sentry from '@sentry/electron/main';
import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, type MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  initDb,
  loadState,
  saveState,
  closeDb,
} from './db';
import { loadHistoryFromJsonl } from './jsonl-loader';
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
  // eslint-disable-next-line no-console
  console.info('[sentry] SENTRY_DSN not set — crash reporting disabled.');
}
import { sessions } from './agent/manager';
import { resolveCwd } from './agent/sessions';
import { installUpdaterIpc } from './updater';
import {
  scanImportableSessions,
  deriveRecentCwds,
  deriveTopModel,
  type ScannableSession,
} from './import-scanner';
import { loadImportableHistory } from './import-history';
import { showNotification, type ShowNotificationPayload } from './notifications';
import { probeNotifyAvailability, notifyLastError } from './notify';
import {
  bootstrapNotify,
  setNotifyRuntimeState,
  createDefaultToastActionRouter,
} from './notify-bootstrap';
import { cancelQuestionRetry } from './notify-retry';
import type { PermissionMode } from './agent/sessions';
import { listModelsFromSettings } from './agent/list-models-from-settings';
import { readMemoryFile, writeMemoryFile, memoryFileExists } from './memory';
import { loadCommands } from './commands-loader';

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

// ───────────────────── importable-sessions cache ─────────────────────────
//
// The CLI transcripts under ~/.claude/projects can run into hundreds of
// files; the head-parse is fast per file but the cumulative latency makes
// the ImportDialog's "Scanning…" state visible for several seconds on cold
// open. We kick off the scan eagerly at app `ready` and serve cached
// results to renderers, refreshing in the background on each request so
// newly-recorded sessions show up without a manual reload.
//
// `recentCwds` is derived from the same scan and seeds the new-session
// default cwd (via the renderer store) — same goal, no second IPC.
let importableCache: ScannableSession[] = [];
let recentCwdsCache: string[] = [];
let topModelCache: string | null = null;
let importablePending: Promise<ScannableSession[]> | null = null;

function refreshImportableCache(): Promise<ScannableSession[]> {
  if (importablePending) return importablePending;
  importablePending = scanImportableSessions()
    .then((rows) => {
      importableCache = rows;
      recentCwdsCache = deriveRecentCwds(rows);
      topModelCache = deriveTopModel(rows);
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

async function getRecentCwds(): Promise<string[]> {
  if (recentCwdsCache.length > 0 || importableCache.length > 0) {
    return recentCwdsCache;
  }
  await refreshImportableCache();
  return recentCwdsCache;
}

async function getTopModel(): Promise<string | null> {
  if (topModelCache !== null || importableCache.length > 0) {
    return topModelCache;
  }
  await refreshImportableCache();
  return topModelCache;
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
  if (process.platform === 'darwin') {
    // Let Electron use its default macOS menu.
    return;
  }
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
    // On macOS: `hiddenInset` keeps OS-drawn traffic lights (top-left) and
    //   hides the title bar. On Windows/Linux: fully frameless — we self-
    //   draw the three controls inside the right pane (see WindowControls).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: process.platform === 'darwin',
    // Windows 11: ask DWM to round the outer corners so the window edge
    //   matches the radii of our internal panels. Without this the window
    //   is a sharp rectangle and rounded interior surfaces look clipped
    //   where they meet it. Ignored on macOS/Linux/<Win11.
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
  sessions.bindSender(win.webContents);

  // If a prior window was hidden then had its WebContents destroyed (can
  // happen under aggressive GC on minimize-to-tray), subsequent `wc.send`
  // calls from the sessions manager no-op silently. Rebinding on `show` and
  // on the fresh window's `did-finish-load` picks up any still-live sessions
  // and routes their events at the live renderer.
  win.on('show', () => {
    if (!win.webContents.isDestroyed()) sessions.rebindSender(win.webContents);
    // Reset the renderer's fade-opacity in case the window was just
    // restored after a fade-to-hide (see `window:beforeHide` below).
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('window:afterShow');
    }
  });
  win.webContents.on('did-finish-load', () => {
    if (!win.webContents.isDestroyed()) sessions.rebindSender(win.webContents);
  });

  const emitMax = () => win.webContents.send('window:maximizedChanged', win.isMaximized());
  win.on('maximize', emitMax);
  win.on('unmaximize', emitMax);

  // Minimize-to-tray: clicking close (or the OS X red dot, our own custom
  // close button via window:close IPC) hides the window instead of quitting.
  // The user can still really quit via the tray menu's Quit item, the
  // app menu's Quit, or Cmd/Ctrl-Q.
  //
  // Fade-to-hide: before actually calling `win.hide()` we send a
  // `window:beforeHide` event so the renderer can run a short opacity
  // fade-out. `HIDE_FADE_MS` matches `DURATION.standard` (180ms) from the
  // shared motion tokens — kept short so closing still feels responsive.
  // Guarded by `fadePending` so repeated Cmd/Ctrl+W presses don't stack
  // timers. On real quit (`isQuitting === true`) we skip the fade entirely
  // so shutdown stays fast.
  const HIDE_FADE_MS = 180;
  let fadePending = false;
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
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
      if (process.platform === 'darwin') app.dock?.hide?.();
    }, HIDE_FADE_MS);
  });

  // After the window is shown again (tray click, dock click on macOS) the
  // renderer's opacity may still be 0 from the previous fade-out. The
  // existing `win.on('show')` handler above dispatches `window:afterShow`
  // to reset it.
}

let tray: Tray | null = null;
let isQuitting = false;

function buildTrayIcon() {
  // Tiny 16×16 placeholder (white square on transparent). On Windows/Linux
  // the OS uses this directly; macOS auto-templates monochrome images.
  // Replace with a real branded asset once we have one.
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buffer[i * 4 + 0] = 255;
    buffer[i * 4 + 1] = 255;
    buffer[i * 4 + 2] = 255;
    buffer[i * 4 + 3] = 220;
  }
  const img = nativeImage.createFromBuffer(buffer, { width: size, height: size });
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
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
  if (process.platform === 'darwin') app.dock?.show?.();
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
  // On Windows, notifications need a stable AppUserModelID so the OS knows
  // which app the toast belongs to (otherwise it shows "electron.exe").
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.ccsm.app');
  }
  initDb();

  // Wave 1D: bootstrap the optional `@ccsm/notify` Adaptive Toast pipeline.
  // Wrapped in try/catch by the bootstrap helper itself; failure (missing
  // native deps, unregistered AUMID, non-win32) leaves the app running with
  // the legacy Electron Notification path. The router below routes toast
  // button clicks (Allow / Allow always / Reject / Focus) back into the same
  // code paths the in-app prompts use.
  try {
    bootstrapNotify(
      createDefaultToastActionRouter({
        resolvePermission: (sessionId, requestId, decision) =>
          sessions.resolvePermission(sessionId, requestId, decision),
        cancelQuestionRetry,
        getMainWindow: () =>
          BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null,
      }),
    );
  } catch (err) {
    // bootstrapNotify already swallows internally; this is belt-and-suspenders
    // so an unexpected throw still can't take down app startup.
    // eslint-disable-next-line no-console
    console.warn(
      `[main] notify bootstrap threw: ${err instanceof Error ? err.message : err}`,
    );
  }

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
      return { ok: true };
    }
  );
  // Session message history is no longer persisted by ccsm — the CLI/Agent
  // SDK already writes every frame to `~/.claude/projects/<key>/<sid>.jsonl`,
  // and ccsm now reads from there via `agent:load-history`. The previous
  // `db:loadMessages` / `db:saveMessages` IPC + SQLite `messages` table were
  // a redundant secondary copy.
  ipcMain.handle(
    'agent:load-history',
    async (e, cwd: unknown, sessionId: unknown) => {
      if (!fromMainFrame(e)) {
        return { ok: false, error: 'rejected' as const };
      }
      if (typeof cwd !== 'string' || typeof sessionId !== 'string') {
        return { ok: false, error: 'invalid_args' as const };
      }
      try {
        return await loadHistoryFromJsonl(cwd, sessionId);
      } catch (err) {
        console.warn('[main] agent:load-history failed', err);
        return {
          ok: false as const,
          error: 'read_error' as const,
          detail: err instanceof Error ? err.message : String(err)
        };
      }
    }
  );

  // Truncation marker (PR `feat/user-block-hover-menu`). Stored in app_state
  // under key `truncation:<sessionId>` as JSON `{ blockId, truncatedAt }`.
  // The renderer reads it after re-hydrating from JSONL and slices the
  // projected MessageBlock[] at the recorded user-block id. Survives ccsm
  // restart so the user-visible truncation isn't lost the moment we go to
  // re-hydrate from disk.
  function truncationKey(sessionId: string): string {
    return `truncation:${sessionId}`;
  }
  ipcMain.handle('truncation:get', (e, sessionId: unknown) => {
    if (!fromMainFrame(e)) return null;
    if (typeof sessionId !== 'string' || !sessionId) return null;
    try {
      const raw = loadState(truncationKey(sessionId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { blockId?: unknown }).blockId === 'string' &&
        typeof (parsed as { truncatedAt?: unknown }).truncatedAt === 'number'
      ) {
        return parsed as { blockId: string; truncatedAt: number };
      }
      return null;
    } catch (err) {
      console.warn('[main] truncation:get failed', err);
      return null;
    }
  });
  ipcMain.handle('truncation:set', (e, sessionId: unknown, marker: unknown) => {
    if (!fromMainFrame(e)) return { ok: false as const, error: 'rejected' };
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false as const, error: 'invalid_args' };
    }
    try {
      if (marker == null) {
        // Clear by writing empty string — saveState upserts; reading back
        // returns '' which the loader will treat as no-marker after the
        // JSON.parse path below. Simpler: just store empty JSON object.
        saveState(truncationKey(sessionId), '');
        return { ok: true as const };
      }
      if (
        typeof marker !== 'object' ||
        typeof (marker as { blockId?: unknown }).blockId !== 'string' ||
        typeof (marker as { truncatedAt?: unknown }).truncatedAt !== 'number'
      ) {
        return { ok: false as const, error: 'invalid_args' };
      }
      saveState(truncationKey(sessionId), JSON.stringify(marker));
      return { ok: true as const };
    } catch (err) {
      console.warn('[main] truncation:set failed', err);
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

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

  ipcMain.handle('dialog:pickDirectory', async (e) => {
    if (!fromMainFrame(e)) return null;
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: i18n.tDialog('chooseCwd')
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  // Save tool output to a file the user picks. Used by the long-output
  // viewer's `Save as .log` action — for >10MB outputs this is the ONLY
  // way the user can see the full content. Capped at 50 MB per file:
  // legitimate "save big tool dump" use cases live well under that, and
  // anything bigger is almost certainly a runaway loop or accidental
  // serialization of a giant in-memory buffer.
  const MAX_SAVE_FILE_BYTES = 50 * 1024 * 1024;
  ipcMain.handle(
    'dialog:saveFile',
    async (
      e,
      args: { defaultName?: string; content: string }
    ): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> => {
      if (!fromMainFrame(e)) return { ok: false, error: 'rejected' };
      const content = typeof args?.content === 'string' ? args.content : '';
      // String length is a fine proxy here — UTF-8 bytes can be at most 4×
      // chars but realistic content (ASCII/UTF-8 text dumps) is ~1×, so we
      // gate on raw length to avoid a wasted Buffer.byteLength roundtrip.
      // The dialog filters offer .log/.txt only.
      if (content.length > MAX_SAVE_FILE_BYTES) {
        return { ok: false, error: 'content_too_large' };
      }
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      try {
        const res = await dialog.showSaveDialog(win, {
          defaultPath: args.defaultName ?? 'tool-output.log',
          filters: [
            { name: 'Log', extensions: ['log', 'txt'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        });
        if (res.canceled || !res.filePath) return { ok: false, canceled: true };
        await fs.promises.writeFile(res.filePath, content, 'utf8');
        return { ok: true, path: res.filePath };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // (#51 / P1-16) Open long tool output in the user's default text editor.
  // Renderer pipes the full stdout text up; we drop it into a uniquely-named
  // file under os.tmpdir() and ask the OS to open it via shell.openPath.
  // The file lives until the OS cleans tmpdir — we do NOT auto-delete: a
  // user may keep the editor window open for hours, and yanking the file
  // out from under them would be a worse bug than a few stray temp files.
  // Capped at the same 50 MB ceiling as saveFile so a runaway tool can't
  // wedge the disk; legitimate "open this dump" cases live well under it.
  const MAX_OPEN_IN_EDITOR_BYTES = 50 * 1024 * 1024;
  ipcMain.handle(
    'tool:open-in-editor',
    async (
      e,
      args: { content: string }
    ): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
      if (!fromMainFrame(e)) return { ok: false, error: 'rejected' };
      const content = typeof args?.content === 'string' ? args.content : '';
      if (content.length > MAX_OPEN_IN_EDITOR_BYTES) {
        return { ok: false, error: 'content_too_large' };
      }
      // High-resolution-ish unique name: ms timestamp + 6 random hex chars.
      // ms alone is enough on a single click, but two parallel "Open in
      // editor" clicks fired in the same tick would otherwise collide on
      // the filename and one editor would silently re-open the other's
      // file. Random suffix keeps them distinct without pulling in uuid.
      const ts = Date.now();
      const rand = Math.floor(Math.random() * 0xffffff)
        .toString(16)
        .padStart(6, '0');
      const filePath = path.join(
        os.tmpdir(),
        `claude-tool-output-${ts}-${rand}.txt`
      );
      try {
        await fs.promises.writeFile(filePath, content, 'utf8');
        // Test/probe escape hatch: when CCSM_OPEN_IN_EDITOR_NOOP is set we
        // write the file but don't actually launch the editor. Lets E2E
        // probes verify the round-trip without spawning notepad/vim/etc.
        // on the CI host. The renderer still sees `{ ok: true, path }`
        // exactly as in production.
        if (process.env.CCSM_OPEN_IN_EDITOR_NOOP) {
          return { ok: true, path: filePath };
        }
        // shell.openPath returns an empty string on success, an error
        // message string on failure. Treat empty as ok.
        const openErr = await shell.openPath(filePath);
        if (openErr) {
          return { ok: false, error: openErr };
        }
        return { ok: true, path: filePath };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
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

  ipcMain.handle(
    'agent:start',
    async (
      e,
      sessionId: string,
      opts: {
        cwd: string;
        model?: string;
        permissionMode?: PermissionMode;
        resumeSessionId?: string;
        // Pre-allocated CLI session UUID. Forwarded to the SDK runner via
        // StartOptions; the legacy hand-written runner ignores it. See
        // `src/stores/store.ts` newSessionId() for the unification rationale.
        sessionId?: string;
      }
    ) => {
      if (!fromMainFrame(e)) {
        return { ok: false, error: 'rejected', errorCode: 'CWD_MISSING' as const };
      }
      // Guard against stale `cwd` paths that no longer exist on disk. Common
      // failure mode: a session was created inside a now-deleted worktree
      // (the Sept worktree feature was reverted in #104), so its persisted
      // `cwd` points at `.claude/worktrees/agent-xxx`. Spawning would crash
      // with ENOENT inside SessionRunner; catching here gives the renderer a
      // clean error code it can surface as "repick your folder".
      const resolvedCwd = resolveCwd(opts.cwd);
      // UNC + non-absolute paths are rejected up front. resolveCwd expands
      // `~` to the home dir, so by this point a safe cwd is always absolute
      // and never a UNC share. See isSafePath() at top-of-file.
      if (!isSafePath(resolvedCwd) || !fs.existsSync(resolvedCwd)) {
        return {
          ok: false,
          error: `Working directory no longer exists: ${opts.cwd}`,
          errorCode: 'CWD_MISSING' as const,
        };
      }

      // Binary resolution lives in `electron/agent-sdk/sessions.ts`
      // (`resolveClaudeInvocation`). CCSM ships the binary inside the
      // installer (PR-B) so we no longer let the renderer pick / persist
      // a path — `agent:start` just trusts the SDK runner to find it.

      const result = await sessions.start(sessionId, opts);

      return result;
    }
  );
  ipcMain.handle('agent:send', (e, sessionId: string, text: string) => {
    if (!fromMainFrame(e)) return false;
    return sessions.send(sessionId, text);
  });
  ipcMain.handle(
    'agent:sendContent',
    (e, sessionId: string, content: unknown[]) => {
      if (!fromMainFrame(e)) return false;
      return sessions.sendContent(sessionId, Array.isArray(content) ? content : []);
    }
  );
  ipcMain.handle('agent:interrupt', (_e, sessionId: string) => sessions.interrupt(sessionId));
  /**
   * (#239) Per-tool-use cancel IPC. Validates payload shape so a malformed
   * call from a compromised renderer can't tickle the manager with bogus
   * args. Returns the same `{ok:true} | {ok:false, error}` shape the
   * renderer already handles for setPermissionMode.
   */
  ipcMain.handle(
    'agent:cancelToolUse',
    async (
      e,
      args: { sessionId: string; toolUseId: string }
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!fromMainFrame(e)) return { ok: false, error: 'rejected' };
      if (
        !args ||
        typeof args !== 'object' ||
        typeof args.sessionId !== 'string' ||
        typeof args.toolUseId !== 'string' ||
        !args.sessionId ||
        !args.toolUseId
      ) {
        return { ok: false, error: 'bad_payload' };
      }
      try {
        const ok = await sessions.cancelToolUse(args.sessionId, args.toolUseId);
        return ok ? { ok: true } : { ok: false, error: 'no_session' };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
  ipcMain.handle(
    'agent:setPermissionMode',
    async (
      e,
      sessionId: string,
      mode: PermissionMode
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!fromMainFrame(e)) return { ok: false, error: 'rejected' };
      // Validate the mode up front so an unknown value gets rejected even
      // when the session no longer exists (manager.setPermissionMode would
      // otherwise short-circuit to `false` and we'd never hit the throw in
      // toCliPermissionMode). The list here mirrors the union in
      // electron/agent/sessions.ts:PermissionMode — keep them in sync.
      const KNOWN_MODES = new Set<string>([
        'default', 'acceptEdits', 'plan', 'bypassPermissions',
        'ask', 'standard', 'dontAsk', 'auto', 'yolo'
      ]);
      if (typeof mode !== 'string' || !KNOWN_MODES.has(mode)) {
        return { ok: false, error: 'unknown_mode' };
      }
      try {
        await sessions.setPermissionMode(sessionId, mode);
        return { ok: true };
      } catch (err) {
        if (err instanceof Error && /Unknown permission mode/i.test(err.message)) {
          return { ok: false, error: 'unknown_mode' };
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
  ipcMain.handle('agent:setModel', (e, sessionId: string, model?: string) => {
    if (!fromMainFrame(e)) return false;
    return sessions.setModel(sessionId, model);
  });
  ipcMain.handle('agent:close', (e, sessionId: string) => {
    if (!fromMainFrame(e)) return false;
    return sessions.close(sessionId);
  });

  ipcMain.handle(
    'agent:resolvePermission',
    (e, sessionId: string, requestId: string, decision: 'allow' | 'deny') => {
      if (!fromMainFrame(e)) return false;
      // Wave 3 polish (#252): if this resolve is answering an ask-question
      // (renderer's QuestionBlock onSubmit calls agentResolvePermission with
      // decision='deny' to release the underlying CLI gate), cancel any
      // pending toast retry. The toastId for question events is `q-${requestId}`
      // (see lifecycle.ts permission dispatch); permissions themselves don't
      // schedule retries today so cancelling under the bare requestId is a
      // cheap, defensive no-op.
      cancelQuestionRetry(`q-${requestId}`);
      cancelQuestionRetry(requestId);
      return sessions.resolvePermission(sessionId, requestId, decision);
    }
  );

  // Per-hunk partial accept for Edit / Write / MultiEdit (#251). Additive —
  // the legacy `agent:resolvePermission` channel above stays as the whole-tool
  // allow/deny path. Renderer should validate `acceptedHunks` is a non-empty
  // subset of available hunk indices before invoking.
  ipcMain.handle(
    'agent:resolvePermissionPartial',
    (e, sessionId: string, requestId: string, acceptedHunks: unknown) => {
      if (!fromMainFrame(e)) return false;
      if (!Array.isArray(acceptedHunks)) return false;
      const indices = acceptedHunks.filter((n): n is number => Number.isInteger(n) && n >= 0);
      return sessions.resolvePermissionPartial(sessionId, requestId, indices);
    }
  );

  ipcMain.handle('import:scan', () => getImportableSessions());
  ipcMain.handle('import:recentCwds', () => getRecentCwds());
  ipcMain.handle('import:topModel', () => getTopModel());
  ipcMain.handle(
    'import:loadHistory',
    async (e, projectDir: unknown, sessionId: unknown) => {
      if (!fromMainFrame(e)) return [];
      if (typeof projectDir !== 'string' || typeof sessionId !== 'string') return [];
      try {
        return await loadImportableHistory(projectDir, sessionId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[main] import:loadHistory failed', err);
        return [];
      }
    }
  );

  // Batched best-effort existence probe for arbitrary filesystem paths.
  // The renderer uses this on hydration to flag sessions whose persisted
  // `cwd` was deleted between runs (typical worktree-cleanup victim — see
  // PR #104). Returned map is keyed by the input path; missing paths and
  // permission errors both map to `false` (we don't surface the distinction
  // — for the migration's purpose they're equivalent: don't auto-spawn).
  ipcMain.handle('paths:exist', (_e, inputPaths: unknown) => {
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
  });

  // ─────────────────────── disk-based slash commands ──────────────────────
  //
  // Picker discovery for user / project / plugin command markdown files.
  // Renderer calls this on focus / cwd change. Execution stays pass-through:
  // selecting one inserts `/<name>` into the textarea, which the existing
  // send path forwards to claude.exe. We never parse the body.
  ipcMain.handle('commands:list', (_e, cwd: string | null | undefined) => {
    // commands-loader does its own fs reads against the supplied cwd; UNC or
    // relative inputs get filtered out here so we don't leak NTLM (Windows)
    // or descend into wherever a confused renderer points us. Empty list is
    // the safe fallback for any unsafe input.
    if (cwd != null && !isSafePath(cwd)) return [];
    return loadCommands({ cwd: cwd ?? null });
  });

  // ─────────────────────── @mention file listing ──────────────────────────
  //
  // Powers the InputBar's @file picker. Walks the session cwd recursively,
  // skipping the usual heavy directories (node_modules, .git, dist, build,
  // .next, .venv, target). Returns POSIX-style relative paths so the mention
  // literal we splice into the composer (`@src/foo.ts`) stays portable
  // across platforms — claude.exe on Windows happily accepts forward
  // slashes too.
  //
  // Caps:
  //   - max 5000 files (after which we bail; the picker fuzzy-search is
  //     plenty accurate at that size, and walking >5k entries on every focus
  //     is wasteful)
  //   - max 12 directory depth (defense against symlink loops)
  //
  // Per-call, not cached: cwd swaps + on-disk edits should reflect quickly,
  // and the renderer only invokes this on focus / @ trigger.
  const FILE_LIST_MAX = 5000;
  const FILE_LIST_MAX_DEPTH = 12;
  const FILE_LIST_SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    'dist',
    'build',
    'out',
    '.next',
    '.nuxt',
    '.turbo',
    '.cache',
    '.venv',
    'venv',
    '__pycache__',
    'target',
    '.idea',
    '.vscode',
  ]);

  ipcMain.handle('files:list', async (e, cwd: string | null | undefined) => {
    if (!fromMainFrame(e)) return [];
    if (cwd == null || !isSafePath(cwd)) return [];
    let rootStat: fs.Stats;
    try {
      rootStat = await fs.promises.stat(cwd);
    } catch {
      return [];
    }
    if (!rootStat.isDirectory()) return [];

    const out: { path: string; name: string }[] = [];
    async function walk(dir: string, rel: string, depth: number): Promise<void> {
      if (out.length >= FILE_LIST_MAX) return;
      if (depth > FILE_LIST_MAX_DEPTH) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (out.length >= FILE_LIST_MAX) return;
        // Skip hidden + heavy build dirs to keep the picker snappy.
        if (ent.name.startsWith('.') && ent.name !== '.env' && ent.name !== '.env.local') {
          if (ent.isDirectory()) continue;
          // hidden file: skip too — usually noise (.DS_Store, .gitignore)
          continue;
        }
        if (ent.isDirectory() && FILE_LIST_SKIP_DIRS.has(ent.name)) continue;
        const childAbs = path.join(dir, ent.name);
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          await walk(childAbs, childRel, depth + 1);
        } else if (ent.isFile()) {
          out.push({ path: childRel, name: ent.name });
        }
      }
    }
    await walk(cwd, '', 0);
    return out;
  });

  ipcMain.handle('shell:openExternal', async (e, url: string) => {
    if (!fromMainFrame(e)) return false;
    // Only http(s). Everything else is a potential shell hijack.
    if (!/^https?:\/\//i.test(url)) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });
  // ──────────────────────── end commands + shell ───────────────────────────

  // ─────────── CLI wizard IPC removed (PR-I) ───────────
  // The first-run "find your claude binary" UI was deleted because CCSM
  // now ships the Claude binary inside the installer (PR-B). All
  // `cli:getInstallHints` / `cli:browseBinary` / `cli:setBinaryPath` /
  // `cli:openDocs` / `cli:retryDetect` handlers were removed — when the
  // SDK throws `ClaudeNotFoundError` the renderer surfaces the
  // installer-corrupt banner via the `CLAUDE_NOT_FOUND` errorCode that
  // `electron/agent/manager.ts` still emits.

  // Memory (CLAUDE.md) editor IPC. Paths are validated inside the memory
  // module — see isAllowedMemoryPath(). Only files named CLAUDE.md are
  // accepted; anything else returns an error so a compromised renderer can't
  // use us as an arbitrary-file-read primitive.
  ipcMain.handle('memory:read', (_e, p: string) => readMemoryFile(p));
  ipcMain.handle('memory:write', (_e, p: string, content: string) =>
    writeMemoryFile(p, content)
  );
  ipcMain.handle('memory:exists', (_e, p: string) => memoryFileExists(p));
  ipcMain.handle('memory:userPath', () => {
    // ~/.claude/CLAUDE.md. Resolved here so the renderer never has to know
    // about homedir semantics (different on Windows vs Unix).
    return path.join(os.homedir(), '.claude', 'CLAUDE.md');
  });
  ipcMain.handle('memory:projectPath', (_e, cwd: string) => {
    // We still force CLAUDE.md basename in the *write* path, but we compose
    // the full path here so the renderer doesn't have to remember the
    // filename. If cwd is empty or not absolute, return null so the UI can
    // show the "open a session" hint.
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return null;
    return path.join(cwd, 'CLAUDE.md');
  });

  ipcMain.handle(
    'notification:show',
    (e, payload: ShowNotificationPayload) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      return showNotification(payload, win);
    }
  );

  ipcMain.handle('notify:availability', async () => {
    const available = await probeNotifyAvailability();
    return { available, error: notifyLastError() };
  });

  // Renderer → main mirror of notification runtime state (#307). The
  // ask-question retry timer fires in main ~30s after the original toast;
  // by then the user may have toggled notifications off or focused the
  // question's session. The renderer's store is the source of truth, so
  // it pushes the two fields the retry gate needs (`notificationsEnabled`,
  // `activeSessionId`) whenever they change. Partial payload — both fields
  // are independently optional.
  ipcMain.handle(
    'notify:setRuntimeState',
    (
      e,
      patch: { notificationsEnabled?: boolean; activeSessionId?: string | null },
    ): { ok: true } | { ok: false } => {
      if (!fromMainFrame(e)) return { ok: false };
      setNotifyRuntimeState(patch);
      return { ok: true };
    },
  );

  installUpdaterIpc();

  // Dev-only debug backdoor for E2E probes. Probes call this via
  // `app.evaluate(() => globalThis.__ccsmDebug.activeSessionPids())` on
  // the Electron main process (NOT the renderer — we intentionally don't
  // widen preload.ts's surface for a test-only affordance). Guarded behind
  // `!app.isPackaged` so prod bundles never expose it.
  if (!app.isPackaged) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const notifyMod = require('./notify') as typeof import('./notify');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bootstrapMod = require('./notify-bootstrap') as typeof import('./notify-bootstrap');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const retryMod = require('./notify-retry') as typeof import('./notify-retry');
    (globalThis as unknown as Record<string, unknown>).__ccsmDebug = {
      activeSessionPids: () => sessions.activeRunnerPids(),
      activeSessionCount: () => sessions.activeSessionCount(),
      // Wave 1D: probe seam — exposed so `scripts/probe-e2e-notify-integration.mjs`
      // can swap the @ccsm/notify importer for a fake without resorting to
      // `require` from inside `app.evaluate` (where it's not in scope).
      notify: notifyMod,
      notifyBootstrap: bootstrapMod,
      // Wave 3 polish (#252): retry module exposed so the e2e probe can
      // install a fake scheduler (no real 30s wait) and assert the retry
      // fires once + cancels on resolve.
      notifyRetry: retryMod,
      sessions,
    };
  }

  createWindow();
  ensureTray();

  // Eager-load CLI transcripts so ImportDialog and the new-session cwd
  // default have data the moment the user opens them. Fire-and-forget;
  // refreshImportableCache logs its own errors and stores [] on failure so
  // getRecentCwds still resolves.
  void refreshImportableCache();
});

app.on('before-quit', () => {
  isQuitting = true;
  // Kill any live claude.exe children before the event loop is torn down.
  // `window-all-closed` already runs closeAll() on Windows/Linux, but on
  // macOS (and on the tray→Quit path that invokes app.quit() directly while
  // windows are hidden-not-closed) before-quit is our only guaranteed hook.
  // closeAll() is idempotent and synchronous (abort signals fire SIGTERM via
  // the spawner); a duplicate call from window-all-closed is a no-op.
  try {
    sessions.closeAll();
  } catch {
    /* ignore — best-effort cleanup on quit */
  }
});

app.on('window-all-closed', () => {
  // Tray-resident: do NOT quit on Windows/Linux when the window closes;
  // the user explicitly chose minimize-to-tray. macOS keeps its dock icon
  // by convention. Real quit goes through tray Quit / Cmd-Q.
  if (process.platform !== 'darwin' && isQuitting) {
    sessions.closeAll();
    closeDb();
    app.quit();
  } else if (process.platform === 'darwin') {
    // mac convention: keep app alive even when window closes; only quit on Cmd-Q
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
