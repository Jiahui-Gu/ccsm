// Connect-RPC peer-cred auth interceptor — derives `ctx.principal` from
// the `PeerInfo` deposited on the request's `contextValues` by the HTTP/2
// server adapter. Single decider for v0.3's only authn mechanism.
//
// Spec refs:
//   - ch03 §1 Listener trait + AuthMiddleware shape (`before(...)` chain).
//   - ch03 §5 per-transport mechanism table.
//   - ch05 §2 the daemon does NOT have a "no principal" code path — every
//     handler reads `ctx.principal` and assumes it is set; the interceptor
//     throws `Unauthenticated` *before* any handler runs if derivation
//     fails. This invariant is the security baseline.
//   - ch05 §3 derivation rules per transport.
//
// SRP: this module is a *decider*. It does not perform any I/O, does not
// touch the socket, does not call out to the OS. The OS-specific syscalls
// live in `./peer-cred.ts` extractors; this file just maps the resulting
// `PeerInfo` discriminated union onto the matching `Principal` shape, sets
// the `Principal` on `contextValues`, and either continues the call chain
// or throws.
//
// Layering rationale (Connect-RPC interceptor vs. AuthMiddleware trait):
// the spec ch03 §1 `AuthMiddleware.before(...)` shape is a v0.4-friendly
// abstraction for *composing* auth links (peer-cred → JWT). For v0.3's
// single-link chain on Listener A, a Connect interceptor is the correct
// concrete realization: Connect already routes interceptor errors as
// `ConnectError` to the transport, and the contextValues mechanism is the
// blessed way to plumb per-call data into handlers. v0.4's JWT validator
// will be a second interceptor in the same array (`[peerCredAuthInterceptor,
// jwtValidatorInterceptor]`), composed left-to-right, matching the
// spec's `authChain[0]` then `authChain[1]` order.

import {
  Code,
  ConnectError,
  createContextKey,
  type Interceptor,
} from '@connectrpc/connect';
import { PEER_INFO_KEY, type PeerInfo } from './peer-info.js';
import type { Principal } from './principal.js';

/**
 * The single forever-stable bearer token that loopback-TCP callers MUST
 * supply during dev / test. Matches the spec's intent that loopback is NOT
 * production transport (spec ch03 §4 — UDS/named-pipe are the production
 * picks; loopback is fallback gated behind MUST-SPIKE) and the manager's
 * T1.3 scope of "Authorization: Bearer test-token; principal=test".
 *
 * Constant kept narrow: a single value, not a configurable allowlist. v0.4
 * will rip out the loopback path entirely once Listener B (TLS+JWT) lands;
 * any production loopback caller before then would be a mistake the test
 * token catches in code review.
 */
export const TEST_BEARER_TOKEN = 'test-token';

/** Principal for authenticated test-token loopback callers. Matches the
 * spec's discriminator (`local-user`) so handlers see no special case;
 * `uid: 'test'` is the canonical owner_id segment (`local-user:test`). */
const TEST_PRINCIPAL: Principal = {
  kind: 'local-user',
  uid: 'test',
  displayName: 'test',
};

/**
 * Connect contextValues key under which the interceptor publishes the
 * derived `Principal`. Handlers read it via
 * `req.contextValues.get(PRINCIPAL_KEY)`.
 *
 * Default is `null` — but the interceptor THROWS before any handler runs
 * if derivation fails, so a handler that observes `null` here is a wiring
 * bug (the interceptor was not installed). The null sentinel is the
 * cheapest way to make that bug throw a NullPointer-style runtime error
 * at the first deref instead of silently treating the call as anonymous.
 */
export const PRINCIPAL_KEY = createContextKey<Principal | null>(null, {
  description: 'ccsm.daemon.auth.principal',
});

/**
 * Derive a `Principal` from a `PeerInfo`. Pure function; no I/O. Throws
 * `ConnectError(Unauthenticated)` if the `PeerInfo` does not carry enough
 * information to produce a principal (spec ch05 §3 `uid MUST resolve`).
 *
 * Exported separately from `peerCredAuthInterceptor` so unit tests can
 * exercise the derivation table without going through the Connect
 * interceptor plumbing.
 */
export function derivePrincipal(peer: PeerInfo): Principal {
  switch (peer.transport) {
    case 'KIND_UDS': {
      // Linux / macOS UDS: kernel-vouched uid via SO_PEERCRED /
      // LOCAL_PEERCRED. Numeric uid stringified per spec ch05 §3.
      // displayName lookup (getpwuid_r / dscl) is best-effort and lives
      // in T1.5 alongside the native addon — for T1.3 we leave it empty
      // (spec ch05 §3 explicitly allows empty when lookup fails).
      if (!Number.isInteger(peer.uid) || peer.uid < 0) {
        throw new ConnectError(
          'invalid uid from UDS peer-cred',
          Code.Unauthenticated,
        );
      }
      return { kind: 'local-user', uid: String(peer.uid), displayName: '' };
    }
    case 'KIND_NAMED_PIPE': {
      // Windows: ImpersonateNamedPipeClient → SID. SID-as-string is the
      // canonical form for `LocalUser.uid` per spec ch05 §3 — no separate
      // `sid` field on the principal (spec ch03 §5 commentary).
      if (peer.sid === '') {
        throw new ConnectError(
          'empty SID from named-pipe peer-cred',
          Code.Unauthenticated,
        );
      }
      return { kind: 'local-user', uid: peer.sid, displayName: peer.displayName };
    }
    case 'KIND_TCP_LOOPBACK_H2C': {
      // Test-only path: spec ch03 §4 lists loopback as a MUST-SPIKE
      // fallback; v0.3 production is UDS / named-pipe. We accept exactly
      // one stable bearer token (TEST_BEARER_TOKEN) so unit tests + smoke
      // harnesses can drive the daemon without standing up a UDS. Any
      // other shape (missing token, wrong token, wrong scheme) is a hard
      // Unauthenticated — there is intentionally no "anonymous loopback"
      // path (spec ch05 §2 invariant).
      if (peer.bearerToken !== TEST_BEARER_TOKEN) {
        throw new ConnectError(
          'loopback transport requires test bearer token',
          Code.Unauthenticated,
        );
      }
      return TEST_PRINCIPAL;
    }
    default: {
      const _exhaustive: never = peer;
      throw new ConnectError(
        `unknown peer-info transport: ${String((_exhaustive as { transport: string }).transport)}`,
        Code.Unauthenticated,
      );
    }
  }
}

/**
 * The Connect interceptor. Composed into the server's interceptor list
 * during T1.4's `makeListenerA` factory; runs FIRST in the chain so every
 * downstream interceptor + handler can rely on `PRINCIPAL_KEY` being set.
 *
 * Behavior:
 *  1. Read `PEER_INFO_KEY` from `req.contextValues`. If the transport
 *     adapter forgot to populate it (sentinel default) → Unauthenticated.
 *  2. Derive `Principal` via `derivePrincipal`. Throws translate to
 *     `ConnectError(Unauthenticated)` directly if not already.
 *  3. Stash the principal under `PRINCIPAL_KEY` and continue the chain.
 *
 * Errors thrown here surface to the client as Connect's standard
 * `Unauthenticated` code; spec ch05 §3 / ch03 §5 say "Electron handles by
 * reconnecting" — the interceptor does not retry, log, or otherwise
 * decorate the failure beyond the spec's required code.
 */
export const peerCredAuthInterceptor: Interceptor = (next) => async (req) => {
  const peer = req.contextValues.get(PEER_INFO_KEY);

  // Detect the sentinel default — the transport adapter forgot to set
  // PEER_INFO_KEY for this request. Spec ch05 §2: there is no "no
  // principal" code path; reject before any handler can read context.
  // We compare on the `bearerToken === null && remoteAddress === ''`
  // shape rather than reference-equality with `NO_PEER_INFO` because
  // contextValues clones the default on each get in some Connect
  // versions (defensive — works regardless of the runtime's behavior).
  if (
    peer.transport === 'KIND_TCP_LOOPBACK_H2C' &&
    peer.bearerToken === null &&
    peer.remoteAddress === '' &&
    peer.remotePort === 0
  ) {
    throw new ConnectError(
      'transport did not provide peer credentials',
      Code.Unauthenticated,
    );
  }

  let principal: Principal;
  try {
    principal = derivePrincipal(peer);
  } catch (err) {
    // Re-throw ConnectError as-is (already typed); wrap any other throw
    // (e.g., a native-addon syscall failure that bubbled up from an
    // earlier extractor that deferred its lookup) into Unauthenticated
    // so the wire surface stays uniform.
    if (err instanceof ConnectError) throw err;
    throw new ConnectError(
      err instanceof Error ? err.message : 'peer-cred derivation failed',
      Code.Unauthenticated,
    );
  }

  req.contextValues.set(PRINCIPAL_KEY, principal);
  return next(req);
};
