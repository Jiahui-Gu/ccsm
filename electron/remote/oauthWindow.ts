// electron/remote/oauthWindow.ts
import path from 'node:path';
import type { BrowserWindow, IpcMain, BrowserWindowConstructorOptions } from 'electron';

const OAUTH_MESSAGE = 'mobileRemote:oauthMessage';

export function runOauthPopup(opts: {
  workerOrigin: string;
  parent?: BrowserWindow;
  timeoutMs?: number;
  createWindow?: (o: BrowserWindowConstructorOptions) => BrowserWindow;
  ipcMain?: IpcMain;
}): Promise<{ authCode: string }> {
  // Lazy electron import so this module is testable in plain Node.
  const electron =
    opts.createWindow && opts.ipcMain
      ? null
      : // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require('electron') as typeof import('electron'));
  const make = opts.createWindow ?? ((o) => new electron!.BrowserWindow(o));
  const ipc = opts.ipcMain ?? electron!.ipcMain;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const win = make({
    width: 520,
    height: 640,
    modal: !!opts.parent,
    parent: opts.parent,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'oauthPopupPreload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  return new Promise<{ authCode: string }>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      cleanup();
      fn();
    };

    const onMessage = (ev: { sender: { id: number } }, msg: unknown) => {
      if (ev.sender?.id !== win.webContents.id) return;
      const code = (msg as { authCode?: unknown })?.authCode;
      if (typeof code === 'string' && code) finish(() => resolve({ authCode: code }));
    };
    const onClosed = () => finish(() => reject(new Error('oauth window closed')));
    const timer = setTimeout(() => finish(() => reject(new Error('oauth timeout'))), timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      ipc.removeListener(OAUTH_MESSAGE, onMessage as never);
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        /* ignore */
      }
    }

    ipc.on(OAUTH_MESSAGE, onMessage as never);
    win.on('closed', onClosed);
    win.loadURL(`${opts.workerOrigin}/auth/github/start`);
  });
}
