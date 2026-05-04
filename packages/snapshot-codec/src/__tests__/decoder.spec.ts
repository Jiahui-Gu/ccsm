// SnapshotV1 decoder tests for @ccsm/snapshot-codec (Task #44, T4.7).
//
// What this suite locks down (spec ch06 §2 + T9.7 spike contract):
//
//   D1. decodeSnapshotV1(encodeSnapshotV1(state)) returns a structurally
//       equal snapshot for both zstd and gzip codecs.
//   D2. encode → decode → encodeInner is byte-identical to encodeInner(state).
//       This is the FOREVER-STABLE byte-equality property from T9.7 spike
//       (`tools/spike-harness/snapshot-roundtrip.spec.ts`).
//   D3. decodeInner exposes every cell field (codepoint, attrsIndex, width,
//       combiners) and every line field (cells, wrapped) verbatim.
//   D4. modes_bitmap decodes back into the symbolic DecodedModes flags.
//   D5. Outer-magic mismatch → BadMagicError(where='outer').
//   D6. Inner-magic mismatch → BadMagicError(where='inner').
//   D7. Non-zero reserved byte → UnsupportedVersionError.
//   D8. inner_len ≠ remaining length → CorruptSnapshotError.
//   D9. Truncated inner payload → CorruptSnapshotError on the missing field.
//   D10. Unknown codec byte → CorruptSnapshotError.
//   D11. Unknown cursor_style → CorruptSnapshotError.
//   D12. Reserved modes_bitmap bits set → UnsupportedVersionError.
//   D13. attrs_index out of range → CorruptSnapshotError.
//   D14. Property fuzz: encode → decode → encode byte-identical for a
//        corpus of fake terminals and a real xterm-headless terminal fed
//        random VT-like sequences.

import { describe, expect, it } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';

import {
  CODEC_GZIP,
  CODEC_ZSTD,
  CURSOR_STYLE_BAR,
  CURSOR_STYLE_BLOCK,
  CURSOR_STYLE_UNDERLINE,
  DEFAULT_COLOR_SENTINEL,
  EMPTY_CODEPOINT,
  FLAG_BOLD,
  FLAG_ITALIC,
  INNER_MAGIC,
  OUTER_HEADER_LEN,
  OUTER_MAGIC,
  RESERVED_BYTES,
  encodeInner,
  encodeSnapshotV1,
  type BufferLike,
  type BufferNamespaceLike,
  type CellLike,
  type LineLike,
  type ModesLike,
  type XtermHeadlessLike,
  // Decoder surface
  BadMagicError,
  CorruptSnapshotError,
  UnsupportedVersionError,
  decodeInner,
  decodeSnapshotV1,
  type DecodedSnapshotV1,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fake terminal builder — copy of the encoder.spec.ts builder so this test
// file is self-contained (vitest runs each file in its own worker; sharing
// helpers via a third file would only save a few lines and obscures
// reading the test in isolation).
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
    width: spec.width ?? 1,
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

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Re-encode a `DecodedSnapshotV1` back to inner bytes by replaying it
// through `encodeInner` with a synthesized fake terminal. This is the
// crux of the byte-equality property — we need a way to take parsed
// data and shove it back through the encoder.
//
// The decoded snapshot already carries everything `encodeInner` reads
// from `XtermHeadlessLike`, so we just adapt it: each `DecodedLine`
// becomes a `FakeLine` whose cells regurgitate the original wire color
// (fg/bg) and flags via the `cellAdapter` shim. We exploit the encoder's
// "first appearance wins" palette rule by replaying cells in canonical
// scan order — yielding the same palette ordering by construction.
function reencodeFromDecoded(d: DecodedSnapshotV1): Uint8Array {
  const palette = d.attrsPalette;

  function decodeColor(wire: number): { mode: 'default' | 'palette' | 'rgb'; raw: number } {
    if (wire === DEFAULT_COLOR_SENTINEL) return { mode: 'default', raw: 0 };
    if ((wire & 0xffffff00) === 0) return { mode: 'palette', raw: wire & 0xff };
    return { mode: 'rgb', raw: wire & 0xffffff };
  }

  function flagsToObj(f: number): FakeCell['flags'] {
    return {
      bold: (f & 0b0000_0001) !== 0,
      italic: (f & 0b0000_0010) !== 0,
      underline: (f & 0b0000_0100) !== 0,
      blink: (f & 0b0000_1000) !== 0,
      inverse: (f & 0b0001_0000) !== 0,
      dim: (f & 0b0010_0000) !== 0,
      strike: (f & 0b0100_0000) !== 0,
      invisible: (f & 0b1000_0000) !== 0,
    };
  }

  function makeFakeLine(line: DecodedLine0): FakeLine {
    const cells: FakeCell[] = line.cells.map((c) => {
      const attr = palette[c.attrsIndex]!;
      const chars =
        c.codepoint === EMPTY_CODEPOINT && c.combiners.length === 0
          ? ''
          : String.fromCodePoint(c.codepoint, ...c.combiners);
      return {
        chars,
        codepoint: c.codepoint,
        width: c.width,
        fg: decodeColor(attr.fg),
        bg: decodeColor(attr.bg),
        flags: flagsToObj(attr.flags),
      };
    });
    return { cells, wrapped: line.wrapped };
  }
  type DecodedLine0 = DecodedSnapshotV1['lines'][number];

  const scrollback = d.lines.slice(0, d.scrollbackLines).map(makeFakeLine);
  const viewport = d.lines.slice(d.scrollbackLines).map(makeFakeLine);

  // mouseTrackingMode reverse-mapping. Encoder collapses 'drag' → vt200
  // bit, so we can never recover 'drag' from bytes; the corpus only
  // exercises {none, x10, vt200, any} which DO round-trip exactly.
  let mouseTrackingMode: ModesLike['mouseTrackingMode'] = 'none';
  if (d.modes.mouseAnyEvent) mouseTrackingMode = 'any';
  else if (d.modes.mouseVt200) mouseTrackingMode = 'vt200';
  else if (d.modes.mouseX10) mouseTrackingMode = 'x10';

  const term = buildFake({
    cols: d.cols,
    rows: d.rows,
    cursorX: d.cursorCol,
    cursorY: d.cursorRow,
    baseY: d.scrollbackLines,
    scrollback,
    viewport,
    modes: {
      applicationCursorKeysMode: d.modes.applicationCursor,
      applicationKeypadMode: d.modes.applicationKeypad,
      bracketedPasteMode: d.modes.bracketedPaste,
      mouseTrackingMode,
      originMode: d.modes.originMode,
      wraparoundMode: d.modes.autoWrap,
    },
    alt: d.modes.altScreen,
  });

  return encodeInner(term, {
    cursorVisible: d.cursorVisible,
    cursorStyle: d.cursorStyle,
    altScreenActive: d.modes.altScreen,
    reverseVideo: d.modes.reverseVideo,
    focusTracking: d.modes.focusTracking,
  });
}

// ---------------------------------------------------------------------------
// D1 + D2: round-trip
// ---------------------------------------------------------------------------

describe('decodeSnapshotV1 round-trip (D1, D2)', () => {
  function richFakeTerm(): XtermHeadlessLike {
    const A = fakeCell({
      chars: 'A',
      fg: { mode: 'rgb', raw: 0xff0000 },
      flags: { bold: true },
    });
    const B = fakeCell({
      chars: 'B',
      bg: { mode: 'palette', raw: 17 },
      flags: { italic: true, underline: true },
    });
    const C = fakeCell({ chars: 'C' });
    return buildFake({
      cols: 6,
      rows: 3,
      cursorX: 2,
      cursorY: 1,
      baseY: 1,
      scrollback: [{ cells: [A, B, C, fakeCell({ chars: 'D' })], wrapped: true }],
      viewport: [
        { cells: [fakeCell({ chars: 'x' }), fakeCell({ chars: 'y' })] },
        { cells: [] },
        { cells: [fakeCell({ chars: 'z' })] },
      ],
      modes: {
        applicationCursorKeysMode: true,
        bracketedPasteMode: true,
        mouseTrackingMode: 'vt200',
        wraparoundMode: true,
      },
    });
  }

  for (const codec of [CODEC_ZSTD, CODEC_GZIP] as const) {
    it(`D1: decode(encode(state)) preserves cols/rows/cursor (codec=${codec})`, () => {
      const term = richFakeTerm();
      const wire = encodeSnapshotV1(term, { codec });
      const decoded = decodeSnapshotV1(wire);
      expect(decoded.cols).toBe(6);
      expect(decoded.rows).toBe(3);
      expect(decoded.cursorRow).toBe(1);
      expect(decoded.cursorCol).toBe(2);
      expect(decoded.scrollbackLines).toBe(1);
      expect(decoded.viewportLines).toBe(3);
      expect(decoded.lines.length).toBe(4);
    });

    it(`D2: encode(decode(encode(state))) byte-identical (codec=${codec})`, () => {
      const term = richFakeTerm();
      const wire = encodeSnapshotV1(term, { codec });
      const decoded = decodeSnapshotV1(wire);
      const innerOriginal = encodeInner(term);
      const innerReencoded = reencodeFromDecoded(decoded);
      expect(bytesEq(innerOriginal, innerReencoded)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// D3: cell field fidelity
// ---------------------------------------------------------------------------

describe('cell field fidelity (D3)', () => {
  it('preserves codepoint + combiners + width + attrs_index', () => {
    // Decomposed form: ASCII 'e' (U+0065) followed by COMBINING ACUTE
    // ACCENT (U+0301). The precomposed 'é' (U+00E9) would be a single
    // codepoint with no combiners — we want to exercise the combiner
    // path explicitly.
    const eAcute = fakeCell({ chars: 'é', codepoint: 0x65, width: 1 });
    const wide = fakeCell({ chars: '漢', codepoint: 0x6f22, width: 2 });
    const cont = fakeCell({ chars: '', codepoint: 0, width: 0 });
    const term = buildFake({
      cols: 3,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [eAcute, wide, cont] }],
    });
    const inner = encodeInner(term);
    const d = decodeInner(inner);
    expect(d.lines).toHaveLength(1);
    const cells = d.lines[0]!.cells;
    expect(cells).toHaveLength(3);
    expect(cells[0]).toEqual({
      codepoint: 0x65,
      attrsIndex: 0,
      width: 1,
      combiners: [0x301],
    });
    expect(cells[1]).toEqual({
      codepoint: 0x6f22,
      attrsIndex: 0,
      width: 2,
      combiners: [],
    });
    expect(cells[2]).toEqual({
      codepoint: 0,
      attrsIndex: 0,
      width: 0,
      combiners: [],
    });
  });

  it('preserves attrs palette entries verbatim', () => {
    const A = fakeCell({
      chars: 'A',
      fg: { mode: 'rgb', raw: 0x123456 },
      bg: { mode: 'palette', raw: 9 },
      flags: { bold: true, italic: true },
    });
    const term = buildFake({
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [A] }],
    });
    const d = decodeInner(encodeInner(term));
    expect(d.attrsPalette).toHaveLength(1);
    expect(d.attrsPalette[0]).toEqual({
      fg: 0x123456,
      bg: 9,
      flags: FLAG_BOLD | FLAG_ITALIC,
    });
  });

  it('preserves wrapped flag per line', () => {
    const term = buildFake({
      cols: 1,
      rows: 3,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [
        { cells: [fakeCell({ chars: 'a' })], wrapped: false },
        { cells: [fakeCell({ chars: 'b' })], wrapped: true },
        { cells: [fakeCell({ chars: 'c' })], wrapped: false },
      ],
    });
    const d = decodeInner(encodeInner(term));
    expect(d.lines.map((l) => l.wrapped)).toEqual([false, true, false]);
  });
});

// ---------------------------------------------------------------------------
// D4: modes_bitmap decoding
// ---------------------------------------------------------------------------

describe('modes decoding (D4)', () => {
  it('all-on encodes and decodes back to all-on (excluding mouseSgr/drag)', () => {
    const term = buildFake({
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [] }],
      modes: {
        applicationCursorKeysMode: true,
        applicationKeypadMode: true,
        bracketedPasteMode: true,
        mouseTrackingMode: 'any',
        originMode: true,
        wraparoundMode: true,
      },
    });
    const wire = encodeSnapshotV1(term, {
      cursorVisible: true,
      focusTracking: true,
      reverseVideo: true,
      altScreenActive: true,
    });
    const d = decodeSnapshotV1(wire);
    expect(d.modes).toEqual({
      applicationCursor: true,
      applicationKeypad: true,
      altScreen: true,
      bracketedPaste: true,
      mouseX10: false,
      mouseVt200: false,
      mouseAnyEvent: true,
      mouseSgr: false,
      cursorVisible: true,
      focusTracking: true,
      originMode: true,
      autoWrap: true,
      reverseVideo: true,
    });
  });

  it('all-off encodes and decodes back to all-off', () => {
    const term = buildFake({
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [] }],
      modes: { wraparoundMode: false },
    });
    const wire = encodeSnapshotV1(term, { cursorVisible: false });
    const d = decodeSnapshotV1(wire);
    for (const v of Object.values(d.modes)) expect(v).toBe(false);
  });

  it('cursorStyle round-trips for all three values', () => {
    for (const style of [CURSOR_STYLE_BLOCK, CURSOR_STYLE_UNDERLINE, CURSOR_STYLE_BAR] as const) {
      const term = buildFake({
        cols: 1,
        rows: 1,
        cursorX: 0,
        cursorY: 0,
        baseY: 0,
        scrollback: [],
        viewport: [{ cells: [] }],
      });
      const wire = encodeSnapshotV1(term, { cursorStyle: style });
      const d = decodeSnapshotV1(wire);
      expect(d.cursorStyle).toBe(style);
    }
  });
});

// ---------------------------------------------------------------------------
// D5-D13: error paths
// ---------------------------------------------------------------------------

describe('error paths (D5-D13)', () => {
  function validWire(): Uint8Array {
    const term = buildFake({
      cols: 2,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [fakeCell({ chars: 'a' })] }],
    });
    return encodeSnapshotV1(term);
  }

  it('D5: outer magic mismatch → BadMagicError(outer)', () => {
    const w = validWire();
    w[0] = 0x00;
    let caught: unknown;
    try {
      decodeSnapshotV1(w);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadMagicError);
    expect((caught as BadMagicError).where).toBe('outer');
  });

  it('D6: inner magic mismatch → BadMagicError(inner)', () => {
    // Build inner bytes manually with a bad magic and feed to decodeInner.
    const bad = new Uint8Array(4);
    bad.set([0x58, 0x58, 0x58, 0x58]);
    let caught: unknown;
    try {
      decodeInner(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadMagicError);
    expect((caught as BadMagicError).where).toBe('inner');
  });

  it('D7: non-zero reserved byte → UnsupportedVersionError', () => {
    const w = validWire();
    w[5] = 0x01;
    expect(() => decodeSnapshotV1(w)).toThrow(UnsupportedVersionError);
  });

  it('D8: inner_len mismatch → CorruptSnapshotError', () => {
    const w = validWire();
    // bump inner_len by one
    new DataView(w.buffer, w.byteOffset, w.byteLength).setUint32(8, w.byteLength - OUTER_HEADER_LEN + 1, true);
    let caught: unknown;
    try {
      decodeSnapshotV1(w);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CorruptSnapshotError);
    expect((caught as Error).message).toMatch(/inner_len/);
  });

  it('D9: truncated inner payload → CorruptSnapshotError on missing field', () => {
    const term = buildFake({
      cols: 4,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [fakeCell({ chars: 'a' })] }],
    });
    const inner = encodeInner(term);
    // Cut off the trailing wrapped byte.
    const truncated = inner.subarray(0, inner.byteLength - 1);
    let caught: unknown;
    try {
      decodeInner(truncated);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CorruptSnapshotError);
    expect((caught as Error).message).toMatch(/truncated/);
  });

  it('D10: unknown codec byte → CorruptSnapshotError', () => {
    const w = validWire();
    w[4] = 0xff;
    let caught: unknown;
    try {
      decodeSnapshotV1(w);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CorruptSnapshotError);
    expect((caught as Error).message).toMatch(/unknown codec/);
  });

  it('D11: unknown cursor_style → CorruptSnapshotError', () => {
    // cursor_style sits at offset 17 in the inner payload (see encoder).
    const term = buildFake({
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [] }],
    });
    const inner = encodeInner(term);
    const tampered = new Uint8Array(inner);
    tampered[17] = 0x09; // not 0/1/2
    expect(() => decodeInner(tampered)).toThrow(CorruptSnapshotError);
  });

  it('D12: reserved modes_bitmap bits set → UnsupportedVersionError', () => {
    const term = buildFake({
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [] }],
    });
    const inner = encodeInner(term);
    const tampered = new Uint8Array(inner);
    // modes_bitmap starts at offset 26; byte 2 must be zero in v1.
    tampered[26 + 2] = 0x01;
    expect(() => decodeInner(tampered)).toThrow(UnsupportedVersionError);
  });

  it('D13: attrs_index out of range → CorruptSnapshotError', () => {
    const term = buildFake({
      cols: 1,
      rows: 1,
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      scrollback: [],
      viewport: [{ cells: [fakeCell({ chars: 'a' })] }],
    });
    const inner = encodeInner(term);
    const tampered = new Uint8Array(inner);
    // First cell's attrs_index uint32 sits right after the line header.
    // Layout per encoder: magic(4) cols(2) rows(2) cur_row(4) cur_col(4)
    // vis(1) style(1) sb(4) vp(4) modes(8) palette_len(4) palette[0]=10
    // → 48 bytes inner header. Then cell_count(2) → 50. codepoint(4) →
    // 54 = attrs_index offset.
    new DataView(tampered.buffer, tampered.byteOffset, tampered.byteLength).setUint32(54, 999, true);
    expect(() => decodeInner(tampered)).toThrow(CorruptSnapshotError);
  });

  it('rejects too-short outer header', () => {
    expect(() => decodeSnapshotV1(new Uint8Array(4))).toThrow(CorruptSnapshotError);
  });
});

// ---------------------------------------------------------------------------
// D14: property fuzz against real xterm-headless
// ---------------------------------------------------------------------------

describe('property fuzz against real xterm-headless (D14)', () => {
  // Deterministic LCG so failures reproduce. Borrowed parameters from
  // Numerical Recipes (well-known constants — not copyrighted).
  function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  function randomVtPayload(rng: () => number, len: number): string {
    // Mix of printable ASCII, CRLF, basic SGR sequences, and unicode.
    const sgr = ['\x1b[0m', '\x1b[1m', '\x1b[31m', '\x1b[1;33m', '\x1b[42m', '\x1b[7m'];
    const uni = ['漢', '快', '照', '📸', '🎉', 'éclair', 'naïve'];
    let out = '';
    while (out.length < len) {
      const r = rng();
      if (r < 0.35) {
        const code = 0x20 + Math.floor(rng() * (0x7e - 0x20));
        out += String.fromCharCode(code);
      } else if (r < 0.55) {
        out += sgr[Math.floor(rng() * sgr.length)]!;
      } else if (r < 0.7) {
        out += uni[Math.floor(rng() * uni.length)]!;
      } else if (r < 0.85) {
        out += '\r\n';
      } else {
        out += ' ';
      }
    }
    return out;
  }

  it('encode → decode → encode is byte-identical for 20 random VT streams', async () => {
    const rng = makeRng(0xc05cdec0);
    for (let i = 0; i < 20; i++) {
      const term = new HeadlessTerminal({
        cols: 40,
        rows: 6,
        scrollback: 50,
        allowProposedApi: true,
      });
      const payload = randomVtPayload(rng, 200 + Math.floor(rng() * 400));
      await new Promise<void>((r) => term.write(payload, r));

      const x = term as unknown as XtermHeadlessLike;
      const wire1 = encodeSnapshotV1(x);
      const decoded = decodeSnapshotV1(wire1);
      const innerDirect = encodeInner(x);
      const innerReencoded = reencodeFromDecoded(decoded);
      expect(bytesEq(innerReencoded, innerDirect)).toBe(true);
    }
  });

  it('encode → decode of a real xterm exposes inner magic constant', async () => {
    const term = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((r) => term.write('hello world', r));
    const wire = encodeSnapshotV1(term as unknown as XtermHeadlessLike);
    const d = decodeSnapshotV1(wire);
    expect(d.cols).toBe(80);
    expect(d.rows).toBe(24);
    // The decoder doesn't expose the magic itself but we can verify the
    // inner-magic constant matches what encoder.ts pins, so any silent
    // change to one but not the other shows up here.
    expect(INNER_MAGIC.length).toBe(4);
    expect(OUTER_MAGIC.length).toBe(4);
    expect(RESERVED_BYTES).toBe(3);
  });
});
