// Preload entry point. Loaded by `electron/window/createWindow.ts` via
// `path.join(__dirname, '..', 'preload', 'index.js')`. v0.3 wave-1 B:
// the 5-bridge fan-out from #769 collapsed to one — the four business
// bridges (ccsmPty / ccsmSession / ccsmNotify / ccsmSessionTitles) moved
// to electron/__legacy_to_delete__/preload-bridges/ pending wave-2
// deletion. Renderer reaches those domains over the daemon's loopback
// HTTP API now (port discovered via `window.ccsm.getDaemonPort()`).

import '@sentry/electron/preload';

import { installCcsmCoreBridge } from './bridges/ccsmCore';

installCcsmCoreBridge();

export type { CCSMAPI } from './bridges/ccsmCore';
