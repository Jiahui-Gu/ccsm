import { describe, expect, it } from 'vitest';
import {
  FrameType,
  decodeExit,
  decodeFrame,
  decodeResize,
  encodeExit,
  encodeFrame,
  encodeResize,
} from '../src/frame';

const ROUNDTRIP_TYPES: ReadonlyArray<{ name: string; type: FrameType }> = [
  { name: 'OUTPUT', type: FrameType.OUTPUT },
  { name: 'INPUT', type: FrameType.INPUT },
  { name: 'PAUSE', type: FrameType.PAUSE },
  { name: 'RESUME', type: FrameType.RESUME },
  { name: 'RESET', type: FrameType.RESET },
  { name: 'EXIT', type: FrameType.EXIT },
];

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

describe('encodeFrame / decodeFrame roundtrip', () => {
  for (const { name, type } of ROUNDTRIP_TYPES) {
    it(`${name} with empty payload roundtrips`, () => {
      const encoded = encodeFrame({ type, seq: 0, payload: new Uint8Array(0) });
      expect(encoded.byteLength).toBe(5);
      const decoded = decodeFrame(encoded);
      expect(decoded.type).toBe(type);
      expect(decoded.seq).toBe(0);
      expect(decoded.payload).toEqual(new Uint8Array(0));
    });

    it(`${name} with 1KB random payload roundtrips`, () => {
      const payload = randomBytes(1024);
      const seq = 0xdeadbeef >>> 0;
      const encoded = encodeFrame({ type, seq, payload });
      expect(encoded.byteLength).toBe(5 + 1024);
      const decoded = decodeFrame(encoded);
      expect(decoded.type).toBe(type);
      expect(decoded.seq).toBe(seq);
      expect(decoded.payload).toEqual(payload);
    });
  }

  it('encodes seq as u32 big-endian', () => {
    const encoded = encodeFrame({
      type: FrameType.OUTPUT,
      seq: 0x01020304,
      payload: new Uint8Array(0),
    });
    expect(Array.from(encoded.slice(0, 5))).toEqual([
      FrameType.OUTPUT,
      0x01,
      0x02,
      0x03,
      0x04,
    ]);
  });

  it('roundtrips seq=0xFFFFFFFF (u32 max)', () => {
    const encoded = encodeFrame({
      type: FrameType.OUTPUT,
      seq: 0xffffffff,
      payload: new Uint8Array([1, 2, 3]),
    });
    const decoded = decodeFrame(encoded);
    expect(decoded.seq).toBe(0xffffffff);
    expect(decoded.payload).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('encodeFrame edge cases', () => {
  it('throws on seq < 0', () => {
    expect(() =>
      encodeFrame({ type: FrameType.OUTPUT, seq: -1, payload: new Uint8Array(0) }),
    ).toThrow(RangeError);
  });

  it('throws on seq > 0xFFFFFFFF', () => {
    expect(() =>
      encodeFrame({
        type: FrameType.OUTPUT,
        seq: 0x100000000,
        payload: new Uint8Array(0),
      }),
    ).toThrow(RangeError);
  });

  it('throws on non-integer seq', () => {
    expect(() =>
      encodeFrame({ type: FrameType.OUTPUT, seq: 1.5, payload: new Uint8Array(0) }),
    ).toThrow(RangeError);
  });
});

describe('decodeFrame edge cases', () => {
  it('throws on buffer < 5 bytes', () => {
    expect(() => decodeFrame(new Uint8Array(0))).toThrow(RangeError);
    expect(() => decodeFrame(new Uint8Array(4))).toThrow(RangeError);
  });

  it('throws on unknown type byte', () => {
    const buf = new Uint8Array([0xff, 0, 0, 0, 0]);
    expect(() => decodeFrame(buf)).toThrow(RangeError);
  });
});

describe('encodeResize / decodeResize roundtrip', () => {
  it('framed RESIZE(80,24) roundtrips through encode/decodeFrame', () => {
    const payload = encodeResize(80, 24);
    expect(payload.byteLength).toBe(4);
    const framed = encodeFrame({ type: FrameType.RESIZE, seq: 7, payload });
    const decodedFrame = decodeFrame(framed);
    expect(decodedFrame.type).toBe(FrameType.RESIZE);
    expect(decodedFrame.seq).toBe(7);
    expect(decodeResize(decodedFrame.payload)).toEqual({ cols: 80, rows: 24 });
  });

  it('roundtrips edge case (1, 1)', () => {
    expect(decodeResize(encodeResize(1, 1))).toEqual({ cols: 1, rows: 1 });
  });

  it('roundtrips edge case (65535, 65535)', () => {
    expect(decodeResize(encodeResize(65535, 65535))).toEqual({
      cols: 65535,
      rows: 65535,
    });
  });

  it('encodeResize throws on cols=65536', () => {
    expect(() => encodeResize(65536, 24)).toThrow(RangeError);
  });

  it('encodeResize throws on rows=65536', () => {
    expect(() => encodeResize(80, 65536)).toThrow(RangeError);
  });

  it('encodeResize throws on negative dims', () => {
    expect(() => encodeResize(-1, 24)).toThrow(RangeError);
    expect(() => encodeResize(80, -1)).toThrow(RangeError);
  });

  it('decodeResize throws on wrong payload length', () => {
    expect(() => decodeResize(new Uint8Array(3))).toThrow(RangeError);
    expect(() => decodeResize(new Uint8Array(5))).toThrow(RangeError);
  });
});

describe('encodeExit / decodeExit roundtrip', () => {
  it('roundtrips code=0', () => {
    expect(decodeExit(encodeExit(0))).toEqual({ code: 0 });
  });

  it('roundtrips code=127', () => {
    expect(decodeExit(encodeExit(127))).toEqual({ code: 127 });
  });

  it('roundtrips code=0xFFFFFFFF', () => {
    expect(decodeExit(encodeExit(0xffffffff))).toEqual({ code: 0xffffffff });
  });

  it('framed EXIT roundtrips through encode/decodeFrame', () => {
    const framed = encodeFrame({
      type: FrameType.EXIT,
      seq: 42,
      payload: encodeExit(137),
    });
    const decodedFrame = decodeFrame(framed);
    expect(decodedFrame.type).toBe(FrameType.EXIT);
    expect(decodedFrame.seq).toBe(42);
    expect(decodeExit(decodedFrame.payload)).toEqual({ code: 137 });
  });

  it('encodeExit throws on negative code', () => {
    expect(() => encodeExit(-1)).toThrow(RangeError);
  });

  it('encodeExit throws on code > 0xFFFFFFFF', () => {
    expect(() => encodeExit(0x100000000)).toThrow(RangeError);
  });

  it('decodeExit throws on wrong payload length', () => {
    expect(() => decodeExit(new Uint8Array(3))).toThrow(RangeError);
    expect(() => decodeExit(new Uint8Array(5))).toThrow(RangeError);
  });
});
