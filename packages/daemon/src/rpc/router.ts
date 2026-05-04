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

import {
  makeCreateSessionHandler,
  type CreateSessionDeps,
} from '../sessions/create-handler.js';
import {
  makeDestroySessionHandler,
  type DestroySessionDeps,
} from '../sessions/destroy-handler.js';
import {
  makeGetSessionHandler,
  makeListSessionsHandler,
  type ReadHandlersDeps,
} from '../sessions/read-handlers.js';
import {
  makeWatchSessionsHandler,
  type WatchSessionsDeps,
} from '../sessions/watch-sessions.js';

import { registerCrashService, type CrashServiceDeps } from './crash/register.js';
import { registerDraftService, type DraftServiceDeps } from './draft/register.js';
import { makeHelloHandler, type HelloDeps } from './hello.js';
import { requestMetaInterceptor } from './middleware/request-meta.js';
import { makeAttachHandler, makeAckPtyHandler, type PtyAttachDeps } from './pty-attach.js';
import {
  registerSettingsService,
  type SettingsServiceDeps,
} from './settings/register.js';

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
 * Opt-in registration of the real T2.3 SessionService.Hello handler on
 * top of the T2.2 stub baseline. Other services remain stub
 * (`Unimplemented`) — those handlers land in their respective tasks
 * (T3.x session, T4.x pty, etc.) and will follow the same pattern of an
 * additive registration over the stubs.
 *
 * Why "register on top" instead of editing `STUB_SERVICES`: the T2.2
 * stub coverage spec (`__tests__/router.spec.ts`) iterates EVERY method
 * on EVERY service expecting `Unimplemented`. Removing SessionService
 * from `STUB_SERVICES` would also strip the stub for the eight other
 * SessionService RPCs (ListSessions / GetSession / ...) that have NOT
 * yet landed, regressing them from `Unimplemented` to `404 Not Found`.
 * The Connect router's `service(desc, impl)` accepts a partial impl
 * and falls back to `Unimplemented` for absent methods — so
 * registering `{ hello }` alongside the prior empty `{}` is the
 * documented additive path.
 *
 * Per Connect-ES `ConnectRouter.service` semantics, calling `service`
 * twice for the same descriptor REPLACES the prior registration (the
 * router is a path-keyed map keyed on `service.typeName + method.name`).
 * Order therefore matters: `registerStubServices(router)` first, then
 * the real-handler overlay so the partial `{ hello }` impl supplants
 * the stub `{}` for SessionService while every other service keeps the
 * stub.
 */
export function registerHelloHandler(
  router: ConnectRouter,
  deps: HelloDeps,
): ConnectRouter {
  router.service(SessionService, { hello: makeHelloHandler(deps) });
  return router;
}

/**
 * Register the v0.3 SessionService handlers that have landed so far —
 * Hello (T2.3), WatchSessions (T3.3), the read pair ListSessions /
 * GetSession (Wave 3 §6.9 sub-task 5 / Task #336), DestroySession
 * (Wave 3 §6.9 sub-task 7 / Task #338) and CreateSession (Wave 3 §6.9
 * sub-task 6 / Task #339) — under a SINGLE
 * `router.service(SessionService, ...)` call.
 *
 * Why a combined registration (not multiple `service()` calls): per
 * Connect-ES `ConnectRouter.service` semantics, calling
 * `service(desc, impl)` more than once for the same descriptor REPLACES
 * the prior registration (the router is a path-keyed map). Registering
 * Hello, then WatchSessions, then ListSessions/GetSession/DestroySession/
 * CreateSession in separate calls would silently drop the earlier ones.
 * The Hello-only path (`registerHelloHandler` above) is preserved for
 * callers that have not yet wired a SessionManager (existing test
 * fixtures); production startup wiring (T1.7) uses this combined form.
 *
 * `readHandlersDeps`, `destroyHandlerDeps` and `createSessionDeps` are
 * optional so existing callers (test fixtures that built
 * `{ helloDeps, watchSessionsDeps }` before the per-overlay sub-tasks
 * landed) keep compiling without churn. In production startup wiring
 * (T1.7) all five are always supplied off the same `SessionManager`
 * instance — single owner of the sessions table; a CreateSession
 * publishes `created` to the same in-memory event bus the
 * WatchSessions stream subscribes to (round-trip: create one ->
 * watcher sees `created` event), and the new row is immediately visible
 * to ListSessions / GetSession on the same boot.
 *
 * Methods not yet implemented (RenameSession, ImportSession, ...) remain
 * `Unimplemented` per the Connect router's "absent method →
 * Unimplemented" rule, exactly as in the stub-only path.
 */
export function registerSessionService(
  router: ConnectRouter,
  deps: {
    readonly helloDeps: HelloDeps;
    readonly watchSessionsDeps: WatchSessionsDeps;
    readonly readHandlersDeps?: ReadHandlersDeps;
    readonly destroyHandlerDeps?: DestroySessionDeps;
    readonly createSessionDeps?: CreateSessionDeps;
  },
): ConnectRouter {
  const impl: Parameters<typeof router.service<typeof SessionService>>[1] = {
    hello: makeHelloHandler(deps.helloDeps),
    watchSessions: makeWatchSessionsHandler(deps.watchSessionsDeps),
  };
  if (deps.readHandlersDeps !== undefined) {
    impl.listSessions = makeListSessionsHandler(deps.readHandlersDeps);
    impl.getSession = makeGetSessionHandler(deps.readHandlersDeps);
  }
  if (deps.destroyHandlerDeps !== undefined) {
    impl.destroySession = makeDestroySessionHandler(deps.destroyHandlerDeps);
  }
  if (deps.createSessionDeps !== undefined) {
    impl.createSession = makeCreateSessionHandler(deps.createSessionDeps);
  }
  router.service(SessionService, impl);
  return router;
}

/**
 * Register the v0.3 PtyService.Attach handler (Wave 3 §6.9 sub-task 10 /
 * Task #355 / spec `2026-05-04-pty-attach-handler.md` §9.2 T-PA-6) AND
 * the AckPty companion handler (Task #49 / T4.13 / spec §6).
 *
 * REPLACES the stub `{}` registration for PtyService with
 * `{ attach, ackPty }`. Other PtyService methods (SendInput / Resize /
 * CheckClaudeAvailable) stay `Code.Unimplemented` per the
 * "absent-method → unimplemented" Connect router rule until their
 * owning tasks land. The combined-registration caveat that applies to
 * SessionService also applies here (`router.service` REPLACES on the
 * same descriptor) — so when the next PtyService method handler ships,
 * it MUST be added to this same call site rather than registered via a
 * second `service()` call.
 */
export function registerPtyService(
  router: ConnectRouter,
  deps: PtyAttachDeps,
): ConnectRouter {
  router.service(PtyService, {
    attach: makeAttachHandler(deps),
    ackPty: makeAckPtyHandler(deps),
  });
  return router;
}

/**
 * Bundled routes callback that installs stubs for every service AND the
 * real T2.3 Hello handler on SessionService. Use this from the daemon's
 * production startup wiring (T1.7) — pass through to
 * `createDaemonNodeAdapter({ helloDeps: ... })`. Unit tests that want
 * pure stubs (no real handlers) keep using `stubRoutes`.
 */
export function makeDaemonRoutes(
  helloDeps: HelloDeps,
  watchSessionsDeps?: WatchSessionsDeps,
  crashDeps?: CrashServiceDeps,
  readHandlersDeps?: ReadHandlersDeps,
  destroyHandlerDeps?: DestroySessionDeps,
  settingsDeps?: SettingsServiceDeps,
  draftDeps?: DraftServiceDeps,
  ptyAttachDeps?: PtyAttachDeps,
  createSessionDeps?: CreateSessionDeps,
): (router: ConnectRouter) => void {
  return (router: ConnectRouter): void => {
    registerStubServices(router);
    if (watchSessionsDeps !== undefined) {
      registerSessionService(router, {
        helloDeps,
        watchSessionsDeps,
        readHandlersDeps,
        destroyHandlerDeps,
        createSessionDeps,
      });
    } else {
      registerHelloHandler(router, helloDeps);
    }
    // CrashService overlay (Wave-3 #229 / #335 / #334; audit #228
    // sub-tasks 2 + 3). `registerCrashService` REPLACES the stub
    // registration for CrashService with a full v0.3 impl exposing
    // `getCrashLog` (#229), `watchCrashLog` (#335) and
    // `getRawCrashLog` (#334). Same additive overlay shape as
    // SessionService above.
    if (crashDeps !== undefined) {
      registerCrashService(router, crashDeps);
    }
    // SettingsService overlay (Wave-3 #349 / audit #228 sub-task 9 /
    // spec #337 §6.1 step 1). Replaces the stub `{}` registration with
    // a full impl exposing `GetSettings` + `UpdateSettings` against the
    // existing `settings` table (no new migration — spec §1).
    if (settingsDeps !== undefined) {
      registerSettingsService(router, settingsDeps);
    }
    // DraftService overlay (Wave-3 #349 / spec #337 §6.1 step 1).
    // Drafts ride on the same `settings` table under key
    // `draft:<session_id>` (spec §2.2 + draft.proto line 8); the
    // overlay exposes `GetDraft` + `UpdateDraft`.
    if (draftDeps !== undefined) {
      registerDraftService(router, draftDeps);
    }
    // PtyService.Attach overlay (Wave-3 §6.9 sub-task 10 / Task #355 /
    // spec `2026-05-04-pty-attach-handler.md` §9.2 T-PA-6). Wires the
    // server-streaming Attach handler against the per-session in-memory
    // emitter registry (PR #1027 / T-PA-5 supplies the production
    // `getEmitter`; tests pass an inline fake). Other PtyService
    // methods stay `Code.Unimplemented` until their tasks land.
    if (ptyAttachDeps !== undefined) {
      registerPtyService(router, ptyAttachDeps);
    }
  };
}

/**
 * Adapter-construction options. We accept the same shape as
 * `ConnectRouterOptions` (gRPC / gRPC-Web / Connect protocol toggles)
 * plus an optional `requestPathPrefix` that the listener layer may
 * supply if it wants to mount the router under a sub-path (the v0.3
 * Listener A serves the router at the root, so the default is empty).
 *
 * `helloDeps` (T2.3) — when provided, the adapter installs the real
 * `SessionService.Hello` handler in addition to the stub baseline. When
 * omitted (the default), every service responds with `Unimplemented`
 * exactly like the T2.2 baseline. The omit-default keeps the T2.2
 * `__tests__/router.spec.ts` and `__tests__/integration.spec.ts`
 * over-the-wire Unimplemented assertions intact.
 */
export interface CreateDaemonNodeAdapterOptions extends ConnectRouterOptions {
  /** Optional URL prefix; default `""` (mount at root). */
  readonly requestPathPrefix?: string;
  /** When set, installs the T2.3 Hello handler on top of the stubs. */
  readonly helloDeps?: HelloDeps;
  /**
   * When set (and `helloDeps` is also set), installs the T3.3
   * WatchSessions streaming handler in the same SessionService
   * registration as Hello — see `registerSessionService` for the
   * "registering a single descriptor twice replaces" caveat that forces
   * the combined registration. v0.3 ships this when the daemon startup
   * wiring (T1.7) constructs a `SessionManager`; tests that don't need
   * a manager simply omit it (Hello-only path stays).
   */
  readonly watchSessionsDeps?: WatchSessionsDeps;
  /**
   * When set, installs the Wave-3 CrashService overlay (Tasks #229
   * + #335 + #334; audit #228 sub-tasks 2 + 3) on top of the stubs.
   * This binds `CrashService.GetCrashLog` (unary),
   * `CrashService.WatchCrashLog` (server-streaming, event-bus driven)
   * and `CrashService.GetRawCrashLog` (server-streaming, file
   * chunked) — the entire v0.3 CrashService surface. Production
   * startup wires this when `index.ts` constructs a `crashDeps` (the
   * same `db` handle the rest of startup uses, the
   * `defaultCrashEventBus` singleton appended to by
   * `appendCrashRaw`, plus the resolved `state/crash-raw.ndjson`
   * path); tests omit it for the stub baseline.
   */
  readonly crashDeps?: CrashServiceDeps;
  /**
   * When set (and `helloDeps` + `watchSessionsDeps` are also set),
   * installs the Wave 3 §6.9 sub-task 5 (Task #336) read pair
   * (ListSessions / GetSession) in the same SessionService
   * registration. Both handlers reuse the SessionManager already wired
   * for WatchSessions (single owner of the sessions table). Tests that
   * don't need the read pair simply omit it and those two methods stay
   * `Unimplemented`.
   */
  readonly readHandlersDeps?: ReadHandlersDeps;
  /**
   * When set (and `helloDeps` + `watchSessionsDeps` are also set),
   * installs the Wave 3 §6.9 sub-task 7 (Task #338) DestroySession
   * handler in the same SessionService registration. Reuses the same
   * `SessionManager` instance the WatchSessions / read overlays use so
   * a DestroySession publishes to the same in-memory event bus the
   * WatchSessions stream subscribes to (round-trip: destroy one ->
   * watcher sees `destroyed` event). Tests that don't need the destroy
   * wire-up simply omit it and the method stays `Unimplemented`.
   */
  readonly destroyHandlerDeps?: DestroySessionDeps;
  /**
   * When set (and `helloDeps` + `watchSessionsDeps` are also set),
   * installs the Wave 3 §6.9 sub-task 6 (Task #339) CreateSession
   * handler in the same SessionService registration as Hello +
   * WatchSessions + read pair + DestroySession (see
   * `registerSessionService` for the "registering twice replaces"
   * caveat). Reuses the SAME `SessionManager` instance the other
   * SessionService overlays use so a CreateSession publishes a
   * `created` event to the same in-memory bus the WatchSessions stream
   * subscribes to (round-trip: create one -> watcher sees `created`)
   * and the new row is immediately visible to ListSessions /
   * GetSession on the same boot. PTY spawn for the freshly-created
   * session is OUT OF SCOPE here — Task #359 wires
   * `attachPtyHost` separately so this unary handler stays decoupled
   * from the spawn lifecycle (see `create-handler.ts` SCOPE note).
   * Tests that don't need the create wire-up simply omit it and the
   * method stays `Unimplemented`.
   */
  readonly createSessionDeps?: CreateSessionDeps;
  /**
   * When set, installs the Wave-3 SettingsService overlay (Task #349 /
   * audit #228 sub-task 9 / spec #337 §6.1 step 1) on top of the
   * stubs. Both `GetSettings` and `UpdateSettings` ship in this
   * registration (no streaming methods on the service). Production
   * startup wires this when `index.ts` constructs a `settingsDeps`
   * against the same `db` handle; tests omit it for the stub baseline.
   */
  readonly settingsDeps?: SettingsServiceDeps;
  /**
   * When set, installs the Wave-3 DraftService overlay (Task #349 /
   * spec #337 §6.1 step 1) on top of the stubs. Both `GetDraft` and
   * `UpdateDraft` ship in this registration. Drafts ride on the
   * `settings` table under key `draft:<session_id>` so this overlay
   * shares the SettingsService `db` handle.
   */
  readonly draftDeps?: DraftServiceDeps;
  /**
   * When set, installs the Wave-3 §6.9 sub-task 10 (Task #355 / spec
   * `2026-05-04-pty-attach-handler.md` §9.2 T-PA-6) PtyService.Attach
   * server-streaming overlay. `getEmitter` is the seam to the per-
   * session `PtySessionEmitter` registry that PR #1027 (T-PA-5)
   * exports. Production startup wires it as `(sid) =>
   * ptyEmitterRegistry.getEmitter(sid)`; tests pass an inline fake.
   * Other PtyService methods (SendInput / Resize / AckPty /
   * CheckClaudeAvailable) stay `Code.Unimplemented` until their
   * owning tasks land.
   */
  readonly ptyAttachDeps?: PtyAttachDeps;
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
 *
 * Interceptor wiring: T2.4 (#37) — `requestMetaInterceptor` is prepended
 * to whatever interceptor list the caller supplies, so it runs FIRST in
 * the chain and rejects empty / whitespace-only `RequestMeta.request_id`
 * before any handler sees the call. Caller-supplied interceptors run
 * AFTER (e.g. T1.3 `peerCredAuthInterceptor` deposited by `makeListenerA`,
 * which prepends auth in front of meta-validation when it builds its own
 * interceptor list — see `bind.ts`). Order is enforced here rather than
 * in `makeListenerA` so any future call site that reaches
 * `createDaemonNodeAdapter` directly still inherits the meta-validation
 * (the alternative — relying on every caller to remember to push the
 * interceptor — is a documentation-only invariant the F7 spec rule
 * forbids).
 */
export function createDaemonNodeAdapter(
  options: CreateDaemonNodeAdapterOptions = {},
): DaemonNodeHandler {
  const {
    helloDeps,
    watchSessionsDeps,
    crashDeps,
    readHandlersDeps,
    destroyHandlerDeps,
    settingsDeps,
    draftDeps,
    ptyAttachDeps,
    createSessionDeps,
    interceptors: callerInterceptors,
    ...rest
  } = options;
  const routes =
    helloDeps !== undefined
      ? makeDaemonRoutes(
          helloDeps,
          watchSessionsDeps,
          crashDeps,
          readHandlersDeps,
          destroyHandlerDeps,
          settingsDeps,
          draftDeps,
          ptyAttachDeps,
          createSessionDeps,
        )
      : stubRoutes;
  const interceptors = [
    requestMetaInterceptor,
    ...(callerInterceptors ?? []),
  ];
  return connectNodeAdapter({
    ...rest,
    interceptors,
    routes,
  });
}
