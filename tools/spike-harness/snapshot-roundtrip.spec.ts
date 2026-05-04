// snapshot-roundtrip.spec.ts — vitest property runner for SnapshotV1 codec.
//
// Spike-harness fixture pinned by spec ch14 §1.B (forever-stable contract).
// Used by ch14 §1.8 (snapshot byte-equality fuzz). Property:
//
//   For all SnapshotV1 inputs `s`:
//     decode(encode(s)) ≈ s              (semantic equality)
//     encode(decode(encode(s))) === encode(s)  (byte equality)
//
// Contract (FOREVER-STABLE — v0.4 may add cases, never rename/remove the spec):
//
//   - Test file path: tools/spike-harness/snapshot-roundtrip.spec.ts
//   - Spec name:      "SnapshotV1 round-trip"
//   - Imports the codec from packages/snapshot-codec (pinned by ch06 §1603 of
//     the design spec).
//
// STATUS: live. T4.6 encoder (#46) + T4.7 decoder (#44, PR #1021 commit
// 82e16c1) are both shipped, so this fixture now drives the real codec.
// Helper code lives in `./snapshot-roundtrip-helpers.ts`; this file owns
// the test cases. The exhaustive fuzz (random VT streams across many
// seeds) lives in `packages/snapshot-codec/src/__tests__/decoder.spec.ts`
// (D14) — this spec is the contract anchor downstream T9.8 wiring targets.

import { describe, expect, it } from 'vitest';

import {
  assertRoundtrip,
  buildHeadlessTerminal,
  bytesEqual,
  decodeSnapshotV1,
  encodeInner,
  encodeSnapshotV1,
  reencodeFromDecoded,
} from './snapshot-roundtrip-helpers.js';

describe('SnapshotV1 round-trip', () => {
  it('decode(encode(s)) is semantically equal to s', async () => {
    const term = await buildHeadlessTerminal({
      cols: 40,
      rows: 6,
      payload: 'hello \x1b[1mworld\x1b[0m\r\nline two',
    });
    const wire = encodeSnapshotV1(term);
    const decoded = decodeSnapshotV1(wire);
    expect(decoded.cols).toBe(40);
    expect(decoded.rows).toBe(6);
    // Viewport line count == rows; scrollback is 0 because nothing has
    // scrolled off in this short payload.
    expect(decoded.scrollbackLines).toBe(0);
    expect(decoded.lines.length).toBe(6);
    // Cursor advanced past "line two" (8 chars) on row 1.
    expect(decoded.cursorRow).toBe(1);
    expect(decoded.cursorCol).toBe(8);
    // Palette must include at least one bold entry from the SGR 1 we wrote.
    const hasBold = decoded.attrsPalette.some((e) => (e.flags & 0x01) !== 0);
    expect(hasBold).toBe(true);
  });

  it('encode(decode(encode(s))) is byte-identical to encode(s)', async () => {
    // Spec ch14 §1.8 corpus C2 (vt-grammar) and C3 (W1-W6 replay) drive
    // exhaustive random fuzz inside `decoder.spec.ts` D14. Here we lock
    // the byte-equality property with three representative shapes:
    //   - empty terminal (degenerate baseline)
    //   - plain ASCII with newlines (cell + line geometry)
    //   - SGR + unicode (palette + grapheme path)
    const cases = [
      { name: 'empty', payload: '' },
      { name: 'ascii', payload: 'foo\r\nbar\r\nbaz qux' },
      {
        name: 'sgr-unicode',
        payload:
          '\x1b[31mred\x1b[0m \x1b[1;42mbold-on-green\x1b[0m\r\n' +
          '漢字 naïve éclair 📸',
      },
    ];
    for (const c of cases) {
      const term = await buildHeadlessTerminal({
        cols: 40,
        rows: 6,
        scrollback: 50,
        payload: c.payload,
      });
      const wire1 = encodeSnapshotV1(term);
      const decoded = decodeSnapshotV1(wire1);
      const innerDirect = encodeInner(term);
      const innerReencoded = reencodeFromDecoded(decoded);
      expect(
        bytesEqual(innerReencoded, innerDirect),
        `case '${c.name}': inner re-encode mismatch ` +
          `(direct=${innerDirect.byteLength}B, re-encoded=${innerReencoded.byteLength}B)`,
      ).toBe(true);
    }
  });

  it('assertRoundtrip helper exposes both contracts as one call', async () => {
    const term = await buildHeadlessTerminal({
      cols: 24,
      rows: 4,
      payload: 'spike\r\nharness',
    });
    // Throws on either contract failure; returning the decoded snapshot
    // keeps the helper useful for downstream T9.8 wiring assertions.
    const decoded = assertRoundtrip(term);
    expect(decoded.cols).toBe(24);
    expect(decoded.rows).toBe(4);
  });
});
