// Preload entry point. Loaded by `electron/window/createWindow.ts` via
// `path.join(__dirname, '..', 'preload', 'index.js')`.
//
// Wave-2-prep restores the 5-bridge skeleton from v0.2 so the renderer
// mounts without crashing on `window.ccsmPty.X is undefined`. The four
// business bridges (Pty/Session/Notify/SessionTitles) are STUBS — wave 2
// sub-PRs B/C replace them one-by-one with real fetch+SSE shims against
// the daemon's loopback API. Splitting the install into 5 separate files
// lets W2-A/B/C touch disjoint files and run in parallel.

import '@sentry/electron/preload';

import { installCcsmCoreBridge } from './bridges/ccsmCore';
import { installCcsmPtyBridge } from './bridges/ccsmPty';
import { installCcsmSessionBridge } from './bridges/ccsmSession';
import { installCcsmNotifyBridge } from './bridges/ccsmNotify';
import { installCcsmSessionTitlesBridge } from './bridges/ccsmSessionTitles';

installCcsmCoreBridge();
installCcsmPtyBridge();
installCcsmSessionBridge();
installCcsmNotifyBridge();
installCcsmSessionTitlesBridge();

export type { CCSMAPI } from './bridges/ccsmCore';
export type { CcsmPtyApi } from './bridges/ccsmPty';
export type { CcsmSessionApi } from './bridges/ccsmSession';
export type { CcsmNotifyApi } from './bridges/ccsmNotify';
export type { CcsmSessionTitlesApi } from './bridges/ccsmSessionTitles';
