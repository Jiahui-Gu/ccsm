// daemon/src/listeners/listenerA.ts — v0.3 Task #104.
//
// "Listener A" is the canonical name for the daemon's data-plane listener
// (frag-6-7 §6.1, final-arch §2.4): a local-only loopback HTTP/2 socket
// that carries Connect-RPC traffic between the Electron client (and the
// future v0.4 web bridge over the supervisor's Listener B) and the
// daemon. Trust model is "same OS user" — every accepted connection is
// peer-credited against the daemon's own uid/sid; mismatched peers are
// rejected with Connect Code.PermissionDenied.
//
// This module ships TWO things, intentionally co-located so the trust
// model and the path that enforces it cannot drift apart:
//
//   1. Path resolver / canonical constants for the Listener A endpoint:
//        Linux/mac : `<runtimeDir>/ccsm-daemon-data.sock` UDS
//        Windows   : `\\.\pipe\ccsm-daemon-data-<sid>` named pipe
//      The Windows branch keys on the daemon's own SID rather than a
//      `userhash(username@hostname)` tag (the v0.3 data-socket choice)
//      because final-arch §2.4 elevates Listener A to the long-lived
//      data plane and SID is the authoritative Windows identity — two
//      users with identical usernames on a domain-joined host (rare but
//      possible after rename / SID-history merges) MUST NOT collide.
//
//   2. A Connect interceptor (`createPeerCredInterceptor`) that reads
//      the per-socket peer-cred verdict stamped by the listener at
//      connection-accept time and rejects mismatches with
//      `Code.PermissionDenied`. The interceptor is pure: it does not
//      touch the socket, it does not call native code; it only consults
//      the context value the listener wrote. This keeps the chain pure-
//      function testable and lets the listener own the one-shot OS call.
//
// Spec citations:
//   - frag-6-7 §6.1 (reliability + security): Listener A trust = same
//     OS user via peer-cred; reject = log + close.
//   - final-arch §2.4 (final architecture, locked 2026-05-02): Listener
//     A is the v0.3+v0.4 long-lived local data plane; control plane
//     stays on the supervisor envelope.
//   - frag-3.4.1 §3.4.1.h: peer-cred posture shared across local
//     listeners; HMAC handshake is authoritative, peer-cred is
//     defense-in-depth.
//   - frag-3.5.1 §3.5.1.1.a: native code is loaded only via
//     `daemon/src/native/index.ts` (the future ccsm_native shim, task
//     #109 / PR #798). This module imports that shim's TypeScript
//     surface; tests inject fakes.
//
// Single Responsibility breakdown:
//   - PRODUCER: `resolveListenerAPath` produces a path string from
//     platform inputs. Pure / no I/O.
//   - DECIDER: `createPeerCredInterceptor` decides pass/reject from a
//     pre-stamped context value. Pure.
//   - SINK: the listener wiring (`stampPeerCredOnAccept`) calls
//     `verifyPeerCred` and writes to a per-socket map. The actual
//     socket-accept lifecycle lives in `daemon/src/sockets/` (T15
//     data-socket already owns the OS listener). This file does NOT
//     create a `net.Server`; it provides the helpers the data-socket
//     wiring composes.

import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { posix as posixPath } from 'node:path';
import {
  Code,
  ConnectError,
  createContextKey,
  type Interceptor,
} from '@connectrpc/connect';
import {
  verifyPeerCred,
  type ExpectedIdentity,
  type NativePeerCredDeps,
  type PeerInfo,
} from '../sockets/peer-cred-verify.js';

// ---------------------------------------------------------------------------
// §1. Canonical Listener A constants + path resolver
// ---------------------------------------------------------------------------

/**
 * Canonical socket / pipe basename. Lifted to a const so test harnesses,
 * client connectors (#103), and ops tooling all reference the same string.
 *
 * NOTE: Differs from the v0.3 transitional `ccsm-data` (data-socket.ts) —
 * Listener A is the final-arch §2.4 name and survives into v0.4. The two
 * coexist during the cutover; T19 wave will retire `ccsm-data`.
 */
export const LISTENER_A_BASENAME = 'ccsm-daemon-data' as const;

/**
 * POSIX socket node filename: `<runtimeDir>/ccsm-daemon-data.sock`.
 */
export const LISTENER_A_POSIX_FILENAME = `${LISTENER_A_BASENAME}.sock` as const;

/**
 * Windows named-pipe prefix (the SID is appended at resolve time):
 *   `\\.\pipe\ccsm-daemon-data-<sid>`
 *
 * SID suffix prevents bind collisions on Citrix / RDS / shared
 * workstations and protects against username-rename SID-history
 * ambiguity.
 */
export const LISTENER_A_WIN_PIPE_PREFIX = `\\\\.\\pipe\\${LISTENER_A_BASENAME}-` as const;

export interface ResolveListenerAPathOptions {
  /** Defaults to `process.platform`. Tests override to exercise the
   *  POSIX / Win branches on a single CI host. */
  readonly platform?: NodeJS.Platform;
  /** Required on POSIX (Linux/mac). The runtime root from
   *  `resolveRuntimeRoot()` (T13). Ignored on Windows where the
   *  named-pipe namespace is global per machine. */
  readonly runtimeDir?: string;
  /** Required on Windows. Daemon's own user SID, obtained at boot via
   *  `ConvertSidToStringSidW(OpenProcessToken(GetCurrentProcess())…)`
   *  through the ccsm_native shim. Ignored on POSIX. */
  readonly sid?: string;
}

/**
 * Resolve the Listener A endpoint path for the current platform.
 *
 * - Linux/Darwin: requires `runtimeDir`; returns
 *   `<runtimeDir>/ccsm-daemon-data.sock`.
 * - Win32: requires `sid`; returns
 *   `\\.\pipe\ccsm-daemon-data-<sid>`.
 *
 * Throws if the platform-required input is missing. We REFUSE to
 * silently fall back (e.g. derive a userhash on Windows when sid is
 * absent) because that would let a misconfigured daemon bind a
 * predictable pipe name and lose the SID-collision protection that
 * justified the elevation from v0.3 `userhash`.
 */
export function resolveListenerAPath(
  opts: ResolveListenerAPathOptions = {},
): string {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    if (typeof opts.sid !== 'string' || opts.sid.length === 0) {
      throw new Error(
        'resolveListenerAPath: win32 requires { sid: string }. ' +
          'Cache the daemon SID at boot via the ccsm_native shim ' +
          '(daemon/src/native/index.ts) and pass it here.',
      );
    }
    return `${LISTENER_A_WIN_PIPE_PREFIX}${opts.sid}`;
  }
  // POSIX (linux / darwin / *bsd): UDS under runtimeDir. Use posix.join
  // so a Windows-host test forcing `platform: 'linux'` still yields a
  // POSIX-shaped path (mirrors `control-socket.ts` defaultControlSocketPath).
  if (typeof opts.runtimeDir !== 'string' || opts.runtimeDir.length === 0) {
    throw new Error(
      `resolveListenerAPath: ${platform} requires { runtimeDir: string }. ` +
        'Pass the output of resolveRuntimeRoot() (T13).',
    );
  }
  return posixPath.join(opts.runtimeDir, LISTENER_A_POSIX_FILENAME);
}

// ---------------------------------------------------------------------------
// §2. Peer-cred verdict — context key + per-socket stamping
// ---------------------------------------------------------------------------

/**
 * Verdict shape stamped onto each accepted Listener A connection. The
 * interceptor reads this; production listener code writes it (see
 * `stampPeerCredOnAccept`). Tests can write directly via
 * `setListenerAPeerCredVerdict` for in-process Connect chain tests.
 */
export interface PeerCredVerdict {
  /** True iff peer's uid (POSIX) / sid (Win) matches the daemon's own. */
  readonly same: boolean;
  /** OS-supplied peer descriptor. Always populated when verifyPeerCred
   *  succeeded — failure to call native is treated as a hard error
   *  upstream (the listener destroys the socket; the interceptor
   *  never sees that connection). */
  readonly peer: PeerInfo;
}

/**
 * Connect context key. Defaults to `undefined`; the interceptor treats
 * undefined as a fail-closed reject because every Listener A connection
 * MUST be stamped at accept time. (A request whose context lacks the
 * verdict either bypassed the listener wiring — programmer bug — or
 * came in via a non-listener-A code path that has no business calling
 * data-plane RPCs.)
 */
export const listenerAPeerCredVerdictKey = createContextKey<
  PeerCredVerdict | undefined
>(undefined, {
  description:
    'Listener A peer-cred verdict, stamped by the listener at connection-accept time',
});

// ---------------------------------------------------------------------------
// §3. Connect interceptor
// ---------------------------------------------------------------------------

/**
 * Reject Connect error code for peer-cred mismatch. Pinned as a const
 * so the daemon, the future web client (Listener B), and tests all
 * reference one symbol.
 *
 * `Code.PermissionDenied` (HTTP 403-equivalent) is the spec-correct
 * choice over `Code.Unauthenticated` (401) because the peer is
 * authenticated by the OS — we know who they are; we just refuse them.
 */
export const PEER_CRED_REJECT_CODE = Code.PermissionDenied;

export interface PeerCredInterceptorOptions {
  /** Optional structured logger. Defaults to a silent stub so unit
   *  tests don't have to plumb pino. Production daemon main wires the
   *  real pino instance. */
  readonly logger?: {
    debug: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
}

const NOOP_LOGGER = {
  debug: (_obj: Record<string, unknown>, _msg: string): void => {
    /* silent */
  },
  warn: (_obj: Record<string, unknown>, _msg: string): void => {
    /* silent */
  },
};

/**
 * Build the Listener A peer-cred Connect interceptor.
 *
 * Behavior per request:
 *   - Read `listenerAPeerCredVerdictKey` from context.
 *   - If absent → throw `ConnectError(Code.PermissionDenied)` (fail-closed).
 *   - If `same === false` → log canonical `listener_a_peercred_reject`
 *     line at warn level with `{peer_pid, peer_uid}` (or `peer_sid` on
 *     Win), throw `ConnectError(Code.PermissionDenied)`.
 *   - If `same === true` → log canonical `listener_a_peercred_pass`
 *     line at debug level with `{peer_pid}`, call `next(req)`.
 *
 * Single responsibility: DECIDER. No socket, no native call, no
 * mutation of context.
 */
export function createPeerCredInterceptor(
  opts: PeerCredInterceptorOptions = {},
): Interceptor {
  const log = opts.logger ?? NOOP_LOGGER;
  return (next) => async (req) => {
    const verdict = req.contextValues.get(listenerAPeerCredVerdictKey);
    if (verdict === undefined) {
      // Fail-closed: a request without a verdict either bypassed the
      // listener (programmer bug) or arrived on a non-Listener-A code
      // path. Either way, refuse — same wire response as a real reject
      // so probes can't distinguish "miswired" from "bad peer".
      log.warn(
        { rpc: req.method.name },
        'listener_a_peercred_reject',
      );
      throw new ConnectError(
        'peer-cred verdict missing on Listener A request',
        PEER_CRED_REJECT_CODE,
      );
    }
    if (!verdict.same) {
      log.warn(
        {
          rpc: req.method.name,
          peer_pid: verdict.peer.pid,
          peer_uid: verdict.peer.uid,
          peer_sid: verdict.peer.sid,
        },
        'listener_a_peercred_reject',
      );
      throw new ConnectError(
        'peer is not the daemon owner',
        PEER_CRED_REJECT_CODE,
      );
    }
    log.debug(
      { rpc: req.method.name, peer_pid: verdict.peer.pid },
      'listener_a_peercred_pass',
    );
    return next(req);
  };
}

// ---------------------------------------------------------------------------
// §4. Listener-side helpers (wiring producer + sink)
// ---------------------------------------------------------------------------

/**
 * Per-socket verdict stash. The Connect adapter's `contextValues`
 * factory reads from this WeakMap (keyed by the underlying Duplex /
 * Socket) and stamps the verdict onto each request. Exported so the
 * data-socket wiring (T15 / data-socket.ts) can share one map across
 * the listener + the adapter without inventing a parallel registry.
 */
export type PeerCredStash = WeakMap<Duplex, PeerCredVerdict>;

/**
 * Allocate a fresh per-socket verdict stash. Returned as a new
 * WeakMap so tests don't accidentally share state across Connect
 * server instances.
 */
export function createPeerCredStash(): PeerCredStash {
  return new WeakMap<Duplex, PeerCredVerdict>();
}

export interface StampPeerCredOnAcceptOptions {
  /** The freshly-accepted socket from `net.createServer`'s connection
   *  callback. */
  readonly socket: Socket;
  /** The shared stash. */
  readonly stash: PeerCredStash;
  /** Daemon's own identity (cached at boot). */
  readonly expected: ExpectedIdentity;
  /** Native deps. In production wired via the ccsm_native shim
   *  (`daemon/src/native/index.ts`); tests inject fakes. */
  readonly deps: NativePeerCredDeps;
  /** Override platform for tests. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Optional logger; defaults to silent. */
  readonly logger?: PeerCredInterceptorOptions['logger'];
}

/**
 * Verify the peer of `socket`, stash the verdict, and return it. The
 * caller (data-socket wiring) decides what to do on a `same === false`
 * verdict — typically `socket.destroy()` so the request never reaches
 * the Connect chain. We still stash the verdict because:
 *   1. Defense-in-depth: if the caller forgets to destroy, the
 *      interceptor will still reject with `PermissionDenied`.
 *   2. Symmetry: the same code path produces the verdict for both
 *      pass and reject; the interceptor sees the same shape.
 *
 * If the native call THROWS (dead pid, ENOSYS, missing binding) we
 * re-throw — that is a programmer / environmental error that should
 * surface to the daemon's unhandled-error sink, not be papered over as
 * a security event.
 */
export function stampPeerCredOnAccept(
  opts: StampPeerCredOnAcceptOptions,
): PeerCredVerdict {
  const log = opts.logger ?? NOOP_LOGGER;
  const verification = verifyPeerCred(
    opts.socket,
    opts.expected,
    { deps: opts.deps, platform: opts.platform },
  );
  const verdict: PeerCredVerdict = {
    same: verification.same,
    peer: verification.peer,
  };
  opts.stash.set(opts.socket, verdict);
  if (!verdict.same) {
    log.warn(
      {
        peer_pid: verdict.peer.pid,
        peer_uid: verdict.peer.uid,
        peer_sid: verdict.peer.sid,
      },
      'listener_a_peercred_reject',
    );
  }
  return verdict;
}

/**
 * Test seam: write a verdict directly to the context (bypasses the
 * listener entirely). Production code MUST NOT call this; the
 * interceptor only trusts verdicts written by `stampPeerCredOnAccept`
 * via the WeakMap-backed contextValues factory.
 *
 * Exported only so in-process Connect chain tests can drive the
 * interceptor without standing up a real socket pair.
 */
export function setListenerAPeerCredVerdict(
  contextValues: { set: (key: typeof listenerAPeerCredVerdictKey, v: PeerCredVerdict | undefined) => unknown },
  verdict: PeerCredVerdict,
): void {
  contextValues.set(listenerAPeerCredVerdictKey, verdict);
}
