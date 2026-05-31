import { describe, it, expect, vi } from 'vitest';
import { registerMobileRemoteIpc } from '../mobileRemoteIpc';
import { MOBILE_REMOTE_CHANNELS } from '../../shared/ipcChannels';
import type { SessionStore } from '../../remote/sessionStore';

function fakeIpc() {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    },
    invoke: (ch: string, ...a: unknown[]) => handlers.get(ch)!(...a),
  };
}
function memStore(loggedIn: boolean): SessionStore {
  let s = loggedIn
    ? { token: 'T', doUrl: 'wss://d', userHash: 'h', expiresAtMs: Date.now() + 60_000 }
    : null;
  return {
    load: () => s,
    save: (x) => {
      s = x;
    },
    clear: () => {
      s = null;
    },
    isPersistAvailable: () => true,
  };
}

// Event shaped so the fromMainFrame guard (senderFrame === sender.mainFrame)
// passes — login/logout are guarded; these tests exercise the flow itself.
function mainFrameEvent(): unknown {
  const mainFrame = { id: 1 };
  return { sender: { mainFrame }, senderFrame: mainFrame };
}

describe('registerMobileRemoteIpc', () => {
  it('login runs the flow and restarts the peer', async () => {
    const { ipcMain, invoke } = fakeIpc();
    const store = memStore(false);
    const restart = vi.fn();
    registerMobileRemoteIpc({
      ipcMain: ipcMain as never,
      store,
      restartMobileRemote: restart,
      broadcast: () => {},
      doLogin: async () => ({ loggedIn: true, userHash: 'h', expiresAtMs: 123, persisted: true }),
    });
    const state = await invoke(MOBILE_REMOTE_CHANNELS.login, mainFrameEvent());
    expect(state).toMatchObject({ loggedIn: true, userHash: 'h' });
    expect(restart).toHaveBeenCalled();
  });

  it('logout clears the store and restarts the peer', async () => {
    const { ipcMain, invoke } = fakeIpc();
    const store = memStore(true);
    const restart = vi.fn();
    registerMobileRemoteIpc({
      ipcMain: ipcMain as never,
      store,
      restartMobileRemote: restart,
      broadcast: () => {},
      doLogin: async () => ({
        loggedIn: false,
        userHash: null,
        expiresAtMs: null,
        persisted: true,
      }),
    });
    const state = await invoke(MOBILE_REMOTE_CHANNELS.logout, mainFrameEvent());
    expect(store.load()).toBeNull();
    expect(state).toMatchObject({ loggedIn: false });
    expect(restart).toHaveBeenCalled();
  });

  it('authState reflects the store', async () => {
    const { ipcMain, invoke } = fakeIpc();
    registerMobileRemoteIpc({
      ipcMain: ipcMain as never,
      store: memStore(true),
      restartMobileRemote: () => {},
      broadcast: () => {},
      doLogin: async () => ({
        loggedIn: false,
        userHash: null,
        expiresAtMs: null,
        persisted: true,
      }),
    });
    const state = (await invoke(MOBILE_REMOTE_CHANNELS.authState)) as { loggedIn: boolean };
    expect(state.loggedIn).toBe(true);
  });
});
