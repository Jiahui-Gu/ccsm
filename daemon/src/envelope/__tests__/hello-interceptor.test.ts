import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
  createHelloState,
  decideHello,
  DAEMON_ACCEPTED_WIRES,
  DAEMON_FRAME_VERSION,
  DAEMON_DEFAULTS,
  DAEMON_FEATURES,
  HELLO_METHOD,
  type HelloConnectionState,
  type HelloRequestPayload,
} from '../hello-interceptor.js';
import { computeHmac, generateNonce } from '../hmac.js';
import { decode as base64urlDecode } from '../base64url.js';
import { DAEMON_PROTOCOL_VERSION } from '../protocol-version.js';

const SECRET = randomBytes(32);
const BOOT_NONCE = '01HZZZBOOTNONCEFAKEULID00';
const CONFIG = { daemonSecret: SECRET, bootNonce: BOOT_NONCE } as const;

function makeHelloPayload(overrides: Partial<HelloRequestPayload> = {}): HelloRequestPayload {
  return {
    clientWire: 'v0.3-json-envelope',
    clientProtocolVersion: DAEMON_PROTOCOL_VERSION,
    clientFrameVersions: [0],
    clientFeatures: ['binary-frames', 'hello'],
    clientHelloNonce: generateNonce(),
    ...overrides,
  };
}

describe('decideHello — pre-handshake gate (spec §3.4.1.f slot #0)', () => {
  it('rejects arbitrary RPC with hello_required + destroySocket=true', () => {
    const state = createHelloState();
    const decision = decideHello(
      { rpcName: 'ccsm.v1/session.subscribe', state },
      CONFIG,
    );
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') {
      expect(decision.code).toBe('hello_required');
      expect(decision.destroySocket).toBe(true);
      expect(decision.message).toContain('ccsm.v1/session.subscribe');
    }
    // State must NOT be flipped on rejection.
    expect(state.handshakeComplete).toBe(false);
    expect(state.consumedClientHelloNonce).toBeUndefined();
  });

  it.each([
    'ccsm.v1/session.send',
    'ccsm.v1/pty.write',
    'daemon.shutdown',
    '/healthz',
    '',
  ])('rejects %j with hello_required pre-handshake', (rpcName) => {
    const state = createHelloState();
    const decision = decideHello({ rpcName, state }, CONFIG);
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') {
      expect(decision.code).toBe('hello_required');
    }
    expect(state.handshakeComplete).toBe(false);
  });

  it('does not normalise the hello method (literal compare)', () => {
    const state = createHelloState();
    // wrong case / whitespace must NOT be treated as the canonical hello.
    for (const variant of ['CCSM.V1/DAEMON.HELLO', ' ccsm.v1/daemon.hello', 'ccsm.v1/daemon.hello ']) {
      const decision = decideHello(
        { rpcName: variant, payload: makeHelloPayload(), state },
        CONFIG,
      );
      expect(decision.kind).toBe('reject');
      if (decision.kind === 'reject') {
        expect(decision.code).toBe('hello_required');
      }
    }
    expect(state.handshakeComplete).toBe(false);
  });
});

describe('decideHello — successful handshake', () => {
  it('flips handshakeComplete and returns reply with HMAC + protocol block', () => {
    const state = createHelloState();
    const req = makeHelloPayload();
    const decision = decideHello(
      { rpcName: HELLO_METHOD, payload: req, state },
      CONFIG,
    );

    expect(decision.kind).toBe('reply');
    if (decision.kind !== 'reply') return;

    expect(state.handshakeComplete).toBe(true);
    expect(state.consumedClientHelloNonce).toBe(req.clientHelloNonce);

    // Verify the HMAC matches what a client computing over the same nonce bytes
    // would produce — this is the round-trip check the client performs via
    // crypto.timingSafeEqual.
    const nonceBytes = base64urlDecode(req.clientHelloNonce);
    const expected = computeHmac(SECRET, nonceBytes);
    expect(decision.payload.helloNonceHmac).toBe(expected);

    // Spec-mandated reply fields.
    expect(decision.payload.protocol).toEqual({
      wire: 'v0.3-json-envelope',
      minClient: 'v0.3',
      daemonProtocolVersion: DAEMON_PROTOCOL_VERSION,
      daemonAcceptedWires: DAEMON_ACCEPTED_WIRES,
      features: DAEMON_FEATURES,
    });
    expect(decision.payload.daemonFrameVersion).toBe(DAEMON_FRAME_VERSION);
    expect(decision.payload.bootNonce).toBe(BOOT_NONCE);
    expect(decision.payload.defaults).toEqual(DAEMON_DEFAULTS);
    expect(decision.payload.compatible).toBe(true);
    expect(decision.payload.reason).toBeUndefined();
  });

  it('still replies (with HMAC) but compatible:false on wire mismatch', () => {
    const state = createHelloState();
    const req = makeHelloPayload({ clientWire: 'v0.5-protobuf-future' });
    const decision = decideHello(
      { rpcName: HELLO_METHOD, payload: req, state },
      CONFIG,
    );

    expect(decision.kind).toBe('reply');
    if (decision.kind !== 'reply') return;

    // Client must still get an HMAC so it can rule out imposter listener.
    expect(decision.payload.helloNonceHmac.length).toBeGreaterThan(0);
    expect(decision.payload.compatible).toBe(false);
    expect(decision.payload.reason).toBe('wire-mismatch');
    // Even on incompatible reply, the handshake state still flips: the socket
    // is about to be torn down by the caller, but the per-connection nonce is
    // single-use regardless.
    expect(state.handshakeComplete).toBe(true);
  });

  it('marks compatible:false on protocol-version mismatch', () => {
    const state = createHelloState();
    const req = makeHelloPayload({ clientProtocolVersion: 99 });
    const decision = decideHello(
      { rpcName: HELLO_METHOD, payload: req, state },
      CONFIG,
    );
    if (decision.kind !== 'reply') throw new Error('expected reply');
    expect(decision.payload.compatible).toBe(false);
    expect(decision.payload.reason).toBe('version-mismatch');
  });

  it('marks compatible:false on frame-version mismatch', () => {
    const state = createHelloState();
    const req = makeHelloPayload({ clientFrameVersions: [9, 10] });
    const decision = decideHello(
      { rpcName: HELLO_METHOD, payload: req, state },
      CONFIG,
    );
    if (decision.kind !== 'reply') throw new Error('expected reply');
    expect(decision.payload.compatible).toBe(false);
    expect(decision.payload.reason).toBe('frame-version-mismatch');
  });
});

describe('decideHello — schema rejection (malformed hello payload)', () => {
  function expectSchemaReject(state: HelloConnectionState, payload: unknown) {
    const decision = decideHello(
      { rpcName: HELLO_METHOD, payload, state },
      CONFIG,
    );
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') {
      expect(decision.code).toBe('schema_violation');
      expect(decision.destroySocket).toBe(true);
    }
    // CRUCIAL: flag must STAY false on schema reject so the bad peer can't
    // sneak past the gate by sending garbage that flips the flag.
    expect(state.handshakeComplete).toBe(false);
  }

  it('rejects null payload', () => {
    expectSchemaReject(createHelloState(), null);
  });

  it('rejects non-object payload', () => {
    expectSchemaReject(createHelloState(), 'string-not-object');
    expectSchemaReject(createHelloState(), 42);
  });

  it('rejects missing clientHelloNonce', () => {
    const { clientHelloNonce: _drop, ...rest } = makeHelloPayload();
    expectSchemaReject(createHelloState(), rest);
  });

  it('rejects clientHelloNonce of wrong length', () => {
    expectSchemaReject(
      createHelloState(),
      makeHelloPayload({ clientHelloNonce: 'too-short' }),
    );
    expectSchemaReject(
      createHelloState(),
      makeHelloPayload({ clientHelloNonce: 'A'.repeat(40) }),
    );
  });

  it('rejects clientHelloNonce with non-base64url characters', () => {
    // 22 chars but contains `!` and `@` outside the base64url alphabet.
    expectSchemaReject(
      createHelloState(),
      makeHelloPayload({ clientHelloNonce: '!@#$%^&*()_+{}[]<>?,./' }),
    );
  });

  it('rejects non-integer clientProtocolVersion', () => {
    expectSchemaReject(
      createHelloState(),
      makeHelloPayload({ clientProtocolVersion: 1.5 as unknown as number }),
    );
    expectSchemaReject(
      createHelloState(),
      makeHelloPayload({ clientProtocolVersion: '1' as unknown as number }),
    );
  });

  it('rejects non-array clientFrameVersions / clientFeatures', () => {
    expectSchemaReject(
      createHelloState(),
      makeHelloPayload({ clientFrameVersions: 0 as unknown as number[] }),
    );
    expectSchemaReject(
      createHelloState(),
      makeHelloPayload({ clientFeatures: 'hello' as unknown as string[] }),
    );
  });

  it('rejects non-string clientWire', () => {
    expectSchemaReject(
      createHelloState(),
      makeHelloPayload({ clientWire: '' as string }),
    );
  });
});

describe('decideHello — post-handshake', () => {
  it('passes arbitrary RPC through after a successful handshake', () => {
    const state = createHelloState();
    decideHello({ rpcName: HELLO_METHOD, payload: makeHelloPayload(), state }, CONFIG);
    expect(state.handshakeComplete).toBe(true);

    for (const rpc of [
      'ccsm.v1/session.subscribe',
      'ccsm.v1/session.send',
      'ccsm.v1/pty.write',
      '/healthz',
      'daemon.shutdown',
    ]) {
      const decision = decideHello({ rpcName: rpc, state }, CONFIG);
      expect(decision.kind).toBe('pass');
    }
  });

  it('rejects a second daemon.hello on the same connection with hello_replay', () => {
    const state = createHelloState();
    const first = decideHello(
      { rpcName: HELLO_METHOD, payload: makeHelloPayload(), state },
      CONFIG,
    );
    expect(first.kind).toBe('reply');

    // Second hello — even with a fresh, valid payload — must be rejected.
    const second = decideHello(
      { rpcName: HELLO_METHOD, payload: makeHelloPayload(), state },
      CONFIG,
    );
    expect(second.kind).toBe('reject');
    if (second.kind === 'reject') {
      expect(second.code).toBe('hello_replay');
      expect(second.destroySocket).toBe(true);
    }
  });

  it('rejects an EXACT-replay hello envelope (same nonce) with hello_replay', () => {
    const state = createHelloState();
    const req = makeHelloPayload();
    decideHello({ rpcName: HELLO_METHOD, payload: req, state }, CONFIG);
    // Exact same payload bytes again — captured-and-replayed by an attacker.
    const replayed = decideHello(
      { rpcName: HELLO_METHOD, payload: req, state },
      CONFIG,
    );
    expect(replayed.kind).toBe('reject');
    if (replayed.kind === 'reject') {
      expect(replayed.code).toBe('hello_replay');
    }
  });
});

describe('decideHello — state isolation across connections', () => {
  it('flipping connection A does not affect connection B', () => {
    const stateA = createHelloState();
    const stateB = createHelloState();

    decideHello(
      { rpcName: HELLO_METHOD, payload: makeHelloPayload(), state: stateA },
      CONFIG,
    );
    expect(stateA.handshakeComplete).toBe(true);
    expect(stateB.handshakeComplete).toBe(false);

    // Connection B is still pre-handshake → an arbitrary RPC still gets gated.
    const decision = decideHello(
      { rpcName: 'ccsm.v1/session.subscribe', state: stateB },
      CONFIG,
    );
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') {
      expect(decision.code).toBe('hello_required');
    }
  });
});

describe('decideHello — HMAC correctness', () => {
  it('computes HMAC over the DECODED nonce bytes, not the base64url string', () => {
    // Regression guard for the round-9 base64url lock: comparing/HMAC-signing
    // the ASCII string would silently work for the common case but break the
    // wire contract once the spec evolves.
    const state = createHelloState();
    const req = makeHelloPayload();
    const decision = decideHello(
      { rpcName: HELLO_METHOD, payload: req, state },
      CONFIG,
    );
    if (decision.kind !== 'reply') throw new Error('expected reply');

    const decodedNonceBytes = base64urlDecode(req.clientHelloNonce);
    expect(decodedNonceBytes.length).toBe(16);

    const expectedHmacOverBytes = computeHmac(SECRET, decodedNonceBytes);
    const wrongHmacOverString = computeHmac(SECRET, req.clientHelloNonce);

    expect(decision.payload.helloNonceHmac).toBe(expectedHmacOverBytes);
    // sanity — the two are different (otherwise the assertion above is vacuous).
    expect(expectedHmacOverBytes).not.toBe(wrongHmacOverString);
  });

  it('different secret produces a different HMAC for the same nonce', () => {
    const state1 = createHelloState();
    const state2 = createHelloState();
    const req = makeHelloPayload();
    const otherSecret = Buffer.alloc(32, 0xab);

    const d1 = decideHello(
      { rpcName: HELLO_METHOD, payload: req, state: state1 },
      CONFIG,
    );
    const d2 = decideHello(
      { rpcName: HELLO_METHOD, payload: req, state: state2 },
      { daemonSecret: otherSecret, bootNonce: BOOT_NONCE },
    );
    if (d1.kind !== 'reply' || d2.kind !== 'reply') throw new Error('expected reply');
    expect(d1.payload.helloNonceHmac).not.toBe(d2.payload.helloNonceHmac);
  });
});
