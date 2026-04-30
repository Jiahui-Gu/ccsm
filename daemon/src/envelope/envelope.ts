// Envelope wire-format core (spec §3.4.1.a + §3.4.1.c).
//
// Wire layout (binary frame format):
//   [totalLen:4][headerLen:2][headerJSON:headerLen][payloadBytes:totalLen-2-headerLen]
//
// - The 4-byte `totalLen` prefix carries TWO logical fields packed together:
//     * high 4 bits   = frame-version nibble (v0.3 daemon: 0x0; v0.4: 0x1)
//     * low  28 bits  = payload length in bytes (everything AFTER the 4-byte
//                       prefix: the 2-byte headerLen + headerJSON + payloadBytes)
//   Max addressable payload is therefore 2^28 - 1 ≈ 256 MiB; we cap it at 16 MiB
//   per spec §3.4.1.a.
//
// Parse order is NON-NEGOTIABLE (spec §3.4.1.a round-3 security CC-1):
//   1. Read 4-byte big-endian header → `raw`.
//   2. Extract version nibble FIRST: `nibble = (raw >>> 28) & 0x0F`. If unknown,
//      throw `UNSUPPORTED_FRAME_VERSION` BEFORE masking — getting this wrong
//      either resurrects a 256 MiB DoS or masks the real reject reason on a
//      v0.4-from-future client.
//   3. THEN mask low 28 bits: `len = raw & 0x0FFFFFFF`.
//   4. THEN cap-check: `len > 16 MiB` → throw `envelope_too_large`.
//
// This module is pure encode/decode. It does NOT compute or verify HMACs (T4
// owns `hmac.ts`); it does NOT validate header schemas (the adapter's TypeBox
// hook owns that, spec §3.4.1.d). It only splits bytes.

const FRAME_VERSION_V03 = 0x0;
const KNOWN_FRAME_VERSIONS: ReadonlySet<number> = new Set([FRAME_VERSION_V03]);

// 16 MiB hard cap on per-frame payload length (spec §3.4.1.a).
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

// Width of the fixed-size length+nibble prefix in bytes.
const PREFIX_LEN = 4;
// Width of the 16-bit headerLen field in bytes.
const HEADER_LEN_FIELD = 2;
// uint16 max — JSON header fits in 64 KiB by construction.
const MAX_HEADER_LEN = 0xffff;

/**
 * Result of decoding one wire frame. `headerJson` is the raw UTF-8 bytes of the
 * JSON header (left as Buffer so the caller can `JSON.parse` AFTER schema
 * validation, per spec §3.4.1.d). `payload` is the opaque trailer (binary PTY
 * bytes for `payloadType: "binary"`, or empty for pure-JSON frames).
 */
export interface DecodedFrame {
  readonly version: number;
  readonly headerJson: Buffer;
  readonly payload: Buffer;
}

export interface EncodeOptions {
  /** Frame-version nibble; defaults to v0.3 (0x0). */
  readonly version?: number;
  /** UTF-8 bytes of the JSON header. Caller is responsible for `JSON.stringify`. */
  readonly headerJson: Buffer;
  /** Opaque trailer bytes; empty Buffer for pure-JSON frames. */
  readonly payload?: Buffer;
}

export class EnvelopeError extends Error {
  public readonly code: string;
  public readonly nibble?: number;
  public readonly len?: number;

  constructor(code: string, message: string, extras?: { nibble?: number; len?: number }) {
    super(message);
    this.name = 'EnvelopeError';
    this.code = code;
    if (extras?.nibble !== undefined) this.nibble = extras.nibble;
    if (extras?.len !== undefined) this.len = extras.len;
  }
}

/**
 * Encode a wire frame from header + optional trailer bytes.
 *
 * Throws `EnvelopeError` with `code = "envelope_too_large"` if the resulting
 * payload exceeds 16 MiB, or `code = "header_too_large"` if the JSON header
 * exceeds the uint16 headerLen field.
 */
export function encodeFrame(opts: EncodeOptions): Buffer {
  const version = opts.version ?? FRAME_VERSION_V03;
  if (!KNOWN_FRAME_VERSIONS.has(version)) {
    throw new EnvelopeError(
      'UNSUPPORTED_FRAME_VERSION',
      `unknown frame-version nibble 0x${version.toString(16)}`,
      { nibble: version },
    );
  }
  const headerJson = opts.headerJson;
  const payload = opts.payload ?? Buffer.alloc(0);
  const headerLen = headerJson.length;
  if (headerLen > MAX_HEADER_LEN) {
    throw new EnvelopeError(
      'header_too_large',
      `header bytes ${headerLen} exceed uint16 max ${MAX_HEADER_LEN}`,
      { len: headerLen },
    );
  }
  const payloadLen = HEADER_LEN_FIELD + headerLen + payload.length;
  if (payloadLen > MAX_PAYLOAD_BYTES) {
    throw new EnvelopeError(
      'envelope_too_large',
      `frame payload ${payloadLen} exceeds 16 MiB cap`,
      { len: payloadLen },
    );
  }
  // Pack version nibble into high 4 bits of totalLen.
  const raw = ((version & 0x0f) << 28) | (payloadLen & 0x0fffffff);
  const out = Buffer.allocUnsafe(PREFIX_LEN + payloadLen);
  out.writeUInt32BE(raw >>> 0, 0);
  out.writeUInt16BE(headerLen, PREFIX_LEN);
  headerJson.copy(out, PREFIX_LEN + HEADER_LEN_FIELD);
  if (payload.length > 0) {
    payload.copy(out, PREFIX_LEN + HEADER_LEN_FIELD + headerLen);
  }
  return out;
}

/**
 * Decode one full wire frame from `buf`. The caller is responsible for buffer
 * accumulation across socket `data` events; this function expects `buf` to
 * contain at least one complete frame starting at offset 0 and returns an
 * error if it does not.
 *
 * Throws `EnvelopeError` on:
 *   - truncated prefix / header / payload (`code = "truncated_frame"`)
 *   - unknown version nibble (`code = "UNSUPPORTED_FRAME_VERSION"`)
 *   - oversize payload (`code = "envelope_too_large"`)
 *   - headerLen > remaining payload (`code = "corrupt_header_len"`)
 */
export function decodeFrame(buf: Buffer): DecodedFrame {
  if (buf.length < PREFIX_LEN) {
    throw new EnvelopeError('truncated_frame', 'buffer too short for 4-byte prefix');
  }
  const raw = buf.readUInt32BE(0);

  // Step 1: extract nibble FIRST (spec §3.4.1.a step 2).
  const nibble = (raw >>> 28) & 0x0f;
  if (!KNOWN_FRAME_VERSIONS.has(nibble)) {
    throw new EnvelopeError(
      'UNSUPPORTED_FRAME_VERSION',
      `unknown frame-version nibble 0x${nibble.toString(16)}`,
      { nibble },
    );
  }

  // Step 2: mask low 28 bits to compute payload length.
  const payloadLen = raw & 0x0fffffff;

  // Step 3: cap-check.
  if (payloadLen > MAX_PAYLOAD_BYTES) {
    throw new EnvelopeError(
      'envelope_too_large',
      `frame payload ${payloadLen} exceeds 16 MiB cap`,
      { len: payloadLen },
    );
  }

  // Step 4: ensure the buffer holds the full frame.
  const totalNeeded = PREFIX_LEN + payloadLen;
  if (buf.length < totalNeeded) {
    throw new EnvelopeError(
      'truncated_frame',
      `buffer ${buf.length} bytes < expected ${totalNeeded}`,
      { len: payloadLen },
    );
  }
  if (payloadLen < HEADER_LEN_FIELD) {
    throw new EnvelopeError(
      'corrupt_header_len',
      `payload ${payloadLen} bytes too small for headerLen field`,
      { len: payloadLen },
    );
  }

  // Step 5: split header / payload.
  const headerLen = buf.readUInt16BE(PREFIX_LEN);
  const headerStart = PREFIX_LEN + HEADER_LEN_FIELD;
  const headerEnd = headerStart + headerLen;
  if (headerEnd > totalNeeded) {
    throw new EnvelopeError(
      'corrupt_header_len',
      `headerLen ${headerLen} overflows frame payload ${payloadLen}`,
      { len: headerLen },
    );
  }

  // Slice (zero-copy views over the input buffer).
  const headerJson = buf.subarray(headerStart, headerEnd);
  const payload = buf.subarray(headerEnd, totalNeeded);

  return { version: nibble, headerJson, payload };
}

export const ENVELOPE_LIMITS = Object.freeze({
  MAX_PAYLOAD_BYTES,
  MAX_HEADER_LEN,
  PREFIX_LEN,
  HEADER_LEN_FIELD,
  FRAME_VERSION_V03,
});
