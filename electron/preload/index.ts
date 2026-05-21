// Preload entry point. Loaded by `electron/window/createWindow.ts` via
// `path.join(__dirname, '..', 'preload', 'index.js')` (resolves to
// `dist/electron/preload/index.js` post-tsc). Splits into 5 single-concern
// bridges (#769, SRP wave-2 PR-A) — each bridge owns its own listener
// sets, IPC channels, and exposed type. Call order below is cosmetic
// (each `install*` is independent and load-safe — just `ipcRenderer.on`
// registrations + `contextBridge.exposeInMainWorld`), kept in the
// original preload.ts order for diff clarity. The Sentry import sits at
// the top by convention, not because the bridges can throw on load.

import '@sentry/electron/preload';

import { installCcsmCoreBridge } from './bridges/ccsmCore';
import { installCcsmPtyBridge } from './bridges/ccsmPty';
import { installCcsmSessionBridge } from './bridges/ccsmSession';
import { installCcsmNotifyBridge } from './bridges/ccsmNotify';
import { installCcsmSessionTitlesBridge } from './bridges/ccsmSessionTitles';
import { installCcsmShellBridge } from './bridges/ccsmShell';

installCcsmCoreBridge();
installCcsmPtyBridge();
installCcsmSessionBridge();
installCcsmNotifyBridge();
installCcsmSessionTitlesBridge();
installCcsmShellBridge();

export type { CCSMAPI } from './bridges/ccsmCore';
export type { CCSMPtyAPI } from './bridges/ccsmPty';
export type { CCSMSessionAPI, SessionState } from './bridges/ccsmSession';
export type { CCSMNotifyAPI } from './bridges/ccsmNotify';
export type { CCSMSessionTitlesAPI } from './bridges/ccsmSessionTitles';
export type { CCSMShellAPI } from './bridges/ccsmShell';
