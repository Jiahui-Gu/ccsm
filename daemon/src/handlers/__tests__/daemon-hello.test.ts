import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { createHmac, randomBytes } from 'node:crypto';

import {
  createDaemonHelloHandler,
  decideHelloReply,
  DaemonHelloSchemaError,
  DAEMON_ACCEPTED_WIRES,
  DAEMON_DEFAULTS,
  DAEMON_FEATURES,
  DAEMON_FRAME_VERSION,
  DAEMON_WIRE,
  HELLO_METHOD_LITERAL,
  HELLO_METHOD_NAMESPACED,
  type HelloReplyPayload,
  type HelloRequestPayload,
} from '../daemon-hello.js';
import {
  encode as base64urlEncode,
  decode as base64urlDecode,
} from '../../envelope/base64url.js';
import { DAEMON_PROTOCOL_VERSION } from '../../envelope/protocol-version.js';
import { HMAC_TAG_LENGTH, NONCE_BYTES } from '../../envelope/hmac.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET = Buffer.from(
  'test-daemon-secret-32-bytes-long-fixture-not-real',
  'utf8',
);
const TEST_BOOT_NONCE = '01HX8VJ6Q9KZ5YBDGXMTNCAVT0';

function makeNonce(seedByte: number): string {
  // Deterministic 16-byte nonce so reference HMACs are reproducible.
  const buf = Buffer.alloc(NONCE_BYTES, seedByte);
  return base64urlEncode(buf);
}

function validRequest(
  overrides: Partial<HelloRequestPayload> = {},
): HelloRequestPayload {
  return {
    clientWire: DAEMON_WIRE,
    clientProtocolVersion: DAEMON_PROTOCOL_VERSION,
    clientFrameVersions: [DAEMON_FRAME_VERSION],
    clientFeatures: ['binary-frames', 'hello'],
    clientHelloNonce: makeNonce(0x42),
    ...overrides,
  };
}

function decide(req: unknown): HelloReplyPayload {
  return decideHelloReply(req, {
    secret: TEST_SECRET,
    bootNonce: TEST_BOOT_NONCE,
    minClient: 'v0.3',
  });
}

/** Independent reference HMAC: never touches the implementation under test. */
function referenceHmac(secret: Buffer, nonceB64url: string): string {
  const nonceBytes = base64urlDecode(nonceB64url);
  const full = createHmac('sha256', secret).update(nonceBytes).digest();
  return base64urlEncode(full.subarray(0, NONCE_BYTES));
}

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('daemon.hello wire constants', () => {
  it('exposes both control-plane literal and data-plane namespaced method names', () => {
    expect(HELLO_METHOD_LITERAL).toBe('daemon.hello');
    expect(HELLO_METHOD_NAMESPACED).toBe('ccsm.v1/daemon.hello');
  });

  it('advertises a single-element wires array on v0.3 (spec §3.4.1.g)', () => {
    expect(DAEMON_ACCEPTED_WIRES).toEqual([DAEMON_WIRE]);
    expect(DAEMON_WIRE).toBe('v0.3-json-envelope');
  });

  it('declares frame-version 0 for v0.3 (spec §3.4.1.c)', () => {
    expect(DAEMON_FRAME_VERSION).toBe(0);
  });

  it('mirrors the canonical features list (spec §3.4.1.g schema)', () => {
    expect(DAEMON_FEATURES).toEqual([
      'binary-frames',
      'stream-heartbeat',
      'interceptors',
      'traceId',
      'bootNonce',
      'hello',
    ]);
  });

  it('mirrors the canonical defaults block (spec §3.4.1.g)', () => {
    expect(DAEMON_DEFAULTS).toEqual({
      deadlineMs: 5_000,
      heartbeatMs: 30_000,
      backpressureBytes: 1_048_576,
    });
    // Defensively frozen — handler returns the same object on every call.
    expect(Object.isFrozen(DAEMON_DEFAULTS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('decideHelloReply — valid request', () => {
  it('returns compatible: true with a 22-char base64url HMAC', () => {
    const reply = decide(validRequest());
    expect(reply.compatible).toBe(true);
    expect(reply.reason).toBeUndefined();
    expect(reply.helloNonceHmac).toHaveLength(HMAC_TAG_LENGTH);
    expect(reply.helloNonceHmac).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(reply.helloNonceHmac).not.toContain('=');
  });

  it('echoes the protocol block with daemonProtocolVersion=1 (spec §3.4.1.g)', () => {
    const reply = decide(validRequest());
    expect(reply.protocol.wire).toBe(DAEMON_WIRE);
    expect(reply.protocol.minClient).toBe('v0.3');
    expect(reply.protocol.daemonProtocolVersion).toBe(DAEMON_PROTOCOL_VERSION);
    expect(reply.protocol.daemonProtocolVersion).toBe(1);
    expect(reply.protocol.daemonAcceptedWires).toEqual([DAEMON_WIRE]);
    expect(reply.protocol.features).toEqual(DAEMON_FEATURES);
  });

  it('surfaces bootNonce + daemonFrameVersion + defaults', () => {
    const reply = decide(validRequest());
    expect(reply.bootNonce).toBe(TEST_BOOT_NONCE);
    expect(reply.daemonFrameVersion).toBe(0);
    expect(reply.defaults).toEqual(DAEMON_DEFAULTS);
  });

  it('HMAC matches an independently-computed reference value (test vector)', () => {
    const nonce = makeNonce(0xAB);
    const reply = decide(validRequest({ clientHelloNonce: nonce }));
    expect(reply.helloNonceHmac).toBe(referenceHmac(TEST_SECRET, nonce));
  });

  it('produces stable HMAC for a fixed (secret, nonce) pair across calls', () => {
    const nonce = makeNonce(0x07);
    const a = decide(validRequest({ clientHelloNonce: nonce }));
    const b = decide(validRequest({ clientHelloNonce: nonce }));
    expect(a.helloNonceHmac).toBe(b.helloNonceHmac);
  });

  it('produces different HMACs for different nonces under the same secret', () => {
    const a = decide(validRequest({ clientHelloNonce: makeNonce(0x01) }));
    const b = decide(validRequest({ clientHelloNonce: makeNonce(0x02) }));
    expect(a.helloNonceHmac).not.toBe(b.helloNonceHmac);
  });

  it('produces different HMACs for the same nonce under different secrets', () => {
    const nonce = makeNonce(0x11);
    const replyA = decide(validRequest({ clientHelloNonce: nonce }));
    const replyB = decideHelloReply(validRequest({ clientHelloNonce: nonce }), {
      secret: Buffer.from('different-secret-bytes-here', 'utf8'),
      bootNonce: TEST_BOOT_NONCE,
      minClient: 'v0.3',
    });
    expect(replyA.helloNonceHmac).not.toBe(replyB.helloNonceHmac);
  });
});

// ---------------------------------------------------------------------------
// Round-9 base64url lock — HMAC is computed over decoded BYTES, not ASCII.
// ---------------------------------------------------------------------------

describe('HMAC compute — bytes vs ASCII regression (spec §3.4.1.g round-9 lock)', () => {
  it('HMAC equals HMAC over decoded 16-byte buffer, NOT over the 22-char ASCII string', () => {
    const nonce = makeNonce(0x55);
    const reply = decide(validRequest({ clientHelloNonce: nonce }));

    // Compute the WRONG way (ASCII) and assert we did NOT do that.
    const wrong = createHmac('sha256', TEST_SECRET).update(nonce, 'ascii').digest();
    const wrongTag = base64urlEncode(wrong.subarray(0, NONCE_BYTES));
    expect(reply.helloNonceHmac).not.toBe(wrongTag);

    // Compute the RIGHT way (decoded bytes) and assert we did.
    expect(reply.helloNonceHmac).toBe(referenceHmac(TEST_SECRET, nonce));
  });

  it('HMAC of all-zero nonce bytes != HMAC of literal "0" * 22 ASCII string', () => {
    const allZeros = base64urlEncode(Buffer.alloc(NONCE_BYTES, 0));
    const reply = decide(validRequest({ clientHelloNonce: allZeros }));

    const asciiHmac = createHmac('sha256', TEST_SECRET).update(allZeros, 'ascii').digest();
    const asciiTag = base64urlEncode(asciiHmac.subarray(0, NONCE_BYTES));

    expect(reply.helloNonceHmac).not.toBe(asciiTag);
  });
});

// ---------------------------------------------------------------------------
// Anti-imposter: incompatible reply still carries helloNonceHmac.
// ---------------------------------------------------------------------------

describe('decideHelloReply — incompatible (anti-imposter, spec §3.4.1.g lines 195/208/212)', () => {
  it('wire-mismatch still surfaces helloNonceHmac', () => {
    const req = validRequest({ clientWire: 'v0.4-protobuf' });
    const reply = decide(req);
    expect(reply.compatible).toBe(false);
    expect(reply.reason).toBe('wire-mismatch');
    // Anti-imposter: HMAC MUST be present so client can rule out imposter
    // before the daemon tears down the socket.
    expect(reply.helloNonceHmac).toHaveLength(HMAC_TAG_LENGTH);
    expect(reply.helloNonceHmac).toBe(
      referenceHmac(TEST_SECRET, req.clientHelloNonce),
    );
  });

  it('version-mismatch (clientProtocolVersion=2) still surfaces helloNonceHmac', () => {
    const req = validRequest({ clientProtocolVersion: 2 });
    const reply = decide(req);
    expect(reply.compatible).toBe(false);
    expect(reply.reason).toBe('version-mismatch');
    expect(reply.helloNonceHmac).toBe(
      referenceHmac(TEST_SECRET, req.clientHelloNonce),
    );
  });

  it('frame-version-mismatch ([1] only — daemon serves 0) still surfaces helloNonceHmac', () => {
    const req = validRequest({ clientFrameVersions: [1] });
    const reply = decide(req);
    expect(reply.compatible).toBe(false);
    expect(reply.reason).toBe('frame-version-mismatch');
    expect(reply.helloNonceHmac).toBe(
      referenceHmac(TEST_SECRET, req.clientHelloNonce),
    );
  });

  it('compatibility checks are evaluated wire → version → frame-version (deterministic)', () => {
    // Wire AND version both wrong — wire wins (listed first in spec).
    const reply = decide(
      validRequest({ clientWire: 'bogus', clientProtocolVersion: 99 }),
    );
    expect(reply.reason).toBe('wire-mismatch');
  });

  it('compatible: true reply does NOT include the optional reason field', () => {
    const reply = decide(validRequest());
    expect(reply.compatible).toBe(true);
    expect('reason' in reply).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema rejection
// ---------------------------------------------------------------------------

describe('decideHelloReply — schema rejection', () => {
  it('rejects null payload', () => {
    expect(() => decide(null)).toThrow(DaemonHelloSchemaError);
  });

  it('rejects non-object payload', () => {
    expect(() => decide('not an object')).toThrow(DaemonHelloSchemaError);
    expect(() => decide(42)).toThrow(DaemonHelloSchemaError);
  });

  it('rejects missing clientWire', () => {
    const r = validRequest();
    const broken = { ...r } as Partial<HelloRequestPayload>;
    delete broken.clientWire;
    expect(() => decide(broken)).toThrow(/clientWire/);
  });

  it('rejects empty-string clientWire', () => {
    expect(() => decide(validRequest({ clientWire: '' }))).toThrow(/clientWire/);
  });

  it('rejects clientProtocolVersion of wrong type (string "1")', () => {
    expect(() =>
      decide({ ...validRequest(), clientProtocolVersion: '1' }),
    ).toThrow(/clientProtocolVersion/);
  });

  it('rejects non-integer clientProtocolVersion (1.5)', () => {
    expect(() => decide(validRequest({ clientProtocolVersion: 1.5 }))).toThrow(
      /clientProtocolVersion/,
    );
  });

  it('rejects clientProtocolVersion < 1', () => {
    expect(() => decide(validRequest({ clientProtocolVersion: 0 }))).toThrow(
      /clientProtocolVersion/,
    );
  });

  it('rejects non-array clientFrameVersions', () => {
    expect(() =>
      decide({ ...validRequest(), clientFrameVersions: 0 as unknown as number[] }),
    ).toThrow(/clientFrameVersions/);
  });

  it('rejects clientFrameVersions with non-integer entries', () => {
    expect(() =>
      decide(validRequest({ clientFrameVersions: [0.5] as unknown as number[] })),
    ).toThrow(/clientFrameVersions/);
  });

  it('rejects non-array clientFeatures', () => {
    expect(() =>
      decide({ ...validRequest(), clientFeatures: 'binary-frames' as unknown as string[] }),
    ).toThrow(/clientFeatures/);
  });

  it('rejects non-string clientFeatures entries', () => {
    expect(() =>
      decide(validRequest({ clientFeatures: [1 as unknown as string] })),
    ).toThrow(/clientFeatures/);
  });

  it('rejects missing clientHelloNonce', () => {
    const broken = validRequest() as Partial<HelloRequestPayload>;
    delete broken.clientHelloNonce;
    expect(() => decide(broken)).toThrow(/clientHelloNonce/);
  });

  it('rejects clientHelloNonce of wrong length (21 chars)', () => {
    expect(() =>
      decide(validRequest({ clientHelloNonce: 'a'.repeat(21) })),
    ).toThrow(/clientHelloNonce/);
  });

  it('rejects clientHelloNonce of wrong length (23 chars)', () => {
    expect(() =>
      decide(validRequest({ clientHelloNonce: 'a'.repeat(23) })),
    ).toThrow(/clientHelloNonce/);
  });

  it('rejects clientHelloNonce with invalid base64url alphabet', () => {
    // 22 chars but contains '+' and '/' which are NOT in the base64url alphabet.
    expect(() =>
      decide(validRequest({ clientHelloNonce: '++++++++++++++++++++++' })),
    ).toThrow(/clientHelloNonce/);
  });
});

// ---------------------------------------------------------------------------
// Factory contract
// ---------------------------------------------------------------------------

describe('createDaemonHelloHandler — factory + dispatcher contract', () => {
  it('returns an async function that resolves to the same value as decideHelloReply', async () => {
    const handler = createDaemonHelloHandler({
      getSecret: () => TEST_SECRET,
      getBootNonce: () => TEST_BOOT_NONCE,
    });
    const req = validRequest();
    const direct = decide(req);
    const viaHandler = await handler(req);
    expect(viaHandler).toEqual(direct);
  });

  it('calls getSecret() on each request (supports rotation)', async () => {
    let calls = 0;
    const secrets = [
      Buffer.from('secret-A', 'utf8'),
      Buffer.from('secret-B', 'utf8'),
    ];
    const handler = createDaemonHelloHandler({
      getSecret: () => secrets[calls++ % 2]!,
      getBootNonce: () => TEST_BOOT_NONCE,
    });
    const nonce = makeNonce(0x77);
    const req = validRequest({ clientHelloNonce: nonce });

    const replyA = (await handler(req)) as HelloReplyPayload;
    const replyB = (await handler(req)) as HelloReplyPayload;

    expect(calls).toBe(2);
    expect(replyA.helloNonceHmac).toBe(referenceHmac(secrets[0]!, nonce));
    expect(replyB.helloNonceHmac).toBe(referenceHmac(secrets[1]!, nonce));
    expect(replyA.helloNonceHmac).not.toBe(replyB.helloNonceHmac);
  });

  it('calls getBootNonce() on each request (supports daemon restart in long-lived dispatcher)', async () => {
    const bootNonces = ['BOOT-AAAAAAAAAAAAAAAAAAAA', 'BOOT-BBBBBBBBBBBBBBBBBBBB'];
    let i = 0;
    const handler = createDaemonHelloHandler({
      getSecret: () => TEST_SECRET,
      getBootNonce: () => bootNonces[i++ % 2]!,
    });

    const a = (await handler(validRequest())) as HelloReplyPayload;
    const b = (await handler(validRequest())) as HelloReplyPayload;
    expect(a.bootNonce).toBe('BOOT-AAAAAAAAAAAAAAAAAAAA');
    expect(b.bootNonce).toBe('BOOT-BBBBBBBBBBBBBBBBBBBB');
  });

  it('rejects (Promise rejection) on schema-violating payload', async () => {
    const handler = createDaemonHelloHandler({
      getSecret: () => TEST_SECRET,
      getBootNonce: () => TEST_BOOT_NONCE,
    });
    await expect(handler(null)).rejects.toBeInstanceOf(DaemonHelloSchemaError);
  });

  it('uses default minClient v0.3 when not overridden', async () => {
    const handler = createDaemonHelloHandler({
      getSecret: () => TEST_SECRET,
      getBootNonce: () => TEST_BOOT_NONCE,
    });
    const reply = (await handler(validRequest())) as HelloReplyPayload;
    expect(reply.protocol.minClient).toBe('v0.3');
  });

  it('honors a custom minClient override', async () => {
    const handler = createDaemonHelloHandler({
      getSecret: () => TEST_SECRET,
      getBootNonce: () => TEST_BOOT_NONCE,
      minClient: 'v0.5',
    });
    const reply = (await handler(validRequest())) as HelloReplyPayload;
    expect(reply.protocol.minClient).toBe('v0.5');
  });

  it('handles many random nonces without divergence from reference HMAC', async () => {
    const handler = createDaemonHelloHandler({
      getSecret: () => TEST_SECRET,
      getBootNonce: () => TEST_BOOT_NONCE,
    });
    for (let i = 0; i < 50; i++) {
      const nonce = base64urlEncode(randomBytes(NONCE_BYTES));
      const reply = (await handler(
        validRequest({ clientHelloNonce: nonce }),
      )) as HelloReplyPayload;
      expect(reply.helloNonceHmac).toBe(referenceHmac(TEST_SECRET, nonce));
    }
  });
});
