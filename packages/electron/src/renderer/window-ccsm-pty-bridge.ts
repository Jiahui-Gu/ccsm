// Renderer-side polyfill that exposes
// `window.ccsmPty.checkClaudeAvailable` against the typed Connect
// `PtyService` client.
//
// Task #464 / SHIP-GATE — root cause of the "every user sees
// ClaudeMissingGuide on first paint" bug:
//   - `src/App.tsx:227` calls `window.ccsmPty.checkClaudeAvailable()`
//     in its boot effect to decide whether to mount the main UI or the
//     guide. The optional chain `bridge?.checkClaudeAvailable` was
//     resolving to `undefined` because v0.3 ships ZERO production
//     preload that installs `window.ccsmPty` (the only sanctioned
//     `contextBridge.exposeInMainWorld` call site,
//     `electron/ipc-allowlisted/preload-allowlisted.ts`, exposes
//     `window.ccsm` — note the missing `Pty` suffix — and the
//     `window.ccsmPty` surface is referenced ONLY in tests / harness
//     stubs).
//   - The catch branch in App.tsx then flipped `claudeAvailable` to
//     `false` and rendered the guide unconditionally.
//
// Round-2 — install timing race that round-1 missed:
//   - Pre-round-2 the polyfill was installed inside `boot.tsx`'s
//     `ColdStartGate.useEffect(deps=[clients])`, which only fires AFTER
//     the async descriptor fetch lands and `setClients(non-null)`
//     re-renders the gate. But `<App/>` is the gate's child, and React
//     fires child useEffect callbacks BEFORE parent useEffect callbacks
//     on the same commit; `App.tsx`'s probe `useEffect(deps=[])` ran
//     ONCE on mount, found `window.ccsmPty === undefined`, set
//     `claudeAvailable=false`, mounted ClaudeMissingGuide. By the time
//     the parent gate's install effect fired and grafted the polyfill
//     onto `window`, App's probe deps `[]` meant it never re-ran —
//     the user was permanently stuck on the guide until they clicked
//     Re-check (which DID work because Re-check reads `window.ccsmPty`
//     at click-time, after the polyfill was installed).
//   - Fix: split install into TWO phases.
//       (1) `installWindowCcsmPtyBridgeStub()` runs SYNCHRONOUSLY at
//           the renderer entry point (`src/index.tsx`) BEFORE
//           `root.render()`. It grafts a `checkClaudeAvailable` async
//           function onto `window.ccsmPty` immediately. The function's
//           body awaits an internal `clientsReady` promise — calls
//           queue up if the bundle isn't built yet.
//       (2) `bindWindowCcsmPtyBridgeClients(clients)` runs in the gate
//           effect once the typed Connect `PtyService` client exists.
//           It resolves the `clientsReady` promise; queued + future
//           calls then dispatch the real RPC.
//   - Result: at App mount time `window.ccsmPty.checkClaudeAvailable`
//     is a callable function (truthy in the optional-chain check), so
//     App's probe enters the `await` branch instead of the catch
//     branch. The await blocks until clients are ready, then resolves
//     with the real daemon answer. ClaudeMissingGuide never flashes.
//
// Why a renderer-side polyfill (and NOT a preload bridge):
//   - The v0.3 daemon-split architecture moved every previously-IPC
//     PtyService surface onto the loopback Connect-RPC transport. The
//     daemon resolves claude (it's the process that spawns ttyd /
//     pty-host, not Electron). Going renderer → preload → ipcMain →
//     daemon RPC would add two hops AND require a new IPC channel on
//     the §3.1 allowlist (which is closed-form and forbids new entries
//     without a chapter-15 audit row).
//   - The renderer ALREADY has a typed Connect `PtyService` client
//     once `<RendererBoot>` builds the clients bundle (see
//     `boot.tsx`'s `ColdStartGate`). The cheapest fix is to install
//     `window.ccsmPty.checkClaudeAvailable` as a thin async wrapper
//     around `clients.pty.checkClaudeAvailable(...)`. Same wire path
//     the rest of the v0.3 RPC surface uses; no new IPC; no preload
//     amendment.
//
// Why we DO NOT install other `window.ccsmPty.*` methods here:
//   - `list / spawn / attach / input / resize / kill / get /
//     onData / onExit / clipboard / getBufferSnapshot` are owned by
//     other tasks (Wave-3 / pty-host wire-up). Those entries land
//     additively when their RPC handlers ship. This file's scope is
//     ONE method — the SHIP-GATE first-paint probe — and one method
//     only.
//
// SRP layering:
//   - producer: the Connect `PtyService` client (`clients.pty`),
//                supplied by `<RendererBoot>`'s `ColdStartGate` via
//                `bindWindowCcsmPtyBridgeClients(clients)`.
//   - decider:  none — this is a thin sink with a single boolean
//                "are clients bound yet" gate driven by an internal
//                Promise.
//   - sink:     `installWindowCcsmPtyBridgeStub()` — performs the
//                one-time `Object.assign` (defensive: don't blow away
//                existing test stubs of `window.ccsmPty`).
//
// 5-tier "no wheel reinvention" judgement (dev.md §1 step 2):
//   1. There is no existing renderer-side helper that bridges Connect
//      clients onto `window.*` — every other RPC consumer reaches the
//      client via `useClients()` / `use<Method>` hooks. This file is a
//      compatibility shim for a renderer call site (`App.tsx:227`)
//      that the v0.3 cutover (#215) has not yet migrated; the surface
//      is intentionally one symbol.
//   2. node:* / web platform — `Promise` (built-in) handles the
//      "queue while not ready" semantics natively. No need for a
//      `p-defer` / `p-queue` dep.
//   3. No new dep introduced.
//   4. N/A.
//   5. Self-written (~80 LoC including the type bridge + two-phase
//      install).

import type { CcsmClients } from '../rpc/clients.js';
import { create } from '@bufbuild/protobuf';
import {
  CheckClaudeAvailableRequestSchema,
  RequestMetaSchema,
} from '@ccsm/proto';

/**
 * Public shape of the polyfilled `window.ccsmPty.checkClaudeAvailable`
 * — mirrors `src/pty.d.ts`'s `CheckClaudeAvailableResult` discriminated
 * union exactly. Kept structurally compatible because the renderer
 * type declaration in `src/pty.d.ts` is the authoritative consumer
 * contract; updating it would force a cross-package dep that this
 * polyfill deliberately avoids.
 */
export type CheckClaudeAvailableResult =
  | { readonly available: true; readonly path: string }
  | { readonly available: false };

/**
 * Generate a per-call request_id. Uses `crypto.randomUUID()` (web
 * platform standard, available in Electron renderer) — the daemon's
 * `requestMetaInterceptor` rejects empty/whitespace-only ids, so we
 * never want to pass `''`.
 */
function newRequestId(): string {
  // Electron 41 ships Chromium 134; `crypto.randomUUID` is on every
  // supported renderer. Defensive fallback for the (vanishingly
  // unlikely) test environment that mocks `globalThis.crypto` to an
  // incomplete shape.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Sufficient for the daemon's "non-empty string" check; collision
  // probability over a session lifetime is irrelevant for a probe RPC.
  return `ccsm-pty-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---- module-private state for the two-phase install ---------------
//
// `clientsReadyResolve` is captured during stub install; the returned
// promise sits in `clientsReady`. The polyfilled async function awaits
// `clientsReady`, so any call issued before `bindWindowCcsmPtyBridgeClients`
// queues at the `await` point and resolves once the bundle is bound.
// `boundClients` holds the resolved bundle for subsequent (synchronous)
// awaits — Promise resolution is "fire and remember" so post-bind calls
// pay no extra microtask cost.
//
// Why module-level state (not a closure inside install): tests and the
// real renderer entry both call `installWindowCcsmPtyBridgeStub` exactly
// once at process start; the bind happens later from a different module
// (`boot.tsx`). Module-level holds the promise across that boundary
// without forcing the caller to thread a handle.

let clientsReady: Promise<CcsmClients> | null = null;
let clientsReadyResolve: ((c: CcsmClients) => void) | null = null;
let boundClients: CcsmClients | null = null;

/**
 * Test seam — reset the module-private install state so spec files can
 * assert the cold-start sequence multiple times without process restart.
 * Production code never invokes this.
 */
export function __resetWindowCcsmPtyBridgeForTest(): void {
  clientsReady = null;
  clientsReadyResolve = null;
  boundClients = null;
  if (typeof window !== 'undefined') {
    const w = window as unknown as { ccsmPty?: unknown };
    delete w.ccsmPty;
  }
}

/**
 * Phase 1 — synchronous install. Call ONCE from the renderer entry
 * (`src/index.tsx`) BEFORE `root.render()`. Grafts a callable
 * `checkClaudeAvailable` onto `window.ccsmPty` so any code that runs
 * during initial mount (notably `src/App.tsx:227`'s boot probe
 * `useEffect`) sees a truthy function and enters the `await` branch
 * instead of the "preload missing" catch branch that flips the user
 * onto ClaudeMissingGuide.
 *
 * The installed function awaits an internal `clientsReady` promise.
 * Calls issued before `bindWindowCcsmPtyBridgeClients(clients)` queue
 * at that `await` and resolve once the bundle is bound. Calls issued
 * after binding pay one extra microtask vs. the post-bind path —
 * negligible vs. the wire RPC latency.
 *
 * Idempotent: re-installing preserves any other `ccsmPty.*` surfaces
 * that other modules / tests have stitched onto the same object, and
 * does not reset the `clientsReady` promise (so an already-bound
 * polyfill keeps working through hot-reload).
 */
export function installWindowCcsmPtyBridgeStub(): void {
  if (typeof window === 'undefined') return;
  if (clientsReady === null) {
    clientsReady = new Promise<CcsmClients>((resolve) => {
      clientsReadyResolve = resolve;
    });
  }

  const checkClaudeAvailable = async (
    opts?: { force?: boolean },
  ): Promise<CheckClaudeAvailableResult> => {
    try {
      // Fast-path: clients already bound. Skip the await tick and use
      // the cached reference.
      const clients = boundClients ?? (await clientsReady!);
      const req = create(CheckClaudeAvailableRequestSchema, {
        meta: create(RequestMetaSchema, {
          requestId: newRequestId(),
          clientVersion: 'ccsm-renderer/0.3',
          clientSendUnixMs: BigInt(Date.now()),
        }),
        // Round-2: thread the renderer's `force` flag onto the wire
        // request. ClaudeMissingGuide's Re-check button passes
        // `{ force: true }` so the daemon resolver bypasses its
        // in-process cache and actually re-runs `where claude` /
        // `which claude`. Without this the resolver would stay on the
        // cached `null` from the boot probe and the user would be
        // permanently stuck on the guide even after installing.
        force: opts?.force === true,
      });
      const res = await clients.pty.checkClaudeAvailable(req);
      if (res.available && res.resolvedPath.length > 0) {
        return { available: true, path: res.resolvedPath };
      }
      return { available: false };
    } catch (err) {
      // Connect transport / daemon errors fall through as "unavailable"
      // rather than throwing — the caller (App.tsx boot effect /
      // ClaudeMissingGuide recheck) treats throws as `false` already,
      // but normalizing here keeps the surface honest to the typed
      // return shape.
      // eslint-disable-next-line no-console
      console.debug('[ccsm/window-ccsm-pty] checkClaudeAvailable RPC failed:', err);
      return { available: false };
    }
  };

  const w = window as unknown as {
    ccsmPty?: Record<string, unknown>;
  };
  // Preserve any pre-existing surface (test stubs, future polyfills
  // for list/spawn/etc.). If the consumer has ALREADY installed a
  // `checkClaudeAvailable` (e.g. e2e harness `addInitScript` stub
  // that runs before bundle eval, or a future preload that delivers
  // the real method), keep theirs — the polyfill exists only to
  // bridge the SHIP-GATE gap when nothing else has supplied one.
  // Round-3: this changed from unconditional overwrite to
  // existence-check so `harness-ui` (no daemon, no clients ever
  // bind) can stub the method to a deterministic
  // `{ available: false }` and the App probe resolves immediately
  // instead of awaiting `clientsReady` forever.
  const existing = w.ccsmPty ?? {};
  w.ccsmPty = {
    ...existing,
    ...(typeof existing.checkClaudeAvailable === 'function'
      ? {}
      : { checkClaudeAvailable }),
  };
}

/**
 * Phase 2 — bind the typed Connect clients bundle. Call from
 * `boot.tsx`'s `ColdStartGate` once the `<ClientsProvider>` clients
 * exist (i.e. once the descriptor fetch has landed). Idempotent —
 * re-binding swaps the cached reference but does NOT re-create the
 * promise, so any pre-bind callers that are still awaiting the
 * original promise resolve with the FIRST bind's value (intentional:
 * a daemon restart from `<ConnectionProvider>` rebuilds clients with
 * a fresh transport for a fresh boot_id; subsequent calls then see
 * the new `boundClients` reference).
 *
 * Safe to call before `installWindowCcsmPtyBridgeStub` (rebuilds the
 * promise so the eventual stub install picks up the bound clients) —
 * production order is stub-then-bind; tests may go either order.
 */
export function bindWindowCcsmPtyBridgeClients(clients: CcsmClients): void {
  boundClients = clients;
  if (clientsReady === null) {
    // Bind before stub install — pre-resolve the promise so the future
    // stub install creates an already-resolved one and post-mount
    // probes see clients without queueing.
    clientsReady = Promise.resolve(clients);
    clientsReadyResolve = null;
    return;
  }
  if (clientsReadyResolve !== null) {
    clientsReadyResolve(clients);
    clientsReadyResolve = null;
  }
}

/**
 * Backward-compatible single-step install — combines stub install +
 * client bind in one call. Retained because the original round-1
 * shape (`installWindowCcsmPtyBridge(clients)`) is referenced by
 * `boot.tsx` callers that don't need the two-phase split (e.g. unit
 * tests that have clients ready at mount).
 *
 * Round-2 production path uses the two-phase API
 * (`installWindowCcsmPtyBridgeStub` from `index.tsx` +
 * `bindWindowCcsmPtyBridgeClients` from `boot.tsx`); this single-step
 * helper is preserved for non-race-sensitive callers and tests.
 */
export function installWindowCcsmPtyBridge(clients: CcsmClients): void {
  installWindowCcsmPtyBridgeStub();
  bindWindowCcsmPtyBridgeClients(clients);
}
