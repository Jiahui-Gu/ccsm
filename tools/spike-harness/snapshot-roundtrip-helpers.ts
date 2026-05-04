// snapshot-roundtrip-helpers.ts — shared helpers for snapshot-roundtrip.spec.ts.
//
// Spike-harness fixture pinned by spec ch14 §1.B (forever-stable contract).
// Implements the two contracts the spec verifies against the real
// `@ccsm/snapshot-codec` codec (T4.6 encoder #46 + T4.7 decoder #44, PR
// #1021 commit 82e16c1):
//
//   - decode(encode(s)) ≈ s              (semantic equality)
//   - encode(decode(encode(s))) === encode(s)  (byte equality)
//
// We intentionally keep this helper minimal — the exhaustive D14 fuzz
// already lives in `packages/snapshot-codec/src/__tests__/decoder.spec.ts`
// (real @xterm/headless terminal fed random VT streams). This spike-level
// fixture exists per ch14 §1.B as the FOREVER-STABLE contract anchor that
// downstream wiring (T9.8) targets via `vitest run tools/spike-harness/`.

import { Terminal as HeadlessTerminal } from '@xterm/headless';

import {
  DEFAULT_COLOR_SENTINEL,
  EMPTY_CODEPOINT,
  decodeSnapshotV1,
  encodeInner,
  encodeSnapshotV1,
  type BufferLike,
  type BufferNamespaceLike,
  type CellLike,
  type DecodedSnapshotV1,
  type LineLike,
  type ModesLike,
  type XtermHeadlessLike,
  // Spike harness lives outside the workspace graph, so we import the
  // codec by its source-tree path rather than the workspace alias. This
  // keeps the harness runnable via the root-level `tools/vitest.config.ts`
  // without requiring a synthetic root-package dependency. Path is
  // FOREVER-STABLE per design spec ch06 §1603.
} from '../../packages/snapshot-codec/src/index.js';

export {
  decodeSnapshotV1,
  encodeInner,
  encodeSnapshotV1,
  type DecodedSnapshotV1,
  type XtermHeadlessLike,
};

/** Byte-equality predicate — true iff `a` and `b` have identical contents. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Spin up a real `@xterm/headless` Terminal, feed it `payload`, and return
 * the (resolved) Terminal cast through the codec's structural input type.
 *
 * The cast is safe: `@xterm/headless`'s `Terminal` exposes the same
 * `cols`/`rows`/`buffer`/`modes` surface that `XtermHeadlessLike`
 * describes — encoder.spec.ts and decoder.spec.ts both rely on this.
 */
export async function buildHeadlessTerminal(opts: {
  cols: number;
  rows: number;
  scrollback?: number;
  payload?: string;
}): Promise<XtermHeadlessLike> {
  const term = new HeadlessTerminal({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback ?? 0,
    allowProposedApi: true,
  });
  if (opts.payload !== undefined && opts.payload.length > 0) {
    await new Promise<void>((resolve) => term.write(opts.payload!, resolve));
  }
  return term as unknown as XtermHeadlessLike;
}

// ---------------------------------------------------------------------------
// `reencodeFromDecoded` — re-encode a `DecodedSnapshotV1` back to inner
// bytes by replaying it through `encodeInner` with a synthesised fake
// terminal. This is the crux of the byte-equality property: parsed data
// → fake xterm shim → encoder produces identical inner bytes.
//
// Mirrors the same-named helper in decoder.spec.ts (D14 fuzz) but lives
// here so the spike-harness contract is self-contained and downstream
// T9.8 wiring can run `vitest run tools/spike-harness/` without pulling
// the codec test suite.
// ---------------------------------------------------------------------------

interface FakeCellSpec {
  chars: string;
  codepoint: number;
  width: number;
  fg: { mode: 'default' | 'palette' | 'rgb'; raw: number };
  bg: { mode: 'default' | 'palette' | 'rgb'; raw: number };
  flags: {
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

function cellAdapter(c: FakeCellSpec): CellLike {
  return {
    getWidth: () => c.width,
    getChars: () => c.chars,
    getCode: () => c.codepoint,
    getFgColor: () => c.fg.raw,
    getBgColor: () => c.bg.raw,
    isFgRGB: () => c.fg.mode === 'rgb',
    isBgRGB: () => c.bg.mode === 'rgb',
    isFgPalette: () => c.fg.mode === 'palette',
    isBgPalette: () => c.bg.mode === 'palette',
    isFgDefault: () => c.fg.mode === 'default',
    isBgDefault: () => c.bg.mode === 'default',
    isBold: () => (c.flags.bold ? 1 : 0),
    isItalic: () => (c.flags.italic ? 1 : 0),
    isUnderline: () => (c.flags.underline ? 1 : 0),
    isBlink: () => (c.flags.blink ? 1 : 0),
    isInverse: () => (c.flags.inverse ? 1 : 0),
    isDim: () => (c.flags.dim ? 1 : 0),
    isStrikethrough: () => (c.flags.strike ? 1 : 0),
    isInvisible: () => (c.flags.invisible ? 1 : 0),
  };
}

function decodeColor(wire: number): FakeCellSpec['fg'] {
  if (wire === DEFAULT_COLOR_SENTINEL) return { mode: 'default', raw: 0 };
  if ((wire & 0xffffff00) === 0) return { mode: 'palette', raw: wire & 0xff };
  return { mode: 'rgb', raw: wire & 0xffffff };
}

function flagsToObj(f: number): FakeCellSpec['flags'] {
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

export function reencodeFromDecoded(d: DecodedSnapshotV1): Uint8Array {
  const palette = d.attrsPalette;

  type FakeLine = { cells: FakeCellSpec[]; wrapped: boolean };

  function makeFakeLine(line: DecodedSnapshotV1['lines'][number]): FakeLine {
    const cells: FakeCellSpec[] = line.cells.map((c) => {
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

  const allLines = d.lines.map(makeFakeLine);
  const cols = d.cols;

  function lineAdapter(l: FakeLine): LineLike {
    return {
      length: cols,
      isWrapped: l.wrapped,
      getCell: (x) => {
        const c = l.cells[x];
        if (c === undefined) {
          return cellAdapter({
            chars: '',
            codepoint: EMPTY_CODEPOINT,
            width: 1,
            fg: { mode: 'default', raw: 0 },
            bg: { mode: 'default', raw: 0 },
            flags: {},
          });
        }
        return cellAdapter(c);
      },
    };
  }

  const buffer: BufferLike = {
    cursorX: d.cursorCol,
    cursorY: d.cursorRow,
    baseY: d.scrollbackLines,
    length: allLines.length,
    getLine: (y) => {
      const l = allLines[y];
      if (!l) return undefined;
      return lineAdapter(l);
    },
    getNullCell: () =>
      cellAdapter({
        chars: '',
        codepoint: EMPTY_CODEPOINT,
        width: 1,
        fg: { mode: 'default', raw: 0 },
        bg: { mode: 'default', raw: 0 },
        flags: {},
      }),
  };
  // mouseTrackingMode reverse-mapping. Encoder collapses 'drag' → vt200,
  // so we only ever recover {none, x10, vt200, any}; the corpus avoids
  // 'drag' so this is exact for our purposes.
  let mouseTrackingMode: ModesLike['mouseTrackingMode'] = 'none';
  if (d.modes.mouseAnyEvent) mouseTrackingMode = 'any';
  else if (d.modes.mouseVt200) mouseTrackingMode = 'vt200';
  else if (d.modes.mouseX10) mouseTrackingMode = 'x10';

  const modes: ModesLike = {
    applicationCursorKeysMode: d.modes.applicationCursor,
    applicationKeypadMode: d.modes.applicationKeypad,
    bracketedPasteMode: d.modes.bracketedPaste,
    mouseTrackingMode,
    originMode: d.modes.originMode,
    wraparoundMode: d.modes.autoWrap,
  };
  const ns: BufferNamespaceLike = {
    active: buffer,
    normal: buffer,
    alternate: d.modes.altScreen ? buffer : ({} as BufferLike),
  };
  const term: XtermHeadlessLike = { cols: d.cols, rows: d.rows, buffer: ns, modes };

  return encodeInner(term, {
    cursorVisible: d.cursorVisible,
    cursorStyle: d.cursorStyle,
    altScreenActive: d.modes.altScreen,
    reverseVideo: d.modes.reverseVideo,
    focusTracking: d.modes.focusTracking,
  });
}

/**
 * The two FOREVER-STABLE contracts as a single helper:
 *
 *   1. semantic: `decode(encode(s))` parses cleanly and reports the same
 *      cols/rows the source terminal had.
 *   2. byte-identical: re-encoding the decoded snapshot produces inner
 *      bytes byte-equal to a direct `encodeInner(s)` of the same source.
 *
 * Returns the decoded snapshot for callers that want extra assertions.
 */
export function assertRoundtrip(term: XtermHeadlessLike): DecodedSnapshotV1 {
  const wire = encodeSnapshotV1(term);
  const decoded = decodeSnapshotV1(wire);
  if (decoded.cols !== term.cols || decoded.rows !== term.rows) {
    throw new Error(
      `assertRoundtrip: semantic mismatch — source ${term.cols}x${term.rows}, ` +
        `decoded ${decoded.cols}x${decoded.rows}`,
    );
  }
  const innerDirect = encodeInner(term);
  const innerReencoded = reencodeFromDecoded(decoded);
  if (!bytesEqual(innerReencoded, innerDirect)) {
    throw new Error(
      `assertRoundtrip: byte mismatch — direct ${innerDirect.byteLength} bytes, ` +
        `re-encoded ${innerReencoded.byteLength} bytes`,
    );
  }
  return decoded;
}
