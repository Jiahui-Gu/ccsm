// ConnectRouter wiring for the daemon. Spec ch04 §3-§6.2.
//
// T2.2 scope: register every v0.3 Connect service from `@ccsm/proto` against
// a `ConnectRouter` with EMPTY service implementations. Connect-ES v2's
// router contract states (see `@connectrpc/connect/dist/.../router.d.ts`):
//
//     "You don't have to implement all RPCs of a service. If you omit a
//      method, the router adds a method that responds with an error code
//      `unimplemented`."
//
// Every absent handler therefore replies with ConnectError code
// `Unimplemented` (proto3 `UNIMPLEMENTED` / Connect spec § "Codes"). This
// is exactly the v0.3 phase-1 behavior the spec asks for: the wire surface
// is complete, the descriptor table is complete, but no behavior is
// attached until the L3+ tasks (T3.x session, T4.x pty, T5.x crash, T6.x
// settings/notify/draft, T1.7 supervisor) land. Each later task swaps
// `{}` for a concrete `ServiceImpl<T>` against the same descriptor — no
// router-level migration, no re-registration order constraints (Connect
// router order is irrelevant; it's a path-keyed map under the hood).
//
// Why ALL services (including SupervisorService): chapter 04 §1 calls
// `supervisor.proto` "daemon-internal mirror of HTTP supervisor" — it is
// not surfaced to clients on Listener A in v0.3, but the router wiring
// is uniform. Keeping it registered here means the daemon's HTTP/2
// surface answers `Unimplemented` (rather than 404) if a misconfigured
// client ever calls it; the actual SupervisorService implementation
// lives behind the Supervisor's separate HTTP server (T1.7), not on the
// Connect router. This keeps one mechanical rule for reviewers ("every
// service in @ccsm/proto is in the router") rather than a
// per-service exception list.
//
// Layer 1 — alternatives checked:
//   - ConnectRouter from @connectrpc/connect (already a daemon dep) gives
//     us Unimplemented-for-absent-methods for free. No need to write
//     `throw new ConnectError("...", Code.Unimplemented)` in 30+ places.
//   - `connectNodeAdapter` from @connectrpc/connect-node is the standard
//     bridge from a router to a Node `http.RequestListener` /
//     `http2.OnStreamHandler`-compatible callback. It accepts a routes
//     callback `(router) => void`, which is exactly what we expose here.
//   - We do NOT instantiate the http2 server here. That is the
//     listener/transport layer's job (T1.4 + T1.5). This file exposes
//     two pure factories — `registerStubServices` and
//     `createDaemonNodeAdapter` — that the listener wires together when
//     it constructs its `http2.createServer({ ... })`.

import {
  ConnectRouter,
  type ConnectRouterOptions,
} from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';

import {
  CrashService,
  DraftService,
  NotifyService,
  PtyService,
  SessionService,
  SettingsService,
  SupervisorService,
} from '@ccsm/proto';

/**
 * Stable enumeration of every v0.3 Connect service from `@ccsm/proto`.
 *
 * Exported so tests can iterate over the full set without re-listing
 * (the "ALL services from packages/proto" requirement in T2.2 is
 * machine-checkable: `STUB_SERVICES.length` must equal the count of
 * exports in `@ccsm/proto/src/index.ts`). When a v0.4 service is added
 * to `@ccsm/proto`, this array MUST be extended in the same PR — the
 * `proto-services-coverage.spec.ts` test fails otherwise.
 */
export const STUB_SERVICES = [
  SessionService,
  PtyService,
  CrashService,
  SettingsService,
  NotifyService,
  DraftService,
  SupervisorService,
] as const;

/**
 * Register every v0.3 service against `router` with an empty
 * implementation `{}`. Connect-ES's router responds with Connect code
 * `Unimplemented` for every absent method, so no per-method stub code
 * is needed.
 *
 * Returns the same router so callers may chain.
 */
export function registerStubServices(router: ConnectRouter): ConnectRouter {
  for (const service of STUB_SERVICES) {
    router.service(service, {});
  }
  return router;
}

/**
 * Default routes callback for `connectNodeAdapter`. Equivalent to:
 *
 *   const handler = connectNodeAdapter({ routes: stubRoutes });
 *
 * See `createDaemonNodeAdapter` for the bundled adapter form.
 */
export const stubRoutes = (router: ConnectRouter): void => {
  registerStubServices(router);
};

/**
 * Adapter-construction options. We accept the same shape as
 * `ConnectRouterOptions` (gRPC / gRPC-Web / Connect protocol toggles)
 * plus an optional `requestPathPrefix` that the listener layer may
 * supply if it wants to mount the router under a sub-path (the v0.3
 * Listener A serves the router at the root, so the default is empty).
 */
export interface CreateDaemonNodeAdapterOptions extends ConnectRouterOptions {
  /** Optional URL prefix; default `""` (mount at root). */
  readonly requestPathPrefix?: string;
}

/**
 * Concrete handler function type returned by `connectNodeAdapter` —
 * compatible with both `http.RequestListener` and the `request` event
 * of `http2.Http2Server`. `@connectrpc/connect-node` does not export
 * its underlying `NodeHandlerFn` alias from the package's public
 * surface, so we derive it here via `ReturnType` to avoid a deep
 * import into the package's internal `node-universal-handler.js`.
 */
export type DaemonNodeHandler = ReturnType<typeof connectNodeAdapter>;

/**
 * Build a Node-compatible request handler that serves every v0.3
 * Connect service with stub (`Unimplemented`) handlers.
 *
 * The returned function is compatible with both `http.Server`'s
 * `request` event and `http2.Http2Server`'s `request` event (the same
 * function shape works for both — connect-node abstracts the
 * difference internally). Listener A wires this into its
 * `http2.createServer({ ... }, handler)` call.
 */
export function createDaemonNodeAdapter(
  options: CreateDaemonNodeAdapterOptions = {},
): DaemonNodeHandler {
  return connectNodeAdapter({
    ...options,
    routes: stubRoutes,
  });
}
