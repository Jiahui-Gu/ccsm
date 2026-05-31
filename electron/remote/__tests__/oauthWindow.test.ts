import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runOauthPopup } from '../oauthWindow';

function fakeWindow() {
  const wc = new EventEmitter() as EventEmitter & { id: number };
  wc.id = 42;
  const win = {
    webContents: wc,
    loadURL: vi.fn(),
    close: vi.fn(),
    isDestroyed: () => false,
    on: (ev: string, cb: () => void) => {
      if (ev === 'closed') (win as unknown as { _onClosed?: () => void })._onClosed = cb;
    },
  };
  return { win, wc };
}

const ORIGIN = 'https://ccsm-worker.example.workers.dev';

describe('runOauthPopup', () => {
  it('resolves with authCode from the popup IPC message', async () => {
    const { win } = fakeWindow();
    const ipc = new EventEmitter();
    const p = runOauthPopup({
      workerOrigin: ORIGIN,
      createWindow: () => win as never,
      ipcMain: ipc as never,
      timeoutMs: 1000,
    });
    // simulate the popup preload forwarding the Worker postMessage
    ipc.emit('mobileRemote:oauthMessage', { sender: { id: 42 } }, { authCode: 'AC' });
    await expect(p).resolves.toEqual({ authCode: 'AC' });
    expect(win.loadURL).toHaveBeenCalledWith(`${ORIGIN}/auth/github/start`);
    expect(win.close).toHaveBeenCalled();
  });

  it('ignores messages from a different sender', async () => {
    const { win } = fakeWindow();
    const ipc = new EventEmitter();
    const p = runOauthPopup({
      workerOrigin: ORIGIN,
      createWindow: () => win as never,
      ipcMain: ipc as never,
      timeoutMs: 50,
    });
    ipc.emit('mobileRemote:oauthMessage', { sender: { id: 999 } }, { authCode: 'NOPE' });
    await expect(p).rejects.toThrow(/timeout/i);
  });

  it('rejects when the window is closed without a code', async () => {
    const { win } = fakeWindow();
    const ipc = new EventEmitter();
    const p = runOauthPopup({
      workerOrigin: ORIGIN,
      createWindow: () => win as never,
      ipcMain: ipc as never,
      timeoutMs: 1000,
    });
    (win as unknown as { _onClosed?: () => void })._onClosed?.();
    await expect(p).rejects.toThrow(/closed/i);
  });
});
