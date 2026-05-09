// Tauri shell entrypoint — Task #112-T3: non-blocking SPA bootstrap.
//
// Why this looks different from Wave-2 T10 / T12 (#685 / #678):
// the old `bootstrap()` did 8 steps of `await` before calling
// `createRoot(...).render(...)`. If the Rust side was slow to spawn the
// daemon (or stuck altogether) the React tree never mounted and the user
// saw a black window. T1 (#1211) replaced the scattered `daemon-ready` /
// `daemon-error` / `daemon-exit` events with a single typed `daemon-state`
// channel — which means we can listen for the full lifecycle from inside
// React (DaemonStateProvider) instead of gating bootstrap on it.
//
// New shape:
//   1. createRoot(...).render(<StrictMode><ShellRoot/></StrictMode>) — sync,
//      runs before any Tauri IPC.
//   2. ShellRoot mounts <DaemonStateProvider> which attaches the
//      `daemon-state` listener inside a useEffect.
//   3. <PhaseSwitch> (App.tsx) reads the current phase and renders either
//      <DaemonStatusOverlay> (pre-Ready) or <RuntimeProvider><App/></...>
//      once the daemon emits `Ready { port, token, ... }`.
//
// We do NOT call `invoke('start_daemon')` here anymore — the Rust setup
// hook spawns the daemon supervisor itself (T2). The legacy
// `daemon-ready` / `daemon-exit` listeners are also gone from this file;
// they remain wired on the Rust side for backwards compatibility but the
// SPA only needs `daemon-state` now.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@ccsm/ui/styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  // Fail loudly — index.html is shipped with the bundle, a missing #root
  // means the build is corrupt.
  throw new Error('Root element #root not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
