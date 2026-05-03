// PeerInfo — the transport-neutral envelope produced by per-OS peer-cred
// extractors and consumed by the auth interceptor (./interceptor.ts).
//
// Spec refs:
//   - ch03 §1 PeerInfo shape (`uds?` / `loopback?`).
//   - ch03 §5 per-transport derivation mechanism.
//   - ch05 §3 derivation rules table.
//
// The envelope is a closed discriminated union via the `transport` tag.
// One field is populated per accepted connection; the others are absent.
// The HTTP/2 server adapter (T1.5) inspects the underlying socket on each
// connection and writes a `PeerInfo` into the Connect `contextValues` under
// `PEER_INFO_KEY`. The interceptor reads it back, derives a `Principal`,
// and stores the `Principal` under `PRINCIPAL_KEY` for downstream handlers.
//
// Why a tagged union and not separate `uds`/`loopback`/`namedPipe` optional
// fields: the spec lists three concrete transports (UDS, named pipe,
// loopback TCP). Forgetting to populate exactly one is a bug; an
// optional-field shape silently degrades to "no principal" instead of
// throwing — discriminated union forces the producer to pick a variant.

import { createContextKey } from '@connectrpc/connect';

/**
 * UDS peer credentials — produced by `getsockopt(SO_PEERCRED)` on linux
 * and `getsockopt(LOCAL_PEERCRED)` on macOS. The kernel returns the uid /
 * gid of the process that owns the connecting end of the socket at
 * connect-time; this is race-free relative to the accept call (the kernel
 * snapshots the credentials when the connection is established).
 *
 * `pid` is not always available on macOS (xucred carries `cr_uid` but the
 * peer pid requires `LOCAL_PEERPID` as a separate `getsockopt`); leave it
 * `null` rather than fabricating zero. Callers MUST NOT rely on `pid` for
 * authorization — only `uid` is the security principal (spec ch03 §5).
 */
export interface UdsPeerCred {
  readonly transport: 'uds';
  readonly uid: number;
  readonly gid: number;
  readonly pid: number | null;
}

/**
 * Windows named-pipe peer credentials — produced by
 * `ImpersonateNamedPipeClient` + `OpenThreadToken` +
 * `GetTokenInformation(TokenUser)`. The SID is the security identifier of
 * the user account that owns the connecting process; `LookupAccountSid`
 * resolves it to a display name (best-effort, may fail for orphan SIDs
 * from deleted local accounts — empty string in that case).
 *
 * SID-as-string form is the canonical Windows representation (e.g.,
 * `S-1-5-21-...-1001`). Spec ch05 §3 pins this as the `uid` value for
 * the `local-user` principal on Windows — there is no separate `sid`
 * field on the `Principal` type, by design (spec ch03 §5 commentary).
 */
export interface NamedPipePeerCred {
  readonly transport: 'namedPipe';
  readonly sid: string;
  readonly displayName: string;
}

/**
 * Loopback TCP peer "credentials" — for v0.3 this is purely a development /
 * test transport (Listener A goes UDS / named-pipe in production). The
 * spec ch03 §5 PID-based synthesis path (`GetExtendedTcpTable` /
 * `/proc/net/tcp`) is deferred to T1.5 if loopback ever becomes a
 * production fallback. For T1.3 we accept a stable test bearer token in
 * the `Authorization` header so unit tests + smoke harnesses can exercise
 * the interceptor without standing up a UDS or named pipe.
 *
 * `bearerToken` is the raw value extracted from the `Authorization: Bearer
 * <token>` request header by the transport adapter. The interceptor checks
 * it against a single forever-stable test value; any mismatch (or absence)
 * is rejected with `Unauthenticated` exactly like a failed peer-cred
 * lookup. The test principal uses `kind: 'local-user'` with `uid: 'test'`
 * so it threads through the same `principalKey` pipeline (`local-user:test`)
 * as any other caller — no special-case in handlers.
 */
export interface LoopbackTcpPeer {
  readonly transport: 'loopbackTcp';
  readonly bearerToken: string | null;
  /** Useful for diagnostics only; not authoritative. */
  readonly remoteAddress: string;
  readonly remotePort: number;
}

/** Closed discriminated union of every peer-info shape v0.3 accepts. */
export type PeerInfo = UdsPeerCred | NamedPipePeerCred | LoopbackTcpPeer;

/**
 * Sentinel value for "no peer info was provided by the transport adapter".
 * The interceptor treats this exactly like a derivation failure (throws
 * Unauthenticated). The default-value mechanism is the only safe shape:
 * Connect's `contextValues.get` requires a default, and we do NOT want
 * `undefined` to thread silently into a handler that forgot to check.
 */
export const NO_PEER_INFO: PeerInfo = {
  transport: 'loopbackTcp',
  bearerToken: null,
  remoteAddress: '',
  remotePort: 0,
};

/**
 * Connect contextValues key under which the HTTP/2 server adapter writes
 * the per-connection `PeerInfo`. Read by `peerCredAuthInterceptor`.
 * Symbol identity is process-local — exporting the key from a single module
 * keeps producers and consumers in lockstep.
 */
export const PEER_INFO_KEY = createContextKey<PeerInfo>(NO_PEER_INFO, {
  description: 'ccsm.daemon.auth.peerInfo',
});
