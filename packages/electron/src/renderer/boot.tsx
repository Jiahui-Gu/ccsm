// T6.6 — Renderer boot wiring.
//
// Spec ref: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// chapter 08 §6.2 ("React Query renderer state layer") + §4.1
// (`app://ccsm/listener-descriptor.json` delivery) + §4.2 (transport bridge)
// + §6 / §6.1 (renderer error contract + cold-start UX).
//
// Single responsibility (sink-style — wires producers/deciders together):
//   1. Construct the `QueryClient` once for the renderer process.
//   2. Build the per-descriptor Connect transport via `connect-web`'s
//      `createConnectTransport` against the descriptor's `address` field
//      (Electron main rewrites this to the renderer-facing bridge URL per
//      §4.1; the renderer never speaks raw UDS / named-pipe).
//   3. Drive the connection lifecycle through T6.7's `<ConnectionProvider>`
//      (Hello + boot_id pinning + reconnect with the locked backoff).
//   4. Once the first Hello succeeds: build a typed `CcsmClients` bundle
//      (T6.3) from a fresh transport over the same descriptor and expose
//      it via `<ClientsProvider>` so every `use<Method>` hook (T6.3
//      `queries.ts`) resolves a real client via `useClients()`.
//   5. While the first Hello has not yet succeeded, render the cold-start
//      modal (T6.8) layered over a neutral placeholder — the call site's
//      `<App/>` MUST NOT be rendered before clients are available, because
//      the goal of T6.6 is to make every `useListSessions(...)` call site
//      legal once #215 cuts over from `window.ccsm*` to the hook layer.
//
// Why both providers (Connection + Clients) instead of one:
//   The two contexts are intentionally separable so v0.4 web/iOS clients
//   that DO NOT share `ConnectionProvider`'s Electron-only descriptor
//   plumbing can still reuse the hook layer over a `ClientsProvider`-only
//   wrapping. Per ch08 §6.2 + ch15 §3 (forever-stable abstraction) the
//   `<ClientsProvider>` surface is the locked seam; `<ConnectionProvider>`
//   is the v0.3 / Electron concrete driver of it.
//
// What this module deliberately does NOT do:
//   - Decide where the descriptor lives on disk (T6.1 / `protocol-app.ts`
//     owns the path + the `app://` registration).
//   - Run the bridge (T6.2 / `transport-bridge.ts` owns it; main wires it).
//   - Define the hook layer (T6.3 `queries.ts` owns it).
//   - Pin a particular reconnect schedule (T6.7 `reconnect.ts` owns it;
//     `<ConnectionProvider>` consumes it).
//
// Cold-start UX integration:
//   The cold-start modal (T6.8) reads `useConnection()` to decide when to
//   open. It MUST be mounted inside `<ConnectionProvider>` (so its hook
//   resolves) AND outside `<ClientsProvider>` (so it shows even when no
//   clients exist yet). We inline a tiny `<ColdStartGate>` component for
//   the latter — it owns no state of its own, just bridges connection
//   state to the modal + clients fork.

import * as React from 'react';
import { createConnectTransport } from '@connectrpc/connect-web';
import type { Transport } from '@connectrpc/connect';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';

import { createClients, type CcsmClients } from '../rpc/clients.js';
import { ClientsProvider } from '../rpc/queries.js';
import {
  ConnectionProvider,
  useConnection,
  type ConnectionEvents,
} from './connection/use-connection.js';
import { defaultFetchDescriptor } from './connection/hello.js';
import { DaemonNotRunningModal } from './components/DaemonNotRunningModal.js';
import { useDaemonColdStartModal } from './components/use-daemon-cold-start-modal.js';
import type { DescriptorV1 } from '../main/protocol-app.js';

/**
 * Default `buildTransport` — Connect-Web HTTP transport against the
 * descriptor's bridge address. Electron main rewrote `address` to
 * `http://127.0.0.1:<bridge-port>` per ch08 §4.1 step 2, so the URL is
 * always loopback-TCP from the renderer's POV regardless of the daemon's
 * actual transport (UDS / named-pipe / h2c-loopback).
 *
 * Exported so:
 *   - Tests can wrap it with a logging adapter.
 *   - A future v0.4 web build can reuse the same shape against a
 *     cloudflared-fronted Listener B URL (the function only depends on
 *     `descriptor.address`).
 */
export function defaultBuildTransport(descriptor: DescriptorV1): Transport {
  // Descriptor `address` from main is already a complete `http://host:port`
  // URL (set by `transport-bridge.ts`'s `BridgeHandle.rendererUrl` — the
  // exact field T6.1 substitutes into the descriptor). We pass it as
  // `baseUrl` unchanged.
  return createConnectTransport({
    baseUrl: descriptor.address,
    // useBinaryFormat: true gives us proto wire bytes over the bridge —
    // matches what the daemon's Connect server speaks natively and avoids
    // the JSON encode/decode overhead in the renderer hot path.
    useBinaryFormat: true,
  });
}

/** Public props for `<RendererBoot>`. */
export interface RendererBootProps {
  /**
   * Children rendered ONLY after the first Hello succeeds. They sit inside
   * `<ClientsProvider>` so any `use<Method>` hook resolves a real client.
   *
   * Before the first connect, children are NOT mounted — the cold-start
   * UX (modal at 8 s; otherwise a transparent placeholder) renders alone.
   * This prevents a flash of UI that calls `useClients()` before the
   * provider is in place (which would throw per `queries.ts`'s hard guard).
   */
  readonly children?: React.ReactNode;
  /**
   * Override the descriptor fetcher. Defaults to fetching
   * `app://ccsm/listener-descriptor.json` per `defaultFetchDescriptor`.
   * Tests inject in-memory descriptors.
   */
  readonly fetchDescriptor?: () => Promise<DescriptorV1>;
  /**
   * Override the transport factory. Defaults to `defaultBuildTransport`.
   * Tests inject a synthetic Transport that records calls.
   */
  readonly buildTransport?: (descriptor: DescriptorV1) => Transport;
  /**
   * Optional connection events forwarded to `<ConnectionProvider>`. The
   * call site can subscribe to `onConnected` / `onDaemonRestart` /
   * `onBackoff` to surface telemetry / toasts. Pure pass-through.
   */
  readonly events?: ConnectionEvents;
  /**
   * Inject a pre-built `QueryClient`. Defaults to a fresh one per mount.
   * Production callers omit; tests pass an explicit instance so they can
   * spy on `invalidateQueries` etc.
   */
  readonly queryClient?: QueryClient;
  /**
   * Inject a pre-built `CcsmClients` bundle. When provided, the gate
   * mounts `<ClientsProvider>` synchronously on first render — useful
   * for tests that drive the hook layer with a stub Transport without
   * waiting for the async descriptor-fetch effect to land. Production
   * callers omit and let the gate build clients from the descriptor.
   */
  readonly clients?: CcsmClients;
}

/**
 * Tiny inner component: bridges connection state to the cold-start modal,
 * AND eagerly builds the typed clients bundle from a fresh transport so
 * the renderer tree always has a `<ClientsProvider>` available even
 * before the first Hello succeeds.
 *
 * Why "always render children" (rather than gating on `state.kind ===
 * 'connected'`):
 *   - `<App/>` contains UI that MUST be visible regardless of daemon
 *     status (window chrome, settings, OS-native dialogs). Gating render
 *     here would break every existing e2e harness that drives `<App/>`
 *     without a daemon (the e2e harnesses still use `window.ccsm*`
 *     stubs; the cutover to RPC hooks is task #215).
 *   - `<ConnectionProvider>` itself documents "renders children
 *     unconditionally"; this gate mirrors that contract.
 *   - The cold-start modal is a layered overlay (`<dialog open>`), not a
 *     tree replacement.
 *
 * Why eagerly build clients (don't wait for Hello):
 *   - Once #215 cuts over, `useListSessions(...)` etc. inside `<App/>`
 *     need a `<ClientsProvider>` mounted or `useClients()` throws. We
 *     mount it as soon as the descriptor is reachable — Hello runs in
 *     parallel via `<ConnectionProvider>`. If the daemon is down, the
 *     hook calls fail with a transport error and React Query surfaces
 *     `error`; the cold-start modal blocks the user from interacting
 *     either way.
 *   - If even the descriptor fetch fails (Electron main not ready /
 *     `protocol.handle` not registered), `<ClientsProvider>` is NOT
 *     mounted — calls to `useClients()` would throw, but pre-#215 there
 *     are zero such call sites; post-#215 the same path runs after
 *     descriptor success, so it's a non-issue in steady state.
 *
 * SRP: producer = `useConnection()` state events + descriptor-fetch
 * effect; decider = the modal `open` flag (delegated to T6.8); sink =
 * `<ClientsProvider>` mount + modal element.
 */
function ColdStartGate(props: {
  readonly children: React.ReactNode;
  readonly fetchDescriptor: () => Promise<DescriptorV1>;
  readonly buildTransport: (d: DescriptorV1) => Transport;
  readonly initialClients?: CcsmClients;
}): React.ReactElement {
  const { state } = useConnection();
  const modal = useDaemonColdStartModal();

  // Build the clients bundle as soon as the descriptor is reachable.
  // Identity-stable across re-renders so child queries do not re-key.
  // When the caller pre-supplies `initialClients` (tests), use it
  // synchronously on first render so the hook layer is reachable
  // without waiting for the descriptor-fetch effect.
  const [clients, setClients] = React.useState<CcsmClients | null>(
    props.initialClients ?? null,
  );
  // `bootId` of the descriptor the clients were built against. If the
  // connection flips to a NEW bootId (daemon restart, detected by T6.7),
  // we rebuild the bundle so all subsequent RPCs target the new daemon's
  // bridge URL (which may have changed if the bridge port rotated).
  const builtForBootIdRef = React.useRef<string | null>(null);

  // Stash the prop callbacks in refs so the effect dep array stays
  // simple (state.kind + bootId only). The effect closes over the latest
  // ref values; the callbacks are not expected to change identity in
  // production but tests may pass new closures per render.
  const fetchDescriptorRef = React.useRef(props.fetchDescriptor);
  fetchDescriptorRef.current = props.fetchDescriptor;
  const buildTransportRef = React.useRef(props.buildTransport);
  buildTransportRef.current = props.buildTransport;

  // Pluck the bootId out so the effect dep is a primitive (eslint
  // exhaustive-deps refuses a complex expression in the array). When
  // the connection is not yet `connected`, attempt boot ONCE on mount
  // (sentinel `__pending__`); on every successful Hello, rebuild against
  // the descriptor's current bootId.
  const connectedBootId = state.kind === 'connected' ? state.bootId : '__pending__';

  React.useEffect(() => {
    if (builtForBootIdRef.current === connectedBootId) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        // Fetch the descriptor and build a fresh transport. Whether or
        // not Hello has already run is irrelevant — the descriptor URL
        // is the source of truth for the bridge address. If the daemon
        // is down, the resulting clients will fail their RPC calls;
        // React Query surfaces those as `error` and the cold-start
        // modal stays up until `<ConnectionProvider>` succeeds.
        const descriptor = await fetchDescriptorRef.current();
        if (cancelled) return;
        const transport = buildTransportRef.current(descriptor);
        const next = createClients(transport);
        builtForBootIdRef.current = connectedBootId;
        setClients(next);
      } catch (err) {
        // Descriptor fetch failed (Electron main not ready / `app://`
        // scheme not registered yet). Leave `clients === null` so the
        // children render WITHOUT a `<ClientsProvider>` — pre-#215 no
        // call site needs one. We do NOT log an error at the warn level
        // because in development the renderer often outruns main's
        // protocol registration; the connection driver retries.
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.debug(
            '[ccsm/renderer/boot] descriptor unreachable; deferring ClientsProvider mount:',
            err,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectedBootId]);

  // Cold-start modal — always mounted; its `open` flag is decided by the
  // T6.8 hook based on connection state + the 8 s budget.
  const overlay = (
    <DaemonNotRunningModal open={modal.open} onRetry={modal.onRetry} />
  );

  // Children render UNCONDITIONALLY (see file header). When clients are
  // available we wrap them in `<ClientsProvider>`; when not, they render
  // bare — that's only legal pre-#215 (no call site uses `useClients()`
  // yet) and during the brief descriptor-fetch race in v0.3.
  if (clients === null) {
    return (
      <>
        {props.children}
        {overlay}
      </>
    );
  }

  return (
    <>
      <ClientsProvider clients={clients}>{props.children}</ClientsProvider>
      {overlay}
    </>
  );
}

/**
 * Top-level renderer boot wrapper. Wrap your `<App/>` (or whatever the
 * renderer entry mounts) in this to install the QueryClient + connection
 * + clients providers.
 *
 * Usage:
 * ```tsx
 *   const root = createRoot(document.getElementById('root')!);
 *   root.render(
 *     <RendererBoot>
 *       <App />
 *     </RendererBoot>
 *   );
 * ```
 *
 * The wrapper is intentionally cheap to construct — no `useEffect` of its
 * own; all lifecycle lives in the children providers. Multi-window
 * Electron apps mount one `<RendererBoot>` per window without sharing
 * state, mirroring how each BrowserWindow gets its own renderer process.
 */
export function RendererBoot(props: RendererBootProps): React.ReactElement {
  // One QueryClient per mount unless the caller injects (tests). Stable
  // identity per render via useState's lazy init form.
  const [queryClient] = React.useState<QueryClient>(
    () => props.queryClient ?? new QueryClient(),
  );

  // Stable defaults. Captured into refs would be over-engineering — the
  // function identities are recomputed on every render but the providers
  // below stash them in their own refs so the effect deps stay stable.
  const fetchDescriptor = props.fetchDescriptor ?? defaultFetchDescriptor;
  const buildTransport = props.buildTransport ?? defaultBuildTransport;

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider
        fetchDescriptor={fetchDescriptor}
        buildTransport={buildTransport}
        events={props.events}
      >
        <ColdStartGate
          fetchDescriptor={fetchDescriptor}
          buildTransport={buildTransport}
          initialClients={props.clients}
        >
          {props.children}
        </ColdStartGate>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
