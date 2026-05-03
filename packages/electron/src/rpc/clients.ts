// T6.3 — Typed Connect-RPC clients factory.
//
// Spec ref: `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md`
// chapter 08 §5 step 2a + §6.2.
//
// Single responsibility: given a Connect `Transport`, produce one typed
// Connect-ES client per service exported from `@ccsm/proto`. Nothing in this
// file constructs a transport — that lives in `packages/electron/src/main/`
// (T6.2 transport-bridge wires the loopback http2 endpoint; the renderer
// builds a `connect-web` transport against the bridge URL it pulls from
// `app://ccsm/listener-descriptor.json`). Keeping construction out of this
// module is the seam that lets v0.4 web/iOS reuse the SAME hook layer
// (`queries.ts`) over a different transport without touching this file.
//
// The seven services come from spec ch04 §1 / @ccsm/proto README — every
// service the v0.3 daemon ships. New RPCs land additively in their existing
// service per ch04 §8: this factory automatically picks them up because it
// only references the `*Service` GenService descriptor; method-level surface
// is generated, not enumerated here.
//
// Cross-package boundary: `@ccsm/electron` imports the public surface of
// `@ccsm/proto` (which re-exports `gen/ts/ccsm/v1/*_pb.js`). The eslint rule
// in `packages/electron/eslint.config.js` forbids importing
// `@ccsm/proto/src/*` directly — we use the package export only.

import { createClient, type Client, type Transport } from '@connectrpc/connect';
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
 * Bundle of typed clients for every service in `@ccsm/proto`. Field names
 * mirror the lower-camel form of each service so consumers read naturally
 * (`clients.session.listSessions(...)`).
 *
 * The shape is forever-stable per ch08 §6.2: v0.4 web/iOS clients share or
 * duplicate this surface; either is fine because the named services are the
 * coupling point. Adding a NEW service in v0.4 is an additive field on this
 * record — existing call sites keep typechecking.
 */
export interface CcsmClients {
  readonly session: Client<typeof SessionService>;
  readonly pty: Client<typeof PtyService>;
  readonly crash: Client<typeof CrashService>;
  readonly settings: Client<typeof SettingsService>;
  readonly notify: Client<typeof NotifyService>;
  readonly draft: Client<typeof DraftService>;
  readonly supervisor: Client<typeof SupervisorService>;
}

/**
 * Build a typed Connect client per service against a single shared
 * `Transport`. The returned object is plain — no caching, no lazy init,
 * because `createClient` is itself a thin wrapper that only stores the
 * descriptor + transport. Callers that need to swap the transport (e.g.,
 * the renderer's reconnect path after a `Hello` failure) build a new
 * bundle; the cost is negligible.
 *
 * @param transport — Connect `Transport` instance constructed by the caller.
 *                    Renderer (Electron v0.3): `connect-web`'s
 *                    `createConnectTransport({ baseUrl: bridgeUrl })`.
 *                    Tests: any `Transport` impl (the included unit test
 *                    uses a synthetic transport that records calls).
 */
export function createClients(transport: Transport): CcsmClients {
  return {
    session: createClient(SessionService, transport),
    pty: createClient(PtyService, transport),
    crash: createClient(CrashService, transport),
    settings: createClient(SettingsService, transport),
    notify: createClient(NotifyService, transport),
    draft: createClient(DraftService, transport),
    supervisor: createClient(SupervisorService, transport),
  };
}

/**
 * Re-export the service descriptors so callers that need raw access (e.g.,
 * the hook layer in `queries.ts` for cache-key derivation) can import from
 * one place rather than reaching back into `@ccsm/proto` directly. Also
 * lets the eslint boundary rule keep `@ccsm/proto` as the only sanctioned
 * proto entrypoint — downstream code only imports `./clients` / `./queries`.
 */
export {
  CrashService,
  DraftService,
  NotifyService,
  PtyService,
  SessionService,
  SettingsService,
  SupervisorService,
};
export type { Client, Transport };
