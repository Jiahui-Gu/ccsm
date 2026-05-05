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
// Task #464 / SHIP-GATE round-2 — install `window.ccsmPty.checkClaudeAvailable`
// SYNCHRONOUSLY before `root.render()`. The polyfill function awaits an
// internal `clientsReady` promise that `<RendererBoot>`'s `ColdStartGate`
// resolves once the typed Connect bundle exists. This ordering matters:
// `<App/>`'s boot probe `useEffect(deps=[])` at `src/App.tsx:227` runs on
// first child commit BEFORE the parent gate's bind effect, and round-1's
// install-inside-effect lost that race — the probe found
// `window.ccsmPty === undefined`, set `claudeAvailable=false`, mounted
// ClaudeMissingGuide before clients ever bound. With the stub installed
// here at module evaluation time the function is callable from the very
// first render commit; the await blocks the probe until clients are
// ready, then resolves with the real daemon answer. See
// `packages/electron/src/renderer/window-ccsm-pty-bridge.ts` header for
// the full timing-race writeup.
import { installWindowCcsmPtyBridgeStub } from '@ccsm/electron/renderer/window-ccsm-pty-bridge';

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

// Task #464 round-2: graft `window.ccsmPty.checkClaudeAvailable` onto
// the renderer global BEFORE React mounts. See the import-site comment
// above for why this is the SHIP-GATE fix vs. installing inside an
// effect (which loses to App.tsx's child useEffect commit ordering).
installWindowCcsmPtyBridgeStub();

// perf/startup-render-gate: render IMMEDIATELY, then kick hydration in the
// background. Previously the renderer awaited `hydrateStore()` (which
// included a `loadModels()` shell-out to the claude binary, 100-500ms)
// before calling root.render(), so first paint was gated on the slowest
// IPC of the boot sequence. Components that read persisted state subscribe
// to `useStore(s => s.hydrated)` and show skeleton/empty UI for the
// sub-frame window before hydration lands.
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
// Defer hydration until after the browser has had a chance to paint the
// pre-hydrate <AppSkeleton/> frame. React 18's `createRoot.render()` schedules
// the initial commit through the concurrent scheduler — it is NOT guaranteed
// to commit before `hydrateStore()` runs to its first real `await`. Pre-#289
// this happened to work because `loadState` was a real IPC (truly async, the
// renderer thread yielded long enough for React to commit + paint). Post-#289
// `loadPersisted()` is `localStorage.getItem` (sync), and `hydrateDrafts()`
// is the same — there is no real yield, so React would batch the skeleton
// commit with the post-hydrate `setState({ hydrated: true })` and the
// skeleton frame would never paint. `setTimeout(0)` queues a fresh macrotask;
// by the time it fires, React's scheduler has already drained its initial
// commit task and the skeleton is in the DOM. harness-ui
// startup-paints-before-hydrate (and real users on cold launch) now actually
// see the skeleton.
setTimeout(() => void hydrateStore(), 0);
