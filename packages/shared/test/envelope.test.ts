import { describe, expect, it } from 'vitest';

import {
  ENVELOPE_MAX_SID_LEN,
  decodeSidEnvelope,
  encodeSidEnvelope,
} from '../src/envelope.js';

describe('encodeSidEnvelope / decodeSidEnvelope roundtrip', () => {
  it('roundtrips a typical sid + small payload', () => {
    const sid = 'abc123';
    const payload = new Uint8Array([0x01, 0x02, 0x03, 0xff]);
    const encoded = encodeSidEnvelope(sid, payload);
    // Header byte is the sidLen (utf8 bytes); 'abc123' is ASCII so 6.
    expect(encoded[0]).toBe(6);
    const decoded = decodeSidEnvelope(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.sid).toBe(sid);
    expect(Array.from(decoded!.payload)).toEqual(Array.from(payload));
  });

  it('roundtrips a multibyte-utf8 sid', () => {
    // 'café' encodes to 5 utf8 bytes (c,a,f,0xc3,0xa9).
    const sid = 'café';
    const payload = new Uint8Array([42]);
    const encoded = encodeSidEnvelope(sid, payload);
    expect(encoded[0]).toBe(5);
    const decoded = decodeSidEnvelope(encoded);
    expect(decoded?.sid).toBe(sid);
    expect(decoded?.payload.byteLength).toBe(1);
    expect(decoded?.payload[0]).toBe(42);
  });

  it('roundtrips an empty payload', () => {
    const encoded = encodeSidEnvelope('s', new Uint8Array(0));
    expect(encoded.byteLength).toBe(2); // 1 (sidLen) + 1 (sid) + 0
    const decoded = decodeSidEnvelope(encoded);
    expect(decoded?.sid).toBe('s');
    expect(decoded?.payload.byteLength).toBe(0);
  });

  it('roundtrips at the sid length cap', () => {
    const sid = 'a'.repeat(ENVELOPE_MAX_SID_LEN);
    const payload = new Uint8Array([7]);
    const encoded = encodeSidEnvelope(sid, payload);
    expect(encoded[0]).toBe(ENVELOPE_MAX_SID_LEN);
    const decoded = decodeSidEnvelope(encoded);
    expect(decoded?.sid).toBe(sid);
    expect(decoded?.payload[0]).toBe(7);
  });
});

describe('encodeSidEnvelope rejects invalid sid', () => {
  it('throws on empty sid', () => {
    expect(() => encodeSidEnvelope('', new Uint8Array(0))).toThrow(
      /bad sid length/i,
    );
  });

  it('throws on sid utf8 length > cap', () => {
    const sid = 'a'.repeat(ENVELOPE_MAX_SID_LEN + 1);
    expect(() => encodeSidEnvelope(sid, new Uint8Array(0))).toThrow(
      /bad sid length/i,
    );
  });
});

describe('decodeSidEnvelope rejects malformed input', () => {
  it('returns null for buffer too short (< 2 bytes)', () => {
    expect(decodeSidEnvelope(new Uint8Array(0))).toBeNull();
    expect(decodeSidEnvelope(new Uint8Array(1))).toBeNull();
  });

  it('returns null for sidLen === 0', () => {
    const buf = new Uint8Array([0, 0xaa]);
    expect(decodeSidEnvelope(buf)).toBeNull();
  });

  it('returns null for sidLen > cap', () => {
    const buf = new Uint8Array(2 + ENVELOPE_MAX_SID_LEN);
    buf[0] = ENVELOPE_MAX_SID_LEN + 1;
    expect(decodeSidEnvelope(buf)).toBeNull();
  });

  it('returns null when sidLen exceeds remaining bytes', () => {
    // Header claims 10-byte sid but only 3 bytes follow.
    const buf = new Uint8Array([10, 0x61, 0x62, 0x63]);
    expect(decodeSidEnvelope(buf)).toBeNull();
  });
});

describe('cross-runtime byte alignment (daemon Buffer ↔ cf-worker Uint8Array)', () => {
  // R-48 (Task #160): the daemon historically wrapped the encoder output
  // with `Buffer.allocUnsafe` while the DO used `new Uint8Array`. The wire
  // bytes MUST be identical so both ends decode each other's frames. We
  // simulate the daemon side by wrapping the encoder output in a Node
  // Buffer (Buffer is a Uint8Array subclass) and the DO side as plain
  // Uint8Array; the byte sequence must match.
  it('produces identical bytes when called via Uint8Array vs Buffer payload', () => {
    const sid = 'sess-7';
    const payloadBytes = new Uint8Array([0x10, 0x20, 0x30, 0x40]);

    // DO-side: payload as Uint8Array straight in.
    const fromUint8 = encodeSidEnvelope(sid, payloadBytes);

    // Daemon-side simulation: payload arrives as a Node Buffer (subclass
    // of Uint8Array). Buffer.from over the same bytes must yield identical
    // wire output.
    const bufferPayload = Buffer.from(payloadBytes);
    const fromBuffer = encodeSidEnvelope(sid, bufferPayload);

    expect(Array.from(fromBuffer)).toEqual(Array.from(fromUint8));
  });

  it('decodes bytes produced via Buffer-wrapped encoder output (daemon→DO direction)', () => {
    const sid = 'sess-8';
    const payload = new Uint8Array([1, 2, 3]);
    const encoded = encodeSidEnvelope(sid, payload);
    // Daemon side may hand the bytes off as a Buffer via
    // `Buffer.from(out.buffer, out.byteOffset, out.byteLength)`. The DO
    // receives an ArrayBuffer from the WS API; in either case decoding
    // through `Uint8Array` view must produce the same sid + payload.
    const asBuffer = Buffer.from(
      encoded.buffer,
      encoded.byteOffset,
      encoded.byteLength,
    );
    const decoded = decodeSidEnvelope(asBuffer);
    expect(decoded?.sid).toBe(sid);
    expect(Array.from(decoded!.payload)).toEqual([1, 2, 3]);
  });

  it('decode is symmetric: encode on one side, decode on the other roundtrips byte-for-byte', () => {
    // Pick a sid + payload representative of real PTY OUTPUT frame bytes
    // (5-byte frame header + arbitrary payload).
    const sid = 'tab-0xfeedface';
    const payload = new Uint8Array(64);
    for (let i = 0; i < payload.byteLength; i++) payload[i] = (i * 31) & 0xff;

    const encodedDaemonSide = encodeSidEnvelope(sid, Buffer.from(payload));
    // Verify wire layout explicitly: [sidLen][sid utf8][payload].
    expect(encodedDaemonSide[0]).toBe(new TextEncoder().encode(sid).byteLength);

    const decodedDoSide = decodeSidEnvelope(encodedDaemonSide);
    expect(decodedDoSide?.sid).toBe(sid);
    expect(Array.from(decodedDoSide!.payload)).toEqual(Array.from(payload));
  });
});
