// electron/remote/oauthPopupPreload.ts
/** Runs in the OAuth popup BrowserWindow (contextIsolation:false). The Worker
 *  callback page calls window.opener.postMessage({authCode}, "*"); standalone
 *  popups have no opener, so we supply one that forwards to the main process. */
import { ipcRenderer } from 'electron';

const WORKER_ORIGIN_PREFIX = 'https://ccsm-worker.';

Object.defineProperty(window, 'opener', {
  configurable: false,
  writable: false,
  value: {
    postMessage: (msg: unknown) => {
      // Only forward from the trusted Worker origin.
      if (!window.location.origin.startsWith(WORKER_ORIGIN_PREFIX)) return;
      ipcRenderer.send('mobileRemote:oauthMessage', msg);
    },
  },
});
