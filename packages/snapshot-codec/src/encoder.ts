// @ccsm/snapshot-codec — SnapshotV1 encoder (xterm-headless → bytes).
//
// Spec: design-spec ch06 §2 ("Snapshot: encoding"). This module owns the
// daemon-side serialization of an `xterm-headless` Terminal into the
// FOREVER-STABLE SnapshotV1Wire byte layout:
//
//   struct SnapshotV1Wire {
//     uint8  outer_magic[4];     // "CSS1"
//     uint8  codec;              // 1 = zstd (default), 2 = gzip
//     uint8  reserved[3];        // MUST be zero in v1
//     uint32 inner_len;          // length of compressed inner payload
//     uint8  inner[inner_len];   // codec(SnapshotV1Inner)
//   }
//
//   struct SnapshotV1Inner {
//     uint8  inner_magic[4];     // "CSS1"
//     uint16 cols;
//     uint16 rows;
//     uint32 cursor_row;
//     uint32 cursor_col;
//     uint8  cursor_visible;
//     uint8  cursor_style;       // 0=block, 1=underline, 2=bar
//     uint32 scrollback_lines;
//     uint32 viewport_lines;
//     uint8  modes_bitmap[8];
//     uint32 attrs_palette_len;
//     AttrEntry attrs_palette[attrs_palette_len];
//     Line lines[scrollback_lines + viewport_lines];
//   }
//
// All multi-byte integers are little-endian (spec ch06 §2). The encoder is
// SYNCHRONOUS by design — the underlying compression dispatch
// (`./index.ts`) wraps node:zlib's sync zstd/gzip primitives. Callers may
// offload to a worker if they want event-loop isolation; that policy
// belongs to the call site, not to the codec.
//
// Design notes:
//
// 1. **Zero runtime deps on @xterm/headless.** This package is a leaf
//    library (eslint forbids `@ccsm/*` imports; we extend that discipline
//    to UI/terminal libs). The encoder accepts a structurally-typed
//    `XtermHeadlessLike` shape that matches the relevant subset of the
//    `@xterm/headless` public API — daemon code passes a real Terminal
//    instance, tests can pass a hand-built fake. The structural type is
//    explicitly compatible with `@xterm/headless`'s `IBuffer` /
//    `IBufferLine` / `IBufferCell` / `IModes` interfaces (verified by
//    importing the type in a test compile-time assertion).
//
// 2. **Determinism rules** (spec ch06 §2 "Encoder determinism rules"):
//    - `attrs_palette` is built by walking cells in canonical order
//      (scrollback oldest→newest, then viewport top→bottom; left→right
//      within a line) and appending each previously-unseen
//      `(fg_rgb, bg_rgb, flags)` tuple in order of first appearance.
//      The first cell scanned with the default attrs produces palette
//      entry 0.
//    - `modes_bitmap[8]` bit positions are FOREVER-STABLE; mapping is
//      pinned in {@link MODES_BITMAP_LAYOUT}.
//    - Grapheme combining marks are preserved per cell:
//      `Cell.codepoint` = base char codepoint; `Cell.combiners[]` = the
//      remaining UTF-32 codepoints in original sequence order. xterm's
//      `IBufferCell.getChars()` returns the full grapheme cluster string
//      for the cell; we iterate via the spread operator (Unicode-aware).
//
// 3. **Scope**: this file emits the inner bytes AND wraps them with the
//    outer header + the codec byte (via `./index.ts`'s `encode()`). T4.7
//    (decoder) lives in a sibling file and is the inverse. T4.8 owns
//    higher-level wrap/unwrap helpers if/when they're needed beyond
//    what's here.

import { encode as encodeCodec, type Codec, CODEC_ZSTD } from './index.js';

// ---------------------------------------------------------------------------
// FOREVER-STABLE constants — these are the wire format. Renumbering any
// of them invalidates every persisted snapshot. Spec ch06 §2 + ch15 §3.
// ---------------------------------------------------------------------------

/** Outer wrapper magic — ASCII "CSS1" (Ccsm Snapshot v1). */
export const OUTER_MAGIC = Uint8Array.of(0x43, 0x53, 0x53, 0x31);

/** Inner payload magic — also "CSS1"; intentional nesting per spec. */
export const INNER_MAGIC = Uint8Array.of(0x43, 0x53, 0x53, 0x31);

/** Number of reserved bytes between `codec` and `inner_len`. */
export const RESERVED_BYTES = 3;

/** Outer header total fixed-size prefix (magic + codec + reserved + inner_len). */
export const OUTER_HEADER_LEN = 4 + 1 + RESERVED_BYTES + 4; // 12

/** Cursor style enum on the wire. Spec ch06 §2. */
export const CURSOR_STYLE_BLOCK = 0 as const;
export const CURSOR_STYLE_UNDERLINE = 1 as const;
export const CURSOR_STYLE_BAR = 2 as const;
export type CursorStyle =
  | typeof CURSOR_STYLE_BLOCK
  | typeof CURSOR_STYLE_UNDERLINE
  | typeof CURSOR_STYLE_BAR;

/**
 * Default-color sentinel encoded into `AttrEntry.fg_rgb` / `bg_rgb` when
 * the source cell uses the terminal's default color (not RGB, not palette).
 *
 * Spec ch06 §2: `0xFF000001 = default`. The high byte 0xFF distinguishes
 * the sentinel from any 0xRRGGBB value (which has high byte 0x00).
 */
export const DEFAULT_COLOR_SENTINEL = 0xff000001;

/**
 * Marker for "no codepoint" in `Cell.codepoint`. Spec ch06 §2 says
 * `0 = empty`; xterm reports an empty cell as `getCode() === 0` and/or
 * `getChars() === ''`.
 */
export const EMPTY_CODEPOINT = 0;

/** Flags layout in `AttrEntry.flags` (uint16 LE). FOREVER-STABLE bit positions. */
export const FLAG_BOLD = 1 << 0;
export const FLAG_ITALIC = 1 << 1;
export const FLAG_UNDERLINE = 1 << 2;
export const FLAG_BLINK = 1 << 3;
export const FLAG_REVERSE = 1 << 4;
export const FLAG_DIM = 1 << 5;
export const FLAG_STRIKE = 1 << 6;
export const FLAG_HIDDEN = 1 << 7;

/**
 * `modes_bitmap[8]` bit→mode mapping (spec ch06 §2). Each entry is
 * `[byteIndex, bitIndex]`. FOREVER-STABLE: new modes in v0.4+ use the
 * NEXT contiguous bit; existing assignments never move.
 */
export const MODES_BITMAP_LAYOUT = {
  /** byte 0 bit 0 — DECCKM application cursor keys (`CSI ? 1 h`). */
  applicationCursor: [0, 0],
  /** byte 0 bit 1 — DECKPAM application keypad (`ESC =`). */
  applicationKeypad: [0, 1],
  /** byte 0 bit 2 — alt-screen active (`CSI ? 1049 h`). */
  altScreen: [0, 2],
  /** byte 0 bit 3 — bracketed paste (`CSI ? 2004 h`). */
  bracketedPaste: [0, 3],
  /** byte 0 bit 4 — mouse mode X10 (`CSI ? 9 h`). */
  mouseX10: [0, 4],
  /** byte 0 bit 5 — mouse mode VT200 (`CSI ? 1000 h`). */
  mouseVt200: [0, 5],
  /** byte 0 bit 6 — mouse mode any-event (`CSI ? 1003 h`). */
  mouseAnyEvent: [0, 6],
  /** byte 0 bit 7 — mouse SGR encoding (`CSI ? 1006 h`). */
  mouseSgr: [0, 7],
  /** byte 1 bit 0 — DECTCEM cursor visible (`CSI ? 25 h`). */
  cursorVisible: [1, 0],
  /** byte 1 bit 1 — focus tracking (`CSI ? 1004 h`). */
  focusTracking: [1, 1],
  /** byte 1 bit 2 — DECOM origin mode (`CSI ? 6 h`). */
  originMode: [1, 2],
  /** byte 1 bit 3 — DECAWM auto-wrap (`CSI ? 7 h`). */
  autoWrap: [1, 3],
  /** byte 1 bit 4 — reverse video (`CSI ? 5 h`). */
  reverseVideo: [1, 4],
} as const satisfies Record<string, readonly [number, number]>;

// ---------------------------------------------------------------------------
// Structural input type — matches the relevant subset of @xterm/headless's
// public API. We intentionally do NOT import @xterm/headless to keep this
// package zero-runtime-dep on UI / terminal libs (see eslint config).
// Tests verify structural compatibility with the real type at compile time.
// ---------------------------------------------------------------------------

/** Subset of `@xterm/headless` `IBufferCell` used by the encoder. */
export interface CellLike {
  getWidth(): number;
  getChars(): string;
  getCode(): number;
  getFgColor(): number;
  getBgColor(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isBold(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isDim(): number;
  isStrikethrough(): number;
  isInvisible(): number;
}

/** Subset of `@xterm/headless` `IBufferLine` used by the encoder. */
export interface LineLike {
  readonly length: number;
  readonly isWrapped: boolean;
  getCell(x: number, cell?: CellLike): CellLike | undefined;
}

/** Subset of `@xterm/headless` `IBuffer` used by the encoder. */
export interface BufferLike {
  readonly cursorX: number;
  readonly cursorY: number;
  readonly baseY: number;
  readonly length: number;
  getLine(y: number): LineLike | undefined;
  getNullCell(): CellLike;
}

/** Subset of `@xterm/headless` `IBufferNamespace` used by the encoder. */
export interface BufferNamespaceLike {
  readonly active: BufferLike;
  readonly normal: BufferLike;
  readonly alternate: BufferLike;
}

/** Subset of `@xterm/headless` `IModes` used by the encoder. */
export interface ModesLike {
  readonly applicationCursorKeysMode: boolean;
  readonly applicationKeypadMode: boolean;
  readonly bracketedPasteMode: boolean;
  readonly mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  readonly originMode: boolean;
  readonly wraparoundMode: boolean;
}

/**
 * Subset of `@xterm/headless` `Terminal` used by the encoder. The real
 * `@xterm/headless.Terminal` class satisfies this interface structurally;
 * tests exercise that compatibility.
 */
export interface XtermHeadlessLike {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: BufferNamespaceLike;
  readonly modes: ModesLike;
}

/**
 * Optional encoder configuration. Most callers will leave everything at
 * the spec defaults.
 */
export interface EncodeOptions {
  /**
   * Compression algorithm to use for the outer wrapper. Spec ch06 §2:
   * the daemon ALWAYS emits `codec = 1` (zstd) in v0.3. Tests and the
   * v0.4 web fallback may pass `CODEC_GZIP`.
   *
   * Default: `CODEC_ZSTD`.
   */
  codec?: Codec;

  /**
   * Whether the cursor is currently visible (DECTCEM). xterm-headless
   * does NOT expose this on the public IModes interface (only in the
   * internal core), so callers must thread it through from wherever
   * they tracked the `CSI ? 25 h/l` sequences.
   *
   * Default: `true` (matches xterm-headless's own default — DECTCEM is
   * "set" out of the box).
   */
  cursorVisible?: boolean;

  /**
   * Cursor visual style. xterm-headless does not expose the DECSCUSR
   * style on its public API, so callers must thread it through.
   *
   * Default: `CURSOR_STYLE_BLOCK`.
   */
  cursorStyle?: CursorStyle;

  /**
   * Whether the alternate-screen buffer is active. xterm-headless's
   * public `IBuffer.type` exposes `'normal' | 'alternate'`, so the
   * encoder can usually derive this — this option exists as an
   * override hook for tests / replay scenarios where the buffer
   * snapshot was captured separately from the mode flag.
   *
   * Default: derived from `term.buffer.active === term.buffer.alternate`.
   */
  altScreenActive?: boolean;

  /**
   * Whether reverse-video mode (`CSI ? 5 h`) is active. xterm-headless
   * does not expose this on the public IModes interface; pass
   * explicitly if your call site tracks it.
   *
   * Default: `false`.
   */
  reverseVideo?: boolean;

  /**
   * Whether focus-tracking mode (`CSI ? 1004 h`) is active. xterm-headless
   * does not expose this on the public IModes interface; pass
   * explicitly if your call site tracks it.
   *
   * Default: `false`.
   */
  focusTracking?: boolean;
}

// ---------------------------------------------------------------------------
// Inner payload writer — a minimal grow-on-demand byte buffer. We use a
// hand-rolled writer (not Buffer / not DataView slabs) so the package
// stays free of `Buffer` API dependence (Node-only) and so the encoder
// runs identically in any environment that supports `Uint8Array` +
// `node:zlib`'s sync helpers (i.e. Node 22+, the only target).
// ---------------------------------------------------------------------------

class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private off = 0;

  constructor(initialCap = 4096) {
    this.buf = new Uint8Array(initialCap);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.off + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength;
    while (cap < this.off + n) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(this.buf);
    this.buf = grown;
    this.view = new DataView(this.buf.buffer);
  }

  writeBytes(b: ArrayLike<number> & { length: number }): void {
    this.ensure(b.length);
    for (let i = 0; i < b.length; i++) this.buf[this.off + i] = b[i]!;
    this.off += b.length;
  }

  writeU8(n: number): void {
    this.ensure(1);
    this.buf[this.off++] = n & 0xff;
  }

  writeU16LE(n: number): void {
    this.ensure(2);
    this.view.setUint16(this.off, n & 0xffff, true);
    this.off += 2;
  }

  writeU32LE(n: number): void {
    this.ensure(4);
    // `setUint32` truncates to 32 bits; we mask defensively so callers
    // can't smuggle in a >2^32 codepoint and get a silently-wrong value.
    this.view.setUint32(this.off, n >>> 0, true);
    this.off += 4;
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.off);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a cell's color number into the wire-format `uint32` that goes
 * into `AttrEntry.fg_rgb` / `bg_rgb`. Spec ch06 §2:
 *   - default → 0xFF000001 sentinel
 *   - palette index N → 0x000000NN (high byte 0)
 *   - RGB 0xRRGGBB → as-is
 *
 * Palette indices and RGB are disambiguated at the decoder via the high
 * three bytes (palette is always < 256; default is 0xFF000001; RGB
 * values are 0xRRGGBB so any non-zero high byte except the sentinel is
 * RGB). The decoder side
 * (`packages/electron/src/renderer/pty/snapshot-decoder.ts`) honors this
 * convention; the test suite pins it.
 */
function colorToWireValue(
  isDefault: boolean,
  isPalette: boolean,
  isRgb: boolean,
  raw: number,
): number {
  if (isDefault) return DEFAULT_COLOR_SENTINEL;
  if (isPalette) return raw & 0xff;
  if (isRgb) return raw & 0xffffff;
  // Unknown mode — should be unreachable; default-fall-back keeps the
  // encoder total. This matches the real-world behavior where an
  // attribute-default cell may have raw=0 but no flags set.
  return DEFAULT_COLOR_SENTINEL;
}

/** Compute the uint16 attribute-flags value for a cell. */
function cellFlags(cell: CellLike): number {
  let flags = 0;
  if (cell.isBold()) flags |= FLAG_BOLD;
  if (cell.isItalic()) flags |= FLAG_ITALIC;
  if (cell.isUnderline()) flags |= FLAG_UNDERLINE;
  if (cell.isBlink()) flags |= FLAG_BLINK;
  if (cell.isInverse()) flags |= FLAG_REVERSE;
  if (cell.isDim()) flags |= FLAG_DIM;
  if (cell.isStrikethrough()) flags |= FLAG_STRIKE;
  if (cell.isInvisible()) flags |= FLAG_HIDDEN;
  return flags;
}

interface AttrTuple {
  fg: number;
  bg: number;
  flags: number;
}

function attrFromCell(cell: CellLike): AttrTuple {
  return {
    fg: colorToWireValue(cell.isFgDefault(), cell.isFgPalette(), cell.isFgRGB(), cell.getFgColor()),
    bg: colorToWireValue(cell.isBgDefault(), cell.isBgPalette(), cell.isBgRGB(), cell.getBgColor()),
    flags: cellFlags(cell),
  };
}

/** Pack `(fg, bg, flags)` into a single key string for the palette dedup map. */
function attrKey(a: AttrTuple): string {
  // 32-bit fg, 32-bit bg, 16-bit flags — pipe-separated so no two
  // distinct tuples can collide via concatenation.
  return `${a.fg.toString(16)}|${a.bg.toString(16)}|${a.flags.toString(16)}`;
}

/**
 * Extract `(base codepoint, combiner codepoints[])` from a grapheme
 * cluster string. Spec ch06 §2 "Grapheme cluster handling":
 *   - base = first scalar value
 *   - combiners = remaining scalar values in original order
 *
 * We iterate via the spread operator which yields Unicode scalar values
 * (not UTF-16 code units), so surrogate pairs (e.g. emoji) are decomposed
 * correctly.
 */
function decomposeChars(chars: string): { base: number; combiners: number[] } {
  if (chars.length === 0) return { base: EMPTY_CODEPOINT, combiners: [] };
  const cps: number[] = [];
  for (const ch of chars) cps.push(ch.codePointAt(0)!);
  const base = cps[0]!;
  const combiners = cps.slice(1);
  return { base, combiners };
}

function setBit(buf: Uint8Array, byteIdx: number, bitIdx: number): void {
  buf[byteIdx] = (buf[byteIdx] ?? 0) | (1 << bitIdx);
}

function buildModesBitmap(
  modes: ModesLike,
  altScreen: boolean,
  cursorVisible: boolean,
  reverseVideo: boolean,
  focusTracking: boolean,
): Uint8Array {
  const out = new Uint8Array(8);
  const L = MODES_BITMAP_LAYOUT;
  if (modes.applicationCursorKeysMode) setBit(out, L.applicationCursor[0], L.applicationCursor[1]);
  if (modes.applicationKeypadMode) setBit(out, L.applicationKeypad[0], L.applicationKeypad[1]);
  if (altScreen) setBit(out, L.altScreen[0], L.altScreen[1]);
  if (modes.bracketedPasteMode) setBit(out, L.bracketedPaste[0], L.bracketedPaste[1]);
  switch (modes.mouseTrackingMode) {
    case 'x10':
      setBit(out, L.mouseX10[0], L.mouseX10[1]);
      break;
    case 'vt200':
      setBit(out, L.mouseVt200[0], L.mouseVt200[1]);
      break;
    case 'drag':
      // `drag` (CSI ? 1002 h) has no dedicated bit per spec — we map it
      // to the closest equivalent (vt200) since no decoder code path
      // distinguishes them at the modes_bitmap level. New modes in
      // v0.4+ may add a dedicated bit; the existing assignment never
      // moves.
      setBit(out, L.mouseVt200[0], L.mouseVt200[1]);
      break;
    case 'any':
      setBit(out, L.mouseAnyEvent[0], L.mouseAnyEvent[1]);
      break;
    case 'none':
      break;
  }
  // mouseSgr (CSI ? 1006 h) — xterm-headless does not expose this on the
  // public IModes interface; bit reserved for callers that thread it
  // through via a higher-level encoder option in the future.
  if (cursorVisible) setBit(out, L.cursorVisible[0], L.cursorVisible[1]);
  if (focusTracking) setBit(out, L.focusTracking[0], L.focusTracking[1]);
  if (modes.originMode) setBit(out, L.originMode[0], L.originMode[1]);
  if (modes.wraparoundMode) setBit(out, L.autoWrap[0], L.autoWrap[1]);
  if (reverseVideo) setBit(out, L.reverseVideo[0], L.reverseVideo[1]);
  return out;
}

// ---------------------------------------------------------------------------
// Inner payload encoder
// ---------------------------------------------------------------------------

/**
 * Encode an xterm-headless terminal state into the SnapshotV1Inner byte
 * layout (NO outer wrapper, NO compression). Useful for tests that want
 * to inspect the inner bytes directly; production callers should use
 * {@link encodeSnapshotV1} which wraps + compresses.
 */
export function encodeInner(
  term: XtermHeadlessLike,
  options: EncodeOptions = {},
): Uint8Array {
  const cols = term.cols;
  const rows = term.rows;
  const buffer = term.buffer.active;
  const cursorX = buffer.cursorX;
  const cursorY = buffer.cursorY;
  const baseY = buffer.baseY;
  const scrollbackLines = baseY;
  const viewportLines = rows;

  const altScreenActive =
    options.altScreenActive ?? term.buffer.active === term.buffer.alternate;
  const cursorVisible = options.cursorVisible ?? true;
  const cursorStyle = options.cursorStyle ?? CURSOR_STYLE_BLOCK;
  const reverseVideo = options.reverseVideo ?? false;
  const focusTracking = options.focusTracking ?? false;

  // -------- Pass 1: walk cells in canonical order to build the palette. --------
  // Spec ch06 §2 "attrs_palette ordering": scrollback oldest→newest,
  // then viewport top→bottom; left→right within a line; first
  // appearance wins.

  interface SnapshotCell {
    codepoint: number;
    combiners: number[];
    width: number;
    attrsIndex: number;
  }
  interface SnapshotLine {
    cells: SnapshotCell[];
    wrapped: boolean;
  }

  const palette: AttrTuple[] = [];
  const paletteIndex = new Map<string, number>();
  const lineSnaps: SnapshotLine[] = [];

  // Total line count in the snapshot = scrollback + viewport. Lines
  // [0, baseY) are scrollback (oldest at 0); lines [baseY, baseY+rows)
  // are the viewport. xterm's `IBuffer.getLine(y)` uses absolute buffer
  // coords matching that layout exactly.
  const totalSnapLines = scrollbackLines + viewportLines;

  const cellRef = buffer.getNullCell();
  for (let y = 0; y < totalSnapLines; y++) {
    const line = buffer.getLine(y);
    if (!line) {
      lineSnaps.push({ cells: [], wrapped: false });
      continue;
    }
    const cells: SnapshotCell[] = [];
    // We always emit at most `cols` cells per line (or fewer if the
    // line itself is shorter — this can happen for the very last line
    // before xterm has padded it). `IBufferLine.length` equals the
    // physical width; xterm initializes it to `cols`, and resizing
    // updates it.
    const lineLen = Math.min(line.length, cols);
    for (let x = 0; x < lineLen; x++) {
      const c = line.getCell(x, cellRef);
      if (!c) {
        cells.push({
          codepoint: EMPTY_CODEPOINT,
          combiners: [],
          width: 1,
          attrsIndex: 0,
        });
        ensureDefaultPaletteEntry(palette, paletteIndex);
        continue;
      }
      const chars = c.getChars();
      const { base, combiners } = decomposeChars(chars);
      // xterm reports width=0 for the trailing half of a wide cell;
      // we preserve that as-is so the decoder can re-create the same
      // continuation-cell layout.
      const width = c.getWidth();

      const attrs = attrFromCell(c);
      const key = attrKey(attrs);
      let idx = paletteIndex.get(key);
      if (idx === undefined) {
        idx = palette.length;
        palette.push(attrs);
        paletteIndex.set(key, idx);
      }
      cells.push({
        codepoint: base,
        combiners,
        width,
        attrsIndex: idx,
      });
    }
    lineSnaps.push({ cells, wrapped: line.isWrapped });
  }

  // Pad missing lines (defensive — usually a no-op).
  while (lineSnaps.length < totalSnapLines) {
    lineSnaps.push({ cells: [], wrapped: false });
  }

  // Ensure the palette has at least one entry — empty terminals would
  // otherwise emit `attrs_palette_len = 0` AND cells with `attrs_index = 0`,
  // which is an out-of-range index.
  ensureDefaultPaletteEntry(palette, paletteIndex);

  // -------- Pass 2: serialize. --------
  const w = new ByteWriter();
  w.writeBytes(INNER_MAGIC); // 4
  w.writeU16LE(cols); // 2
  w.writeU16LE(rows); // 2
  w.writeU32LE(cursorY); // 4
  w.writeU32LE(cursorX); // 4
  w.writeU8(cursorVisible ? 1 : 0); // 1
  w.writeU8(cursorStyle); // 1
  w.writeU32LE(scrollbackLines); // 4
  w.writeU32LE(viewportLines); // 4

  const modesBitmap = buildModesBitmap(
    term.modes,
    altScreenActive,
    cursorVisible,
    reverseVideo,
    focusTracking,
  );
  w.writeBytes(modesBitmap); // 8

  w.writeU32LE(palette.length); // 4
  for (const a of palette) {
    w.writeU32LE(a.fg);
    w.writeU32LE(a.bg);
    w.writeU16LE(a.flags);
  }

  for (const ls of lineSnaps) {
    w.writeU16LE(ls.cells.length);
    for (const c of ls.cells) {
      w.writeU32LE(c.codepoint);
      w.writeU32LE(c.attrsIndex);
      w.writeU8(c.width);
      w.writeU8(c.combiners.length);
      for (const cp of c.combiners) w.writeU32LE(cp);
    }
    w.writeU8(ls.wrapped ? 1 : 0);
  }

  return w.finish();
}

function ensureDefaultPaletteEntry(
  palette: AttrTuple[],
  paletteIndex: Map<string, number>,
): void {
  if (palette.length > 0) return;
  const def: AttrTuple = {
    fg: DEFAULT_COLOR_SENTINEL,
    bg: DEFAULT_COLOR_SENTINEL,
    flags: 0,
  };
  palette.push(def);
  paletteIndex.set(attrKey(def), 0);
}

// ---------------------------------------------------------------------------
// Outer wrapper + compression
// ---------------------------------------------------------------------------

/**
 * Encode an xterm-headless terminal state into the full SnapshotV1Wire
 * byte format (outer "CSS1" magic + codec byte + reserved + inner_len +
 * compressed inner). This is what the daemon writes to
 * `pty_snapshot.payload` (spec ch07 §2) and ships on the wire inside
 * `PtySnapshot.screen_state` (spec ch04 §3).
 *
 * @param term     Source terminal — typically an `@xterm/headless`
 *                 `Terminal` instance, but any structurally-compatible
 *                 object works (tests use a hand-built fake).
 * @param options  Encoder options; see {@link EncodeOptions}.
 * @returns        SnapshotV1Wire bytes, ready to persist or transmit.
 */
export function encodeSnapshotV1(
  term: XtermHeadlessLike,
  options: EncodeOptions = {},
): Uint8Array {
  const codec = options.codec ?? CODEC_ZSTD;
  const inner = encodeInner(term, options);
  // Compress (and prepend the codec byte). We then strip that leading
  // codec byte off — `encodeCodec` returns `[codec, ...compressed]`,
  // but the SnapshotV1Wire header carries `codec` AT a different
  // offset (after the 4-byte outer magic), so we rebuild the framing.
  const codecPlusCompressed = encodeCodec(inner, codec);
  const compressed = codecPlusCompressed.subarray(1);

  const out = new Uint8Array(OUTER_HEADER_LEN + compressed.byteLength);
  out.set(OUTER_MAGIC, 0);
  out[4] = codec;
  // out[5..7] = reserved, already zero-initialized.
  // inner_len at offset 8 (uint32 LE).
  new DataView(out.buffer).setUint32(8, compressed.byteLength, true);
  out.set(compressed, OUTER_HEADER_LEN);
  return out;
}
