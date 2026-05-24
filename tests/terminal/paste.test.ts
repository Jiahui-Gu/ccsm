// Focused unit tests for `preparePastePayload` in `src/terminal/paste.ts`
// (the stateless shared paste module). Complements the property suite in
// `tests/contract/paste-normalization.property.test.ts` with explicit,
// narrative test cases for each branch — the bracketed-paste on/off
// split, every line-ending variant, NUL pass-through, and the "no length
// cap" transport invariant from `project_ccsm_transparent_transport.md`.

import { describe, it, expect } from 'vitest';

import { preparePastePayload } from '../../src/terminal/paste';

const SOH = '\x1b[200~';
const EOH = '\x1b[201~';

describe('preparePastePayload — bracketed-paste branching', () => {
  it('wraps with sentinels when bracketed=true', () => {
    expect(preparePastePayload('hello', true)).toBe(`${SOH}hello${EOH}`);
  });

  it('does not wrap when bracketed=false', () => {
    expect(preparePastePayload('hello', false)).toBe('hello');
  });

  it('emits sentinels for empty input when bracketed=true (paste boundary still visible)', () => {
    // Ink-based TUIs (claude) rely on the boundary to detect "paste end";
    // an empty paste should still be marked, never collapse to "".
    expect(preparePastePayload('', true)).toBe(`${SOH}${EOH}`);
  });

  it('returns empty string for empty input when bracketed=false', () => {
    expect(preparePastePayload('', false)).toBe('');
  });
});

describe('preparePastePayload — line-ending normalization', () => {
  it('normalizes CRLF to LF', () => {
    expect(preparePastePayload('a\r\nb', false)).toBe('a\nb');
    expect(preparePastePayload('a\r\nb', true)).toBe(`${SOH}a\nb${EOH}`);
  });

  it('normalizes lone CR to LF', () => {
    expect(preparePastePayload('a\rb', false)).toBe('a\nb');
  });

  it('passes LF through unchanged', () => {
    expect(preparePastePayload('a\nb', false)).toBe('a\nb');
  });

  it('handles mixed line endings (CRLF, lone CR, LF) consistently', () => {
    const mixed = 'one\r\ntwo\rthree\nfour';
    expect(preparePastePayload(mixed, false)).toBe('one\ntwo\nthree\nfour');
  });

  it('produces no CR bytes in the output, ever', () => {
    const out = preparePastePayload('\r\r\n\r\n\r', false);
    expect(out.includes('\r')).toBe(false);
  });

  it('preserves consecutive line-break runs (\\r\\r → \\n\\n, not collapsed)', () => {
    // Regression guard: a careless regex like /(\r\n|\r|\n)+/g would
    // collapse runs into one LF, breaking visible blank lines in pastes.
    expect(preparePastePayload('\r\r', false)).toBe('\n\n');
    expect(preparePastePayload('\r\n\r\n', false)).toBe('\n\n');
  });
});

describe('preparePastePayload — transparent transport', () => {
  it('passes NUL bytes through unchanged in both modes', () => {
    const input = 'before\x00middle\x00after';
    expect(preparePastePayload(input, false)).toBe(input);
    expect(preparePastePayload(input, true)).toBe(`${SOH}${input}${EOH}`);
  });

  it('passes ESC and other control bytes through unchanged', () => {
    const input = '\x07\x03\x1b\x1f';
    expect(preparePastePayload(input, false)).toBe(input);
  });

  it('passes high-bit / multi-byte characters through unchanged', () => {
    const input = 'café 中文 🙂';
    expect(preparePastePayload(input, false)).toBe(input);
    expect(preparePastePayload(input, true)).toBe(`${SOH}${input}${EOH}`);
  });

  it('does NOT escape embedded bracketed-paste sentinels (transport invariant)', () => {
    // If production ever started escaping these, it would silently corrupt
    // any paste that happens to contain the byte sequence. The transport
    // contract says only CR is touched.
    const input = `before${SOH}middle${EOH}after`;
    expect(preparePastePayload(input, false)).toBe(input);
    expect(preparePastePayload(input, true)).toBe(`${SOH}${input}${EOH}`);
  });

  it('applies no length cap — 1 MB paste flows through (bracketed=false)', () => {
    const big = 'x'.repeat(1024 * 1024);
    const out = preparePastePayload(big, false);
    expect(out.length).toBe(big.length);
    expect(out).toBe(big);
  });

  it('applies no length cap — 1 MB paste flows through (bracketed=true)', () => {
    const big = 'x'.repeat(1024 * 1024);
    const out = preparePastePayload(big, true);
    expect(out.length).toBe(big.length + SOH.length + EOH.length);
    expect(out.startsWith(SOH)).toBe(true);
    expect(out.endsWith(EOH)).toBe(true);
  });
});
