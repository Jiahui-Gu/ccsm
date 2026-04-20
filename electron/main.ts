import { app, BrowserWindow, Menu, ipcMain, safeStorage, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { initDb, loadState, saveState, closeDb } from './db';
import { sessions } from './agent/manager';
import { installUpdaterIpc } from './updater';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

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

// Hide the default application menu — Agentory is a single-window tool and
// File/Edit/View/Window/Help adds noise without value. DevTools still opens
// via openDevTools in dev.
Menu.setApplicationMenu(null);

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
    titleBarStyle: 'default',
    frame: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (isDev) {
    win.loadURL('http://localhost:4100');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  sessions.bindSender(win.webContents);
}

app.whenReady().then(() => {
  initDb();
  ipcMain.handle('db:load', (_e, key: string) => loadState(key));
  ipcMain.handle('db:save', (_e, key: string, value: string) => saveState(key, value));
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

  ipcMain.handle(
    'agent:start',
    (
      _e,
      sessionId: string,
      opts: { cwd: string; model?: string; permissionMode?: PermissionMode; resumeSessionId?: string }
    ) => {
      const apiKey = readApiKey();
      return sessions.start(sessionId, { ...opts, apiKey });
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

  installUpdaterIpc();

  createWindow();
});

app.on('window-all-closed', () => {
  sessions.closeAll();
  closeDb();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
