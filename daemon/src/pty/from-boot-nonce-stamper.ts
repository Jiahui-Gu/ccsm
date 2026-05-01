// T48 — `fromBootNonce` wiring for PTY stream emissions.
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
//     §3.5.1.4 (lines 101, 103, 118, 136):
//       "Daemon emits a `{ kind: 'heartbeat', ts, traceId, bootNonce }`
//        envelope on every server-stream every `heartbeatMs` ..."
//       "client passes `fromBootNonce` (the nonce it last saw on a delta
//        or heartbeat from this daemon). On mismatch, daemon **ignores
//        `fromSeq`**, sends `{ kind: 'bootChanged', bootNonce,
//        snapshotPending: true }`, and follows with a fresh snapshot
//        from seq 0."
//   - docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md
//     §6.5 (line 141, R3-T8 line 499): `bootNonce` is camelCase, ULID
//     value minted once at supervisor boot; same value surfaced on
//     `/healthz`, in `daemon.hello` reply, and on every PTY-stream
//     heartbeat / chunk-frame envelope. **Single source of truth** —
//     `daemon/src/index.ts:16` mints it via `ulid()` at module load.
//
// Single Responsibility (per `feedback_single_responsibility`):
//   - This module is a PRODUCER helper. Given the per-boot nonce held
//     by the wiring layer, it stamps that nonce onto outgoing PTY
//     stream envelopes and decides the resubscribe match outcome.
//   - It does NOT mint the nonce (supervisor boot owns generation),
//     does NOT write sockets (T44 stream RPC owns I/O), does NOT
//     construct the full envelope (caller passes the kind-specific
//     payload; we only attach `bootNonce`).
//   - Mirrors `trace-id-map.ts` in scope: tiny pure helper that owns
//     ONE wire field, kept next to its consumer (PTY stream layer).
//
// Why not modify T37 (lifecycle FSM) or T41 (fan-out registry)?
//   - T37 is a pure decider mapping (state, event) → next-state. It
//     has no envelope shape — adding `bootNonce` would couple the
//     decider to the wire format (Layer-1 violation).
//   - T41 is generic over `<TMessage>` (line 33 of fanout-registry.ts).
//     It is a SINK that routes opaque messages; injecting `bootNonce`
//     into its API would force the message shape onto every consumer
//     (notifications, session updates, future v0.5 web fan-out) for a
//     PTY-specific concern. Wrong layer.
//
//   The correct seam is the PRODUCER side: code that BUILDS the
//   envelope before handing it to T41.broadcast(). T48 lives here to
//   stamp the nonce at construction time. Spec line 149 confirms this:
//   "emits envelope with `traceId + bootNonce` (obs-P0-2 +
//    fwdcompat-P1-1)" — emission, not registry, not FSM.

/**
 * Per-boot nonce. Crockford ULID (26 chars) per frag-6-7 §6.5 line 141
 * round-3 lock CF-2: camelCase wire field, ULID value (NOT `Date.now()`
 * — two crashes within 1 ms must produce distinct ids).
 *
 * Type alias is structural (just `string`) but documents the wire
 * contract for grep-ability and reviewer intent.
 */
export type BootNonce = string;

/**
 * Outcome of comparing a client-supplied `fromBootNonce` against the
 * daemon's current per-boot value on a `subscribePty` resubscribe.
 *
 * Drives the spec §3.5.1.4 line 103 contract:
 *   - `match`    → daemon honours `fromSeq`, replays as normal.
 *   - `mismatch` → daemon ignores `fromSeq`, emits a `bootChanged`
 *                  frame and follows with a fresh snapshot from seq 0.
 *   - `absent`   → first-time subscribe (no prior nonce known to the
 *                  client). Treated as match: nothing to compare.
 *
 * The wiring layer (T44 ptySubscribe handler) maps this enum to the
 * actual emission decision; this helper does NOT emit.
 */
export type BootNonceCompare = 'match' | 'mismatch' | 'absent';

/**
 * The `bootChanged` envelope payload (spec §3.5.1.4 line 103).
 * Emitted exactly once per resubscribe when client's `fromBootNonce`
 * does not match `daemonNonce`. The wiring layer follows it with a
 * fresh snapshot from seq 0.
 */
export interface BootChangedFrame {
  readonly kind: 'bootChanged';
  readonly bootNonce: BootNonce;
  readonly snapshotPending: true;
}

/**
 * Stamper bound to one daemon-boot's nonce. Construct ONCE per daemon
 * process at the wiring layer (PTY stream RPC initializer), reading the
 * nonce from `daemon/src/index.ts` (the same value passed to the hello
 * interceptor — single source of truth).
 *
 * The stamper is pure modulo the captured nonce; safe to call from any
 * envelope-construction site (heartbeat scheduler `sendHeartbeat`
 * callback, chunk fan-out producer, snapshot RPC handler, resubscribe
 * decision branch).
 */
export interface FromBootNonceStamper {
  /**
   * Return the bound nonce as a bare value. For callers that need to
   * inject it into a custom envelope shape (e.g. the §3.5.1.4 line 101
   * heartbeat envelope: `{ kind: 'heartbeat', ts, traceId, bootNonce }`)
   * without the cost of an object spread.
   */
  getBootNonce(): BootNonce;

  /**
   * Stamp `bootNonce` onto an outgoing envelope. Returns a fresh object
   * — never mutates the input. The `bootNonce` field is REQUIRED on the
   * output type per project convention (memory: required > optional).
   *
   * If the input already carries a `bootNonce` field, the daemon-bound
   * value WINS — same security posture as `boot-nonce-precedence.ts`
   * for the reserved header (a producer that accidentally passes a
   * client-provided value through must not be able to spoof the boot
   * identity on outbound emissions).
   */
  stamp<T extends object>(envelope: T): T & { bootNonce: BootNonce };

  /**
   * Compare a client-supplied `fromBootNonce` against the bound value.
   * Drives the resubscribe decision (spec §3.5.1.4 line 103). The
   * wiring layer emits `buildBootChangedFrame()` on `'mismatch'`,
   * honours `fromSeq` on `'match'` / `'absent'`.
   *
   * `undefined` and empty string both map to `'absent'` so a client
   * that omits the field (first subscribe) and a client that sends
   * `""` (defensive serializer) behave identically.
   */
  compareFromBootNonce(clientNonce: string | undefined): BootNonceCompare;

  /**
   * Build the `bootChanged` envelope for the wiring layer to emit on a
   * `compareFromBootNonce(...) === 'mismatch'` resubscribe. Always
   * carries the daemon's CURRENT bound nonce (so the client can update
   * its `lastSeenBootNonce` in one frame without waiting for the
   * follow-up heartbeat).
   */
  buildBootChangedFrame(): BootChangedFrame;
}

/**
 * Validate that `nonce` is a non-empty string. We do NOT enforce ULID
 * regex here — the supervisor-side mint (`daemon/src/index.ts:16`
 * uses `ulid()`) is the source of truth, and adding a regex check
 * would duplicate validation that lives in spec §3.4.1.d (envelope
 * schema validator). A defensive non-empty check catches the only
 * realistic foot-gun: an early-init wiring layer that constructs the
 * stamper with `bootNonce: undefined as unknown as string`.
 */
function assertNonEmptyNonce(nonce: BootNonce): void {
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new TypeError(
      `from-boot-nonce-stamper: bootNonce must be a non-empty string, got ${typeof nonce === 'string' ? '<empty string>' : String(nonce)}`,
    );
  }
}

/**
 * Construct a stamper bound to one daemon-boot's nonce. Instantiate
 * ONCE per daemon process at PTY stream wiring init time:
 *
 *   import { bootNonce } from './index.js';
 *   const stamper = createFromBootNonceStamper(bootNonce);
 *   // pass `stamper` to ptySubscribe handler, heartbeat sendHeartbeat
 *   // closure, chunk fan-out producer.
 *
 * Tests typically construct a fresh instance per case with a known
 * nonce so the assertions can be exact.
 */
export function createFromBootNonceStamper(
  bootNonce: BootNonce,
): FromBootNonceStamper {
  assertNonEmptyNonce(bootNonce);
  // Capture the nonce in the closure. Immutable for the daemon's life;
  // a fresh boot constructs a fresh stamper (caller responsibility).
  const bound: BootNonce = bootNonce;

  function getBootNonce(): BootNonce {
    return bound;
  }

  function stamp<T extends object>(envelope: T): T & { bootNonce: BootNonce } {
    // Spread so the daemon-bound value WINS over any field already on
    // the input. Order matters: input first, daemon-bound second. This
    // mirrors `boot-nonce-precedence.ts` (daemon overrides client) so
    // a producer that forwards a client-provided envelope cannot spoof
    // the boot identity.
    return { ...envelope, bootNonce: bound };
  }

  function compareFromBootNonce(
    clientNonce: string | undefined,
  ): BootNonceCompare {
    if (clientNonce === undefined || clientNonce === '') {
      return 'absent';
    }
    return clientNonce === bound ? 'match' : 'mismatch';
  }

  function buildBootChangedFrame(): BootChangedFrame {
    // `snapshotPending: true` is a literal type per the spec contract:
    // a `bootChanged` frame is ALWAYS followed by a fresh snapshot
    // (spec line 103 — "follows with a fresh snapshot from seq 0").
    // The wiring layer is responsible for actually emitting the
    // snapshot; this helper just sets the flag the client renders the
    // `─── daemon restarted ───` divider on.
    return {
      kind: 'bootChanged',
      bootNonce: bound,
      snapshotPending: true,
    };
  }

  return {
    getBootNonce,
    stamp,
    compareFromBootNonce,
    buildBootChangedFrame,
  };
}
