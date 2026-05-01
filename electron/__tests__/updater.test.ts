import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ----------------------------------------------------------------------------
// Mocks
//
// We mock both 'electron' and 'electron-updater' because the real modules
// can't run in Node (electron needs the binary; electron-updater probes the
// runtime environment on import). The mocks preserve enough behavior to
// verify our IPC wiring: handlers registered, status broadcasts emitted,
// periodic check scheduled.
// ----------------------------------------------------------------------------

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
type Listener = (payload: unknown) => void;

const ipcHandlers = new Map<string, IpcHandler>();
const webContentsSends: Array<{ channel: string; payload: unknown }> = [];
const autoUpdaterEmitter = new EventEmitter();
// Use a mutable object so the mock factories can close over a stable reference
// across `vi.resetModules()` re-imports. Reassigning primitives like
// `appIsPackaged = false` wouldn't take effect after reset, because the new
// mock factory snapshots its own binding — but a property on a persistent
// object works because the object identity survives.
const state = {
  appIsPackaged: true,
  appVersion: '0.1.2',
  appName: 'CCSM',
  checkForUpdatesImpl: (async () => ({ updateInfo: {} })) as () => Promise<unknown>,
  downloadUpdateImpl: (async () => undefined) as () => Promise<unknown>
};
const quitAndInstallCalls: Array<{ isSilent: boolean; isForceRunAfter: boolean }> = [];

vi.mock('electron', () => {
  const ipcMain = {
    handle: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler);
    }
  };
  const BrowserWindow = {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) =>
            webContentsSends.push({ channel, payload })
        }
      }
    ]
  };
  const app = {
    get isPackaged() {
      return state.appIsPackaged;
    },
    getVersion: () => state.appVersion,
    getName: () => state.appName
  };
  return { ipcMain, BrowserWindow, app };
});

vi.mock('electron-updater', () => {
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    logger: null as unknown,
    on: (event: string, listener: Listener) => {
      autoUpdaterEmitter.on(event, listener);
    },
    checkForUpdates: () => state.checkForUpdatesImpl(),
    downloadUpdate: () => state.downloadUpdateImpl(),
    quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => {
      quitAndInstallCalls.push({ isSilent, isForceRunAfter });
    }
  };
  return { autoUpdater };
});

function resetState() {
  ipcHandlers.clear();
  webContentsSends.length = 0;
  autoUpdaterEmitter.removeAllListeners();
  quitAndInstallCalls.length = 0;
  state.appIsPackaged = true;
  state.appVersion = '0.1.2';
  state.appName = 'CCSM';
  state.checkForUpdatesImpl = async () => ({ updateInfo: {} });
  state.downloadUpdateImpl = async () => undefined;
}

async function freshModule() {
  resetState();
  const mod = await import('../updater');
  mod.__resetUpdaterForTests();
  mod.installUpdaterIpc();
  return mod;
}

function sendsFor(channel: string) {
  return webContentsSends.filter((s) => s.channel === channel).map((s) => s.payload);
}

describe('updater: IPC wiring', () => {
  beforeEach(async () => {
    await freshModule();
  });

  it('registers all expected ipc handlers', () => {
    const expected = [
      'updates:status',
      'updates:check',
      'updates:download',
      'updates:install',
      'updates:getAutoCheck',
      'updates:setAutoCheck'
    ];
    for (const ch of expected) {
      expect(ipcHandlers.has(ch), `missing handler: ${ch}`).toBe(true);
    }
  });

  it('configures autoUpdater for autoDownload + autoInstallOnAppQuit', async () => {
    const { autoUpdater } = await import('electron-updater');
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('leaves allowPrerelease=false for the prod variant (#891)', async () => {
    const { autoUpdater } = await import('electron-updater');
    // Default reset state has appName='CCSM' so installUpdaterIpc must NOT
    // flip allowPrerelease — prod users only see stable releases.
    expect(autoUpdater.allowPrerelease).toBe(false);
  });

  it('flips allowPrerelease=true for the dev variant (#891)', async () => {
    // Override appName before re-importing so the dual-install branch fires.
    state.appName = 'CCSM Dev';
    const mod = await import('../updater');
    mod.__resetUpdaterForTests();
    // Reset the mock field too — module-scoped mock object survives across
    // freshModule() calls in beforeEach, so the prior installUpdaterIpc may
    // have left it at its default. Force a known starting point.
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.allowPrerelease = false;
    mod.installUpdaterIpc();
    expect(autoUpdater.allowPrerelease).toBe(true);
  });

  it('broadcasts status on update-available and fires update:available channel', () => {
    autoUpdaterEmitter.emit('update-available', { version: '1.2.3', releaseDate: '2026-01-01' });

    const statusSends = sendsFor('updates:status');
    expect(statusSends).toContainEqual({
      kind: 'available',
      version: '1.2.3',
      releaseDate: '2026-01-01'
    });

    const availableSends = sendsFor('update:available');
    expect(availableSends).toContainEqual({ version: '1.2.3', releaseDate: '2026-01-01' });
  });

  it('broadcasts status on update-downloaded and fires update:downloaded channel', () => {
    autoUpdaterEmitter.emit('update-downloaded', { version: '1.2.3' });

    expect(sendsFor('updates:status')).toContainEqual({ kind: 'downloaded', version: '1.2.3' });
    expect(sendsFor('update:downloaded')).toContainEqual({ version: '1.2.3' });
  });

  it('broadcasts status on error and fires update:error channel', () => {
    autoUpdaterEmitter.emit('error', new Error('network down'));

    expect(sendsFor('updates:status')).toContainEqual({ kind: 'error', message: 'network down' });
    expect(sendsFor('update:error')).toContainEqual({ message: 'network down' });
  });

  it('updates:check returns not-available in dev (unpackaged) without calling autoUpdater', async () => {
    // Switch to dev mode after the default freshModule() in beforeEach; the
    // app.isPackaged getter reads state at call time so this takes effect.
    state.appIsPackaged = false;

    let checkCalled = false;
    state.checkForUpdatesImpl = async () => {
      checkCalled = true;
      return { updateInfo: {} };
    };

    const handler = ipcHandlers.get('updates:check')!;
    const result = await handler({});
    expect(result).toEqual({ kind: 'not-available', version: '0.1.2' });
    expect(checkCalled).toBe(false);
  });

  it('updates:check surfaces autoUpdater errors through the status channel', async () => {
    state.checkForUpdatesImpl = async () => {
      throw new Error('boom');
    };
    const handler = ipcHandlers.get('updates:check')!;
    const result = (await handler({})) as { kind: string; message: string };
    expect(result.kind).toBe('error');
    expect(result.message).toBe('boom');
    expect(sendsFor('updates:status')).toContainEqual({ kind: 'error', message: 'boom' });
  });

  it('updates:install calls quitAndInstall with visible installer + relaunch', async () => {
    // Defense-in-depth gate (#TBD): updates:install refuses unless
    // lastStatus is `downloaded`. Drive the broadcast first so the
    // handler can proceed.
    autoUpdaterEmitter.emit('update-downloaded', { version: '0.1.3' });
    const handler = ipcHandlers.get('updates:install')!;
    const res = await handler({});
    expect(res).toEqual({ ok: true });
    // quitAndInstall is scheduled via setImmediate — flush it.
    await new Promise((r) => setImmediate(r));
    expect(quitAndInstallCalls).toEqual([{ isSilent: false, isForceRunAfter: true }]);
  });

  it('updates:install refuses when no download has completed', async () => {
    // No `update-downloaded` event broadcast → lastStatus stays `idle`.
    // The defense-in-depth gate must short-circuit before quitAndInstall.
    const handler = ipcHandlers.get('updates:install')!;
    const res = await handler({});
    expect(res).toEqual({ ok: false, reason: 'not-ready' });
    expect(quitAndInstallCalls).toEqual([]);
  });

  it('updates:install refuses when not packaged', async () => {
    state.appIsPackaged = false;
    const handler = ipcHandlers.get('updates:install')!;
    const res = await handler({});
    expect(res).toEqual({ ok: false, reason: 'not-packaged' });
  });

  it('updates:download proxies to autoUpdater.downloadUpdate()', async () => {
    let called = false;
    state.downloadUpdateImpl = async () => {
      called = true;
    };
    const handler = ipcHandlers.get('updates:download')!;
    const res = await handler({});
    expect(res).toEqual({ ok: true });
    expect(called).toBe(true);
  });

  it('updates:setAutoCheck toggles the preference', async () => {
    const setHandler = ipcHandlers.get('updates:setAutoCheck')!;
    const getHandler = ipcHandlers.get('updates:getAutoCheck')!;
    expect(await getHandler({})).toBe(true);
    expect(await setHandler({}, false)).toBe(false);
    expect(await getHandler({})).toBe(false);
    expect(await setHandler({}, true)).toBe(true);
  });

  it('updates:status returns the last broadcast status', async () => {
    autoUpdaterEmitter.emit('update-available', { version: '9.9.9' });
    const handler = ipcHandlers.get('updates:status')!;
    const res = await handler({});
    expect(res).toEqual({ kind: 'available', version: '9.9.9', releaseDate: undefined });
  });
});
