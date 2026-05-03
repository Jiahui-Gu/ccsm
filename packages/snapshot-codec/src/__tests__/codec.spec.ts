// Codec roundtrip + golden tests for @ccsm/snapshot-codec.
//
// What this suite locks down (spec ch06 §2 / spec ch15 §3 audit row 5):
//   1. encode/decode are mutually inverse for both codecs.
//   2. The first byte of the output is the codec byte (1 or 2).
//   3. The compressed payload starts with the well-known frame magic of
//      the chosen algorithm — pins the algorithm choice without coupling
//      to zlib library version (which controls the rest of the bytes).
//   4. encode is deterministic within a single Node process — same input
//      twice MUST produce byte-identical output. v0.4 ship-gate (c)
//      relies on this for cross-process snapshot byte-equality.
//   5. decode of a hex-pinned golden blob reproduces a known plaintext
//      for both codecs. Decode is portable across zlib versions because
//      both gzip and zstd frame formats are spec'd; this test would
//      catch a swap of the codec byte semantics or a regression in the
//      underlying decompressor.
//   6. decode rejects empty buffer and unknown codec bytes.

import { describe, expect, it } from 'vitest';
import {
  CODEC_GZIP,
  CODEC_ZSTD,
  decode,
  encode,
  EmptyBufferError,
  UnknownCodecError,
} from '../index.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// We use Node Buffer (which IS a Uint8Array) for string<->bytes conversion
// rather than TextEncoder/TextDecoder so the spec runs cleanly under both
// the package-local lint config and the repo-root lint sweep (which does
// not whitelist the WHATWG encoder globals). The codec API itself is
// Uint8Array-only — Buffer here is just test scaffolding.

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'));
}

function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}

function utf8Decode(b: Uint8Array): string {
  return Buffer.from(b).toString('utf8');
}

// Inputs that exercise different shapes the codec is likely to see in
// production: tiny ASCII, binary with all 0..255 bytes, repetitive text
// (large compression ratio), and unicode (multibyte UTF-8).
const TINY_ASCII = utf8('hello world');
const REPETITIVE = utf8('a'.repeat(4096));
const UNICODE = utf8('snapshot 快照 📸 ' + 'ñ'.repeat(100));
const BINARY = (() => {
  const b = new Uint8Array(512);
  for (let i = 0; i < b.length; i++) b[i] = i & 0xff;
  return b;
})();
const EMPTY = new Uint8Array(0);

const FIXTURES: Array<{ name: string; bytes: Uint8Array }> = [
  { name: 'tiny ascii', bytes: TINY_ASCII },
  { name: 'repetitive', bytes: REPETITIVE },
  { name: 'unicode', bytes: UNICODE },
  { name: 'binary 0..255', bytes: BINARY },
  { name: 'empty input', bytes: EMPTY },
];

// ---------------------------------------------------------------------------
// roundtrip
// ---------------------------------------------------------------------------

describe('encode/decode roundtrip', () => {
  for (const codec of [CODEC_ZSTD, CODEC_GZIP] as const) {
    for (const f of FIXTURES) {
      it(`codec=${codec} ${f.name}`, () => {
        const encoded = encode(f.bytes, codec);
        // first byte MUST be the codec id
        expect(encoded[0]).toBe(codec);
        const decoded = decode(encoded);
        expect(bytesEq(decoded, f.bytes)).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// frame-magic assertions: pin the algorithm choice, not the bytes
// ---------------------------------------------------------------------------

describe('frame magic', () => {
  it('codec=1 emits a zstd frame (magic 0xfd2fb528 little-endian)', () => {
    const out = encode(TINY_ASCII, CODEC_ZSTD);
    // [codec, 28, b5, 2f, fd, ...]
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(0x28);
    expect(out[2]).toBe(0xb5);
    expect(out[3]).toBe(0x2f);
    expect(out[4]).toBe(0xfd);
  });

  it('codec=2 emits a gzip frame (magic 0x1f 0x8b 0x08)', () => {
    const out = encode(TINY_ASCII, CODEC_GZIP);
    // [codec, 1f, 8b, 08, ...]
    expect(out[0]).toBe(2);
    expect(out[1]).toBe(0x1f);
    expect(out[2]).toBe(0x8b);
    expect(out[3]).toBe(0x08);
  });
});

// ---------------------------------------------------------------------------
// determinism (within a single process)
// ---------------------------------------------------------------------------

describe('encode determinism', () => {
  for (const codec of [CODEC_ZSTD, CODEC_GZIP] as const) {
    it(`codec=${codec} same input → byte-identical output`, () => {
      const a = encode(REPETITIVE, codec);
      const b = encode(REPETITIVE, codec);
      expect(bytesEq(a, b)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// golden decode: hex-pinned blobs MUST decode to known plaintext.
//
// The blobs were produced offline using `node:zlib` defaults and are kept
// as exact byte sequences so any future codec swap (e.g., changing zstd
// level, accidentally re-numbering CODEC_ZSTD/CODEC_GZIP) trips the test.
// Decode is portable across zlib versions because both formats are
// fully specified; encode output is NOT pinned here because Node's
// bundled zlib/zstd library version controls the post-magic bytes.
// ---------------------------------------------------------------------------

describe('golden decode', () => {
  it('codec=1 zstd golden → "hello world"', () => {
    // codec(01) | zstd frame for "hello world" (level=default, no dict)
    const golden = fromHex('0128b52ffd200b59000068656c6c6f20776f726c64');
    expect(golden[0]).toBe(1);
    const decoded = decode(golden);
    expect(utf8Decode(decoded)).toBe('hello world');
  });

  it('codec=2 gzip golden → "hello world"', () => {
    // codec(02) | gzip frame for "hello world" (level=default, mtime=0)
    const golden = fromHex(
      '021f8b080000000000000acb48cdc9c95728cf2fca49010085114a0d0b000000',
    );
    expect(golden[0]).toBe(2);
    const decoded = decode(golden);
    expect(utf8Decode(decoded)).toBe('hello world');
  });

  it('encode → golden-decode chain works end-to-end', () => {
    // Belt-and-suspenders: a freshly-encoded buffer decodes back via the
    // same decode() the goldens use, ensuring no encode/decode drift.
    for (const codec of [CODEC_ZSTD, CODEC_GZIP] as const) {
      const encoded = encode(TINY_ASCII, codec);
      const decoded = decode(encoded);
      expect(utf8Decode(decoded)).toBe('hello world');
      // hex render is just for clear failure output if this ever breaks
      expect(hex(encoded).startsWith(codec === 1 ? '0128b52ffd' : '021f8b08')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

describe('decode error handling', () => {
  it('rejects empty buffer', () => {
    expect(() => decode(new Uint8Array(0))).toThrow(EmptyBufferError);
  });

  it('rejects unknown codec byte 0x00', () => {
    expect(() => decode(new Uint8Array([0x00, 0xde, 0xad]))).toThrow(UnknownCodecError);
  });

  it('rejects unknown codec byte 0x03 (reserved for future use)', () => {
    expect(() => decode(new Uint8Array([0x03, 0xde, 0xad]))).toThrow(UnknownCodecError);
  });

  it('rejects unknown codec byte 0xff', () => {
    expect(() => decode(new Uint8Array([0xff, 0xde, 0xad]))).toThrow(UnknownCodecError);
  });

  it('UnknownCodecError carries the offending codec byte', () => {
    try {
      decode(new Uint8Array([0x42, 0x00]));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownCodecError);
      expect((e as UnknownCodecError).codec).toBe(0x42);
    }
  });

  it('propagates underlying zlib error on garbage zstd payload', () => {
    // codec=1 followed by bytes that are not a valid zstd frame — the
    // decompressor MUST surface a zlib error rather than silently
    // returning an empty / partial buffer.
    expect(() =>
      decode(new Uint8Array([0x01, 0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe])),
    ).toThrow();
  });

  it('propagates underlying zlib error on truncated gzip payload', () => {
    // codec=2 followed by partial gzip magic — decompressor MUST throw.
    expect(() => decode(new Uint8Array([0x02, 0x1f, 0x8b]))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// API surface sanity
// ---------------------------------------------------------------------------

describe('API surface', () => {
  it('exports CODEC_ZSTD = 1 and CODEC_GZIP = 2 with correct numeric type', () => {
    expect(CODEC_ZSTD).toBe(1);
    expect(CODEC_GZIP).toBe(2);
  });

  it('encode returns a fresh Uint8Array (not a view of the input)', () => {
    const out = encode(TINY_ASCII, CODEC_ZSTD);
    expect(out).toBeInstanceOf(Uint8Array);
    // mutating output MUST NOT mutate input
    out[0] = 0xff;
    expect(TINY_ASCII[0]).toBe('h'.charCodeAt(0));
  });
});
