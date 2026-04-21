import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, safeStorage, dialog, Notification, type MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { initDb, loadState, saveState, loadMessages, saveMessages, closeDb } from './db';
import { sessions } from './agent/manager';
import { installUpdaterIpc } from './updater';
import { scanImportableSessions } from './import-scanner';
import type { PermissionMode } from './agent/sessions';
import { EndpointsManager, type KeyCrypto } from './endpoints-manager';

const KEYCHAIN_FILE = 'anthropic-key.bin';

function keychainPath(): string {
  return path.join(app.getPath('userData'), KEYCHAIN_FILE);
}

function readApiKey(): string {
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    const p = keychainPath();
    if (!fs.existsSync(p)) return '';
    const buf = fs.readFileSync(p);
    return safeStorage.decryptString(buf);
  } catch {
    return '';
  }
}

function writeApiKey(value: string): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const p = keychainPath();
    if (!value) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return true;
    }
    const enc = safeStorage.encryptString(value);
    fs.writeFileSync(p, enc, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

const isDev = !app.isPackaged;

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
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: process.platform === 'darwin',
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
    app.setAppUserModelId('com.agentory.desktop');
  }
  initDb();

  const cryptoAdapter: KeyCrypto = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (cipher) => safeStorage.decryptString(cipher),
  };
  const endpoints = new EndpointsManager({ crypto: cryptoAdapter });

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

  // Endpoints + models IPC
  ipcMain.handle('endpoints:list', () => endpoints.listEndpoints());
  ipcMain.handle(
    'endpoints:add',
    (_e, input: { name: string; baseUrl: string; kind?: 'anthropic'; apiKey?: string; isDefault?: boolean }) =>
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
  ipcMain.handle('keychain:getApiKey', () => readApiKey());
  ipcMain.handle('keychain:setApiKey', (_e, value: string) => writeApiKey(value));
  ipcMain.handle('keychain:hasEncryption', () => safeStorage.isEncryptionAvailable());

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
    (
      _e,
      sessionId: string,
      opts: {
        cwd: string;
        model?: string;
        permissionMode?: PermissionMode;
        resumeSessionId?: string;
        endpointId?: string;
      }
    ) => {
      const envOverrides = resolveSessionEndpointEnv(opts.endpointId);
      // Fall back to the global keychain key only when no endpoint was chosen
      // or the endpoint has no stored key (user is still relying on parent
      // env). Per-endpoint keys always win.
      const apiKey = envOverrides?.ANTHROPIC_API_KEY ? undefined : readApiKey();
      return sessions.start(sessionId, { ...opts, apiKey, envOverrides });
    }
  );
  ipcMain.handle('agent:send', (_e, sessionId: string, text: string) =>
    sessions.send(sessionId, text)
  );
  ipcMain.handle('agent:interrupt', (_e, sessionId: string) => sessions.interrupt(sessionId));
  ipcMain.handle('agent:setPermissionMode', (_e, sessionId: string, mode: PermissionMode) =>
    sessions.setPermissionMode(sessionId, mode)
  );
  ipcMain.handle('agent:setModel', (_e, sessionId: string, model?: string) =>
    sessions.setModel(sessionId, model)
  );
  ipcMain.handle('agent:close', (_e, sessionId: string) => sessions.close(sessionId));
  ipcMain.handle(
    'agent:resolvePermission',
    (_e, sessionId: string, requestId: string, decision: 'allow' | 'deny') =>
      sessions.resolvePermission(sessionId, requestId, decision)
  );

  ipcMain.handle('import:scan', () => scanImportableSessions());

  ipcMain.handle(
    'notification:show',
    (e, payload: { sessionId: string; title: string; body?: string }) => {
      if (!Notification.isSupported()) return false;
      const win = BrowserWindow.fromWebContents(e.sender);
      const n = new Notification({
        title: payload.title,
        body: payload.body ?? '',
        silent: false
      });
      n.on('click', () => {
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
          win.webContents.send('notification:focusSession', payload.sessionId);
        }
      });
      n.show();
      return true;
    }
  );

  installUpdaterIpc();

  createWindow();
  ensureTray();
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
