import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, safeStorage, dialog, shell, type MenuItemConstructorOptions } from 'electron';
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
import { sessions } from './agent/manager';
import { resolveCwd } from './agent/sessions';
import { installUpdaterIpc } from './updater';
import {
  scanImportableSessions,
  deriveRecentCwds,
  deriveTopModel,
  type ScannableSession,
} from './import-scanner';
import { showNotification, type ShowNotificationPayload } from './notifications';
import type { PermissionMode } from './agent/sessions';
import { EndpointsManager, type KeyCrypto } from './endpoints-manager';
import { ClaudeNotFoundError, detectClaudeVersion, resolveClaudeBinary } from './agent/binary-resolver';
import { readMemoryFile, writeMemoryFile, memoryFileExists } from './memory';
import {
  runPreflight,
  createPr,
  fetchPrChecks,
  type CreatePrArgs
} from './pr';

const isDev = !app.isPackaged;

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

// We don't want a visible File/Edit/View menu bar — Agentory is a single-
// window tool and those menus add noise. But on Windows/Linux, setting the
// app menu to null also removes the built-in Edit-role accelerators
// (Ctrl+C / Ctrl+V / Ctrl+X / Ctrl+A / Ctrl+Z), which makes chat content
// feel "not copyable". Install a minimal, hidden app menu whose only job
// is to carry those accelerators, and hide the menu bar so it's not
// visible. On macOS, the default app menu already handles this.
if (process.platform === 'darwin') {
  // Let Electron use its default macOS menu.
} else {
  const accelMenu = Menu.buildFromTemplate([
    {
      label: '&Edit',
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
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.setMenuBarVisibility(false);

  if (isDev) {
    const port = process.env.AGENTORY_DEV_PORT || '4100';
    win.loadURL(`http://localhost:${port}`);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  installContextMenu(win);
  sessions.bindSender(win.webContents);

  const emitMax = () => win.webContents.send('window:maximizedChanged', win.isMaximized());
  win.on('maximize', emitMax);
  win.on('unmaximize', emitMax);

  // Minimize-to-tray: clicking close (or the OS X red dot, our own custom
  // close button via window:close IPC) hides the window instead of quitting.
  // The user can still really quit via the tray menu's Quit item, the
  // app menu's Quit, or Cmd/Ctrl-Q.
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
    if (process.platform === 'darwin') app.dock?.hide?.();
  });
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

function ensureTray() {
  if (tray) return tray;
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('Agentory');
  const showWindow = () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (process.platform === 'darwin') app.dock?.show?.();
  };
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Agentory', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  return tray;
}

app.whenReady().then(() => {
  // On Windows, notifications need a stable AppUserModelID so the OS knows
  // which app the toast belongs to (otherwise it shows "electron.exe").
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.agentory.next');
  }
  initDb();

  const cryptoAdapter: KeyCrypto = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (cipher) => safeStorage.decryptString(cipher),
  };
  const endpoints = new EndpointsManager({
    crypto: cryptoAdapter,
  });

  // First-run migration: if the parent env has ANTHROPIC_BASE_URL set and no
  // endpoints exist yet, seed a "Default" endpoint with the env key so the
  // self-host user flow Just Works on first launch. If neither is set, stay
  // empty — the user will add endpoints via Settings.
  void seedDefaultEndpointFromEnv(endpoints);

  ipcMain.handle('db:load', (_e, key: string) => loadState(key));
  ipcMain.handle('db:save', (_e, key: string, value: string) => saveState(key, value));
  ipcMain.handle('db:loadMessages', (_e, sessionId: string) => loadMessages(sessionId));
  ipcMain.handle(
    'db:saveMessages',
    (_e, sessionId: string, blocks: Array<{ id: string; kind: string }>) =>
      saveMessages(sessionId, blocks)
  );

  // i18n: renderer mirrors the resolved UI language to main so OS
  // notifications use it. Renderer also asks main for the OS locale at
  // boot to seed the "system" preference. Imports at the top of the file
  // would create a circular ts-tree edge with electron/i18n.ts; doing the
  // require here keeps the import graph linear.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const i18n = require('./i18n') as typeof import('./i18n');
  ipcMain.handle('agentory:get-system-locale', () => {
    try {
      return app.getLocale();
    } catch {
      return undefined;
    }
  });
  ipcMain.on('agentory:set-language', (_e, lang: unknown) => {
    if (lang === 'en' || lang === 'zh') i18n.setMainLanguage(lang);
  });
  // Seed the active language from the OS at boot, before any window is
  // created — first notification fires with the right copy even if the
  // renderer hasn't dispatched yet.
  try {
    i18n.setMainLanguage(i18n.resolveSystemLanguage(app.getLocale()));
  } catch {
    /* ignore — falls through to the default 'en' */
  }

  // Endpoints + models IPC
  ipcMain.handle('endpoints:list', () => endpoints.listEndpoints());
  ipcMain.handle(
    'endpoints:add',
    (_e, input: { name: string; baseUrl: string; kind?: import('./endpoints-manager').EndpointKind; apiKey?: string; isDefault?: boolean }) =>
      endpoints.addEndpoint(input)
  );
  ipcMain.handle(
    'endpoints:update',
    (
      _e,
      id: string,
      patch: { name?: string; baseUrl?: string; apiKey?: string | null; isDefault?: boolean }
    ) => endpoints.updateEndpoint(id, patch)
  );
  ipcMain.handle('endpoints:remove', (_e, id: string) => endpoints.removeEndpoint(id));
  ipcMain.handle(
    'endpoints:testConnection',
    (_e, args: { baseUrl: string; apiKey: string }) => endpoints.testConnection(args)
  );
  ipcMain.handle('endpoints:refreshModels', (_e, id: string) => endpoints.refreshModels(id));
  ipcMain.handle(
    'endpoints:setManualModels',
    (_e, id: string, ids: string[]) => endpoints.setManualModelIds(id, Array.isArray(ids) ? ids : [])
  );
  ipcMain.handle(
    'endpoints:createMessage',
    (
      _e,
      args: {
        endpointId: string;
        model: string;
        maxTokens?: number;
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        system?: string;
      }
    ) => endpoints.createMessage(args)
  );
  ipcMain.handle('models:listByEndpoint', (_e, id: string) => endpoints.listModels(id));
  ipcMain.handle('models:listAll', () => endpoints.listModelsAll());

  // Main-process helper: resolve a session's endpoint env (base URL + plain
  // key) so the spawner can inject them per-session without the renderer ever
  // touching the plaintext key. Returns null if endpointId is unknown.
  function resolveSessionEndpointEnv(
    endpointId: string | undefined
  ): Record<string, string> | undefined {
    if (!endpointId) return undefined;
    const ep = endpoints.getEndpoint(endpointId);
    if (!ep) return undefined;
    const overrides: Record<string, string> = {};
    overrides.ANTHROPIC_BASE_URL = ep.baseUrl;
    const key = endpoints.getPlainKey(endpointId);
    if (key) {
      overrides.ANTHROPIC_API_KEY = key;
      overrides.ANTHROPIC_AUTH_TOKEN = key;
    }
    return overrides;
  }
  // Expose for agent:start below.
  (global as unknown as { __agentoryEndpointEnv?: typeof resolveSessionEndpointEnv }).__agentoryEndpointEnv =
    resolveSessionEndpointEnv;
  ipcMain.handle('app:getDataDir', () => app.getPath('userData'));
  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('dialog:pickDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Choose working directory'
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

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
      _e,
      sessionId: string,
      opts: {
        cwd: string;
        model?: string;
        permissionMode?: PermissionMode;
        resumeSessionId?: string;
        endpointId?: string;
        allowedTools?: readonly string[];
        disallowedTools?: readonly string[];
      }
    ) => {
      // Guard against stale `cwd` paths that no longer exist on disk. Common
      // failure mode: a session was created inside a now-deleted worktree
      // (the Sept worktree feature was reverted in #104), so its persisted
      // `cwd` points at `.claude/worktrees/agent-xxx`. Spawning would crash
      // with ENOENT inside SessionRunner; catching here gives the renderer a
      // clean error code it can surface as "repick your folder".
      const resolvedCwd = resolveCwd(opts.cwd);
      if (!fs.existsSync(resolvedCwd)) {
        return {
          ok: false,
          error: `Working directory no longer exists: ${opts.cwd}`,
          errorCode: 'CWD_MISSING' as const,
        };
      }

      const envOverrides = resolveSessionEndpointEnv(opts.endpointId);
      const binaryPath = loadClaudeBinPath() ?? undefined;

      const result = await sessions.start(sessionId, {
        ...opts,
        envOverrides,
        binaryPath,
      });

      return result;
    }
  );
  ipcMain.handle('agent:send', (_e, sessionId: string, text: string) =>
    sessions.send(sessionId, text)
  );
  ipcMain.handle(
    'agent:sendContent',
    (_e, sessionId: string, content: unknown[]) =>
      sessions.sendContent(sessionId, Array.isArray(content) ? content : [])
  );
  ipcMain.handle('agent:interrupt', (_e, sessionId: string) => sessions.interrupt(sessionId));
  ipcMain.handle('agent:setPermissionMode', (_e, sessionId: string, mode: PermissionMode) =>
    sessions.setPermissionMode(sessionId, mode)
  );
  ipcMain.handle('agent:setModel', (_e, sessionId: string, model?: string) =>
    sessions.setModel(sessionId, model)
  );
  ipcMain.handle('agent:close', (_e, sessionId: string) => {
    return sessions.close(sessionId);
  });

  ipcMain.handle(
    'agent:resolvePermission',
    (_e, sessionId: string, requestId: string, decision: 'allow' | 'deny') =>
      sessions.resolvePermission(sessionId, requestId, decision)
  );

  ipcMain.handle('import:scan', () => getImportableSessions());
  ipcMain.handle('import:recentCwds', () => getRecentCwds());
  ipcMain.handle('import:topModel', () => getTopModel());

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
      try {
        out[p] = fs.existsSync(resolveCwd(p));
      } catch {
        out[p] = false;
      }
    }
    return out;
  });

  // ───────────────────────────── /pr flow ──────────────────────────────────
  //
  // Renderer → main IPC for preflight checks, PR creation, and CI polling.
  // All spawn() happens in main; the renderer never touches git / gh /
  // process.env.PATH directly. See electron/pr.ts for the helpers.
  ipcMain.handle('pr:preflight', (_e, cwd: string | null | undefined) => runPreflight(cwd));
  ipcMain.handle(
    'pr:create',
    (_e, args: CreatePrArgs) => createPr(args)
  );
  ipcMain.handle(
    'pr:checks',
    (_e, cwd: string, number: number) => fetchPrChecks(cwd, number)
  );
  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    // Only http(s). Everything else is a potential shell hijack.
    if (!/^https?:\/\//i.test(url)) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });
  // ──────────────────────────── end /pr flow ───────────────────────────────

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
  // The persisted path wins over $AGENTORY_CLAUDE_BIN and PATH on subsequent
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
      title: 'Select claude binary',
      filters,
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle(
    'cli:setBinaryPath',
    async (_e, rawPath: string): Promise<
      { ok: true; version: string | null } | { ok: false; error: string }
    > => {
      const p = typeof rawPath === 'string' ? rawPath.trim() : '';
      if (!p) return { ok: false, error: 'Empty path' };
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

  installUpdaterIpc();

  createWindow();
  ensureTray();

  // Eager-load CLI transcripts so ImportDialog and the new-session cwd
  // default have data the moment the user opens them. Fire-and-forget;
  // refreshImportableCache logs its own errors and stores [] on failure so
  // getRecentCwds still resolves.
  void refreshImportableCache();

  // Boot-time model discovery: kick off `refreshModels` for every persisted
  // endpoint so the UI sees model lists without the user having to click
  // "Refresh models" first. Run sequentially (one endpoint at a time) — the
  // discovery is local-only (settings.json + env), but serialising avoids any
  // pathological file-read contention if a relay sets up many endpoints.
  // setImmediate so we don't add to the synchronous boot path; everything
  // here is fire-and-forget — results land in sqlite, IPC `models:listByEndpoint`
  // picks them up on next read.
  setImmediate(() => {
    void (async () => {
      const allEndpoints = endpoints.listEndpoints();
      for (const ep of allEndpoints) {
        try {
          await endpoints.refreshModels(ep.id);
        } catch (err) {
          console.warn(`[boot-discover] refresh failed for ${ep.id}:`, err);
        }
      }
    })();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
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

async function seedDefaultEndpointFromEnv(mgr: EndpointsManager): Promise<void> {
  try {
    const existing = mgr.listEndpoints();
    if (existing.length > 0) return;
    const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
    if (!baseUrl) return;
    const envKey =
      process.env.ANTHROPIC_API_KEY?.trim() ||
      process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
      '';
    const row = mgr.addEndpoint({
      name: 'Default',
      baseUrl,
      kind: 'anthropic',
      apiKey: envKey || undefined,
      isDefault: true,
    });
    // Best-effort initial refresh. Failures are surfaced via the row's
    // last_status — we don't block startup on this.
    void mgr.refreshModels(row.id).catch(() => {});
  } catch (err) {
    console.warn('[main] seedDefaultEndpointFromEnv failed', err);
  }
}
