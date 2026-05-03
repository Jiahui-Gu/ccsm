// @ccsm/daemon auth subsystem — peer-cred authentication for Listener A.
//
// Spec refs:
//   - ch03 §1 Listener trait + AuthMiddleware composition.
//   - ch03 §5 per-transport mechanism table.
//   - ch05 §1-§3 Principal model, single-principal invariant, derivation
//     rules per transport.
//
// Public surface (consumed by T1.4 makeListenerA + T1.5 transport adapters):
//   - `Principal` / `principalKey` — discriminated union mirroring the
//     proto oneof, plus the canonical `owner_id` formatter.
//   - `PeerInfo` + `PEER_INFO_KEY` — transport adapters write per-call peer
//     credentials onto the Connect contextValues under this key.
//   - `peerCredAuthInterceptor` + `PRINCIPAL_KEY` — the interceptor reads
//     `PEER_INFO_KEY`, derives a `Principal`, publishes it under
//     `PRINCIPAL_KEY`, throws Unauthenticated on failure.
//   - `extractUdsPeerCred` / `extractNamedPipePeerCred` /
//     `extractLoopbackTcpPeer` — per-OS extractor helpers transport
//     adapters call at accept-time to build a `PeerInfo`.
//
// `derivePrincipal` is exported for unit-test reuse (decision table is
// tested independently of the Connect interceptor plumbing).

export type { Principal } from './principal.js';
export { principalKey } from './principal.js';
export type {
  PeerInfo,
  UdsPeerCred,
  NamedPipePeerCred,
  LoopbackTcpPeer,
} from './peer-info.js';
export { PEER_INFO_KEY, NO_PEER_INFO } from './peer-info.js';
export type {
  UdsLookup,
  UdsLookupResult,
  NamedPipeLookup,
  NamedPipeLookupResult,
} from './peer-cred.js';
export {
  extractUdsPeerCred,
  extractNamedPipePeerCred,
  extractLoopbackTcpPeer,
  unsupportedUdsLookup,
  unsupportedNamedPipeLookup,
} from './peer-cred.js';
export {
  PRINCIPAL_KEY,
  TEST_BEARER_TOKEN,
  derivePrincipal,
  peerCredAuthInterceptor,
} from './interceptor.js';
