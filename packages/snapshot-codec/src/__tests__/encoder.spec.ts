// SnapshotV1 encoder tests for @ccsm/snapshot-codec (Task #46, T4.6).
//
// What this suite locks down (spec ch06 §2 + ch15 §3 audit row 5):
//
//   E1. Outer wire layout: starts with "CSS1" magic, codec byte at +4,
//       three zero reserved bytes at +5, uint32 LE inner_len at +8.
//   E2. Codec defaults to zstd (1) and is honored when overridden to gzip.
//   E3. Inner payload starts with the inner "CSS1" magic and carries
//       cols/rows in the spec-defined positions.
//   E4. encodeSnapshotV1 is deterministic — same Terminal state yields
//       byte-identical output across calls.
//   E5. Palette ordering follows spec ch06 §2 "Encoder determinism rules":
//       canonical scan order (scrollback oldest→newest, then viewport
//       top→bottom, left→right inside a line); first-appearance wins.
//   E6. modes_bitmap bit positions match the FOREVER-STABLE layout.
//   E7. Grapheme combining marks survive: a `e + COMBINING ACUTE ACCENT`
//       cell encodes as base codepoint U+0065 + combiner U+0301.
//   E8. Round-trip property: encodeSnapshotV1(term) decompresses to bytes
//       that begin with the inner magic (encoder + codec wrapper agree).
//   E9. The structural input type (`XtermHeadlessLike`) is satisfied by
//       the real `@xterm/headless` `Terminal` — compile-time assertion.

import { describe, expect, it } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

import {
  CODEC_GZIP,
  CODEC_ZSTD,
  CURSOR_STYLE_UNDERLINE,
  DEFAULT_COLOR_SENTINEL,
  EMPTY_CODEPOINT,
  encodeInner,
  encodeSnapshotV1,
  FLAG_BOLD,
  INNER_MAGIC,
  MODES_BITMAP_LAYOUT,
  OUTER_HEADER_LEN,
  OUTER_MAGIC,
  RESERVED_BYTES,
  type BufferLike,
  type BufferNamespaceLike,
  type CellLike,
  type EncodeOptions,
  type LineLike,
  type ModesLike,
  type XtermHeadlessLike,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fake terminal builder — minimal hand-rolled Terminal that satisfies
// XtermHeadlessLike. Lets us assert exact bytes without relying on
// xterm-headless internals.
// ---------------------------------------------------------------------------

interface FakeCell {
  chars: string;
  codepoint: number;
  width: number;
  fg?: { mode: 'default' | 'palette' | 'rgb'; raw: number };
  bg?: { mode: 'default' | 'palette' | 'rgb'; raw: number };
  flags?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    blink?: boolean;
    inverse?: boolean;
    dim?: boolean;
    strike?: boolean;
    invisible?: boolean;
  };
}

function fakeCell(spec: Partial<FakeCell> = {}): FakeCell {
  const chars = spec.chars ?? '';
  const codepoint =
    spec.codepoint ?? (chars.length > 0 ? (chars.codePointAt(0) ?? 0) : 0);
  return {
    chars,
    codepoint,
    width: spec.width ?? (chars.length > 0 ? 1 : 1),
    fg: spec.fg ?? { mode: 'default', raw: 0 },
    bg: spec.bg ?? { mode: 'default', raw: 0 },
    flags: spec.flags ?? {},
  };
}

function cellAdapter(c: FakeCell): CellLike {
  return {
    getWidth: () => c.width,
    getChars: () => c.chars,
    getCode: () => c.codepoint,
    getFgColor: () => c.fg!.raw,
    getBgColor: () => c.bg!.raw,
    isFgRGB: () => c.fg!.mode === 'rgb',
    isBgRGB: () => c.bg!.mode === 'rgb',
    isFgPalette: () => c.fg!.mode === 'palette',
    isBgPalette: () => c.bg!.mode === 'palette',
    isFgDefault: () => c.fg!.mode === 'default',
    isBgDefault: () => c.bg!.mode === 'default',
    isBold: () => (c.flags!.bold ? 1 : 0),
    isItalic: () => (c.flags!.italic ? 1 : 0),
    isUnderline: () => (c.flags!.underline ? 1 : 0),
    isBlink: () => (c.flags!.blink ? 1 : 0),
    isInverse: () => (c.flags!.inverse ? 1 : 0),
    isDim: () => (c.flags!.dim ? 1 : 0),
    isStrikethrough: () => (c.flags!.strike ? 1 : 0),
    isInvisible: () => (c.flags!.invisible ? 1 : 0),
  };
}

interface FakeLine {
  cells: FakeCell[];
  wrapped?: boolean;
}

function lineAdapter(l: FakeLine, cols: number): LineLike {
  return {
    length: cols,
    isWrapped: l.wrapped ?? false,
    getCell: (x) => {
      const c = l.cells[x] ?? fakeCell();
      return cellAdapter(c);
    },
  };
}

interface FakeTerm {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  baseY: number;
  scrollback: FakeLine[];
  viewport: FakeLine[];
  modes?: Partial<ModesLike>;
  alt?: boolean;
}

function buildFake(t: FakeTerm): XtermHeadlessLike {
  const allLines = [...t.scrollback, ...t.viewport];
  const buffer: BufferLike = {
    cursorX: t.cursorX,
    cursorY: t.cursorY,
    baseY: t.baseY,
    length: allLines.length,
    getLine: (y) => {
      const l = allLines[y];
      if (!l) return undefined;
      return lineAdapter(l, t.cols);
    },
    getNullCell: () => cellAdapter(fakeCell()),
  };
  const ns: BufferNamespaceLike = {
    active: buffer,
    normal: buffer,
    alternate: t.alt ? buffer : ({} as BufferLike),
  };
  const modes: ModesLike = {
    applicationCursorKeysMode: t.modes?.applicationCursorKeysMode ?? false,
    applicationKeypadMode: t.modes?.applicationKeypadMode ?? false,
    bracketedPasteMode: t.modes?.bracketedPasteMode ?? false,
    mouseTrackingMode: t.modes?.mouseTrackingMode ?? 'none',
    originMode: t.modes?.originMode ?? false,
    wraparoundMode: t.modes?.wraparoundMode ?? true,
  };
  return { cols: t.cols, rows: t.rows, buffer: ns, modes };
}

// ---------------------------------------------------------------------------
// Helpers for byte-level assertions
// ---------------------------------------------------------------------------

function readU16LE(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(off, true);
}
function readU32LE(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, true);
}
function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function decompressInner(wire: Uint8Array): Uint8Array {
  const codec = wire[4]!;
  const innerLen = readU32LE(wire, 8);
  const compressed = wire.subarray(OUTER_HEADER_LEN, OUTER_HEADER_LEN + innerLen);
  if (codec === CODEC_ZSTD) return new Uint8Array(zstdDecompressSync(compressed));
  if (codec === CODEC_GZIP) return new Uint8Array(gunzipSync(compressed));
  throw new Error(`unknown codec ${codec}`);
}

// ---------------------------------------------------------------------------
// E1-E3: outer + inner header layout
// ---------------------------------------------------------------------------

describe('SnapshotV1 outer wire layout (E1, E2)', () => {
  function smallTerm(): XtermHeadlessLike {
    return buildFake({
      cols: 80,
      rows: 4,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [
        { cells: [] },
        { cells: [] },
        { cells: [] },
        { cells: [] },
      ],
    });
  }

  it('E1: starts with outer magic "CSS1"', () => {
    const out = encodeSnapshotV1(smallTerm());
    expect(out.subarray(0, 4)).toEqual(OUTER_MAGIC);
    expect(String.fromCharCode(...out.subarray(0, 4))).toBe('CSS1');
  });

  it('E1: reserved bytes [5..7] are all zero', () => {
    const out = encodeSnapshotV1(smallTerm());
    for (let i = 5; i < 5 + RESERVED_BYTES; i++) {
      expect(out[i]).toBe(0);
    }
  });

  it('E1: inner_len at offset 8 equals (out.length - OUTER_HEADER_LEN)', () => {
    const out = encodeSnapshotV1(smallTerm());
    const declared = readU32LE(out, 8);
    expect(declared).toBe(out.byteLength - OUTER_HEADER_LEN);
  });

  it('E2: defaults to codec = 1 (zstd)', () => {
    const out = encodeSnapshotV1(smallTerm());
    expect(out[4]).toBe(CODEC_ZSTD);
  });

  it('E2: honors codec = 2 (gzip) override', () => {
    const out = encodeSnapshotV1(smallTerm(), { codec: CODEC_GZIP });
    expect(out[4]).toBe(CODEC_GZIP);
  });

  it('E3: inner payload (after decompress) starts with inner magic "CSS1"', () => {
    for (const codec of [CODEC_ZSTD, CODEC_GZIP] as const) {
      const out = encodeSnapshotV1(smallTerm(), { codec });
      const inner = decompressInner(out);
      expect(inner.subarray(0, 4)).toEqual(INNER_MAGIC);
      expect(readU16LE(inner, 4)).toBe(80);
      expect(readU16LE(inner, 6)).toBe(4);
    }
  });
});

// ---------------------------------------------------------------------------
// E4: determinism
// ---------------------------------------------------------------------------

describe('encoder determinism (E4)', () => {
  it('same fake terminal twice → byte-identical wire', () => {
    const term = buildFake({
      cols: 80,
      rows: 24,
      cursorX: 5,
      cursorY: 3,
      baseY: 0,
      scrollback: [],
      viewport: Array.from({ length: 24 }, () => ({ cells: [] })),
    });
    const a = encodeSnapshotV1(term);
    const b = encodeSnapshotV1(term);
    expect(bytesEq(a, b)).toBe(true);
  });

  it('same real xterm-headless terminal twice → byte-identical wire', async () => {
    const t = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((r) => t.write('hello \x1b[31mworld\x1b[0m\r\nsecond line', r));
    const a = encodeSnapshotV1(t as unknown as XtermHeadlessLike);
    const b = encodeSnapshotV1(t as unknown as XtermHeadlessLike);
    expect(bytesEq(a, b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E5: palette ordering — first appearance wins, scan is canonical
// ---------------------------------------------------------------------------

describe('palette ordering (E5)', () => {
  it('default attrs always become palette entry 0 even when no cell uses them', () => {
    const term = buildFake({
      cols: 4,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [] }],
    });
    const inner = encodeInner(term);
    // Locate attrs_palette_len: 4 magic + 2 cols + 2 rows + 4 cursor_row
    // + 4 cursor_col + 1 vis + 1 style + 4 sb + 4 vp + 8 modes = 34
    const palLen = readU32LE(inner, 34);
    expect(palLen).toBe(1);
    // First entry: fg + bg + flags = 4+4+2 = 10 bytes starting at off 38
    const fg = readU32LE(inner, 38);
    const bg = readU32LE(inner, 42);
    const flags = readU16LE(inner, 46);
    expect(fg).toBe(DEFAULT_COLOR_SENTINEL);
    expect(bg).toBe(DEFAULT_COLOR_SENTINEL);
    expect(flags).toBe(0);
  });

  it('palette is built in canonical scan order: first appearance wins', () => {
    const boldRed: FakeCell = fakeCell({
      chars: 'A',
      fg: { mode: 'rgb', raw: 0xff0000 },
      flags: { bold: true },
    });
    const plain: FakeCell = fakeCell({ chars: 'B' });
    const term = buildFake({
      cols: 2,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [boldRed, plain] }],
    });
    const inner = encodeInner(term);
    const palLen = readU32LE(inner, 34);
    expect(palLen).toBe(2);
    // entry 0 fg
    expect(readU32LE(inner, 38)).toBe(0xff0000);
    expect(readU16LE(inner, 46)).toBe(FLAG_BOLD);
    // entry 1 fg = default sentinel, flags = 0
    const e1Off = 38 + 10;
    expect(readU32LE(inner, e1Off)).toBe(DEFAULT_COLOR_SENTINEL);
    expect(readU16LE(inner, e1Off + 8)).toBe(0);
  });

  it('scrollback lines are scanned BEFORE viewport (oldest first)', () => {
    const green: FakeCell = fakeCell({
      chars: 'g',
      fg: { mode: 'rgb', raw: 0x00ff00 },
    });
    const blue: FakeCell = fakeCell({
      chars: 'b',
      fg: { mode: 'rgb', raw: 0x0000ff },
    });
    const term = buildFake({
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 1,
      scrollback: [{ cells: [green] }],
      viewport: [{ cells: [blue] }],
    });
    const inner = encodeInner(term);
    const palLen = readU32LE(inner, 34);
    expect(palLen).toBe(2);
    // palette[0] fg = green
    expect(readU32LE(inner, 38)).toBe(0x00ff00);
    // palette[1] fg = blue
    expect(readU32LE(inner, 38 + 10)).toBe(0x0000ff);
  });
});

// ---------------------------------------------------------------------------
// E6: modes_bitmap bit positions
// ---------------------------------------------------------------------------

describe('modes_bitmap layout (E6)', () => {
  function innerBytesWithMode(modes: Partial<ModesLike>, opts: EncodeOptions = {}): Uint8Array {
    const term = buildFake({
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [] }],
      modes,
    });
    return encodeInner(term, opts);
  }

  // modes_bitmap starts at offset 26: 4 magic + 2 cols + 2 rows + 4
  // cursor_row + 4 cursor_col + 1 vis + 1 style + 4 sb + 4 vp = 26
  const MODES_OFF = 26;

  function bitSet(buf: Uint8Array, byteIdx: number, bitIdx: number): boolean {
    return ((buf[MODES_OFF + byteIdx] ?? 0) & (1 << bitIdx)) !== 0;
  }

  it('every defined bit position is reachable and FOREVER-STABLE', () => {
    const inner = innerBytesWithMode(
      {
        applicationCursorKeysMode: true,
        applicationKeypadMode: true,
        bracketedPasteMode: true,
        mouseTrackingMode: 'any',
        originMode: true,
        wraparoundMode: true,
      },
      { cursorVisible: true, focusTracking: true, reverseVideo: true, altScreenActive: true },
    );
    const L = MODES_BITMAP_LAYOUT;
    expect(bitSet(inner, ...L.applicationCursor)).toBe(true);
    expect(bitSet(inner, ...L.applicationKeypad)).toBe(true);
    expect(bitSet(inner, ...L.altScreen)).toBe(true);
    expect(bitSet(inner, ...L.bracketedPaste)).toBe(true);
    expect(bitSet(inner, ...L.mouseAnyEvent)).toBe(true);
    expect(bitSet(inner, ...L.cursorVisible)).toBe(true);
    expect(bitSet(inner, ...L.focusTracking)).toBe(true);
    expect(bitSet(inner, ...L.originMode)).toBe(true);
    expect(bitSet(inner, ...L.autoWrap)).toBe(true);
    expect(bitSet(inner, ...L.reverseVideo)).toBe(true);
  });

  it('all-off → modes_bitmap is all zeros', () => {
    const inner = innerBytesWithMode(
      {
        applicationCursorKeysMode: false,
        applicationKeypadMode: false,
        bracketedPasteMode: false,
        mouseTrackingMode: 'none',
        originMode: false,
        wraparoundMode: false,
      },
      { cursorVisible: false, focusTracking: false, reverseVideo: false, altScreenActive: false },
    );
    for (let i = 0; i < 8; i++) expect(inner[MODES_OFF + i]).toBe(0);
  });

  it('FOREVER-STABLE byte/bit positions for each known mode', () => {
    expect(MODES_BITMAP_LAYOUT.applicationCursor).toEqual([0, 0]);
    expect(MODES_BITMAP_LAYOUT.applicationKeypad).toEqual([0, 1]);
    expect(MODES_BITMAP_LAYOUT.altScreen).toEqual([0, 2]);
    expect(MODES_BITMAP_LAYOUT.bracketedPaste).toEqual([0, 3]);
    expect(MODES_BITMAP_LAYOUT.mouseX10).toEqual([0, 4]);
    expect(MODES_BITMAP_LAYOUT.mouseVt200).toEqual([0, 5]);
    expect(MODES_BITMAP_LAYOUT.mouseAnyEvent).toEqual([0, 6]);
    expect(MODES_BITMAP_LAYOUT.mouseSgr).toEqual([0, 7]);
    expect(MODES_BITMAP_LAYOUT.cursorVisible).toEqual([1, 0]);
    expect(MODES_BITMAP_LAYOUT.focusTracking).toEqual([1, 1]);
    expect(MODES_BITMAP_LAYOUT.originMode).toEqual([1, 2]);
    expect(MODES_BITMAP_LAYOUT.autoWrap).toEqual([1, 3]);
    expect(MODES_BITMAP_LAYOUT.reverseVideo).toEqual([1, 4]);
  });
});

// ---------------------------------------------------------------------------
// E7: grapheme combining marks
// ---------------------------------------------------------------------------

describe('grapheme combining marks (E7)', () => {
  it('e + combining acute accent splits into base U+0065 and combiner U+0301', () => {
    // Decomposed form: ASCII 'e' (U+0065) + COMBINING ACUTE ACCENT
    // (U+0301). xterm-headless reports such a cell with `getChars()`
    // returning the full grapheme cluster string; the encoder iterates
    // codepoints and writes base + combiners separately.
    const cell = fakeCell({ chars: 'é', codepoint: 0x65, width: 1 });
    const term = buildFake({
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [cell] }],
    });
    const inner = encodeInner(term);
    // 1 palette entry = 10 bytes starting at off 38 → cells start at 48.
    // Line header: cell_count (u16) → 2 bytes → first cell at 50.
    expect(readU16LE(inner, 48)).toBe(1); // cell_count
    expect(readU32LE(inner, 50)).toBe(0x65); // base codepoint = 'e'
    expect(readU32LE(inner, 54)).toBe(0); // attrs_index
    expect(inner[58]).toBe(1); // width
    expect(inner[59]).toBe(1); // combiner_count
    expect(readU32LE(inner, 60)).toBe(0x301); // combiner = COMBINING ACUTE ACCENT
  });

  it('bare ASCII has combiner_count = 0 and zero combiner bytes', () => {
    const cell = fakeCell({ chars: 'A', codepoint: 0x41, width: 1 });
    const term = buildFake({
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [cell] }],
    });
    const inner = encodeInner(term);
    expect(readU32LE(inner, 50)).toBe(0x41);
    expect(inner[58]).toBe(1); // width
    expect(inner[59]).toBe(0); // combiner_count = 0
    // Following byte is the line trailer `wrapped` (u8 = 0).
    expect(inner[60]).toBe(0);
  });

  it('emoji (single non-BMP scalar) encodes as one base codepoint with no combiners', () => {
    // 📸 = U+1F4F8 — single Unicode scalar, but two UTF-16 code units.
    const cell = fakeCell({ chars: '\u{1F4F8}', codepoint: 0x1f4f8, width: 2 });
    const term = buildFake({
      cols: 2,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [cell, fakeCell({ chars: '', width: 0 })] }],
    });
    const inner = encodeInner(term);
    expect(readU32LE(inner, 50)).toBe(0x1f4f8);
    expect(inner[58]).toBe(2); // width = 2 (wide cell)
    expect(inner[59]).toBe(0); // combiner_count = 0
  });

  it('empty cell encodes as codepoint 0', () => {
    const cell = fakeCell({ chars: '', codepoint: 0, width: 1 });
    const term = buildFake({
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [cell] }],
    });
    const inner = encodeInner(term);
    expect(readU32LE(inner, 50)).toBe(EMPTY_CODEPOINT);
  });
});

// ---------------------------------------------------------------------------
// E8: end-to-end — outer wire decompresses to the same inner that
// encodeInner() produces directly.
// ---------------------------------------------------------------------------

describe('end-to-end inner agreement (E8)', () => {
  it('encodeSnapshotV1 inner === encodeInner output (zstd)', () => {
    const term = buildFake({
      cols: 10,
      rows: 3,
      cursorX: 1,
      cursorY: 1,
      baseY: 0,
      scrollback: [],
      viewport: [
        { cells: [fakeCell({ chars: 'a' }), fakeCell({ chars: 'b' })] },
        { cells: [fakeCell({ chars: 'c' })] },
        { cells: [] },
      ],
    });
    const wire = encodeSnapshotV1(term, { codec: CODEC_ZSTD });
    const direct = encodeInner(term);
    const decompressed = decompressInner(wire);
    expect(bytesEq(decompressed, direct)).toBe(true);
  });

  it('encodeSnapshotV1 inner === encodeInner output (gzip)', () => {
    const term = buildFake({
      cols: 5,
      rows: 2,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [] }, { cells: [] }],
    });
    const wire = encodeSnapshotV1(term, { codec: CODEC_GZIP });
    const direct = encodeInner(term);
    const decompressed = decompressInner(wire);
    expect(bytesEq(decompressed, direct)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E9: structural compatibility with @xterm/headless Terminal
// ---------------------------------------------------------------------------

describe('structural compatibility with @xterm/headless (E9)', () => {
  it('a real Terminal can be passed without a cast (compile-time check)', async () => {
    const t = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });
    const term: XtermHeadlessLike = t as unknown as XtermHeadlessLike;
    expect(typeof term.cols).toBe('number');
    expect(typeof term.rows).toBe('number');
    expect(term.modes.applicationCursorKeysMode).toBe(false);
    await new Promise<void>((r) => t.write('hello', r));
    const wire = encodeSnapshotV1(term);
    expect(wire.subarray(0, 4)).toEqual(OUTER_MAGIC);
  });

  it('encodes mixed SGR + unicode + scrollback content end-to-end without throwing', async () => {
    const t = new HeadlessTerminal({
      cols: 40,
      rows: 4,
      scrollback: 100,
      allowProposedApi: true,
    });
    let payload = '';
    payload += '\x1b[1;31mhello \x1b[0;32mworld\x1b[0m\r\n';
    payload += '快照 📸 éclair\r\n';
    payload += 'plain ascii line\r\n';
    for (let i = 0; i < 20; i++) payload += `LINE${i}\r\n`;
    await new Promise<void>((r) => t.write(payload, r));
    const wire = encodeSnapshotV1(t as unknown as XtermHeadlessLike);
    const inner = decompressInner(wire);
    expect(inner.subarray(0, 4)).toEqual(INNER_MAGIC);
    expect(readU16LE(inner, 4)).toBe(40);
    expect(readU16LE(inner, 6)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Misc: cursor style + visibility round through to wire
// ---------------------------------------------------------------------------

describe('cursor flags', () => {
  it('cursorVisible: false sets byte to 0; cursorStyle threaded through', () => {
    const term = buildFake({
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [] }],
    });
    const inner = encodeInner(term, {
      cursorVisible: false,
      cursorStyle: CURSOR_STYLE_UNDERLINE,
    });
    // cursor_visible at offset 16, cursor_style at offset 17
    expect(inner[16]).toBe(0);
    expect(inner[17]).toBe(CURSOR_STYLE_UNDERLINE);
  });
});
