// L1 envelope hello interceptor (spec §3.4.1.f slot #0 + §3.4.1.g handshake).
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md
//     §3.4.1.f bullet 0: "helloInterceptor — runs FIRST on every envelope.
//     Allowlist ['ccsm.v1/daemon.hello']; for any other method on a connection
//     that has not yet completed handshake, rejects with `hello_required`."
//   - Same fragment §3.4.1.g: 2-frame HMAC handshake. Daemon proves possession
//     of `daemon.secret` by computing HMAC-SHA256 over the client-supplied
//     16-byte `clientHelloNonce` and replying with `helloNonceHmac` +
//     `protocol` block. Per-connection `clientHelloNonce` is single-use:
//     any further `daemon.hello` on the same socket is rejected with
//     `hello_replay`.
//   - r7 manager lock: explicit ordering #0 so the handshake-required check
//     fires BEFORE migrationGateInterceptor; otherwise a non-hello RPC during
//     migration would short-circuit with MIGRATION_PENDING and leak
//     pre-handshake daemon state to an unverified peer.
//
// Single Responsibility (producer / decider / sink discipline):
//   This module is a PURE DECIDER. It maintains per-connection handshake state
//   in an injected `Map<connId, HelloConnectionState>` and decides one of four
//   outcomes per envelope:
//     - { kind: 'reject', code: 'hello_required' }    — pre-handshake non-hello
//     - { kind: 'reject', code: 'hello_replay' }      — second hello on socket
//     - { kind: 'reject', code: 'schema_violation' }  — malformed hello payload
//     - { kind: 'reply',  payload: HelloReply }       — first hello, succeeds
//     - { kind: 'pass' }                              — post-handshake non-hello
//
//   It does NOT:
//     - own the per-connection state Map (caller injects + clears on disconnect),
//     - perform `socket.destroy()` (sink — caller does that on `hello_required`),
//     - read process state, env, or wall-clock,
//     - log (separate sink).

import { Buffer } from 'node:buffer';
import { computeHmac, HMAC_TAG_LENGTH, NONCE_BYTES } from './hmac.js';
import { decode as base64urlDecode } from './base64url.js';
import { DAEMON_PROTOCOL_VERSION } from './protocol-version.js';

/** Canonical hello RPC method name (spec §3.4.1.g). */
export const HELLO_METHOD = 'ccsm.v1/daemon.hello';

/** Canonical wire-format identifier for v0.3 (spec §3.4.1.g). */
export const DAEMON_WIRE = 'v0.3-json-envelope' as const;

/**
 * Daemon-accepted wire formats list, surfaced in the hello reply
 * (spec §3.4.1.g `daemonAcceptedWires`; v0.3 ships a single-element array,
 * v0.4 will append `"v0.4-protobuf"`).
 */
export const DAEMON_ACCEPTED_WIRES: readonly string[] = [DAEMON_WIRE] as const;

/**
 * Active frame-version nibble (spec §3.4.1.c high 4 bits of totalLen prefix).
 * v0.3 = 0x0; v0.4 = 0x1.
 */
export const DAEMON_FRAME_VERSION = 0;

/**
 * Active feature flags announced in `protocol.features[]`. Mirrors the spec
 * §3.4.1.g schema list. Kept here (not in protocol-version.ts) because the
 * feature set is hello-reply concern, not version-check concern.
 */
export const DAEMON_FEATURES: readonly string[] = [
  'binary-frames',
  'stream-heartbeat',
  'interceptors',
  'traceId',
  'bootNonce',
  'hello',
] as const;

/** Defaults block surfaced in the hello reply (spec §3.4.1.g `defaults`). */
export const DAEMON_DEFAULTS = Object.freeze({
  deadlineMs: 5_000,
  heartbeatMs: 30_000,
  backpressureBytes: 1_048_576,
});

/**
 * Per-connection handshake state. Owned by the caller (the connect adapter /
 * dispatcher), passed in via `ctx.state` so this interceptor can stay pure.
 *
 * Lifecycle: caller creates one instance per accepted socket (initial
 * `handshakeComplete = false`), and disposes it on socket close.
 */
export interface HelloConnectionState {
  handshakeComplete: boolean;
  /**
   * The `clientHelloNonce` the daemon HMAC-signed in the reply. Stored solely
   * so a replayed `daemon.hello` on the same socket can be rejected with
   * `hello_replay` — single-use per spec §3.4.1.g.
   */
  consumedClientHelloNonce?: string;
}

/**
 * Construct an empty per-connection handshake state. Use this at socket-accept
 * time so the interceptor never has to deal with missing state.
 */
export function createHelloState(): HelloConnectionState {
  return { handshakeComplete: false };
}

/** Hello payload field shape (spec §3.4.1.g frame 1). */
export interface HelloRequestPayload {
  readonly clientWire: string;
  readonly clientProtocolVersion: number;
  readonly clientFrameVersions: readonly number[];
  readonly clientFeatures: readonly string[];
  readonly clientHelloNonce: string;
}

/** Hello reply payload (spec §3.4.1.g frame 2). */
export interface HelloReplyPayload {
  readonly helloNonceHmac: string;
  readonly protocol: {
    readonly wire: string;
    readonly minClient: string;
    readonly daemonProtocolVersion: number;
    readonly daemonAcceptedWires: readonly string[];
    readonly features: readonly string[];
  };
  readonly daemonFrameVersion: number;
  readonly bootNonce: string;
  readonly defaults: typeof DAEMON_DEFAULTS;
  readonly compatible: boolean;
  readonly reason?: string;
}

/** Rejection codes (spec §3.4.1.f / §3.4.1.g). */
export type HelloRejectionCode =
  | 'hello_required'
  | 'hello_replay'
  | 'schema_violation';

export type HelloDecision =
  | { readonly kind: 'pass' }
  | {
      readonly kind: 'reply';
      readonly payload: HelloReplyPayload;
    }
  | {
      readonly kind: 'reject';
      readonly code: HelloRejectionCode;
      readonly message: string;
      /**
       * True iff the caller MUST `socket.destroy()` after writing the
       * rejection frame. Per §3.4.1.g, `hello_required` is socket-fatal;
       * `hello_replay` and `schema_violation` on `daemon.hello` are also
       * socket-fatal because they imply a broken/hostile peer.
       */
      readonly destroySocket: boolean;
    };

/** Inputs the interceptor reads on every envelope. */
export interface HelloInterceptorContext {
  /** Wire-literal RPC method name (e.g. `ccsm.v1/daemon.hello`). */
  readonly rpcName: string;
  /**
   * Parsed `payload` field from the envelope. Only consulted when
   * `rpcName === HELLO_METHOD`; `unknown` because the interceptor is
   * responsible for shape-validating it.
   */
  readonly payload?: unknown;
  /** Per-connection handshake state; mutated in-place on a successful reply. */
  readonly state: HelloConnectionState;
}

/** Daemon-side inputs that don't change per envelope. */
export interface HelloInterceptorConfig {
  /** Loaded `daemon.secret` bytes (spec §3.4.1.g — used for HMAC compute). */
  readonly daemonSecret: Buffer;
  /** Per-process boot nonce (ULID); same value the supervisor surfaces on `/healthz`. */
  readonly bootNonce: string;
  /** Minimum acceptable client wire identifier (spec §3.4.1.g `minClient`). */
  readonly minClient?: string;
}

const DEFAULT_MIN_CLIENT = 'v0.3';

/**
 * Decide what to do with one envelope based on connection handshake state.
 *
 * Pre-handshake decision tree:
 *   - rpcName !== HELLO_METHOD                     → reject `hello_required`
 *   - rpcName === HELLO_METHOD ∧ malformed payload → reject `schema_violation`
 *   - rpcName === HELLO_METHOD ∧ valid payload     → reply (and flip flag)
 *
 * Post-handshake decision tree:
 *   - rpcName === HELLO_METHOD                     → reject `hello_replay`
 *   - rpcName !== HELLO_METHOD                     → pass (downstream interceptors run)
 *
 * Pure function modulo a single side-effect: on a successful first hello, the
 * caller-owned `state` object is mutated in place (`handshakeComplete = true`,
 * `consumedClientHelloNonce` recorded). This is the ONLY mutation; rejection
 * paths leave `state` untouched so a buggy/hostile peer cannot lock itself out
 * by sending garbage hellos forever (the socket just keeps getting torn down).
 */
export function decideHello(
  ctx: HelloInterceptorContext,
  config: HelloInterceptorConfig,
): HelloDecision {
  const { rpcName, payload, state } = ctx;

  if (state.handshakeComplete) {
    if (rpcName === HELLO_METHOD) {
      return reject(
        'hello_replay',
        `daemon.hello received after handshake complete on this connection`,
        true,
      );
    }
    return { kind: 'pass' };
  }

  // Pre-handshake.
  if (rpcName !== HELLO_METHOD) {
    return reject(
      'hello_required',
      `RPC ${rpcName} rejected: connection has not completed daemon.hello handshake`,
      true,
    );
  }

  // First hello on this connection — validate shape, then HMAC-sign the nonce.
  const validated = validateHelloRequest(payload);
  if (!validated.ok) {
    return reject('schema_violation', validated.message, true);
  }

  const helloReq = validated.payload;
  const minClient = config.minClient ?? DEFAULT_MIN_CLIENT;

  // Compatibility decision (spec §3.4.1.g `compatible` + `reason`).
  // We still reply with the HMAC even on `compatible: false` so the client can
  // rule out an imposter listener (spec §3.4.1.g paragraph after the schema).
  const compatibility = checkCompatibility(helloReq, minClient);

  // Compute the HMAC over the raw 16-byte nonce buffer (NOT the base64url
  // string) — both sides MUST decode to bytes BEFORE the constant-time compare
  // per the round-9 base64url lock.
  const nonceBytes = base64urlDecode(helloReq.clientHelloNonce);
  const helloNonceHmac = computeHmac(config.daemonSecret, nonceBytes);

  const reply: HelloReplyPayload = {
    helloNonceHmac,
    protocol: {
      wire: DAEMON_WIRE,
      minClient,
      daemonProtocolVersion: DAEMON_PROTOCOL_VERSION,
      daemonAcceptedWires: DAEMON_ACCEPTED_WIRES,
      features: DAEMON_FEATURES,
    },
    daemonFrameVersion: DAEMON_FRAME_VERSION,
    bootNonce: config.bootNonce,
    defaults: DAEMON_DEFAULTS,
    compatible: compatibility.compatible,
    ...(compatibility.compatible
      ? {}
      : { reason: compatibility.reason }),
  };

  // ONLY mutation site. Flip the flag and record the consumed nonce so a
  // replayed hello on this socket is caught by the post-handshake branch above
  // (extra defense-in-depth check below also catches an exact-nonce replay
  // even if some buggy upstream wiped `handshakeComplete`).
  state.handshakeComplete = true;
  state.consumedClientHelloNonce = helloReq.clientHelloNonce;

  return { kind: 'reply', payload: reply };
}

interface HelloValidationOk {
  readonly ok: true;
  readonly payload: HelloRequestPayload;
}
interface HelloValidationErr {
  readonly ok: false;
  readonly message: string;
}

/**
 * Shape-check the hello request payload. Strict on the fields this interceptor
 * actually reads (`clientWire`, `clientProtocolVersion`, `clientHelloNonce`)
 * and lenient on the rest (any future field a v0.4 client might add survives
 * via duck-typing on the typed shape).
 */
function validateHelloRequest(
  payload: unknown,
): HelloValidationOk | HelloValidationErr {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, message: 'daemon.hello payload must be an object' };
  }
  const p = payload as Record<string, unknown>;

  if (typeof p['clientWire'] !== 'string' || p['clientWire'].length === 0) {
    return { ok: false, message: 'daemon.hello.clientWire must be a non-empty string' };
  }
  if (
    typeof p['clientProtocolVersion'] !== 'number' ||
    !Number.isInteger(p['clientProtocolVersion']) ||
    (p['clientProtocolVersion'] as number) < 1
  ) {
    return {
      ok: false,
      message: 'daemon.hello.clientProtocolVersion must be a positive integer',
    };
  }
  if (!Array.isArray(p['clientFrameVersions'])) {
    return {
      ok: false,
      message: 'daemon.hello.clientFrameVersions must be an array of integers',
    };
  }
  for (const v of p['clientFrameVersions'] as unknown[]) {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return {
        ok: false,
        message: 'daemon.hello.clientFrameVersions entries must be integers',
      };
    }
  }
  if (!Array.isArray(p['clientFeatures'])) {
    return {
      ok: false,
      message: 'daemon.hello.clientFeatures must be an array of strings',
    };
  }
  for (const v of p['clientFeatures'] as unknown[]) {
    if (typeof v !== 'string') {
      return {
        ok: false,
        message: 'daemon.hello.clientFeatures entries must be strings',
      };
    }
  }

  const nonce = p['clientHelloNonce'];
  if (typeof nonce !== 'string' || nonce.length !== HMAC_TAG_LENGTH) {
    return {
      ok: false,
      message: `daemon.hello.clientHelloNonce must be a ${HMAC_TAG_LENGTH}-char base64url string`,
    };
  }
  // Decode-check: every accepted nonce must be exactly NONCE_BYTES bytes
  // post-decode. This catches base64url strings of the right length but
  // wrong byte count (impossible for 22 chars, but the explicit check
  // documents the invariant the HMAC compute relies on).
  let decoded: Buffer;
  try {
    decoded = base64urlDecode(nonce);
  } catch {
    return {
      ok: false,
      message: 'daemon.hello.clientHelloNonce is not valid base64url',
    };
  }
  if (decoded.length !== NONCE_BYTES) {
    return {
      ok: false,
      message: `daemon.hello.clientHelloNonce must decode to ${NONCE_BYTES} bytes`,
    };
  }

  return {
    ok: true,
    payload: {
      clientWire: p['clientWire'] as string,
      clientProtocolVersion: p['clientProtocolVersion'] as number,
      clientFrameVersions: p['clientFrameVersions'] as readonly number[],
      clientFeatures: p['clientFeatures'] as readonly string[],
      clientHelloNonce: nonce,
    },
  };
}

type CompatibilityReason =
  | 'wire-mismatch'
  | 'version-mismatch'
  | 'frame-version-mismatch';

interface CompatibilityResult {
  readonly compatible: boolean;
  readonly reason?: CompatibilityReason;
}

/**
 * Compute the `compatible` + `reason` fields per spec §3.4.1.g.
 *
 * Compatibility is a soft signal — even on `compatible: false`, the daemon
 * still replies with `helloNonceHmac` (so the client can rule out imposter)
 * and the caller still tears down the connection AFTER the reply ships.
 */
function checkCompatibility(
  req: HelloRequestPayload,
  _minClient: string,
): CompatibilityResult {
  if (!DAEMON_ACCEPTED_WIRES.includes(req.clientWire)) {
    return { compatible: false, reason: 'wire-mismatch' };
  }
  if (req.clientProtocolVersion !== DAEMON_PROTOCOL_VERSION) {
    return { compatible: false, reason: 'version-mismatch' };
  }
  if (!req.clientFrameVersions.includes(DAEMON_FRAME_VERSION)) {
    return { compatible: false, reason: 'frame-version-mismatch' };
  }
  return { compatible: true };
}

function reject(
  code: HelloRejectionCode,
  message: string,
  destroySocket: boolean,
): HelloDecision {
  return { kind: 'reject', code, message, destroySocket };
}
