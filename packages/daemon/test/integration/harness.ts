// packages/daemon/test/integration/harness.ts
//
// Shared in-process Connect harness for the integration spec family
// (T8.10 — peer-cred-rejection, version-mismatch, crash-stream,
// crash-getlog, settings-roundtrip, settings-error).
//
// What this harness owns:
//   - Spin up an h2c (HTTP/2 cleartext) Connect server on an ephemeral
//     127.0.0.1 port.
//   - Wire the daemon's `peerCredAuthInterceptor` (T1.3 / src/auth) so
//     `ctx.principal` is populated for every handler under test.
//   - Inject the per-connection `PeerInfo` into the Connect contextValues
//     using the loopback-TCP "Authorization: Bearer test-token" path —
//     the canonical Listener-A test seam (T1.5 will replace this with the
//     UDS / named-pipe peer-cred extractors).
//   - Hand every spec a typed Connect client + the principalKey of the
//     authenticated caller.
//
// What this harness does NOT own:
//   - Any RPC handler — each spec wires its own service implementation
//     into the router (the SessionService Hello handler, the SettingsService
//     impls, the CrashService stream, etc.). Handlers are deliberately
//     spec-scoped so each .spec.ts file remains the single source of
//     truth for what its RPC's contract is.
//   - The descriptor file / Listener factory (T1.4) — those land in
//     T1.4 / T1.5 and pull this harness's transport bring-up into a real
//     production code path. Until then, the harness is the moral
//     equivalent of a Listener-A test seam (spec ch12 §3 names this
//     pattern: "daemon runs in-process (not service-installed) on an
//     ephemeral port / temp UDS path").
//   - SQLite / state-dir bring-up — settings-roundtrip.spec.ts uses
//     `openDatabase(':memory:')` directly and seeds the `settings` table
//     itself; harness stays storage-agnostic.
//
// Why a dedicated harness vs. inlining the bring-up in each spec:
//   - SRP: every spec that needs an authenticated Connect client today
//     would otherwise duplicate ~80 lines of http2 + interceptor wiring.
//     One place to change when T1.5 lands the real PeerInfo injector.
//   - Avoids re-inventing the existing rpc/clients-transport-matrix.spec.ts
//     pattern: that file owns the multi-transport matrix (which
//     deliberately bypasses the auth interceptor — it tests transports,
//     not auth). T8.10 specs need the auth chain in the loop, so the
//     harness composes the interceptor on top.

import * as http2 from 'node:http2';
import { randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import {
  type Client,
  type ConnectRouter,
  type Interceptor,
  createClient,
} from '@connectrpc/connect';
import {
  connectNodeAdapter,
  createConnectTransport,
} from '@connectrpc/connect-node';
import type { DescService } from '@bufbuild/protobuf';

import {
  PEER_INFO_KEY,
  TEST_BEARER_TOKEN,
  peerCredAuthInterceptor,
  type PeerInfo,
} from '../../src/auth/index.js';
import { RequestMetaSchema } from '@ccsm/proto';

// ---------------------------------------------------------------------------
// Per-test bring-up shape — returned by `startHarness` and consumed by the
// spec's beforeEach/afterEach pair.
// ---------------------------------------------------------------------------

export interface Harness {
  /** Authority of the server (`http://127.0.0.1:<port>`). */
  readonly baseUrl: string;
  /** Tear down the server + close any open http2 sessions. */
  readonly stop: () => Promise<void>;
  /**
   * Make a Connect client for a given service descriptor. Each call
   * returns a fresh client bound to the harness's transport — cheap, so
   * specs that need multiple service clients can call this several times.
   * The caller (loopback) is the canonical test principal `local-user:test`.
   */
  readonly makeClient: <T extends DescService>(desc: T) => Client<T>;
  /**
   * Make a client whose underlying transport sends NO Authorization header.
   * The Connect call will reject with `Unauthenticated` at the
   * interceptor layer before the handler runs. Used by the
   * peer-cred-rejection spec.
   */
  readonly makeUnauthenticatedClient: <T extends DescService>(desc: T) => Client<T>;
  /**
   * Make a client whose Authorization header carries an arbitrary bearer
   * value (e.g., a non-allowlisted user's token). Forces the
   * `derivePrincipal` failure path under loopback-TCP transport. The
   * peer-cred-rejection spec uses this for the wrong-token case.
   */
  readonly makeClientWithBearer: <T extends DescService>(
    desc: T,
    bearer: string,
  ) => Client<T>;
}

// ---------------------------------------------------------------------------
// Service-impl injection helper. Each spec passes a function that takes the
// router and registers its handlers; the harness composes the interceptor
// chain identically across all specs.
// ---------------------------------------------------------------------------

export type RouterSetup = (router: ConnectRouter) => void;

export interface StartOptions {
  /**
   * Wire one or more service impls into the router. Called once at start.
   * Specs typically pass a single arrow that calls `router.service(...)`
   * for each service they exercise.
   */
  readonly setup: RouterSetup;
  /**
   * Optional extra server-side interceptors (after the peer-cred
   * interceptor). Most specs leave this empty; T1.7's request-meta
   * validator will be added here once it lands. Order matches Connect's
   * left-to-right composition.
   */
  readonly extraInterceptors?: readonly Interceptor[];
}

// ---------------------------------------------------------------------------
// PeerInfo injection — the test seam.
//
// The real Listener-A path (T1.5) reads peer credentials from the OS the
// moment a connection is accepted. For the in-process harness we stand in
// the loopback-TCP variant of `PeerInfo` because:
//   1. h2c-loopback is the only universally-supported transport (UDS is
//      POSIX-only, named pipe is Windows-only — see clients-transport-
//      matrix.spec.ts skip rules);
//   2. the daemon's `peerCredAuthInterceptor` already understands the
//      bearer-token shape of `LoopbackTcpPeer` (TEST_BEARER_TOKEN), so we
//      get the real interceptor decision-table in the loop without
//      mocking it out.
//
// This is the explicit "mocked peer-cred middleware" path called out in
// spec ch12 §3 peer-cred-rejection: the OS-syscall path (real second uid)
// is gated on a self-hosted Ubuntu runner with `useradd ccsm-test-other`;
// the matrix legs use the bearer-token mock to validate the auth chain.
// ---------------------------------------------------------------------------

const peerInfoFromHeaderInterceptor: Interceptor = (next) => async (req) => {
  const authz = req.header.get('authorization');
  let bearerToken: string | null = null;
  if (authz !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(authz);
    if (match !== null) {
      bearerToken = match[1] ?? null;
    }
  }
  const peer: PeerInfo = {
    transport: 'loopbackTcp',
    bearerToken,
    remoteAddress: '127.0.0.1',
    remotePort: 0,
  };
  req.contextValues.set(PEER_INFO_KEY, peer);
  return next(req);
};

// ---------------------------------------------------------------------------
// startHarness — the public entry point.
// ---------------------------------------------------------------------------

export async function startHarness(opts: StartOptions): Promise<Harness> {
  const interceptors: Interceptor[] = [
    // 1. inject PeerInfo from the request's Authorization header (replaces
    //    the OS peer-cred extractor for in-process tests).
    peerInfoFromHeaderInterceptor,
    // 2. derive Principal from PeerInfo and stash on PRINCIPAL_KEY. Throws
    //    Unauthenticated before any handler if derivation fails.
    peerCredAuthInterceptor,
    // 3. spec-supplied extras (e.g., request-meta validator).
    ...(opts.extraInterceptors ?? []),
  ];

  const handler = connectNodeAdapter({
    routes: opts.setup,
    interceptors,
  });

  const server = http2.createServer({}, handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // OS-assigned ephemeral port — concurrent test files do not collide.
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string' || typeof addr.port !== 'number') {
    throw new Error('harness: loopback listen returned no port');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  function clientWithAuth<T extends DescService>(
    desc: T,
    authzValue: string | null,
  ): Client<T> {
    const transport = createConnectTransport({
      httpVersion: '2',
      baseUrl,
      // Inject the Authorization header on every call. We use a Connect
      // client interceptor so the header is set per RPC, before Connect
      // frames the request — this matches how a real Electron client
      // would attach an auth header.
      interceptors: [
        (next) => async (req) => {
          if (authzValue !== null) {
            req.header.set('authorization', authzValue);
          }
          return next(req);
        },
      ],
    });
    return createClient(desc, transport);
  }

  return {
    baseUrl,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Hard timeout so a hung client connection does not pin teardown.
        setTimeout(() => resolve(), 1000).unref();
      });
    },
    makeClient: (desc) => clientWithAuth(desc, `Bearer ${TEST_BEARER_TOKEN}`),
    makeUnauthenticatedClient: (desc) => clientWithAuth(desc, null),
    makeClientWithBearer: (desc, bearer) =>
      clientWithAuth(desc, `Bearer ${bearer}`),
  };
}

// ---------------------------------------------------------------------------
// Convenience: build a `RequestMeta` with a non-empty UUID. Every RPC
// requires one (ch04 §2 — empty request_id → InvalidArgument
// `request.missing_id`). Specs use this to keep test bodies short.
// ---------------------------------------------------------------------------

export function newRequestMeta() {
  return create(RequestMetaSchema, {
    requestId: randomUUID(),
    clientVersion: '0.3.0-test',
    clientSendUnixMs: BigInt(Date.now()),
  });
}

// Re-export the principalKey of the canonical loopback test caller — specs
// that assert owner_id matches the caller use this to avoid hardcoding the
// string in two places.
export const TEST_PRINCIPAL_KEY = 'local-user:test';
