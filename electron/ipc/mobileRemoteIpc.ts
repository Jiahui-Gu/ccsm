// electron/ipc/mobileRemoteIpc.ts
import type { IpcMain } from 'electron';
import { MOBILE_REMOTE_CHANNELS } from '../shared/ipcChannels';
import type { SessionStore } from '../remote/sessionStore';
import { loggedOut, type MobileRemoteAuthState } from '../remote/oauthLogin';

function stateFromStore(store: SessionStore): MobileRemoteAuthState {
  const s = store.load();
  if (!s || s.expiresAtMs <= Date.now()) return loggedOut();
  return {
    loggedIn: true,
    userHash: s.userHash,
    expiresAtMs: s.expiresAtMs,
    persisted: store.isPersistAvailable(),
  };
}

export function registerMobileRemoteIpc(deps: {
  ipcMain: IpcMain;
  store: SessionStore;
  restartMobileRemote: () => void;
  broadcast: (state: MobileRemoteAuthState) => void;
  doLogin: () => Promise<MobileRemoteAuthState>;
}): void {
  const { ipcMain, store, restartMobileRemote, broadcast, doLogin } = deps;

  ipcMain.handle(MOBILE_REMOTE_CHANNELS.login, async () => {
    const state = await doLogin();
    restartMobileRemote();
    broadcast(state);
    return state;
  });

  ipcMain.handle(MOBILE_REMOTE_CHANNELS.logout, async () => {
    store.clear();
    restartMobileRemote();
    const state = stateFromStore(store);
    broadcast(state);
    return state;
  });

  ipcMain.handle(MOBILE_REMOTE_CHANNELS.authState, async () => stateFromStore(store));
}
