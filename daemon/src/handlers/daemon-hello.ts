// T19 — `daemon.hello` RPC handler (control-socket dispatcher slot).
//
// Spec citation:
//   docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md
//   §3.4.1.g — 2-frame HMAC handshake. The DAEMON computes
//   `helloNonceHmac = HMAC-SHA256(daemon.secret, clientHelloNonce-bytes)`
//   truncated to 16 bytes, base64url-no-pad. The client verifies. We do
//   NOT verify any client HMAC — the client's identity is already proven
//   by peer-cred (§3.1.1) + ACL (§7.1).
//
//   Anti-imposter contract (spec lines 195, 208, 212): the reply MUST
//   carry `helloNonceHmac` even when `compatible: false`, so the client
//   can rule out an imposter listener BEFORE the daemon tears down the
//   socket. Returning a bare error on incompatibility would defeat the
//   whole point of the HMAC challenge-response.
//
// Relationship to T8 (PR #663) helloInterceptor:
//   - T8 is the slot-#0 envelope interceptor that gates non-hello RPCs
//     pre-handshake (`hello_required`) and rejects replays
//     (`hello_replay`). It currently inlines the HMAC compute itself.
//   - T19 (this file) is the canonical wire-level handler that the
//     control-socket dispatcher (T16, PR #665) registers in place of
//     the NOT_IMPLEMENTED stub for `daemon.hello`. It is the same
//     pure decision T8 makes on a successful first hello, factored out
//     so the dispatcher slot is real instead of throwing
//     NotImplementedError, and so a future cleanup can have T8 delegate
//     here (de-duplicating the compute path).
//
// Single Responsibility (producer / decider / sink discipline):
//   PURE DECIDER. Inputs:
//     - per-call request payload (validated here, schema-rejected on
//       malformed shape — same rules T8 enforces),
//     - daemon-wide config injected by factory: `getSecret()`,
//       `getBootNonce()`, optional `minClient`.
//   Outputs:
//     - on valid request: a HelloReplyPayload (helloNonceHmac +
//       protocol block + compatibility verdict).
//     - on malformed request: throws `DaemonHelloSchemaError` so the
//       dispatcher's caller (T14 control-socket transport) maps it to a
//       wire-level `schema_violation` rejection frame. This handler
//       does NOT touch the socket — sink ownership stays in T14.
//   No socket I/O, no per-connection state (the interceptor T8 owns
//   that), no key material on disk reads (factory injects the secret so
//   tests don't need a real keystore).

import { Buffer } from 'node:buffer';
import { decode as base64urlDecode } from '../envelope/base64url.js';
import {
  computeHmac,
  HMAC_TAG_LENGTH,
  NONCE_BYTES,
} from '../envelope/hmac.js';
import { DAEMON_PROTOCOL_VERSION } from '../envelope/protocol-version.js';

// ---------------------------------------------------------------------------
// Wire constants (mirror the helloInterceptor exports — single source of truth
// is currently split between T8 and T19; a follow-up should consolidate into
// one module once the interceptor delegates here).
// ---------------------------------------------------------------------------

/** Canonical hello RPC method name (spec §3.4.1.g, namespaced per §3.4.1.g
 *  RPC-namespace rule `ccsm.<wireMajor>/<service>.<method>`). The dispatcher's
 *  SUPERVISOR_RPCS allowlist accepts the literal `daemon.hello` (control-plane
 *  carve-out, spec line 249); on the data-plane the same handler is reached
 *  via the namespaced form. The handler itself is namespace-agnostic. */
export const HELLO_METHOD_NAMESPACED = 'ccsm.v1/daemon.hello';
export const HELLO_METHOD_LITERAL = 'daemon.hello';

/** Canonical wire-format identifier for v0.3 (spec §3.4.1.g). */
export const DAEMON_WIRE = 'v0.3-json-envelope' as const;

/** Daemon-accepted wire formats list (spec §3.4.1.g `daemonAcceptedWires`).
 *  v0.3 ships a single-element array; v0.4 will append `'v0.4-protobuf'`. */
export const DAEMON_ACCEPTED_WIRES: readonly string[] = [DAEMON_WIRE] as const;

/** Active frame-version nibble (spec §3.4.1.c). v0.3 = 0; v0.4 = 1. */
export const DAEMON_FRAME_VERSION = 0;

/** Active feature flags announced in `protocol.features[]` (spec §3.4.1.g). */
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

const DEFAULT_MIN_CLIENT = 'v0.3';

// ---------------------------------------------------------------------------
// Wire payload shapes (mirror spec §3.4.1.g frame 1 / frame 2 schema).
// ---------------------------------------------------------------------------

export interface HelloRequestPayload {
  readonly clientWire: string;
  readonly clientProtocolVersion: number;
  readonly clientFrameVersions: readonly number[];
  readonly clientFeatures: readonly string[];
  readonly clientHelloNonce: string;
}

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
  readonly reason?: CompatibilityReason;
}

export type CompatibilityReason =
  | 'wire-mismatch'
  | 'version-mismatch'
  | 'frame-version-mismatch';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown on malformed `daemon.hello` payload. The control-socket transport
 *  (T14) maps this to a wire-level `schema_violation` rejection frame and is
 *  responsible for the post-reply `socket.destroy()` per spec §3.4.1.g. */
export class DaemonHelloSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonHelloSchemaError';
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface DaemonHelloHandlerConfig {
  /** Returns the daemon.secret bytes for HMAC compute. Indirected through a
   *  getter so tests don't need a real keystore and so secret rotation
   *  (frag-6-7 §7.2) can swap the value live without rebuilding the
   *  dispatcher registry. */
  readonly getSecret: () => Buffer;
  /** Returns the per-process boot nonce (ULID). Same value the supervisor
   *  surfaces on `/healthz` (spec §3.4.1.g). Getter — not a constant —
   *  because the daemon's bootNonce is allocated at boot and the handler
   *  module is imported earlier in the dependency graph. */
  readonly getBootNonce: () => string;
  /** Optional override for the `minClient` advertised in the reply. Default
   *  `'v0.3'`. Tests may pass a stub. */
  readonly minClient?: string;
}

/**
 * Construct the `daemon.hello` handler bound to a given secret/bootNonce
 * source. The returned function matches the dispatcher's `Handler` shape
 * (`(req: unknown, ctx) => Promise<unknown>`) so it can be registered via
 * `dispatcher.register('daemon.hello', createDaemonHelloHandler({...}))`.
 *
 * Decision flow (single envelope):
 *   1. Validate request shape — throw `DaemonHelloSchemaError` on bad input.
 *   2. Compute `helloNonceHmac` over the DECODED 16-byte nonce buffer
 *      (NOT the ASCII string — spec §3.4.1.g round-9 base64url lock).
 *   3. Decide `compatible` per spec §3.4.1.g compatibility rule.
 *   4. Return reply payload with `helloNonceHmac` populated even when
 *      `compatible: false` (anti-imposter — spec lines 195, 208, 212).
 */
export function createDaemonHelloHandler(
  config: DaemonHelloHandlerConfig,
): (req: unknown) => Promise<HelloReplyPayload> {
  const minClient = config.minClient ?? DEFAULT_MIN_CLIENT;

  return async function handleDaemonHello(
    req: unknown,
  ): Promise<HelloReplyPayload> {
    return decideHelloReply(req, {
      secret: config.getSecret(),
      bootNonce: config.getBootNonce(),
      minClient,
    });
  };
}

// ---------------------------------------------------------------------------
// Pure decision (exported for direct unit testing without the async wrapper).
// ---------------------------------------------------------------------------

interface DecideArgs {
  readonly secret: Buffer;
  readonly bootNonce: string;
  readonly minClient: string;
}

/** Synchronous pure decider. Throws `DaemonHelloSchemaError` on bad payload;
 *  otherwise returns the reply payload. The async factory above wraps this
 *  for the dispatcher contract; tests prefer this entry point because they
 *  can assert against the throw without `await expect(...).rejects`. */
export function decideHelloReply(
  req: unknown,
  args: DecideArgs,
): HelloReplyPayload {
  const validated = validateHelloRequest(req);
  const compatibility = checkCompatibility(validated, args.minClient);

  // Decode the wire string back to bytes BEFORE HMAC compute. Comparing the
  // ASCII strings would bypass the constant-time guarantee on the client
  // side AND produce a different HMAC value (HMAC over 22 ASCII bytes !==
  // HMAC over 16 raw bytes). Spec §3.4.1.g round-9 base64url lock.
  const nonceBytes = base64urlDecode(validated.clientHelloNonce);
  const helloNonceHmac = computeHmac(args.secret, nonceBytes);

  const reply: HelloReplyPayload = {
    helloNonceHmac,
    protocol: {
      wire: DAEMON_WIRE,
      minClient: args.minClient,
      daemonProtocolVersion: DAEMON_PROTOCOL_VERSION,
      daemonAcceptedWires: DAEMON_ACCEPTED_WIRES,
      features: DAEMON_FEATURES,
    },
    daemonFrameVersion: DAEMON_FRAME_VERSION,
    bootNonce: args.bootNonce,
    defaults: DAEMON_DEFAULTS,
    compatible: compatibility.compatible,
    ...(compatibility.compatible ? {} : { reason: compatibility.reason }),
  };

  return reply;
}

// ---------------------------------------------------------------------------
// Validation (strict on fields the handler reads; lenient on extras so a
// future v0.4 client carrying additional optional fields still handshakes).
// ---------------------------------------------------------------------------

function validateHelloRequest(payload: unknown): HelloRequestPayload {
  if (payload === null || typeof payload !== 'object') {
    throw new DaemonHelloSchemaError(
      'daemon.hello payload must be an object',
    );
  }
  const p = payload as Record<string, unknown>;

  if (typeof p['clientWire'] !== 'string' || p['clientWire'].length === 0) {
    throw new DaemonHelloSchemaError(
      'daemon.hello.clientWire must be a non-empty string',
    );
  }
  if (
    typeof p['clientProtocolVersion'] !== 'number' ||
    !Number.isInteger(p['clientProtocolVersion']) ||
    (p['clientProtocolVersion'] as number) < 1
  ) {
    throw new DaemonHelloSchemaError(
      'daemon.hello.clientProtocolVersion must be a positive integer',
    );
  }
  if (!Array.isArray(p['clientFrameVersions'])) {
    throw new DaemonHelloSchemaError(
      'daemon.hello.clientFrameVersions must be an array of integers',
    );
  }
  for (const v of p['clientFrameVersions'] as unknown[]) {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new DaemonHelloSchemaError(
        'daemon.hello.clientFrameVersions entries must be integers',
      );
    }
  }
  if (!Array.isArray(p['clientFeatures'])) {
    throw new DaemonHelloSchemaError(
      'daemon.hello.clientFeatures must be an array of strings',
    );
  }
  for (const v of p['clientFeatures'] as unknown[]) {
    if (typeof v !== 'string') {
      throw new DaemonHelloSchemaError(
        'daemon.hello.clientFeatures entries must be strings',
      );
    }
  }

  const nonce = p['clientHelloNonce'];
  if (typeof nonce !== 'string' || nonce.length !== HMAC_TAG_LENGTH) {
    throw new DaemonHelloSchemaError(
      `daemon.hello.clientHelloNonce must be a ${HMAC_TAG_LENGTH}-char base64url string`,
    );
  }
  // Decode-check: every accepted nonce must be exactly NONCE_BYTES bytes
  // post-decode. The 22-char length filter above already rules out most
  // bad inputs but the explicit decode catches non-base64url alphabet.
  let decoded: Buffer;
  try {
    decoded = base64urlDecode(nonce);
  } catch {
    throw new DaemonHelloSchemaError(
      'daemon.hello.clientHelloNonce is not valid base64url',
    );
  }
  if (decoded.length !== NONCE_BYTES) {
    throw new DaemonHelloSchemaError(
      `daemon.hello.clientHelloNonce must decode to ${NONCE_BYTES} bytes`,
    );
  }

  return {
    clientWire: p['clientWire'] as string,
    clientProtocolVersion: p['clientProtocolVersion'] as number,
    clientFrameVersions: p['clientFrameVersions'] as readonly number[],
    clientFeatures: p['clientFeatures'] as readonly string[],
    clientHelloNonce: nonce,
  };
}

// ---------------------------------------------------------------------------
// Compatibility (spec §3.4.1.g compatibility rule, line 212).
// ---------------------------------------------------------------------------

interface CompatibilityResult {
  readonly compatible: boolean;
  readonly reason?: CompatibilityReason;
}

function checkCompatibility(
  req: HelloRequestPayload,
  _minClient: string,
): CompatibilityResult {
  // Order: wire → version → frame-version. Matches the order the spec lists
  // the three reasons; deterministic so a client receiving multiple
  // mismatches always gets the same `reason` value across daemons.
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
