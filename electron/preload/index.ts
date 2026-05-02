// Preload entry point. Loaded by `electron/window/createWindow.ts` via
// `path.join(__dirname, '..', 'preload', 'index.js')` (resolves to
// `dist/electron/preload/index.js` post-tsc). Splits into 5 single-concern
// bridges (#769, SRP wave-2 PR-A) — each bridge owns its own listener
// sets, IPC channels, and exposed type. The order of `install*` calls is
// not load-bearing (each bridge is independent), but kept in the original
// preload.ts order for diff clarity.

import '@sentry/electron/preload';

import { installCcsmCoreBridge } from './bridges/ccsmCore';
import { installCcsmPtyBridge } from './bridges/ccsmPty';
import { installCcsmSessionBridge } from './bridges/ccsmSession';
import { installCcsmNotifyBridge } from './bridges/ccsmNotify';
import { installCcsmSessionTitlesBridge } from './bridges/ccsmSessionTitles';
import { installCcsmLogBridge } from './bridges/ccsmLog';

installCcsmCoreBridge();
installCcsmPtyBridge();
installCcsmSessionBridge();
installCcsmNotifyBridge();
installCcsmSessionTitlesBridge();
// v0.3 task #125 / frag-6-7 §6.6.2: renderer console-forward (gated by
// CCSM_RENDERER_LOG_FORWARD=1). No-op when the env flag is off, so this
// install is unconditional.
installCcsmLogBridge();

export type { CCSMAPI } from './bridges/ccsmCore';
export type { CCSMPtyAPI } from './bridges/ccsmPty';
export type { CCSMSessionAPI, SessionState } from './bridges/ccsmSession';
export type { CCSMNotifyAPI } from './bridges/ccsmNotify';
export type { CCSMSessionTitlesAPI } from './bridges/ccsmSessionTitles';
