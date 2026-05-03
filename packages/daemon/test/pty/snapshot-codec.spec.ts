// packages/daemon/test/pty/snapshot-codec.spec.ts
//
// T10.8 — SnapshotV1 outer-wrapper / codec lock-spec.
//
// Forever-stable enforcement of design-spec ch15 §3 #5:
//
//   "5. Changing the SnapshotV1 binary layout fields/order; the format is
//   `schema_version == 1` and frozen. _Mechanism: `pty/snapshot-codec.spec.ts`
//   + a checked-in golden binary at `packages/daemon/test/fixtures/snapshot-v1-golden.bin`;
//   encoder MUST round-trip the golden byte-for-byte for both `codec=1` (zstd)
//   and `codec=2` (gzip) — Chapter 06 §2."
//
// And ch15 §3 #21:
//
//   "21. v0.4 (or v0.3.x) MUST NOT bump SnapshotV1 `schema_version` to add
//   compression; compression already ships in v1 via the `codec` byte
//   (1=zstd, 2=gzip) — Chapter 06 §2. New codec values are added inside
//   the open enum on the `codec` byte; `schema_version=2` is reserved
//   for genuine inner-layout changes only."
//
// What this spec locks (FOREVER-STABLE in v0.3 and forward):
//   L1. Outer wrapper magic === ASCII "CSS1" (4 bytes 0x43 0x53 0x53 0x31).
//   L2. `codec` byte enum:
//         CODEC_ZSTD = 1 (default; daemon ALWAYS emits this in v0.3)
//         CODEC_GZIP = 2 (browser-DecompressionStream fallback)
//       No other codec value exists in v0.3. Open-enum rules (ch15 §3 #21)
//       allow v0.4+ to add new values inside the byte; v0.3 rejects unknown
//       codec values.
//   L3. `reserved` is exactly 3 bytes, each MUST be 0x00 in v1; readers
//       MUST reject non-zero (so v2 can repurpose them).
//   L4. `inner_len` is little-endian uint32 immediately after `reserved`.
//   L5. `inner` is exactly `inner_len` bytes of codec-compressed payload.
//   L6. Both codecs MUST decompress to the SAME canonical
//       `SnapshotV1Inner` byte layout (forever-stable inner is independent
//       of which compression wrapper carried it).
//   L7. The checked-in golden file at
//       `packages/daemon/test/fixtures/snapshot-v1-golden.bin` MUST
//       round-trip byte-identically through both codecs (encode then
//       decode then re-encode produces the same bytes).
//
// What this spec does NOT do yet (deferred to T4.6 / T4.7 / T4.8):
//   - Round-trip via the production encoder — Task #46 owns
//     `packages/snapshot-codec/src/encoder.ts`. When that lands, the
//     `it.todo` blocks below flip to real assertions that import the
//     encoder and assert byte-equality with the canonical inner buffer
//     defined here.
//   - Round-trip via the production decoder — Task #44 owns
//     `packages/snapshot-codec/src/decoder.ts`.
//   - Codec wrapper helpers — Task #52 owns the zstd + gzip
//     wrap/unwrap functions; this spec inlines the equivalent logic
//     (with no new dependency: Node's built-in `node:zlib` already
//     ships `zstdCompressSync` / `gzipSync` in Node 22+).
//
// Why we can write the lock-spec BEFORE the production code:
//   The lock contract is a property of the WIRE FORMAT, not of any
//   particular implementation. The spec specifies the bytes; this test
//   asserts the bytes. The production encoder must satisfy these bytes
//   (that's the whole point of a lock-spec). When the encoder lands, it
//   either matches the golden — green — or it doesn't, and the diff
//   tells the encoder author exactly which byte to fix.
//
// Why the golden file ships in this PR (not later when T4.6 lands):
//   ch15 §3 #5 names the golden path explicitly; the audit row's
//   "Mechanism" demands a checked-in fixture. Without the file, the
//   forbidden-pattern row has no test backing and the audit chapter
//   becomes unfalsifiable. Generating the golden now uses only the
//   spec text (no production encoder) so the binary IS the spec.

import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gunzipSync,
  gzipSync,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib';

import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = resolve(__dirname, '..', 'fixtures');
const GOLDEN_PATH = join(FIXTURES_DIR, 'snapshot-v1-golden.bin');

// ---------------------------------------------------------------------------
// Spec constants — these MUST match design-spec ch06 §2 byte-for-byte.
// ---------------------------------------------------------------------------

/** Outer wrapper magic — "CSS1" (Ccsm Snapshot v1). */
const OUTER_MAGIC = Buffer.from('CSS1', 'ascii');

/** Inner payload magic — also "CSS1"; intentional nesting per spec. */
const INNER_MAGIC = Buffer.from('CSS1', 'ascii');

/**
 * Codec byte values — forever-stable per ch06 §2 + ch15 §3 #21.
 * Open enum: v0.4+ may add new values inside the byte (e.g. 3, 4, ...)
 * without bumping `schema_version`. v0.3 ships exactly these two.
 */
const CODEC_ZSTD = 1 as const;
const CODEC_GZIP = 2 as const;

/** Set of codec byte values defined in v0.3. */
const V03_CODECS = [CODEC_ZSTD, CODEC_GZIP] as const;

/** Number of reserved bytes between `codec` and `inner_len`. */
const RESERVED_BYTES = 3;

/** Outer header total fixed-size prefix (magic + codec + reserved + inner_len). */
const OUTER_HEADER_LEN = 4 + 1 + RESERVED_BYTES + 4; // 12

// ---------------------------------------------------------------------------
// Canonical inner payload — minimal SnapshotV1Inner per ch06 §2.
//
// Represents an empty 80x24 terminal: no scrollback, default cursor at
// (0,0) visible block style, no modes set, empty palette, and 24
// empty viewport lines (cell_count=0, wrapped=0).
//
// Field order MUST match the struct definition in spec ch06 §2 exactly:
//   inner_magic[4] = "CSS1"
//   cols  : u16 LE = 80
//   rows  : u16 LE = 24
//   cursor_row : u32 LE = 0
//   cursor_col : u32 LE = 0
//   cursor_visible : u8 = 1
//   cursor_style   : u8 = 0 (block)
//   scrollback_lines : u32 LE = 0
//   viewport_lines   : u32 LE = 24
//   modes_bitmap[8] = all zero (no modes active)
//   attrs_palette_len : u32 LE = 0
//   attrs_palette[0]  = (empty)
//   lines[24] each = { cell_count: u16 LE = 0; cells[0] = (empty); wrapped: u8 = 0 }
//
// All multi-byte ints are little-endian per spec ("All multi-byte
// integers are little-endian.").
// ---------------------------------------------------------------------------
function buildCanonicalInner(): Buffer {
  const cols = 80;
  const rows = 24;
  const scrollback = 0;
  const viewport = rows;
  const lineCount = scrollback + viewport;

  // Each empty line: u16 cell_count=0 + 0 cells + u8 wrapped=0 = 3 bytes.
  const PER_EMPTY_LINE = 2 + 0 + 1;
  const linesLen = lineCount * PER_EMPTY_LINE;

  const fixedLen =
    4 + // inner_magic
    2 + 2 + // cols, rows
    4 + 4 + // cursor_row, cursor_col
    1 + 1 + // cursor_visible, cursor_style
    4 + 4 + // scrollback_lines, viewport_lines
    8 + // modes_bitmap
    4; // attrs_palette_len (no entries follow)

  const buf = Buffer.alloc(fixedLen + linesLen);
  let off = 0;

  INNER_MAGIC.copy(buf, off); off += 4;
  buf.writeUInt16LE(cols, off); off += 2;
  buf.writeUInt16LE(rows, off); off += 2;
  buf.writeUInt32LE(0, off); off += 4; // cursor_row
  buf.writeUInt32LE(0, off); off += 4; // cursor_col
  buf.writeUInt8(1, off); off += 1; // cursor_visible
  buf.writeUInt8(0, off); off += 1; // cursor_style = block
  buf.writeUInt32LE(scrollback, off); off += 4;
  buf.writeUInt32LE(viewport, off); off += 4;
  // modes_bitmap[8] — all zero (Buffer.alloc already zeroed)
  off += 8;
  buf.writeUInt32LE(0, off); off += 4; // attrs_palette_len = 0

  // Empty lines.
  for (let i = 0; i < lineCount; i++) {
    buf.writeUInt16LE(0, off); off += 2; // cell_count
    // 0 cells follow
    buf.writeUInt8(0, off); off += 1; // wrapped = 0
  }

  if (off !== buf.length) {
    throw new Error(`canonical inner: off ${off} != len ${buf.length}`);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Codec wrap / unwrap (the bytes-only contract; production code in T4.8
// will live in @ccsm/snapshot-codec but speak EXACTLY this byte format).
//
// Determinism notes:
//   - `zstdCompressSync` with default params is deterministic across runs
//     (verified locally; libzstd given the same input produces the same
//     output bytes).
//   - `gzipSync` includes a 10-byte gzip header. Bytes 4..7 are mtime
//     (always 0 from gzipSync), byte 8 is XFL (compression-level flag),
//     byte 9 is the "OS" byte which DEFAULTS DIFFERENTLY across host OS
//     (e.g. 0x03 on Linux, 0x0a on Windows). To make the golden bytes
//     stable across CI runners we normalize the OS byte to 0xff
//     ("unknown") after compression. Decompressors ignore the OS byte.
// ---------------------------------------------------------------------------

function wrap(codec: 1 | 2, inner: Buffer): Buffer {
  let compressed: Buffer;
  if (codec === CODEC_ZSTD) {
    compressed = Buffer.from(zstdCompressSync(inner));
  } else {
    const raw = Buffer.from(gzipSync(inner, { level: 9 }));
    // Normalize gzip header for cross-platform byte stability:
    //   bytes 4..7 = mtime (already 0 from gzipSync; assert it)
    //   byte    9 = OS — force to 0xff (unknown) so the same payload
    //              encodes to the same bytes on linux/macos/windows.
    if (raw.readUInt32LE(4) !== 0) {
      throw new Error('gzipSync produced non-zero mtime — host clock leak?');
    }
    raw[9] = 0xff;
    compressed = raw;
  }
  const out = Buffer.alloc(OUTER_HEADER_LEN + compressed.length);
  let off = 0;
  OUTER_MAGIC.copy(out, off); off += 4;
  out.writeUInt8(codec, off); off += 1;
  // reserved[3] — Buffer.alloc already zeroed
  off += RESERVED_BYTES;
  out.writeUInt32LE(compressed.length, off); off += 4;
  compressed.copy(out, off); off += compressed.length;
  if (off !== out.length) {
    throw new Error(`wrap: off ${off} != len ${out.length}`);
  }
  return out;
}

interface ParsedWire {
  codec: number;
  reserved: Buffer;
  innerLen: number;
  innerCompressed: Buffer;
}

function parseWire(wire: Buffer): ParsedWire {
  if (wire.length < OUTER_HEADER_LEN) {
    throw new Error(`SnapshotV1: wire too short (${wire.length} < ${OUTER_HEADER_LEN})`);
  }
  if (wire.compare(OUTER_MAGIC, 0, 4, 0, 4) !== 0) {
    throw new Error(
      `SnapshotV1: bad outer magic ${wire.subarray(0, 4).toString('hex')} (expected "CSS1")`,
    );
  }
  const codec = wire.readUInt8(4);
  const reserved = wire.subarray(5, 5 + RESERVED_BYTES);
  const innerLen = wire.readUInt32LE(8);
  const innerCompressed = wire.subarray(OUTER_HEADER_LEN, OUTER_HEADER_LEN + innerLen);
  if (innerCompressed.length !== innerLen) {
    throw new Error(
      `SnapshotV1: truncated inner (got ${innerCompressed.length}, want ${innerLen})`,
    );
  }
  return { codec, reserved, innerLen, innerCompressed };
}

function unwrap(wire: Buffer): Buffer {
  const parsed = parseWire(wire);
  if (parsed.reserved.some((b) => b !== 0)) {
    throw new Error(
      `SnapshotV1: reserved bytes MUST be zero in v1, got ${parsed.reserved.toString('hex')}`,
    );
  }
  if (parsed.codec === CODEC_ZSTD) {
    return Buffer.from(zstdDecompressSync(parsed.innerCompressed));
  }
  if (parsed.codec === CODEC_GZIP) {
    return Buffer.from(gunzipSync(parsed.innerCompressed));
  }
  throw new Error(`SnapshotV1: unknown codec ${parsed.codec} in v0.3 (valid: 1=zstd, 2=gzip)`);
}

// ---------------------------------------------------------------------------
// Golden file format — two wrapped snapshots concatenated with a u32 LE
// length prefix per entry, in fixed order [zstd, gzip]. This is a TEST
// fixture envelope, not a wire format; it exists purely so the single
// file path named in ch15 §3 #5 carries both codec variants.
//
//   golden := { u32 LE len_z; bytes wire_zstd[len_z];
//               u32 LE len_g; bytes wire_gzip[len_g]; }
// ---------------------------------------------------------------------------

function buildGolden(): { wireZstd: Buffer; wireGzip: Buffer; golden: Buffer } {
  const inner = buildCanonicalInner();
  const wireZstd = wrap(CODEC_ZSTD, inner);
  const wireGzip = wrap(CODEC_GZIP, inner);
  const golden = Buffer.alloc(4 + wireZstd.length + 4 + wireGzip.length);
  let off = 0;
  golden.writeUInt32LE(wireZstd.length, off); off += 4;
  wireZstd.copy(golden, off); off += wireZstd.length;
  golden.writeUInt32LE(wireGzip.length, off); off += 4;
  wireGzip.copy(golden, off); off += wireGzip.length;
  return { wireZstd, wireGzip, golden };
}

function parseGolden(buf: Buffer): { wireZstd: Buffer; wireGzip: Buffer } {
  let off = 0;
  const lenZ = buf.readUInt32LE(off); off += 4;
  const wireZstd = buf.subarray(off, off + lenZ); off += lenZ;
  const lenG = buf.readUInt32LE(off); off += 4;
  const wireGzip = buf.subarray(off, off + lenG); off += lenG;
  if (off !== buf.length) {
    throw new Error(`golden: trailing bytes (consumed ${off}, total ${buf.length})`);
  }
  return { wireZstd, wireGzip };
}

// ---------------------------------------------------------------------------
// L1-L7 assertions
// ---------------------------------------------------------------------------

describe('SnapshotV1 outer wrapper — codec byte enum (L1-L2)', () => {
  it('L1: outer magic is exactly ASCII "CSS1"', () => {
    expect(OUTER_MAGIC).toEqual(Buffer.from([0x43, 0x53, 0x53, 0x31]));
    expect(OUTER_MAGIC.toString('ascii')).toBe('CSS1');
  });

  it('L2: CODEC_ZSTD === 1 (forever-stable v0.3 default)', () => {
    expect(CODEC_ZSTD).toBe(1);
  });

  it('L2: CODEC_GZIP === 2 (browser DecompressionStream fallback)', () => {
    expect(CODEC_GZIP).toBe(2);
  });

  it('L2: v0.3 defines exactly two codec values (no others)', () => {
    expect(V03_CODECS).toEqual([1, 2]);
    expect(V03_CODECS.length).toBe(2);
  });

  it('L2: unwrap rejects unknown codec values (open enum, v0.3 readers)', () => {
    const inner = buildCanonicalInner();
    const validWire = wrap(CODEC_ZSTD, inner);
    // Mutate the codec byte to an unknown value.
    const bogus = Buffer.from(validWire);
    bogus[4] = 9; // not 1, not 2
    expect(() => unwrap(bogus)).toThrow(/unknown codec/);
  });
});

describe('SnapshotV1 outer wrapper — reserved + length fields (L3-L5)', () => {
  it('L3: reserved is exactly 3 bytes, all zero in v1', () => {
    const wire = wrap(CODEC_ZSTD, buildCanonicalInner());
    const parsed = parseWire(wire);
    expect(parsed.reserved.length).toBe(RESERVED_BYTES);
    expect(parsed.reserved.equals(Buffer.alloc(RESERVED_BYTES))).toBe(true);
  });

  it('L3: reader MUST reject non-zero reserved bytes', () => {
    const wire = Buffer.from(wrap(CODEC_ZSTD, buildCanonicalInner()));
    // Flip one bit in reserved[1].
    wire[6] = 0x01;
    expect(() => unwrap(wire)).toThrow(/reserved bytes MUST be zero/);
  });

  it('L4: inner_len is uint32 little-endian at offset 8', () => {
    const inner = buildCanonicalInner();
    const wire = wrap(CODEC_ZSTD, inner);
    const declared = wire.readUInt32LE(8);
    expect(declared).toBe(wire.length - OUTER_HEADER_LEN);
  });

  it('L5: inner payload occupies exactly inner_len bytes after the header', () => {
    const wire = wrap(CODEC_GZIP, buildCanonicalInner());
    const parsed = parseWire(wire);
    expect(parsed.innerCompressed.length).toBe(parsed.innerLen);
    // Total wire = header + inner.
    expect(wire.length).toBe(OUTER_HEADER_LEN + parsed.innerLen);
  });
});

describe('SnapshotV1 inner payload — codec-independent (L6)', () => {
  it('L6: zstd and gzip wrappers decompress to identical canonical inner bytes', () => {
    const inner = buildCanonicalInner();
    const wireZ = wrap(CODEC_ZSTD, inner);
    const wireG = wrap(CODEC_GZIP, inner);
    const innerZ = unwrap(wireZ);
    const innerG = unwrap(wireG);
    expect(innerZ.equals(inner)).toBe(true);
    expect(innerG.equals(inner)).toBe(true);
    expect(innerZ.equals(innerG)).toBe(true);
  });

  it('L6: canonical inner starts with the inner magic "CSS1"', () => {
    const inner = buildCanonicalInner();
    expect(inner.subarray(0, 4).toString('ascii')).toBe('CSS1');
  });

  it('L6: canonical 80x24 empty inner has the spec-defined fixed layout length', () => {
    // 4 magic + 2+2 cols/rows + 4+4 cursor + 1+1 cursor flags +
    // 4+4 scrollback/viewport + 8 modes + 4 palette_len = 38
    // 24 lines * (2 cell_count + 0 cells + 1 wrapped) = 72
    // total = 110
    const inner = buildCanonicalInner();
    expect(inner.length).toBe(38 + 72);
    expect(inner.length).toBe(110);
  });
});

describe('SnapshotV1 golden binary — ch15 §3 #5 forbidden-pattern fixture (L7)', () => {
  it('L7: golden file exists at the spec-named path', () => {
    expect(existsSync(GOLDEN_PATH)).toBe(true);
  });

  it('L7: golden file matches the deterministic generator byte-for-byte', () => {
    // If this fails because the spec generator changed, regenerate the
    // fixture intentionally:
    //   GOLDEN_REGEN=1 pnpm --filter @ccsm/daemon test snapshot-codec
    const { golden: expected } = buildGolden();
    if (process.env.GOLDEN_REGEN === '1') {
      writeFileSync(GOLDEN_PATH, expected);
    }
    const actual = readFileSync(GOLDEN_PATH);
    if (!actual.equals(expected)) {
      // Surface a hex preview so a drift is debuggable from CI logs alone.
      const head = (b: Buffer): string => b.subarray(0, 32).toString('hex');
      throw new Error(
        `golden drift:\n  actual.len=${actual.length} head=${head(actual)}\n` +
          `  expected.len=${expected.length} head=${head(expected)}\n` +
          `  to regenerate: GOLDEN_REGEN=1 pnpm --filter @ccsm/daemon test snapshot-codec`,
      );
    }
    expect(actual.equals(expected)).toBe(true);
  });

  it('L7: golden contains a codec=1 (zstd) wire and a codec=2 (gzip) wire in order', () => {
    const buf = readFileSync(GOLDEN_PATH);
    const { wireZstd, wireGzip } = parseGolden(buf);
    expect(parseWire(wireZstd).codec).toBe(CODEC_ZSTD);
    expect(parseWire(wireGzip).codec).toBe(CODEC_GZIP);
  });

  it('L7: golden zstd wire round-trips byte-identically (encode -> decode -> encode)', () => {
    const buf = readFileSync(GOLDEN_PATH);
    const { wireZstd } = parseGolden(buf);
    const inner = unwrap(wireZstd);
    const reEncoded = wrap(CODEC_ZSTD, inner);
    expect(reEncoded.equals(wireZstd)).toBe(true);
  });

  it('L7: golden gzip wire round-trips byte-identically (encode -> decode -> encode)', () => {
    const buf = readFileSync(GOLDEN_PATH);
    const { wireGzip } = parseGolden(buf);
    const inner = unwrap(wireGzip);
    const reEncoded = wrap(CODEC_GZIP, inner);
    expect(reEncoded.equals(wireGzip)).toBe(true);
  });

  it('L7: golden zstd inner === golden gzip inner (codec-independent payload)', () => {
    const buf = readFileSync(GOLDEN_PATH);
    const { wireZstd, wireGzip } = parseGolden(buf);
    expect(unwrap(wireZstd).equals(unwrap(wireGzip))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Forward-compat hooks for T4.6 (encoder), T4.7 (decoder), T4.8 (codec
// wrappers). These flip from `it.todo` to real assertions when the
// production modules at `packages/snapshot-codec/src/` land.
// ---------------------------------------------------------------------------

describe('SnapshotV1 production-codec integration — pending downstream tasks', () => {
  it.todo(
    'T4.6 (Task #46): @ccsm/snapshot-codec encoder produces the canonical inner ' +
      'bytes from an empty 80x24 xterm-headless terminal',
  );
  it.todo(
    'T4.7 (Task #44): @ccsm/snapshot-codec decoder applied to the golden zstd wire ' +
      'yields an xterm-headless state matching the source state',
  );
  it.todo(
    'T4.7 (Task #44): @ccsm/snapshot-codec decoder applied to the golden gzip wire ' +
      'yields the same xterm-headless state as the zstd wire',
  );
  it.todo(
    'T4.8 (Task #52): @ccsm/snapshot-codec wrap()/unwrap() produce wire bytes ' +
      'byte-identical to this spec’s reference wrap() for both codecs',
  );
});
