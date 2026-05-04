// @ccsm/snapshot-codec — SnapshotV1 decoder (bytes → DecodedSnapshotV1).
//
// Spec: design-spec ch06 §2 ("Snapshot: encoding"). This module is the
// inverse of `./encoder.ts`: it parses SnapshotV1Wire bytes back into a
// structured `DecodedSnapshotV1` value that mirrors the on-wire layout
// 1:1 — same field names, same units, same ordering.
//
// Why not "directly mutate an xterm.js Terminal"? Spec ch06 §2 line 1594
// describes the v0.3 client (Electron renderer) decoder as "mutates an
// xterm.js Terminal buffer directly". That xterm.js mutation is a
// SEPARATE concern owned by the renderer (T4.8 / `packages/electron/.../
// snapshot-decoder.ts` per spec line 1594) — this leaf-library codec
// package is forbidden from depending on xterm.js (eslint
// no-restricted-imports). Decoder responsibility is split:
//
//   1. THIS file (`decoder.ts`):
//        SnapshotV1Wire bytes → `DecodedSnapshotV1` (pure data, no UI).
//        Validates outer/inner magic, codec, reserved bytes; decompresses;
//        parses every Cell + AttrEntry + Line. Byte-identical roundtrip
//        verifiable here (T9.7 spike `tools/spike-harness/
//        snapshot-roundtrip.spec.ts`).
//
//   2. Renderer-side `snapshot-decoder.ts` (separate task):
//        `DecodedSnapshotV1` → mutate xterm.js Terminal buffer. Requires
//        xterm.js, runs in renderer.
//
// This split mirrors the encoder, which accepts a structurally-typed
// `XtermHeadlessLike` shape rather than importing @xterm/headless.
//
// SYNCHRONOUS by design — see `./index.ts` rationale.

import { decode as decodeCodec, CODEC_ZSTD, CODEC_GZIP, type Codec } from './index.js';
import {
  CURSOR_STYLE_BAR,
  CURSOR_STYLE_BLOCK,
  CURSOR_STYLE_UNDERLINE,
  INNER_MAGIC,
  MODES_BITMAP_LAYOUT,
  OUTER_HEADER_LEN,
  OUTER_MAGIC,
  RESERVED_BYTES,
  type CursorStyle,
} from './encoder.js';

// ---------------------------------------------------------------------------
// Decoded data types — mirror the SnapshotV1Inner struct from ch06 §2.
// ---------------------------------------------------------------------------

/** A `(fg, bg, flags)` palette entry (`AttrEntry` in the spec). */
export interface DecodedAttrEntry {
  /**
   * Foreground wire value (uint32). Encoded per spec ch06 §2:
   *   - `0xFF000001` → terminal default
   *   - `0x000000NN` → palette index N (0..255)
   *   - `0xRRGGBB`   → 24-bit RGB
   * Disambiguation lives at the consumer; this layer reports the raw
   * uint32 so renderers can apply theme overrides without re-parsing.
   */
  fg: number;
  /** Background wire value (uint32) — same encoding as `fg`. */
  bg: number;
  /** Attribute flag bits — see `FLAG_*` constants in `./encoder.ts`. */
  flags: number;
}

/** A single grid cell (`Cell` in the spec). */
export interface DecodedCell {
  /** Base grapheme cluster character codepoint; `0` (`EMPTY_CODEPOINT`) for empty cells. */
  codepoint: number;
  /** Index into `attrsPalette`. */
  attrsIndex: number;
  /** Display width — `1` for narrow, `2` for east-asian wide, `0` for wide-cell continuation. */
  width: number;
  /** Combining-mark codepoints in original sequence order; empty array if none. */
  combiners: number[];
}

/** A single buffer line (`Line` in the spec). */
export interface DecodedLine {
  /** Cells in left→right order; length matches the encoder's per-line cell count. */
  cells: DecodedCell[];
  /** Continuation-line marker — `true` if this line was wrapped from the previous. */
  wrapped: boolean;
}

/**
 * Decoded `SnapshotV1Inner` payload — structurally mirrors the on-wire
 * layout. All multi-byte integers are already unpacked as JS numbers.
 *
 * Lines are ordered scrollback-oldest → scrollback-newest → viewport-top
 * → viewport-bottom (same as the encoder writes them). The first
 * `scrollbackLines` entries are scrollback; the next `viewportLines` are
 * the active viewport.
 */
export interface DecodedSnapshotV1 {
  /** Terminal column count. */
  cols: number;
  /** Terminal row count. */
  rows: number;
  /** 0-based cursor row inside the buffer. */
  cursorRow: number;
  /** 0-based cursor column. */
  cursorCol: number;
  /** Whether the cursor was visible (DECTCEM). */
  cursorVisible: boolean;
  /** Cursor visual style (`CURSOR_STYLE_*`). */
  cursorStyle: CursorStyle;
  /** Number of scrollback lines stored in `lines`. */
  scrollbackLines: number;
  /** Number of viewport lines stored in `lines` — typically equal to `rows`. */
  viewportLines: number;
  /**
   * Decoded `(byteIndex, bitIndex) → boolean` mode map. Keys match the
   * `MODES_BITMAP_LAYOUT` symbolic names from `./encoder.ts`.
   *
   * Reserved bits (per spec: byte 1 bits 5-7 + bytes 2-7) are NOT exposed
   * here — the decoder rejects non-zero reserved bits with
   * {@link CorruptSnapshotError} so v2 can repurpose them.
   */
  modes: DecodedModes;
  /** Attribute palette — entry 0 is the default-attrs entry per spec. */
  attrsPalette: DecodedAttrEntry[];
  /** All buffer lines — scrollback first (oldest→newest), then viewport (top→bottom). */
  lines: DecodedLine[];
  /**
   * Raw `SnapshotV1Inner` magic + bitmap retained for forward-compat.
   * Renderers usually ignore `rawModesBitmap`; downstream packages may
   * use it to pass the bytes through unchanged when re-emitting.
   */
  rawModesBitmap: Uint8Array;
}

/** Decoded mode flags — boolean form of `MODES_BITMAP_LAYOUT`. */
export interface DecodedModes {
  applicationCursor: boolean;
  applicationKeypad: boolean;
  altScreen: boolean;
  bracketedPaste: boolean;
  mouseX10: boolean;
  mouseVt200: boolean;
  mouseAnyEvent: boolean;
  mouseSgr: boolean;
  cursorVisible: boolean;
  focusTracking: boolean;
  originMode: boolean;
  autoWrap: boolean;
  reverseVideo: boolean;
}

// ---------------------------------------------------------------------------
// Errors — every failure path produces a typed error so callers (daemon
// snapshot loader, renderer attach path) can branch on `instanceof` and
// log telemetry without re-parsing the byte stream.
// ---------------------------------------------------------------------------

/**
 * Thrown when the wire bytes do not form a valid SnapshotV1Wire frame.
 * Common causes: truncated buffer, wrong outer magic, non-zero reserved
 * bytes, mismatched `inner_len`. The original bytes are not mutated; the
 * thrown error carries an English diagnostic only.
 */
export class CorruptSnapshotError extends Error {
  constructor(message: string) {
    super(`@ccsm/snapshot-codec: ${message}`);
    this.name = 'CorruptSnapshotError';
  }
}

/**
 * Thrown when the outer or inner magic does not match `"CSS1"`.
 *
 * Subclass of {@link CorruptSnapshotError} so callers that already catch
 * the parent type also catch this; specific catches (e.g., to surface a
 * different telemetry tag for "not even a snapshot at all") still work.
 */
export class BadMagicError extends CorruptSnapshotError {
  public readonly where: 'outer' | 'inner';
  constructor(where: 'outer' | 'inner', got: Uint8Array) {
    super(
      `bad ${where} magic — expected "CSS1" (43 53 53 31), got ` +
        Array.from(got)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' '),
    );
    this.name = 'BadMagicError';
    this.where = where;
  }
}

/**
 * Thrown when `schema_version`-equivalent invariants are violated by a
 * frame that otherwise has a valid magic. v1 specifies that the three
 * reserved bytes between `codec` and `inner_len` MUST be zero — readers
 * MUST reject non-zero so v2 can repurpose them (spec ch06 §2 reader
 * rules).
 */
export class UnsupportedVersionError extends CorruptSnapshotError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedVersionError';
  }
}

// ---------------------------------------------------------------------------
// Byte reader — mirror of `ByteWriter` from encoder.ts. Tracks an offset
// and bounds-checks every read against the underlying buffer length so a
// truncated payload throws a typed error rather than producing NaN cells.
// ---------------------------------------------------------------------------

class ByteReader {
  private readonly view: DataView;
  private off = 0;

  constructor(public readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get offset(): number {
    return this.off;
  }

  get remaining(): number {
    return this.buf.byteLength - this.off;
  }

  private require(n: number, what: string): void {
    if (this.off + n > this.buf.byteLength) {
      throw new CorruptSnapshotError(
        `truncated payload reading ${what}: need ${n} bytes at offset ${this.off}, ` +
          `have ${this.buf.byteLength - this.off}`,
      );
    }
  }

  readBytes(n: number, what: string): Uint8Array {
    this.require(n, what);
    // `subarray` shares the underlying ArrayBuffer (no copy); decoder
    // outputs are read-only by convention so this is safe.
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  readU8(what: string): number {
    this.require(1, what);
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }

  readU16LE(what: string): number {
    this.require(2, what);
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }

  readU32LE(what: string): number {
    this.require(4, what);
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function decodeCursorStyle(byte: number): CursorStyle {
  switch (byte) {
    case CURSOR_STYLE_BLOCK:
      return CURSOR_STYLE_BLOCK;
    case CURSOR_STYLE_UNDERLINE:
      return CURSOR_STYLE_UNDERLINE;
    case CURSOR_STYLE_BAR:
      return CURSOR_STYLE_BAR;
    default:
      throw new CorruptSnapshotError(
        `unknown cursor_style byte 0x${byte.toString(16).padStart(2, '0')} ` +
          `(expected 0=block, 1=underline, 2=bar per spec ch06 §2)`,
      );
  }
}

function decodeModesBitmap(bitmap: Uint8Array): DecodedModes {
  // Spec ch06 §2: byte 1 bits 5-7 + bytes 2-7 are RESERVED, MUST be zero
  // in v1; readers reject non-zero so v2 can grow.
  const reservedByte1Mask = 0b11100000;
  if ((bitmap[1] ?? 0) & reservedByte1Mask) {
    throw new UnsupportedVersionError(
      `modes_bitmap byte 1 has reserved bits 5-7 set (got 0x${(bitmap[1] ?? 0)
        .toString(16)
        .padStart(2, '0')}); v1 readers MUST reject — see spec ch06 §2`,
    );
  }
  for (let i = 2; i < 8; i++) {
    if ((bitmap[i] ?? 0) !== 0) {
      throw new UnsupportedVersionError(
        `modes_bitmap byte ${i} is reserved and MUST be zero in v1 (got 0x${(bitmap[i] ?? 0)
          .toString(16)
          .padStart(2, '0')}) — see spec ch06 §2`,
      );
    }
  }
  const get = (byteIdx: number, bitIdx: number): boolean =>
    ((bitmap[byteIdx] ?? 0) & (1 << bitIdx)) !== 0;
  const L = MODES_BITMAP_LAYOUT;
  return {
    applicationCursor: get(L.applicationCursor[0], L.applicationCursor[1]),
    applicationKeypad: get(L.applicationKeypad[0], L.applicationKeypad[1]),
    altScreen: get(L.altScreen[0], L.altScreen[1]),
    bracketedPaste: get(L.bracketedPaste[0], L.bracketedPaste[1]),
    mouseX10: get(L.mouseX10[0], L.mouseX10[1]),
    mouseVt200: get(L.mouseVt200[0], L.mouseVt200[1]),
    mouseAnyEvent: get(L.mouseAnyEvent[0], L.mouseAnyEvent[1]),
    mouseSgr: get(L.mouseSgr[0], L.mouseSgr[1]),
    cursorVisible: get(L.cursorVisible[0], L.cursorVisible[1]),
    focusTracking: get(L.focusTracking[0], L.focusTracking[1]),
    originMode: get(L.originMode[0], L.originMode[1]),
    autoWrap: get(L.autoWrap[0], L.autoWrap[1]),
    reverseVideo: get(L.reverseVideo[0], L.reverseVideo[1]),
  };
}

// ---------------------------------------------------------------------------
// Inner-payload decoder — mirror of `encodeInner`.
// ---------------------------------------------------------------------------

/**
 * Decode the raw `SnapshotV1Inner` byte stream (post-decompression) into
 * a {@link DecodedSnapshotV1}. Useful for tests that round-trip through
 * `encodeInner` directly. Production callers should use
 * {@link decodeSnapshotV1}, which validates the outer wrapper and
 * dispatches decompression.
 *
 * @throws {@link BadMagicError} if the inner magic is not `"CSS1"`.
 * @throws {@link CorruptSnapshotError} on truncation or invalid byte
 *   values (e.g. unknown `cursor_style`).
 * @throws {@link UnsupportedVersionError} if reserved `modes_bitmap`
 *   bits are non-zero.
 */
export function decodeInner(inner: Uint8Array): DecodedSnapshotV1 {
  const r = new ByteReader(inner);

  const magic = r.readBytes(4, 'inner magic');
  if (!bytesEqual(magic, INNER_MAGIC)) {
    throw new BadMagicError('inner', magic);
  }

  const cols = r.readU16LE('cols');
  const rows = r.readU16LE('rows');
  const cursorRow = r.readU32LE('cursor_row');
  const cursorCol = r.readU32LE('cursor_col');
  const cursorVisibleByte = r.readU8('cursor_visible');
  if (cursorVisibleByte !== 0 && cursorVisibleByte !== 1) {
    throw new CorruptSnapshotError(
      `cursor_visible must be 0 or 1, got ${cursorVisibleByte}`,
    );
  }
  const cursorStyle = decodeCursorStyle(r.readU8('cursor_style'));
  const scrollbackLines = r.readU32LE('scrollback_lines');
  const viewportLines = r.readU32LE('viewport_lines');

  const rawModesBitmap = new Uint8Array(r.readBytes(8, 'modes_bitmap'));
  const modes = decodeModesBitmap(rawModesBitmap);

  const paletteLen = r.readU32LE('attrs_palette_len');
  // Sanity bound — a 4-byte length field could legally encode ~4G entries
  // but no real terminal produces more than ~thousands. Reject anything
  // that would obviously exhaust memory before we even start allocating.
  // 1M entries × 10 bytes = 10 MB allocation — generous upper bound.
  if (paletteLen > 1_000_000) {
    throw new CorruptSnapshotError(
      `attrs_palette_len=${paletteLen} exceeds sanity bound 1_000_000 — likely corrupt`,
    );
  }
  const attrsPalette: DecodedAttrEntry[] = new Array(paletteLen);
  for (let i = 0; i < paletteLen; i++) {
    const fg = r.readU32LE(`attrs_palette[${i}].fg`);
    const bg = r.readU32LE(`attrs_palette[${i}].bg`);
    const flags = r.readU16LE(`attrs_palette[${i}].flags`);
    attrsPalette[i] = { fg, bg, flags };
  }

  const totalLines = scrollbackLines + viewportLines;
  if (totalLines > 10_000_000) {
    throw new CorruptSnapshotError(
      `scrollback_lines + viewport_lines = ${totalLines} exceeds sanity bound 10_000_000`,
    );
  }
  const lines: DecodedLine[] = new Array(totalLines);
  for (let li = 0; li < totalLines; li++) {
    const cellCount = r.readU16LE(`lines[${li}].cell_count`);
    const cells: DecodedCell[] = new Array(cellCount);
    for (let ci = 0; ci < cellCount; ci++) {
      const codepoint = r.readU32LE(`lines[${li}].cells[${ci}].codepoint`);
      const attrsIndex = r.readU32LE(`lines[${li}].cells[${ci}].attrs_index`);
      // Validate attrs_index against palette to fail fast on corruption.
      // The encoder always emits at least one palette entry (the default),
      // so even an empty terminal has paletteLen >= 1.
      if (attrsIndex >= paletteLen) {
        throw new CorruptSnapshotError(
          `lines[${li}].cells[${ci}].attrs_index=${attrsIndex} out of range ` +
            `(palette length ${paletteLen})`,
        );
      }
      const width = r.readU8(`lines[${li}].cells[${ci}].width`);
      const combinerCount = r.readU8(`lines[${li}].cells[${ci}].combiner_count`);
      const combiners: number[] = new Array(combinerCount);
      for (let k = 0; k < combinerCount; k++) {
        combiners[k] = r.readU32LE(`lines[${li}].cells[${ci}].combiners[${k}]`);
      }
      cells[ci] = { codepoint, attrsIndex, width, combiners };
    }
    const wrappedByte = r.readU8(`lines[${li}].wrapped`);
    if (wrappedByte !== 0 && wrappedByte !== 1) {
      throw new CorruptSnapshotError(
        `lines[${li}].wrapped must be 0 or 1, got ${wrappedByte}`,
      );
    }
    lines[li] = { cells, wrapped: wrappedByte === 1 };
  }

  if (r.remaining !== 0) {
    throw new CorruptSnapshotError(
      `${r.remaining} unexpected trailing bytes after inner payload (read ${r.offset} of ${inner.byteLength})`,
    );
  }

  return {
    cols,
    rows,
    cursorRow,
    cursorCol,
    cursorVisible: cursorVisibleByte === 1,
    cursorStyle,
    scrollbackLines,
    viewportLines,
    modes,
    attrsPalette,
    lines,
    rawModesBitmap,
  };
}

// ---------------------------------------------------------------------------
// Outer-wrapper decoder — bytes → DecodedSnapshotV1.
// ---------------------------------------------------------------------------

/**
 * Decode SnapshotV1Wire bytes back into a structured snapshot.
 *
 * Validation order (matches spec ch06 §2 decoder steps 1-3):
 *   1. Outer magic must equal `"CSS1"`.
 *   2. `codec` byte must be 1 (zstd) or 2 (gzip).
 *   3. `reserved[3]` bytes must all be zero (v1 invariant).
 *   4. `inner_len` must equal `wire.byteLength - OUTER_HEADER_LEN`.
 *   5. Decompress; parse inner via {@link decodeInner}.
 *
 * @param wire SnapshotV1Wire bytes — typically read from
 *   `pty_snapshot.payload` (spec ch07 §2) or from a `PtySnapshot`
 *   `screen_state` field.
 * @returns Structured snapshot mirroring SnapshotV1Inner.
 * @throws {@link BadMagicError} on outer magic mismatch.
 * @throws {@link UnsupportedVersionError} if `reserved` bytes are non-zero
 *   or `inner_len` doesn't match the buffer length.
 * @throws {@link CorruptSnapshotError} for any other framing / parse error.
 *   Underlying zlib errors (truncated payload, bad zstd magic, etc.) from
 *   {@link decodeCodec} propagate unchanged so the daemon's existing
 *   zlib-error handling keeps working.
 */
export function decodeSnapshotV1(wire: Uint8Array): DecodedSnapshotV1 {
  if (wire.byteLength < OUTER_HEADER_LEN) {
    throw new CorruptSnapshotError(
      `wire payload too short: need ${OUTER_HEADER_LEN} header bytes, got ${wire.byteLength}`,
    );
  }
  const magic = wire.subarray(0, 4);
  if (!bytesEqual(magic, OUTER_MAGIC)) {
    throw new BadMagicError('outer', magic);
  }
  const codec = wire[4]!;
  if (codec !== CODEC_ZSTD && codec !== CODEC_GZIP) {
    throw new CorruptSnapshotError(
      `unknown codec byte 0x${codec.toString(16).padStart(2, '0')} ` +
        `(expected 0x01 zstd or 0x02 gzip per spec ch06 §2)`,
    );
  }
  for (let i = 5; i < 5 + RESERVED_BYTES; i++) {
    if (wire[i] !== 0) {
      throw new UnsupportedVersionError(
        `reserved byte at offset ${i} is 0x${wire[i]!.toString(16).padStart(2, '0')}; ` +
          `v1 readers MUST reject non-zero so v2 can repurpose — see spec ch06 §2`,
      );
    }
  }
  const innerLen = new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getUint32(8, true);
  const expected = wire.byteLength - OUTER_HEADER_LEN;
  if (innerLen !== expected) {
    throw new CorruptSnapshotError(
      `inner_len=${innerLen} does not match remaining buffer length ${expected}`,
    );
  }
  const compressed = wire.subarray(OUTER_HEADER_LEN, OUTER_HEADER_LEN + innerLen);

  // Re-prepend the codec byte so we can reuse the codec-dispatch
  // primitive in `./index.ts`. The wire format carries `codec` at
  // offset 4 (different position than the inner-codec primitive
  // expects), so we rebuild the [codec, ...compressed] shape here.
  const codecPlusCompressed = new Uint8Array(1 + compressed.byteLength);
  codecPlusCompressed[0] = codec;
  codecPlusCompressed.set(compressed, 1);
  const inner = decodeCodec(codecPlusCompressed);

  return decodeInner(inner);
}

// Re-export the codec union for callers that need to inspect/decide on
// compression algorithm before handing bytes off.
export type { Codec };
