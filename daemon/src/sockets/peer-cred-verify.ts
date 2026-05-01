// T46 — Sender peer-cred verification on each accepted Connect /
// Control socket connection.
//
// Per feedback_single_responsibility: this module is a pure DECIDER /
// PRODUCER seam. It observes a freshly-accepted socket, asks the OS
// "who is on the other end?" through an injected native binding, and
// returns the verdict + the peer descriptor. It performs NO side
// effects: it does not close the socket, does not log, does not throw
// on mismatch. The caller (Connect adapter on `accept()`) decides
// what to do with the verdict — typically `socket.destroy()` + warn,
// per the §3.4.1.g HMAC-as-authoritative posture (peer-cred is
// defense-in-depth; HMAC handshake is the binding identity proof).
//
// Spec:
//   - frag-3.4.1 §3.4.1.j: sender peer-cred verification on each
//     accepted connection.
//   - v0.3-design.md §3.1.1: "Sender peer-cred verification: on each
//     accepted connection, daemon validates peer is same user. Win:
//     GetNamedPipeClientProcessId → OpenProcessToken → match user
//     SID. Unix: SO_PEERCRED (Linux) / getpeereid (Mac)."
//
// Per-platform native call shape (frag-11 ccsm_native binding):
//   Win32 :  GetNamedPipeClientProcessId(pipeHandle)
//              → OpenProcessToken(pid, TOKEN_QUERY)
//              → GetTokenInformation(TokenUser)
//              → ConvertSidToStringSidW
//   Linux :  getsockopt(fd, SOL_SOCKET, SO_PEERCRED) → ucred
//   Darwin:  getpeereid(fd) → (uid, gid)
//
// Per the §3.5.1.1.a "no direct native import outside
// daemon/src/native/impl/" rule (mirrored from frag-3.5.1 for the
// PTY native surface), this module does NOT load the binding
// directly. Production wires real deps via the future
// `daemon/src/native/index.ts` shim alongside frag-11; tests inject
// fakes per-platform.
//
// Mirrors T38 (sigchld-reaper) / T39 (win-jobobject) / T45 patterns:
// per-platform DI seam, default-loader throws a frag-11 pointer
// until the binding lands.
//
// Single-responsibility breakdown:
//   - PRODUCER : asks the OS for the peer descriptor.
//   - DECIDER  : compares peer against the expected identity.
//   - SINK     : NONE — caller closes / logs.

import type { Socket } from 'node:net';

/**
 * Peer descriptor returned by the OS, normalised across platforms.
 *
 * - Win32  : `{ pid, sid }` — `OpenProcessToken` user SID is the
 *            authoritative identity; `uid` is left undefined because
 *            Windows has no POSIX uid concept and faking one would
 *            invite cross-platform identity confusion.
 * - Linux  : `{ uid, gid, pid }` — `SO_PEERCRED` returns all three;
 *            `sid` is undefined.
 * - Darwin : `{ uid, gid }` — `getpeereid` returns no pid; the
 *            `peerPid` field used in `pino.warn` envelope_oversize
 *            logs (frag-3.4.1 §3.4.1, line 28) is therefore
 *            best-effort on macOS and callers MUST tolerate
 *            `pid === undefined`.
 */
export interface PeerInfo {
  /** POSIX user id. Undefined on Win32. */
  uid?: number;
  /** POSIX group id. Undefined on Win32 + Darwin (getpeereid returns
   *  it but we keep the surface symmetric with Win where it is
   *  meaningless). Linux fills it. */
  gid?: number;
  /** OS process id of the peer. Undefined on Darwin (getpeereid
   *  does not return it). */
  pid?: number;
  /** Windows user SID (`S-1-5-21-...`). Undefined on POSIX. */
  sid?: string;
}

/**
 * Result of `verifyPeerCred`. The caller — the Connect / Control
 * adapter `accept()` handler — decides what to do based on `same`:
 *
 *   if (!result.same) {
 *     log.warn({ peer: result.peer }, 'peer_cred_mismatch');
 *     socket.destroy();
 *     return;
 *   }
 *   ctx.peer = { uid: result.peer.uid ?? -1, pid: result.peer.pid ?? -1 };
 *
 * The verifier itself never throws on mismatch — that would force
 * try/catch around every `accept()` and conflate "peer is wrong"
 * (security event, log + destroy) with "native call exploded"
 * (programmer error, crash). Native call failures DO throw; see
 * `verifyPeerCred` JSDoc for that path.
 */
export interface PeerCredVerification {
  /**
   * `true` iff the peer matches the expected identity:
   *   - Win32 : `peer.sid === expectedSid`
   *   - POSIX : `peer.uid === expectedUid`
   * Comparison is strict equality on the canonicalised SID string
   * (Win) or numeric uid (POSIX). No prefix / SID-history /
   * impersonation-chain unwrapping — the §3.1.1 spec text says
   * "match user SID", interpreted as the token's primary user SID.
   */
  same: boolean;
  /** Peer descriptor as returned by the OS. Always populated when
   *  the native call succeeds (which is the only path that reaches
   *  this return — failure throws). */
  peer: PeerInfo;
}

/**
 * Native peer-cred surface, exposed by the in-tree `ccsm_native`
 * binding (frag-11). Every platform exposes a different subset; the
 * binding's TypeScript declaration (future
 * `daemon/src/native/index.d.ts`) will narrow these by `process.platform`.
 *
 * Production wires this through the future
 * `daemon/src/native/index.ts` shim (per the §3.5.1.1.a "no direct
 * native import outside `daemon/src/native/impl/`" rule). Tests
 * inject fakes per-platform.
 *
 * All methods MUST throw on the wrong platform — the per-platform
 * branching in `verifyPeerCred` only calls the matching surface, so
 * this is a safety net for misconfigured production wiring.
 */
export interface NativePeerCredDeps {
  // ---- Win32 ----
  /**
   * Resolve the client process id of an accepted named-pipe
   * connection. Wraps `GetNamedPipeClientProcessId(hPipe)`.
   *
   * The argument is the freshly-accepted Node `Socket` whose
   * underlying handle is a Win32 named pipe. The binding extracts
   * the OS handle via `socket._handle.fd` (or the equivalent N-API
   * accessor); this module passes the raw `Socket` so the binding
   * owns that extraction in one place.
   *
   * MUST throw on non-Win32 (`ENOSYS`).
   */
  getNamedPipeClientProcessId?(socket: Socket): number;

  /**
   * Open the process token for `pid`, query `TokenUser`, and return
   * the canonical string SID (`S-1-5-21-...`) via
   * `ConvertSidToStringSidW`. Wraps the
   * `OpenProcessToken(PROCESS_QUERY_LIMITED_INFORMATION) →
   * GetTokenInformation(TokenUser) → ConvertSidToStringSidW`
   * sequence as one native call so the JS layer never sees a
   * dangling token handle.
   *
   * MUST throw on non-Win32 (`ENOSYS`).
   * MUST throw on dead pid / access denied — those are programmer
   * or environmental errors that the caller should surface, not
   * silently treat as "different user".
   */
  openProcessTokenUserSid?(pid: number): string;

  // ---- Linux ----
  /**
   * `getsockopt(fd, SOL_SOCKET, SO_PEERCRED)` — returns the kernel-
   * recorded `(pid, uid, gid)` of the peer at `connect()` time.
   * Linux-only; macOS does not implement `SO_PEERCRED` (the
   * matching primitive is `getpeereid`).
   *
   * As with `getNamedPipeClientProcessId`, the binding extracts the
   * underlying fd from the Node `Socket` itself.
   *
   * MUST throw on non-Linux (`ENOSYS`).
   */
  getsockoptPeerCred?(socket: Socket): { uid: number; gid: number; pid: number };

  // ---- Darwin ----
  /**
   * `getpeereid(fd)` — returns the effective `(uid, gid)` of the
   * peer at `connect()` time on macOS / BSD. Does NOT return a pid;
   * callers MUST treat `peer.pid` as undefined on this platform.
   *
   * MUST throw on non-Darwin (`ENOSYS`). (Linux's libc has
   * `getpeereid` as a wrapper around `SO_PEERCRED`, but we
   * intentionally do NOT use it on Linux — `SO_PEERCRED` gives us
   * the pid, which is required for the `peerPid` forensic field in
   * the §3.4.1 envelope_oversize log.)
   */
  getpeereid?(socket: Socket): { uid: number; gid: number };
}

/**
 * Expected identity, depending on platform.
 *
 *   - Win32 : pass `{ expectedSid }` — the daemon's own user SID,
 *             obtained at boot from `ConvertSidToStringSidW` on the
 *             daemon process token. Cached for the daemon's
 *             lifetime; no need to re-query per connection.
 *   - POSIX : pass `{ expectedUid }` — typically `process.getuid()`
 *             at daemon boot. Same caching note.
 *
 * Passing the wrong one for the platform throws — the verifier is
 * platform-aware and will not silently coerce.
 */
export type ExpectedIdentity =
  | { expectedSid: string; expectedUid?: undefined }
  | { expectedUid: number; expectedSid?: undefined };

export interface VerifyPeerCredOptions {
  /**
   * Optional dependency injection. Defaults to the in-tree native
   * binding loader (`loadDefaultDeps`), which currently throws a
   * frag-11 pointer until the binding lands. Tests always inject;
   * production code injects via the future
   * `daemon/src/native/index.ts` shim.
   */
  deps?: NativePeerCredDeps;
  /**
   * Override `process.platform` for testing. Production code does
   * NOT pass this — it is injected by the per-platform test blocks
   * to exercise all three branches on a single CI host.
   */
  platform?: NodeJS.Platform;
}

/**
 * Verify that the peer of `socket` is the same OS user as the
 * daemon. Returns `{ same, peer }`; does NOT throw on mismatch.
 *
 * Throws iff:
 *   - the native call fails (dead pid, ENOSYS, missing binding) —
 *     these are programmer / environmental errors, not security
 *     events; the caller should let them bubble to the daemon's
 *     unhandled-error sink.
 *   - the platform is unsupported (not win32 / linux / darwin) —
 *     the daemon is not supported on such hosts per frag-12 §12.1
 *     platform matrix.
 *   - `expected` is shaped wrong for the current platform (Win
 *     receives `expectedUid`, or POSIX receives `expectedSid`) —
 *     this is a programmer error in the call site wiring.
 *
 * Single responsibility: PRODUCE peer descriptor, DECIDE same/not,
 * RETURN. No socket lifecycle, no logging.
 */
export function verifyPeerCred(
  socket: Socket,
  expected: ExpectedIdentity,
  options: VerifyPeerCredOptions = {},
): PeerCredVerification {
  const platform = options.platform ?? process.platform;
  const deps = options.deps ?? loadDefaultDeps();

  switch (platform) {
    case 'win32': {
      if (typeof expected.expectedSid !== 'string') {
        throw new Error(
          'verifyPeerCred: win32 requires { expectedSid: string }, ' +
            'got expectedUid. The daemon must cache its own SID at ' +
            'boot via ConvertSidToStringSidW and pass it here.',
        );
      }
      if (
        typeof deps.getNamedPipeClientProcessId !== 'function' ||
        typeof deps.openProcessTokenUserSid !== 'function'
      ) {
        throw new Error(
          'verifyPeerCred: win32 deps missing ' +
            'getNamedPipeClientProcessId / openProcessTokenUserSid. ' +
            'Wire ccsm_native (frag-11).',
        );
      }
      const pid = deps.getNamedPipeClientProcessId(socket);
      const sid = deps.openProcessTokenUserSid(pid);
      return {
        same: sid === expected.expectedSid,
        peer: { pid, sid },
      };
    }

    case 'linux': {
      if (typeof expected.expectedUid !== 'number') {
        throw new Error(
          'verifyPeerCred: linux requires { expectedUid: number }, ' +
            'got expectedSid. The daemon must cache process.getuid() ' +
            'at boot and pass it here.',
        );
      }
      if (typeof deps.getsockoptPeerCred !== 'function') {
        throw new Error(
          'verifyPeerCred: linux deps missing getsockoptPeerCred. ' +
            'Wire ccsm_native (frag-11).',
        );
      }
      const cred = deps.getsockoptPeerCred(socket);
      return {
        same: cred.uid === expected.expectedUid,
        peer: { uid: cred.uid, gid: cred.gid, pid: cred.pid },
      };
    }

    case 'darwin': {
      if (typeof expected.expectedUid !== 'number') {
        throw new Error(
          'verifyPeerCred: darwin requires { expectedUid: number }, ' +
            'got expectedSid. The daemon must cache process.getuid() ' +
            'at boot and pass it here.',
        );
      }
      if (typeof deps.getpeereid !== 'function') {
        throw new Error(
          'verifyPeerCred: darwin deps missing getpeereid. ' +
            'Wire ccsm_native (frag-11).',
        );
      }
      const cred = deps.getpeereid(socket);
      // pid intentionally undefined per getpeereid contract.
      return {
        same: cred.uid === expected.expectedUid,
        peer: { uid: cred.uid, gid: cred.gid },
      };
    }

    default:
      throw new Error(
        `verifyPeerCred: unsupported platform "${platform}". ` +
          'Daemon is supported on win32 / linux / darwin only ' +
          '(frag-12 §12.1 platform matrix).',
      );
  }
}

/**
 * Production-default dependency loader. The in-tree
 * `ccsm_native.node` binding is owned by frag-11 (§11.4); until it
 * lands, this throws a clear error directing callers to inject deps.
 * Tests always inject; the daemon runtime path will be wired in the
 * `daemon/src/native/index.ts` shim PR alongside the binding (per
 * §3.5.1.1.a "no direct native import" rule, this module is NOT
 * allowed to `require('../native/ccsm_native.node')` directly).
 */
export function loadDefaultDeps(): NativePeerCredDeps {
  throw new Error(
    'verifyPeerCred: no default native deps available yet. ' +
      'Pass `options.deps` until the in-tree ccsm_native binding ' +
      '(frag-11 §11.4) lands and `daemon/src/native/index.ts` is wired.',
  );
}
