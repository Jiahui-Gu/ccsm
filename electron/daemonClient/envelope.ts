// electron/daemonClient/envelope.ts
//
// Electron-side mirror of the daemon's envelope wire-format
// (`daemon/src/envelope/envelope.ts`). Pure encode/decode of length-prefixed
// JSON+trailer frames per spec frag-3.4.1 §3.4.1.a (frame-version nibble +
// 16 MiB cap) + §3.4.1.c (header + payload split).
//
// Why a mirror instead of an import:
//   - daemon/ is a separate workspace bundle (ESM, NodeNext) and electron/
//     compiles to CommonJS via tsconfig.electron.json. The two cannot share
//     source files at runtime (`ERR_REQUIRE_ESM`). The wire format is locked
//     by the spec and is byte-stable across versions, so the cost of a small
//     duplicated module is low; a drift-guard test (`envelope-parity.test.ts`)
//     pins this mirror against the daemon's encoder by round-tripping the
//     same JSON bytes through both sides.
//   - Mirrors the same precedent set by `electron/daemon/bootDaemon.ts`,
//     which mirrors `scripts/double-bind-guard.ts` for the same reason.
//
// Single Responsibility (per dev contract §2):
//   - DECIDER: `encodeFrame` / `decodeFrame` are pure functions
//     `(input) -> output | EnvelopeError`. No I/O, no module-level state.
//
// Spec layout (must stay byte-identical to daemon/src/envelope/envelope.ts):
//   [totalLen:4][headerLen:2][headerJSON:headerLen][payloadBytes:totalLen-2-headerLen]
//
// Parse order is NON-NEGOTIABLE (frag-3.4.1 §3.4.1.a round-3 security CC-1):
//   1. Read 4-byte big-endian -> `raw`.
//   2. Extract version nibble FIRST: `nibble = (raw >>> 28) & 0x0F`.
//      Unknown -> throw `UNSUPPORTED_FRAME_VERSION` BEFORE masking.
//   3. THEN mask low 28 bits: `len = raw & 0x0FFFFFFF`.
//   4. THEN cap-check: `len > 16 MiB` -> throw `envelope_too_large`.

import { Buffer } from 'node:buffer';

const FRAME_VERSION_V03 = 0x0;
const KNOWN_FRAME_VERSIONS: ReadonlySet<number> = new Set([FRAME_VERSION_V03]);

// 16 MiB hard cap on per-frame payload length (spec §3.4.1.a).
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

const PREFIX_LEN = 4;
const HEADER_LEN_FIELD = 2;
const MAX_HEADER_LEN = 0xffff;

export interface DecodedFrame {
  readonly version: number;
  readonly headerJson: Buffer;
  readonly payload: Buffer;
}

export interface EncodeOptions {
  readonly version?: number;
  readonly headerJson: Buffer;
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

export function decodeFrame(buf: Buffer): DecodedFrame {
  if (buf.length < PREFIX_LEN) {
    throw new EnvelopeError('truncated_frame', 'buffer too short for 4-byte prefix');
  }
  const raw = buf.readUInt32BE(0);

  // Step 1: extract nibble FIRST.
  const nibble = (raw >>> 28) & 0x0f;
  if (!KNOWN_FRAME_VERSIONS.has(nibble)) {
    throw new EnvelopeError(
      'UNSUPPORTED_FRAME_VERSION',
      `unknown frame-version nibble 0x${nibble.toString(16)}`,
      { nibble },
    );
  }

  // Step 2: mask low 28 bits.
  const payloadLen = raw & 0x0fffffff;

  // Step 3: cap-check.
  if (payloadLen > MAX_PAYLOAD_BYTES) {
    throw new EnvelopeError(
      'envelope_too_large',
      `frame payload ${payloadLen} exceeds 16 MiB cap`,
      { len: payloadLen },
    );
  }

  // Step 4: ensure full-frame availability.
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
