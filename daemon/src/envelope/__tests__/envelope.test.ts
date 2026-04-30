import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';

import {
  decodeFrame,
  encodeFrame,
  ENVELOPE_LIMITS,
  EnvelopeError,
} from '../envelope.js';

const enc = (h: object, p?: Buffer): Buffer =>
  encodeFrame({
    headerJson: Buffer.from(JSON.stringify(h), 'utf8'),
    payload: p,
  });

describe('envelope.encodeFrame / decodeFrame', () => {
  it('round-trips a small JSON-only frame byte-equal', () => {
    const header = { id: 7, method: 'ccsm.v1/daemon.hello', payloadType: 'json', payloadLen: 0 };
    const frame = enc(header);
    const decoded = decodeFrame(frame);
    expect(decoded.version).toBe(0x0);
    expect(JSON.parse(decoded.headerJson.toString('utf8'))).toEqual(header);
    expect(decoded.payload.length).toBe(0);
  });

  it('round-trips a binary frame with header + trailer split correctly', () => {
    const header = { id: 11, payloadType: 'binary', payloadLen: 64 };
    const trailer = Buffer.alloc(64, 0xab);
    const frame = enc(header, trailer);
    const decoded = decodeFrame(frame);
    expect(decoded.version).toBe(0x0);
    expect(JSON.parse(decoded.headerJson.toString('utf8'))).toEqual(header);
    expect(decoded.payload.length).toBe(64);
    expect(decoded.payload.equals(trailer)).toBe(true);
  });

  it('encodes the version nibble in the high 4 bits of the totalLen prefix', () => {
    const frame = enc({ id: 1 });
    const raw = frame.readUInt32BE(0);
    expect((raw >>> 28) & 0x0f).toBe(0x0);
    // Low 28 bits equal the byte-count after the 4-byte prefix.
    expect(raw & 0x0fffffff).toBe(frame.length - 4);
  });

  it('rejects a frame whose payload would exceed 16 MiB', () => {
    // Synthesize a header claiming 16 MiB + 1 payload by hand-crafting the
    // 4-byte prefix; encodeFrame would refuse to produce one for us.
    const oversize = ENVELOPE_LIMITS.MAX_PAYLOAD_BYTES + 1;
    const buf = Buffer.alloc(4);
    // nibble=0x0, len=oversize
    buf.writeUInt32BE((0x0 << 28) | (oversize & 0x0fffffff), 0);
    expect(() => decodeFrame(buf)).toThrowError(EnvelopeError);
    try {
      decodeFrame(buf);
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError);
      expect((e as EnvelopeError).code).toBe('envelope_too_large');
    }
  });

  it('encodeFrame refuses to build an oversize frame', () => {
    const big = Buffer.alloc(ENVELOPE_LIMITS.MAX_PAYLOAD_BYTES);
    try {
      encodeFrame({ headerJson: Buffer.from('{}'), payload: big });
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError);
      expect((e as EnvelopeError).code).toBe('envelope_too_large');
    }
  });

  it('rejects an unknown frame-version nibble (e.g. 0x1) BEFORE cap-checking', () => {
    // Construct a frame whose nibble is 0x1 and whose masked length is small.
    // Spec §3.4.1.a CC-1: nibble check must run BEFORE the length cap so the
    // attacker's "set high bit and confuse the cap-check" trick is blocked.
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE((0x1 << 28) | (16 & 0x0fffffff), 0);
    try {
      decodeFrame(buf);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError);
      expect((e as EnvelopeError).code).toBe('UNSUPPORTED_FRAME_VERSION');
      expect((e as EnvelopeError).nibble).toBe(0x1);
    }
  });

  it('rejects a truncated frame (prefix says N bytes, buffer has fewer)', () => {
    const frame = enc({ id: 5 }, Buffer.alloc(128, 0x01));
    const truncated = frame.subarray(0, frame.length - 10);
    try {
      decodeFrame(truncated);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError);
      expect((e as EnvelopeError).code).toBe('truncated_frame');
    }
  });

  it('rejects a buffer too short for even the 4-byte prefix', () => {
    try {
      decodeFrame(Buffer.alloc(2));
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError);
      expect((e as EnvelopeError).code).toBe('truncated_frame');
    }
  });

  it('rejects a frame whose headerLen overflows the declared payload', () => {
    // Build a hand-crafted frame with payloadLen = 4 but headerLen = 100.
    const payloadLen = 4;
    const buf = Buffer.alloc(4 + payloadLen);
    buf.writeUInt32BE((0x0 << 28) | payloadLen, 0);
    buf.writeUInt16BE(100, 4); // bogus headerLen
    try {
      decodeFrame(buf);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError);
      expect((e as EnvelopeError).code).toBe('corrupt_header_len');
    }
  });

  it('decoded headerJson + payload are zero-copy views into the input buffer', () => {
    const trailer = Buffer.from('hello world', 'utf8');
    const frame = enc({ id: 99, payloadType: 'binary' }, trailer);
    const decoded = decodeFrame(frame);
    // Mutating the source buffer must show through the decoded views — proves
    // we did not allocate fresh copies on the hot PTY path.
    frame[frame.length - 1] = 0x21;
    expect(decoded.payload[decoded.payload.length - 1]).toBe(0x21);
  });

  it('handles an exactly-at-cap frame (16 MiB payload boundary)', () => {
    // Header = "{}" (2 bytes) + headerLen field (2 bytes) + filler trailer up
    // to the cap. Verifies the boundary is INCLUSIVE on the cap value.
    const headerJson = Buffer.from('{}', 'utf8');
    const trailerLen =
      ENVELOPE_LIMITS.MAX_PAYLOAD_BYTES -
      ENVELOPE_LIMITS.HEADER_LEN_FIELD -
      headerJson.length;
    const trailer = Buffer.alloc(trailerLen, 0x55);
    const frame = encodeFrame({ headerJson, payload: trailer });
    expect(frame.length).toBe(
      ENVELOPE_LIMITS.PREFIX_LEN + ENVELOPE_LIMITS.MAX_PAYLOAD_BYTES,
    );
    const decoded = decodeFrame(frame);
    expect(decoded.payload.length).toBe(trailerLen);
  });
});
