// Security gate around the mobile-remote login / logout IPC handlers.
//
// `login` triggers an OAuth flow and restarts the remote server; `logout`
// clears the persisted session and restarts the server. Both are privileged
// and state-mutating, so they must confirm the message came from our
// top-level renderer frame before acting. `authState` is read-only and
// intentionally stays unguarded.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MOBILE_REMOTE_CHANNELS } from '../../shared/ipcChannels';
import type { SessionStore } from '../../remote/sessionStore';
import type { MobileRemoteAuthState } from '../../remote/oauthLogin';

vi.mock('electron', () => ({}));

// Mock the security guard. Default: accept; tests can flip to reject.
let allowGuard = true;
vi.mock('../../security/ipcGuards', () => ({
  fromMainFrame: (_e: unknown) => allowGuard,
}));

import { registerMobileRemoteIpc } from '../mobileRemoteIpc';

type Handler = (e: unknown, ...args: unknown[]) => Promise<MobileRemoteAuthState>;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (ch: string, fn: Handler) => handlers.set(ch, fn),
    on: (ch: string, fn: Handler) => handlers.set(ch, fn),
  } as unknown as Electron.IpcMain;
  return { ipcMain, handlers };
}

const loggedOutState: MobileRemoteAuthState = {
  loggedIn: false,
  userHash: null,
  expiresAtMs: null,
  persisted: false,
};
const loggedInState: MobileRemoteAuthState = {
  loggedIn: true,
  userHash: 'abc',
  expiresAtMs: Date.now() + 60_000,
  persisted: false,
};

const fakeEvent = {} as Electron.IpcMainInvokeEvent;

describe('mobile-remote login/logout security gate', () => {
  let handlers: Map<string, Handler>;
  let store: SessionStore;
  let restartMobileRemote: ReturnType<typeof vi.fn>;
  let broadcast: ReturnType<typeof vi.fn>;
  let doLogin: ReturnType<typeof vi.fn>;
  let clearMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    allowGuard = true;
    clearMock = vi.fn();
    // `stateFromStore` reads store.load(); an expired/empty session yields
    // loggedOut(). Return null so the rejected return is a stable loggedOut.
    store = {
      load: () => null,
      clear: () => clearMock(),
      isPersistAvailable: () => false,
    } as unknown as SessionStore;
    restartMobileRemote = vi.fn();
    broadcast = vi.fn();
    doLogin = vi.fn(async () => loggedInState);
    const fake = fakeIpcMain();
    handlers = fake.handlers;
    registerMobileRemoteIpc({
      ipcMain: fake.ipcMain,
      store,
      restartMobileRemote,
      broadcast,
      doLogin,
    });
  });

  it('login runs OAuth + restarts when the sender is the main frame', async () => {
    const result = await handlers.get(MOBILE_REMOTE_CHANNELS.login)!(fakeEvent);
    expect(doLogin).toHaveBeenCalled();
    expect(restartMobileRemote).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(loggedInState);
    expect(result).toEqual(loggedInState);
  });

  it('login does nothing when the sender is not the main frame', async () => {
    allowGuard = false;
    const result = await handlers.get(MOBILE_REMOTE_CHANNELS.login)!(fakeEvent);
    expect(doLogin).not.toHaveBeenCalled();
    expect(restartMobileRemote).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(result).toEqual(loggedOutState);
  });

  it('logout clears + restarts when the sender is the main frame', async () => {
    const result = await handlers.get(MOBILE_REMOTE_CHANNELS.logout)!(fakeEvent);
    expect(clearMock).toHaveBeenCalled();
    expect(restartMobileRemote).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(loggedOutState);
    expect(result).toEqual(loggedOutState);
  });

  it('logout does nothing when the sender is not the main frame', async () => {
    allowGuard = false;
    const result = await handlers.get(MOBILE_REMOTE_CHANNELS.logout)!(fakeEvent);
    expect(clearMock).not.toHaveBeenCalled();
    expect(restartMobileRemote).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(result).toEqual(loggedOutState);
  });
});
