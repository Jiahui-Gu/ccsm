import { init as sentryInit, captureException } from '@sentry/electron/renderer';
import { ErrorBoundary } from '@sentry/react';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import { hydrateStore, type HydrationTrace } from './stores/store';
import { flushNow, setPersistErrorHandler } from './stores/persist';
import './styles/global.css';
// T6.6 — Renderer boot wiring (Wave 0e prerequisite). Mounts the Connect-RPC
// provider chain so the hook layer in `@ccsm/electron/rpc/queries.js` can be
// used by `<App/>` once #215 cuts call sites over from `window.ccsm*` to RPC.
// See docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md ch08 §6.2.
import { RendererBoot } from '@ccsm/electron/renderer/boot';

// All knobs (DSN, environment, opt-out gating) live in the main process
// init. The renderer SDK auto-discovers them via the IPC bridge that
// @sentry/electron/preload installs.
sentryInit({});

// Funnel silent persist failures (db locked, disk full, schema mismatch)
// to Sentry + console so we stop losing them. The previous handler hook
// existed but nothing installed it — every saveState rejection vanished
// into a `.catch(noop)` and the user shipped with stale state on disk.
setPersistErrorHandler((err) => {
  console.error('[persist] saveState failed:', err);
  try {
    captureException(err);
  } catch {
    /* Sentry not initialized in this build — console.error suffices */
  }
});

// Flush any debounced state write before the renderer is torn down. Without
// this, a quit within ~250 ms of the last user action drops that action
// (sidebar resize, model pick, etc.) on next launch.
window.addEventListener('beforeunload', () => {
  flushNow();
});

const root = createRoot(document.getElementById('root')!);

// perf/startup-render-gate: render IMMEDIATELY, then kick hydration in the
// background. Previously the renderer awaited `hydrateStore()` (which
// included a `loadModels()` shell-out to the claude binary, 100-500ms)
// before calling root.render(), so first paint was gated on the slowest
// IPC of the boot sequence. Components that read persisted state subscribe
// to `useStore(s => s.hydrated)` and show skeleton/empty UI for the
// sub-frame window before hydration lands.
//
// The double `requestAnimationFrame` wrapper below preserves this contract
// after PR #976 (Wave 0e persist.ts cutover) made `loadPersisted()` resolve
// on the next microtask (sync `localStorage.getItem` inside an async wrapper)
// — so hydration would otherwise complete in the same task as `root.render()`
// and the skeleton frame would never paint. A single rAF is insufficient: the
// callback runs *right before* the next paint, so React's hydration commit +
// DOM mutation lands in the same frame and the compositor never sees the
// skeleton. Double rAF: the first schedules the skeleton paint, the second
// fires AFTER that paint commits, guaranteeing one skeleton frame lands
// before hydration mutates the DOM. See Task #311 / #306.
const trace = ((window as unknown as {
  __ccsmHydrationTrace?: HydrationTrace;
}).__ccsmHydrationTrace ??= {} as HydrationTrace);
trace.renderedAt = Date.now();
root.render(
  <ErrorBoundary
    fallback={
      <div className="p-4 text-fg-tertiary">
        Something went wrong. The error was reported to the developer.
      </div>
    }
  >
    <RendererBoot>
      <App />
    </RendererBoot>
  </ErrorBoundary>
);
if (typeof requestAnimationFrame === 'function') {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      hydrateStore().finally(() => {
        (window as unknown as { __ccsm_hydrated?: boolean }).__ccsm_hydrated = true;
      });
    });
  });
} else {
  hydrateStore().finally(() => {
    (window as unknown as { __ccsm_hydrated?: boolean }).__ccsm_hydrated = true;
  });
}
