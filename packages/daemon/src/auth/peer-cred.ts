// Per-OS peer-credential extractors — derive a `PeerInfo` from an
// already-accepted Node socket. Used by the HTTP/2 server adapter (T1.5)
// the moment a connection is accepted, BEFORE the request reaches any
// Connect handler.
//
// Spec refs:
//   - ch03 §5 per-transport mechanism table.
//   - ch05 §3 derivation rules table.
//
// SRP: each function in this module is a *producer* — given a socket plus
// the transport kind it was bound on, it returns a `PeerInfo` (or throws).
// The functions do NOT touch Connect, do NOT touch handlers, do NOT mutate
// shared state. The interceptor (./interceptor.ts) is the lone decider
// that turns `PeerInfo` into a `Principal`.
//
// Layer 1 — repo-internal alternatives checked:
//   - Node's `net.Socket` exposes no SO_PEERCRED helper. There is no
//     `net.Socket.getPeerCredentials()` API.
//   - The `unix-dgram` / `unix-socket-credentials` npm packages are
//     unmaintained and ship native add-ons; introducing one is a
//     dependency burden when the only consumer is daemon-internal.
//   - The minimal native FFI required (single `getsockopt(2)` per accept)
//     fits a tiny addon that T1.5 will land alongside the HTTP/2-over-UDS
//     transport (the right place — the addon needs the same toolchain as
//     the http2 server). T1.3 defines the *interface* the addon will
//     satisfy and an injection seam so T1.5 can plug in the syscall
//     without re-shaping consumer code.
//
// Concretely: each extractor accepts a `lookup` callback that performs the
// OS-specific syscall. T1.5 will provide a real implementation backed by
// the native addon; T1.3 ships a default `unsupported` implementation that
// throws `OperationUnsupported` so missing wiring fails loud at boot
// instead of silently degrading to a "no principal" path (forbidden by
// spec ch05 §2 — the daemon does NOT have a "no principal" code path).

import type { Socket } from 'node:net';
import type { LoopbackTcpPeer, NamedPipePeerCred, UdsPeerCred } from './peer-info.js';

/**
 * Result of an OS-level peer-cred lookup on a UDS socket. Returned by the
 * `udsLookup` callback that T1.5's native addon will provide. Plain shape
 * (no `PeerInfo` discriminator) so the addon stays unaware of the auth
 * module's wire vocabulary.
 */
export interface UdsLookupResult {
  readonly uid: number;
  readonly gid: number;
  /** May be `null` on macOS — see `peer-info.ts` UdsPeerCred docs. */
  readonly pid: number | null;
}

/**
 * Result of a named-pipe peer-cred lookup (Windows). `displayName` is
 * best-effort: empty string when `LookupAccountSid` cannot resolve the
 * SID (orphan SIDs from deleted local accounts).
 */
export interface NamedPipeLookupResult {
  readonly sid: string;
  readonly displayName: string;
}

/** Synchronous syscall callback contract for UDS peer-cred lookup. */
export type UdsLookup = (socket: Socket) => UdsLookupResult;

/** Synchronous syscall callback contract for named-pipe peer-cred lookup. */
export type NamedPipeLookup = (socket: Socket) => NamedPipeLookupResult;

/**
 * Default UDS lookup — throws `OperationUnsupported` so a transport that
 * forgot to wire T1.5's addon fails loud at the first connection rather
 * than silently rejecting every caller as `Unauthenticated` (which would
 * still be safe but would confuse operators chasing "why does nobody
 * connect"). The error message names the seam so the fix is one grep away.
 */
export const unsupportedUdsLookup: UdsLookup = () => {
  throw new Error(
    'UDS peer-cred lookup not wired — provide a `UdsLookup` callback to extractUdsPeerCred (T1.5 native addon).',
  );
};

/** Default named-pipe lookup — same fail-loud philosophy as `unsupportedUdsLookup`. */
export const unsupportedNamedPipeLookup: NamedPipeLookup = () => {
  throw new Error(
    'Named-pipe peer-cred lookup not wired — provide a `NamedPipeLookup` callback to extractNamedPipePeerCred (T1.5 native addon).',
  );
};

/**
 * Extract UDS peer credentials from an accepted socket. Spec ch03 §5
 * (linux: `getsockopt(SO_PEERCRED)`; macOS: `getsockopt(LOCAL_PEERCRED)`).
 *
 * Throws (typically the addon's own error) if the kernel rejects the
 * syscall — e.g., the peer process exited between accept(2) and
 * getsockopt(2). Caller (the interceptor) translates the throw into a
 * Connect `Unauthenticated` error.
 */
export function extractUdsPeerCred(
  socket: Socket,
  lookup: UdsLookup = unsupportedUdsLookup,
): UdsPeerCred {
  const { uid, gid, pid } = lookup(socket);
  return { transport: 'KIND_UDS', uid, gid, pid };
}

/**
 * Extract named-pipe peer credentials from an accepted socket on Windows.
 * Spec ch03 §5 / ch05 §3: `ImpersonateNamedPipeClient` + `OpenThreadToken`
 * + `GetTokenInformation(TokenUser)` → SID; `LookupAccountSid` for the
 * advisory display name.
 *
 * Returns the SID as a string in canonical Windows form (`S-1-5-21-...`).
 * `displayName` may be empty (best-effort, never used for authorization
 * per spec ch05 §2).
 */
export function extractNamedPipePeerCred(
  socket: Socket,
  lookup: NamedPipeLookup = unsupportedNamedPipeLookup,
): NamedPipePeerCred {
  const { sid, displayName } = lookup(socket);
  if (sid === '') {
    // Empty SID is a derivation failure (the kernel would never return
    // this; an addon bug or mocked lookup that returned it must not be
    // accepted as a valid principal — spec ch05 §3 `uid MUST resolve`).
    throw new Error('named-pipe lookup returned empty SID');
  }
  return { transport: 'KIND_NAMED_PIPE', sid, displayName };
}

/**
 * Extract loopback-TCP peer "credentials" from request headers. The
 * loopback transport is dev/test only in v0.3 (Listener A binds UDS or
 * named-pipe in production; loopback is a fallback the brief explicitly
 * gates behind a MUST-SPIKE — see spec ch03 §4). For T1.3 we accept a
 * stable test bearer token; T1.5 may upgrade this to PID-based synthesis
 * if the spike forces loopback into production.
 *
 * `headers` is the standard WHATWG `Headers` instance the HTTP/2 adapter
 * already has on the request; `remoteAddress` / `remotePort` come from
 * the underlying `net.Socket` for diagnostics.
 */
export function extractLoopbackTcpPeer(
  headers: Headers,
  remoteAddress: string,
  remotePort: number,
): LoopbackTcpPeer {
  const authz = headers.get('authorization');
  let bearerToken: string | null = null;
  if (authz !== null) {
    // Match `Bearer <token>` case-insensitively per RFC 6750 §2.1, but
    // the token itself is case-sensitive. We do NOT trim the token —
    // any internal whitespace is part of the token and a mismatch should
    // (intentionally) reject it.
    const match = /^Bearer\s+(.+)$/i.exec(authz);
    if (match !== null) {
      bearerToken = match[1] ?? null;
    }
  }
  return {
    transport: 'KIND_TCP_LOOPBACK_H2C',
    bearerToken,
    remoteAddress,
    remotePort,
  };
}
