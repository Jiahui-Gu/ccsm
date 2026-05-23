// Property test for paste normalization (audit finding 6).
//
// Mirrors `preparePastePayload` from `src/terminal/xtermSingleton.ts`
// (introduced in PR #1303 — "fix(paste): wrap in bracketed-paste when
// active + normalize CRLF"). The production function is module-local
// (not exported), so this test re-declares the contract algorithm and
// asserts the properties the production code claims to provide. If a
// future refactor changes the algorithm in `xtermSingleton.ts`, this
// file is the executable spec and must be updated in lockstep.
//
// ccsm is a transparent transport (memory:
// project_ccsm_transparent_transport.md): the terminal pane forwards
// input to the CLI byte-for-byte. The ONLY rewrites permitted on the
// paste path are:
//
//   1. CRLF → LF and lone CR → LF normalization. PTYs interpret each
//      `\r` as Enter; without normalization a multi-line Windows
//      clipboard paste submits after every visual line.
//   2. Bracketed-paste wrapping (`\x1b[200~ … \x1b[201~`) IFF the host
//      app has DECSET 2004 active.
//
// Anything else — chunking, length caps, content-based rewriting — is
// a bug per the transport invariant. The properties below encode that
// constraint precisely.
//
// `fast-check` is not a devDep (verified against package.json on the
// branch base) and the task brief forbids adding it here, so we
// hand-roll a small biased generator that hits the failure-mode-rich
// shapes the production normalizer worried about (CRLF, CR, NUL,
// ESC, high-bit, mixed). N=1000 samples per property — enough to
// catch a shift in CRLF handling but cheap enough to keep the suite
// fast.

import { describe, it, expect } from 'vitest';

// ── Reference implementation ──────────────────────────────────────────
// VERBATIM mirror of `preparePastePayload` in
// `src/terminal/xtermSingleton.ts`. Keep these two in sync; the
// production source is the source of truth for behavior, this file is
// the source of truth for the *properties* that behavior must satisfy.
function preparePastePayload(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized;
}

// ── Hand-rolled generator ─────────────────────────────────────────────
// Deterministic mulberry32 PRNG so failures are reproducible. Seeded
// from the test name to keep failures across the suite independent.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Bag of bytes the paste path is likely to see in the wild. Biased
// hard toward CR / LF / CRLF so the normalization branches get hit;
// includes ESC and high-bit / control bytes so we exercise the
// transport invariant (no byte except \r should be rewritten).
const CHAR_BAG: string[] = [
  // CRLF / CR / LF bias — must be the dominant source of bytes so
  // mutation in the normalization regex shows up reliably.
  '\r\n', '\r\n', '\r\n',
  '\r', '\r', '\r',
  '\n', '\n', '\n',
  // ASCII text.
  'a', 'B', '0', ' ', '\t', '.', '/', ':', '-',
  // Control bytes & escape. The bracketed-paste sentinels are intentionally
  // NOT in the bag — a generated input that happens to start with `\x1b[200~`
  // would (correctly) fail the "plain output has no leading sentinel" check
  // for the wrong reason. Embedded sentinels are exercised separately below.
  '\x00', '\x03', '\x07', '\x1b',
  // High-bit + multi-byte (UTF-16 surrogate handling sanity).
  'é', '中', '🙂',
];

function randString(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * (maxLen + 1));
  let s = '';
  for (let i = 0; i < len; i++) {
    s += CHAR_BAG[Math.floor(rng() * CHAR_BAG.length)];
  }
  return s;
}

function* samples(seed: number, n: number, maxLen: number): Generator<string> {
  const rng = mulberry32(seed);
  yield ''; // empty-string edge case
  yield '\r';
  yield '\n';
  yield '\r\n';
  yield '\r\r\n';
  yield '\r\n\r\n';
  yield 'a\r\nb\rc\nd';
  for (let i = 0; i < n; i++) yield randString(rng, maxLen);
}

const N = 1000;
const MAX_LEN = 64;

// ── Property helpers ──────────────────────────────────────────────────
// Strip bracketed-paste sentinels for the "preserve all non-CRLF
// bytes" property — the sentinels are the one rewrite the transport
// invariant explicitly permits, so they don't count against
// preservation.
function stripBracketed(s: string): string {
  if (s.startsWith('\x1b[200~') && s.endsWith('\x1b[201~')) {
    return s.slice('\x1b[200~'.length, s.length - '\x1b[201~'.length);
  }
  return s;
}

// "All non-line-break bytes are preserved exactly" — every byte that
// isn't a CR or LF in the input must equal every non-line-break byte in
// the output, in the same order. This is the precise transparent-transport
// property: line breaks may be reshaped (CRLF→LF, lone CR→LF inject a LF
// where the CR was), but no other content shifts, gets dropped, or gets
// duplicated.
function nonLineBreakPreserved(input: string, output: string): boolean {
  const stripLineBreaks = (s: string): string => s.replace(/[\r\n]/g, '');
  return stripLineBreaks(input) === stripLineBreaks(stripBracketed(output));
}

describe('paste-normalization properties (PR #1303)', () => {
  it('CRLF normalization is idempotent (bracketed=false)', () => {
    for (const s of samples(0x1303_a, N, MAX_LEN)) {
      const once = preparePastePayload(s, false);
      const twice = preparePastePayload(once, false);
      expect(twice).toBe(once);
    }
  });

  it('CRLF normalization is idempotent (bracketed=true, payload only)', () => {
    // When bracketed=true the second pass would re-wrap an already-
    // wrapped string. The relevant idempotence is on the inner
    // payload — strip & re-prepare.
    for (const s of samples(0x1303_b, N, MAX_LEN)) {
      const once = preparePastePayload(s, true);
      const innerOnce = stripBracketed(once);
      const innerTwice = preparePastePayload(innerOnce, false);
      expect(innerTwice).toBe(innerOnce);
    }
  });

  it('output contains no CR bytes (CRLF normalization is complete)', () => {
    for (const s of samples(0x1303_c, N, MAX_LEN)) {
      for (const bracketed of [false, true]) {
        const out = preparePastePayload(s, bracketed);
        // Note: the bracketed sentinels are ESC + '[' + digits + '~' —
        // no '\r'. So this check is invariant of wrapping.
        expect(out.includes('\r')).toBe(false);
      }
    }
  });

  it('all non-line-break input bytes are preserved (transparent transport)', () => {
    for (const s of samples(0x1303_d, N, MAX_LEN)) {
      for (const bracketed of [false, true]) {
        const out = preparePastePayload(s, bracketed);
        expect(nonLineBreakPreserved(s, out)).toBe(true);
      }
    }
  });

  it('LF count is preserved (one LF in → one LF out per original line break)', () => {
    // Every CRLF, lone CR, and lone LF in the input maps to exactly one
    // LF in the output. So total line-break count is conserved across
    // the normalization. This guards against a regression where the
    // regex collapses adjacent line breaks (e.g. "\r\r" → "\n" instead
    // of "\n\n").
    for (const s of samples(0x1303_d2, N, MAX_LEN)) {
      const out = stripBracketed(preparePastePayload(s, true));
      const inputBreaks = (s.match(/\r\n|\r|\n/g) ?? []).length;
      const outputLfs = (out.match(/\n/g) ?? []).length;
      expect(outputLfs).toBe(inputBreaks);
    }
  });

  it('no length cap is applied (transparent transport — no chunking)', () => {
    // Production must not silently truncate large pastes. Build a
    // large-but-fast string (~1 MB) and assert the output (minus
    // wrapping, minus CR removal) matches.
    const big = 'x'.repeat(1024 * 1024); // 1 MB, no CR/LF — no rewrite
    const outPlain = preparePastePayload(big, false);
    expect(outPlain.length).toBe(big.length);
    const outWrapped = preparePastePayload(big, true);
    expect(outWrapped.length).toBe(big.length + '\x1b[200~'.length + '\x1b[201~'.length);
  });

  it('bracketed wrapping is added IFF requested and never partially', () => {
    for (const s of samples(0x1303_e, 200, MAX_LEN)) {
      const wrapped = preparePastePayload(s, true);
      const plain = preparePastePayload(s, false);
      // Wrapped output starts with DCS 200~ and ends with 201~ ALWAYS,
      // even for empty input (so claude/Ink sees a paste boundary).
      expect(wrapped.startsWith('\x1b[200~')).toBe(true);
      expect(wrapped.endsWith('\x1b[201~')).toBe(true);
      // Plain output has no sentinels at the boundary.
      expect(plain.startsWith('\x1b[200~')).toBe(false);
      // Stripping wrap on wrapped must equal plain output.
      expect(stripBracketed(wrapped)).toBe(plain);
    }
  });

  it('embedded bracketed-paste sentinels in input are NOT escaped (transparent transport)', () => {
    // If the production code ever started escaping embedded sentinels it
    // would silently corrupt content. The transport invariant says only
    // CR is touched — verify by feeding sentinel-containing input.
    const input = 'before\x1b[200~middle\x1b[201~after';
    expect(preparePastePayload(input, false)).toBe(input);
    expect(preparePastePayload(input, true)).toBe(`\x1b[200~${input}\x1b[201~`);
  });
});
