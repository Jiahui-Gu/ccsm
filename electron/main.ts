import * as Sentry from '@sentry/electron/main';
import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, type MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  initDb,
  loadState,
  saveState,
  loadMessages,
  saveMessages,
  closeDb,
  loadClaudeBinPath,
  saveClaudeBinPath,
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
  lookupToastTarget,
  consumeToastTarget,
} from './notify-bootstrap';
import { cancelQuestionRetry } from './notify-retry';
import type { PermissionMode } from './agent/sessions';
import { listModelsFromSettings } from './agent/list-models-from-settings';
import { ClaudeNotFoundError, detectClaudeVersion, resolveClaudeBinary } from './agent/binary-resolver';
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
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
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
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
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
    bootstrapNotify((event) => {
      const target = lookupToastTarget(event.toastId);
      if (!target) return;
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (target.kind === 'permission') {
        // The toastId for permission events IS the requestId (see lifecycle.ts
        // → permissionRequestToWaitingBlock). Resolve the underlying CLI
        // permission gate and notify the renderer so it can update its
        // waiting-block UI + (for `allow-always`) seed `allowAlwaysTools`.
        const requestId = event.toastId;
        if (event.action === 'allow' || event.action === 'allow-always') {
          sessions.resolvePermission(target.sessionId, requestId, 'allow');
        } else if (event.action === 'reject') {
          sessions.resolvePermission(target.sessionId, requestId, 'deny');
        }
        if (win) {
          win.webContents.send('notify:toastAction', {
            sessionId: target.sessionId,
            requestId,
            action: event.action,
          });
        }
        consumeToastTarget(event.toastId);
      } else if (target.kind === 'question' || target.kind === 'turn_done') {
        // Questions + turn_done only carry `focus`; other actions are no-ops
        // here (the renderer drives the actual answer flow once focused).
        consumeToastTarget(event.toastId);
      }
      // Always raise the window on any action — the user clicked the toast,
      // they want to see ccsm. Mirrors the existing `notification:focusSession`
      // path used by the legacy Electron Notification.
      if (win) {
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.focus();
        win.webContents.send('notification:focusSession', target.sessionId);
      }
    });
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
  ipcMain.handle('db:loadMessages', (e, sessionId: string) => {
    if (!fromMainFrame(e)) return [];
    return loadMessages(sessionId);
  });
  // Cap renderer-supplied message payloads. The DB column is unbounded TEXT,
  // so a buggy or malicious renderer could otherwise pin the WAL with
  // gigabytes of JSON and balloon `~/.config/.../ccsm.db` past disk
  // budget. The caps below are well above any legitimate session:
  //   - 64 chars per sessionId (sessions are uuid-ish ~36 chars)
  //   - 50_000 blocks per session (current cap on history retention)
  //   - 1 MB per individual block JSON (a single block this large is a bug)
  const MAX_SESSION_ID_LEN = 64;
  const MAX_BLOCKS = 50_000;
  const MAX_BLOCK_BYTES = 1_000_000;
  ipcMain.handle(
    'db:saveMessages',
    (
      e,
      sessionId: string,
      blocks: Array<{ id: string; kind: string }>
    ): { ok: true } | { ok: false; error: string } => {
      if (!fromMainFrame(e)) return { ok: false, error: 'rejected' };
      if (typeof sessionId !== 'string' || sessionId.length > MAX_SESSION_ID_LEN) {
        return { ok: false, error: 'payload_too_large' };
      }
      if (!Array.isArray(blocks) || blocks.length > MAX_BLOCKS) {
        return { ok: false, error: 'payload_too_large' };
      }
      const filtered: Array<{ id: string; kind: string }> = [];
      for (const b of blocks) {
        try {
          const json = JSON.stringify(b);
          if (json.length > MAX_BLOCK_BYTES) {
            console.warn(
              `[main] db:saveMessages dropping oversized block (${json.length} bytes) for session=${sessionId}`
            );
            continue;
          }
          filtered.push(b);
        } catch {
          console.warn('[main] db:saveMessages dropping unserializable block');
        }
      }
      saveMessages(sessionId, filtered);
      return { ok: true };
    }
  );

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

      // Validate the persisted path exists on disk. A stale entry (e.g. from a
      // dev probe whose temp dir was GC'd) would otherwise be passed to the
      // spawner verbatim, bypassing resolveClaudeBinary() and producing an
      // opaque "system cannot find the path specified" exit instead of the
      // CLI-missing dialog. Self-heal by clearing the dead value so subsequent
      // launches fall through to PATH lookup / first-run wizard.
      const persisted = loadClaudeBinPath();
      const binaryPath =
        persisted && fs.existsSync(persisted) ? persisted : undefined;
      if (persisted && !binaryPath) {
        saveClaudeBinPath(null);
      }

      const result = await sessions.start(sessionId, {
        ...opts,
        binaryPath,
      });

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

  // ───────────────────────────── CLI wizard ────────────────────────────────
  //
  // First-run detection flow: renderer polls `cli:retryDetect` on mount, and
  // the store opens a blocking modal when found=false. User then either:
  //   (a) copies an install command from `cli:getInstallHints` → installs
  //       externally → clicks Retry;
  //   (b) clicks Browse → `cli:browseBinary` → `cli:setBinaryPath` persists
  //       their pick to `app_state`;
  //   (c) clicks the docs link → `cli:openDocs`.
  //
  // The persisted path wins over $CCSM_CLAUDE_BIN and PATH on subsequent
  // `agent:start` (see handler above). Intentionally no bundled binary and no
  // auto-downloader — both would drag us into code-signing + update infra that
  // is out of scope for MVP (and legally murky for claude.exe specifically).
  const CLAUDE_DOCS_URL = 'https://code.claude.com/docs/en/setup';

  ipcMain.handle('cli:getInstallHints', () => {
    const platform = process.platform;
    const arch = process.arch;
    const NPM = 'npm install -g @anthropic-ai/claude-code';
    if (platform === 'win32') {
      return {
        os: 'win32',
        arch,
        commands: {
          native: 'irm https://claude.ai/install.ps1 | iex',
          packageManager: 'winget install Anthropic.ClaudeCode',
          npm: NPM,
        },
        docsUrl: CLAUDE_DOCS_URL,
      };
    }
    if (platform === 'darwin') {
      return {
        os: 'darwin',
        arch,
        commands: {
          native: 'curl -fsSL https://claude.ai/install.sh | bash',
          packageManager: 'brew install --cask claude-code',
          npm: NPM,
        },
        docsUrl: CLAUDE_DOCS_URL,
      };
    }
    return {
      os: platform,
      arch,
      commands: {
        native: 'curl -fsSL https://claude.ai/install.sh | bash',
        npm: NPM,
      },
      docsUrl: CLAUDE_DOCS_URL,
    };
  });

  ipcMain.handle('cli:browseBinary', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const filters =
      process.platform === 'win32'
        ? [
            { name: 'Executables', extensions: ['exe', 'cmd', 'bat'] },
            { name: 'All files', extensions: ['*'] },
          ]
        : [{ name: 'All files', extensions: ['*'] }];
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: i18n.tDialog('selectClaude'),
      filters,
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle(
    'cli:setBinaryPath',
    async (e, rawPath: string): Promise<
      { ok: true; version: string | null } | { ok: false; error: string }
    > => {
      if (!fromMainFrame(e)) return { ok: false, error: 'rejected' };
      const p = typeof rawPath === 'string' ? rawPath.trim() : '';
      if (!p) return { ok: false, error: 'Empty path' };
      // Refuse UNC / non-absolute. The browse dialog only emits absolute
      // local paths, so an unsafe input here is always a hand-crafted call.
      if (!isSafePath(p)) return { ok: false, error: 'Invalid path' };
      try {
        if (!fs.existsSync(p)) return { ok: false, error: 'File does not exist' };
        const stat = fs.statSync(p);
        if (!stat.isFile()) return { ok: false, error: 'Not a regular file' };
        // POSIX: require exec bit. Windows has no concept of it — `fs.access(X_OK)`
        // falls back to checking PATHEXT, which for an absolute path is moot; we
        // rely on `--version` succeeding below instead.
        if (process.platform !== 'win32') {
          try {
            fs.accessSync(p, fs.constants.X_OK);
          } catch {
            return { ok: false, error: 'File is not executable' };
          }
        }
        const version = await detectClaudeVersion(p);
        if (version === null) {
          return {
            ok: false,
            error: 'Could not verify binary: `--version` failed or timed out',
          };
        }
        saveClaudeBinPath(p);
        return { ok: true, version };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcMain.handle('cli:openDocs', async () => {
    await shell.openExternal(CLAUDE_DOCS_URL);
    return true;
  });

  ipcMain.handle(
    'cli:retryDetect',
    async (): Promise<
      { found: true; path: string; version: string | null } | { found: false; searchedPaths: string[] }
    > => {
      // Persisted path wins: if the user already picked one, try that first
      // (and refresh its version). Don't silently wipe it on failure — the
      // user may have renamed / temporarily moved the binary; let them
      // re-pick explicitly.
      const persisted = loadClaudeBinPath();
      if (persisted) {
        if (fs.existsSync(persisted)) {
          const version = await detectClaudeVersion(persisted);
          if (version !== null) return { found: true, path: persisted, version };
        }
      }
      try {
        const path = await resolveClaudeBinary();
        const version = await detectClaudeVersion(path);
        return { found: true, path, version };
      } catch (err) {
        if (err instanceof ClaudeNotFoundError) {
          return { found: false, searchedPaths: err.searchedPaths };
        }
        return { found: false, searchedPaths: [err instanceof Error ? err.message : String(err)] };
      }
    }
  );
  // ────────────────────────── end CLI wizard ───────────────────────────────

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
