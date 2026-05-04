// @ccsm/snapshot-codec — SnapshotV1 inner-codec layer.
//
// Per design spec ch06 §2 ("Codec rules"), SnapshotV1 wraps a compressed
// payload behind a single `codec` byte that names the algorithm:
//   1 = zstd (forever-stable v0.3 daemon default; empty zstd dictionary)
//   2 = gzip (browser fallback via DecompressionStream("gzip"); v0.4 web
//             client may emit/accept this when wasm zstd is unavailable)
//
// This package is INTENTIONALLY the inner compression-dispatch primitive
// only. It does not produce the full SnapshotV1Wire frame (outer "CSS1"
// magic, reserved bytes, inner_len prefix) — that framing is layered on
// top by the daemon snapshot serializer (T4.6/T4.7) so the wire format
// and the codec dispatch can evolve independently.
//
// Public shape:
//   encode(buf, codec) -> Uint8Array
//     [codec_byte] ++ compress(buf, codec)
//   decode(buf) -> Uint8Array
//     reads buf[0], dispatches to the matching decompressor
//
// Both functions are SYNCHRONOUS by design. `node:zlib` exposes synchronous
// zstd and gzip primitives in Node >= 22.15 (engines.node enforces this);
// callers can offload to a worker if they need to keep the event loop free
// — that policy belongs to the call site, not to the codec.
//
// Forward-compat (v0.4): adding `codec = 3` (e.g., zstd-with-dictionary)
// only requires extending the `Codec` union and the dispatch tables here;
// no change to callers, no `schema_version` bump (spec ch06 §2 / ch15 §3).
//
// The full SnapshotV1Wire encoder (xterm-headless Terminal -> wire bytes)
// lives in `./encoder.ts` and is re-exported below; this `index.ts`
// continues to own the inner compression-dispatch primitives so the two
// concerns remain separable for the v0.4 web client (which will reuse
// the codec dispatch but not the Node-only zstd path).

export {
  CURSOR_STYLE_BAR,
  CURSOR_STYLE_BLOCK,
  CURSOR_STYLE_UNDERLINE,
  DEFAULT_COLOR_SENTINEL,
  EMPTY_CODEPOINT,
  FLAG_BLINK,
  FLAG_BOLD,
  FLAG_DIM,
  FLAG_HIDDEN,
  FLAG_ITALIC,
  FLAG_REVERSE,
  FLAG_STRIKE,
  FLAG_UNDERLINE,
  INNER_MAGIC,
  MODES_BITMAP_LAYOUT,
  OUTER_HEADER_LEN,
  OUTER_MAGIC,
  RESERVED_BYTES,
  encodeInner,
  encodeSnapshotV1,
} from './encoder.js';
export type {
  BufferLike,
  BufferNamespaceLike,
  CellLike,
  CursorStyle,
  EncodeOptions,
  LineLike,
  ModesLike,
  XtermHeadlessLike,
} from './encoder.js';

import {
  zstdCompressSync,
  zstdDecompressSync,
  gzipSync,
  gunzipSync,
} from 'node:zlib';

/**
 * Codec identifiers carried in the leading byte of the encoded buffer.
 *
 * The numeric values are FOREVER-STABLE — they appear on disk inside
 * persisted `pty_snapshot.payload` rows (spec ch07 §2) and on the wire
 * inside `PtySnapshot.screen_state` frames. Renumbering breaks every
 * historical snapshot, so we type the values as a literal union and the
 * byte positions are the source of truth.
 */
export type Codec = 1 | 2;

/** Spec ch06 §2: codec = 1 → zstd. */
export const CODEC_ZSTD = 1 as const;
/** Spec ch06 §2: codec = 2 → gzip. */
export const CODEC_GZIP = 2 as const;

/**
 * Thrown when {@link decode} encounters a codec byte that this build does
 * not understand. The thrown error carries the offending byte so callers
 * (e.g. the daemon snapshot loader) can log telemetry without re-parsing.
 */
export class UnknownCodecError extends Error {
  public readonly codec: number;
  constructor(codec: number) {
    super(
      `@ccsm/snapshot-codec: unknown codec byte 0x${codec.toString(16).padStart(2, '0')} ` +
        `(expected 0x01 zstd or 0x02 gzip per spec ch06 §2)`,
    );
    this.name = 'UnknownCodecError';
    this.codec = codec;
  }
}

/**
 * Thrown when {@link decode} is called with an empty buffer — there is no
 * codec byte to read, which is always a programmer error (a real
 * SnapshotV1 inner payload is never zero-length).
 */
export class EmptyBufferError extends Error {
  constructor() {
    super('@ccsm/snapshot-codec: cannot decode empty buffer (codec byte missing)');
    this.name = 'EmptyBufferError';
  }
}

// `node:zlib`'s sync helpers accept any TypedArray / Buffer / ArrayBuffer and
// return a Node Buffer (which IS a Uint8Array, just with extra methods). We
// keep the public surface as plain `Uint8Array` so non-Node consumers (and
// tests) don't have to import the Buffer type.

function compress(buf: Uint8Array, codec: Codec): Uint8Array {
  switch (codec) {
    case CODEC_ZSTD:
      return zstdCompressSync(buf);
    case CODEC_GZIP:
      return gzipSync(buf);
    default: {
      // Exhaustiveness guard: if `Codec` ever grows a value we forgot to
      // handle, TypeScript flags `_exhaustive` as a never-mismatch error.
      const _exhaustive: never = codec;
      throw new UnknownCodecError(_exhaustive as unknown as number);
    }
  }
}

function decompress(payload: Uint8Array, codec: number): Uint8Array {
  switch (codec) {
    case CODEC_ZSTD:
      return zstdDecompressSync(payload);
    case CODEC_GZIP:
      return gunzipSync(payload);
    default:
      throw new UnknownCodecError(codec);
  }
}

/**
 * Encode an inner snapshot payload by compressing it with `codec` and
 * prefixing the resulting bytes with the single codec byte.
 *
 * Output layout: `[codec_byte][compressed_bytes...]`
 *
 * @param buf   Uncompressed inner-payload bytes (typically the
 *              `SnapshotV1Inner` byte stream produced by the daemon
 *              snapshot serializer; this layer is opaque to the codec).
 * @param codec Compression algorithm identifier (1 = zstd, 2 = gzip).
 * @returns     A fresh `Uint8Array` whose first byte is `codec` and whose
 *              remaining bytes are the compressed `buf`.
 */
export function encode(buf: Uint8Array, codec: Codec): Uint8Array {
  const compressed = compress(buf, codec);
  const out = new Uint8Array(1 + compressed.byteLength);
  out[0] = codec;
  out.set(compressed, 1);
  return out;
}

/**
 * Decode an encoded inner snapshot payload by reading the leading codec
 * byte and decompressing the remainder with the matching algorithm.
 *
 * @param buf  Encoded bytes produced by {@link encode} (or any peer that
 *             follows the same `[codec_byte][compressed_bytes...]` shape).
 * @returns    The original uncompressed payload.
 * @throws     {@link EmptyBufferError} if `buf.byteLength === 0`.
 * @throws     {@link UnknownCodecError} if the codec byte is not 1 or 2.
 *             Underlying zlib errors (truncated payload, bad magic, etc.)
 *             propagate unchanged so the daemon's existing zlib error
 *             handling (spec ch06 §2 reader rules) keeps working.
 */
export function decode(buf: Uint8Array): Uint8Array {
  if (buf.byteLength === 0) {
    throw new EmptyBufferError();
  }
  const codec = buf[0]!;
  // `subarray` shares the underlying ArrayBuffer (no copy) — safe because
  // node:zlib reads but never mutates the input.
  const payload = buf.subarray(1);
  return decompress(payload, codec);
}
