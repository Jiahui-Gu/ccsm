#!/usr/bin/env node
// probe.mjs — T9.7 spike: SnapshotV1 encode -> decode -> encode byte-identical.
//
// Spec: ch14 §1.8 phase 4.5. Validates that a candidate SnapshotV1 wire
// format is bit-stable under round-trip, using the deterministic vt-grammar
// corpus (C2) plus a minimal xterm replay corpus (C3 stand-in) as the
// snapshot payload source.
//
// Why this matters for T4.6 (the real codec):
//   The daemon persists terminal scrollback / cell grid as SnapshotV1 blobs
//   and replays them on resume. If `encode(decode(encode(s))) !== encode(s)`
//   we lose stable hashing (no content-addressed dedup, no diff-friendly
//   deltas, no reproducible CI golden tests). Therefore the codec MUST be
//   canonical: every logical snapshot has exactly one byte-string encoding.
//
// What this probe ships:
//   1. A reference SnapshotV1 codec (`refCodec`) implementing the canonical
//      rules below. This is NOT the production codec — that's T4.6's job.
//      It exists to (a) prove the byte-identity property is achievable with
//      a small, easy-to-audit core, and (b) lock the canonicalization rules
//      that T4.6 inherits.
//   2. A corpus runner that feeds {vt-grammar, xterm replay} bytes through
//      a tiny VT model -> snapshot struct -> codec round-trip. Asserts
//      byte-equality across N seeds.
//
// Canonical rules locked by this spike (forever-stable per ch14 §1.B):
//   R1. Magic + version: bytes 0..3 = "SNP1" (0x53 0x4E 0x50 0x31).
//   R2. Big-endian u32 lengths everywhere; no zigzag, no var-int (avoids
//       multiple valid encodings of the same integer).
//   R3. Map keys serialized in lexicographic byte order (no hash-iteration
//       leakage). Empty maps are length=0, no padding.
//   R4. Strings are length-prefixed UTF-8; no NUL terminator (NUL would
//       admit two encodings: with and without trailing NUL).
//   R5. Optional fields use a "present?" bitfield in the struct header; an
//       absent field contributes ZERO bytes to the payload (cannot be
//       written as length=0). This is the rule most likely to be violated
//       by a naive impl — covered by case `cursor-default` below.
//   R6. No floats. All numeric fields are u32 / i32 (rendering math is in
//       the renderer, not the snapshot).
//
// Contract (forever-stable per tools/spike-harness/README.md):
//   args:   none
//   env:    PROBE_SEEDS  (optional, default "1,2,3,4,5")  comma-sep u32
//           PROBE_COUNT  (optional, default "200")        seqs per seed
//           PROBE_LENGTH (optional, default "256")        bytes per seq
//   stdout: one JSON line per seed:
//             {seed, count, payloadBytes, encBytes, encEqual:true}
//           plus a final summary line:
//             {ok:true|false, seedsTested:[...], xtermReplayCases:[...],
//              durationMs, verdict:"GREEN"|"RED"}
//   exit:   0 if every seed + replay case round-trips byte-identical,
//           1 on any mismatch (mismatch dumped on stderr as hex diff).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// 1. Reference SnapshotV1 codec
// ---------------------------------------------------------------------------
//
// Snapshot shape (the smallest grid model that exercises every rule):
//
//   struct Snapshot {
//     u32   schemaVersion;          // R6
//     u32   cols;
//     u32   rows;
//     bool  hasCursor;              // R5: gates `cursor`
//     ?{ u32 col; u32 row; }   cursor;
//     map<string, u32>          counters;   // R3 sorted, R4 string keys
//     bytes                     screen;     // R2 length-prefixed
//   }

const MAGIC = Buffer.from('SNP1', 'ascii'); // R1

function writeU32BE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function writeBytes(buf) {
  return Buffer.concat([writeU32BE(buf.length), buf]);
}

function writeString(s) {
  return writeBytes(Buffer.from(s, 'utf8'));
}

function encode(snap) {
  if (!Number.isInteger(snap.schemaVersion) || snap.schemaVersion < 0) {
    throw new Error('schemaVersion must be u32');
  }
  if (!Number.isInteger(snap.cols) || !Number.isInteger(snap.rows)) {
    throw new Error('cols/rows must be u32');
  }
  // R5: bool 1 byte; payload follows ONLY when set.
  const hasCursor = snap.hasCursor ? 1 : 0;
  const cursorBytes = hasCursor
    ? Buffer.concat([writeU32BE(snap.cursor.col), writeU32BE(snap.cursor.row)])
    : Buffer.alloc(0);

  // R3: sort keys lexicographically (byte-wise on UTF-8) before serialising.
  const keys = Object.keys(snap.counters || {}).sort((a, b) => {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return Buffer.compare(ab, bb);
  });
  const counterChunks = [writeU32BE(keys.length)];
  for (const k of keys) {
    const v = snap.counters[k];
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`counter[${k}] must be u32`);
    }
    counterChunks.push(writeString(k));
    counterChunks.push(writeU32BE(v));
  }

  const screen = Buffer.isBuffer(snap.screen)
    ? snap.screen
    : Buffer.from(snap.screen ?? new Uint8Array(0));

  return Buffer.concat([
    MAGIC,
    writeU32BE(snap.schemaVersion),
    writeU32BE(snap.cols),
    writeU32BE(snap.rows),
    Buffer.from([hasCursor]),
    cursorBytes,
    Buffer.concat(counterChunks),
    writeBytes(screen),
  ]);
}

function decode(buf) {
  let off = 0;
  const need = (n, what) => {
    if (off + n > buf.length) {
      throw new Error(`SNP1 truncated reading ${what} at offset ${off}`);
    }
  };
  need(4, 'magic');
  if (buf.compare(MAGIC, 0, 4, 0, 4) !== 0) {
    throw new Error(`SNP1 bad magic: ${buf.subarray(0, 4).toString('hex')}`);
  }
  off += 4;
  need(4, 'schemaVersion');
  const schemaVersion = buf.readUInt32BE(off); off += 4;
  need(4, 'cols');
  const cols = buf.readUInt32BE(off); off += 4;
  need(4, 'rows');
  const rows = buf.readUInt32BE(off); off += 4;
  need(1, 'hasCursor');
  const hasCursorByte = buf.readUInt8(off); off += 1;
  if (hasCursorByte !== 0 && hasCursorByte !== 1) {
    throw new Error(`SNP1 bad hasCursor byte: ${hasCursorByte}`);
  }
  const hasCursor = hasCursorByte === 1;
  let cursor;
  if (hasCursor) {
    need(8, 'cursor');
    const col = buf.readUInt32BE(off); off += 4;
    const row = buf.readUInt32BE(off); off += 4;
    cursor = { col, row };
  }
  need(4, 'counters.len');
  const counterCount = buf.readUInt32BE(off); off += 4;
  const counters = {};
  for (let i = 0; i < counterCount; i++) {
    need(4, 'counter.keylen');
    const klen = buf.readUInt32BE(off); off += 4;
    need(klen, 'counter.key');
    const key = buf.subarray(off, off + klen).toString('utf8');
    off += klen;
    need(4, 'counter.val');
    counters[key] = buf.readUInt32BE(off); off += 4;
  }
  need(4, 'screen.len');
  const slen = buf.readUInt32BE(off); off += 4;
  need(slen, 'screen.bytes');
  const screen = buf.subarray(off, off + slen);
  off += slen;
  if (off !== buf.length) {
    throw new Error(`SNP1 trailing bytes: consumed=${off} total=${buf.length}`);
  }
  return { schemaVersion, cols, rows, hasCursor, cursor, counters, screen };
}

// ---------------------------------------------------------------------------
// 2. Tiny VT model — folds bytes from vt-grammar / xterm replay into a
//    Snapshot struct. NOT a full xterm; just enough state to make the
//    snapshot non-trivial (counts of CSI/OSC/DCS/SGR/printable + a moving
//    cursor + the raw bytes as `screen`).
// ---------------------------------------------------------------------------
function fold(bytes) {
  const snap = {
    schemaVersion: 1,
    cols: 80,
    rows: 24,
    hasCursor: false,
    cursor: undefined,
    counters: { csi: 0, osc: 0, dcs: 0, sgr: 0, printable: 0 },
    screen: Buffer.from(bytes),
  };
  let i = 0;
  let col = 0;
  let row = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x1B && i + 1 < bytes.length) {
      const n = bytes[i + 1];
      if (n === 0x5B) {
        // ESC [ ... final
        let j = i + 2;
        while (j < bytes.length && bytes[j] >= 0x30 && bytes[j] <= 0x3F) j++;
        const final = bytes[j];
        if (final === 0x6D) snap.counters.sgr++;
        else snap.counters.csi++;
        i = j + 1;
        continue;
      }
      if (n === 0x5D) {
        snap.counters.osc++;
        let j = i + 2;
        while (j < bytes.length && bytes[j] !== 0x07) j++;
        i = j + 1;
        continue;
      }
      if (n === 0x50) {
        snap.counters.dcs++;
        let j = i + 2;
        while (j + 1 < bytes.length && !(bytes[j] === 0x1B && bytes[j + 1] === 0x5C)) j++;
        i = j + 2;
        continue;
      }
      i += 2;
      continue;
    }
    if (b >= 0x20 && b < 0x7F) {
      snap.counters.printable++;
      col++;
      if (col >= snap.cols) { col = 0; row = (row + 1) % snap.rows; }
      snap.hasCursor = true;
      snap.cursor = { col, row };
    }
    i++;
  }
  return snap;
}

// ---------------------------------------------------------------------------
// 3. Corpus drivers
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VT_GRAMMAR = join(__dirname, '..', '..', 'vt-grammar.mjs');

function vtGrammarBytes(seed, count, length) {
  const r = spawnSync(process.execPath, [
    VT_GRAMMAR,
    `--seed=${seed}`, `--count=${count}`, `--length=${length}`,
  ], { encoding: 'buffer', maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    throw new Error(`vt-grammar exit ${r.status}: ${r.stderr.toString('utf8')}`);
  }
  return r.stdout;
}

// xterm replay corpus stand-in (C3): hand-picked sequences exercising the
// rule edges. Each case is `{ name, bytes, mutate? }`. `mutate` lets us also
// hit cursor-absent / counters-empty paths on the encoder.
const XTERM_REPLAY_CASES = [
  {
    name: 'empty',
    bytes: Buffer.alloc(0),
    mutate: (s) => { s.hasCursor = false; s.cursor = undefined; },
  },
  {
    name: 'cursor-default',
    // Triggers R5: a snapshot with no cursor must encode shorter than one
    // with a cursor at (0,0). If the encoder forgets R5 and emits zero-bytes
    // for "absent", the two snapshots collide.
    bytes: Buffer.from('hello'),
    mutate: (s) => { s.hasCursor = false; s.cursor = undefined; },
  },
  {
    name: 'sgr-reset',
    bytes: Buffer.from('\x1b[0mA\x1b[31mB\x1b[0m'),
  },
  {
    name: 'osc-window-title',
    bytes: Buffer.from('\x1b]0;hello\x07world'),
  },
  {
    name: 'dcs-passthrough',
    bytes: Buffer.from('\x1bPdata\x1b\\after'),
  },
  {
    name: 'cursor-move',
    bytes: Buffer.from('\x1b[10;20HX\x1b[2;3HY'),
  },
  {
    name: 'mixed-utf8',
    // Multi-byte UTF-8 in OSC payload exercises R4 (UTF-8 length-prefix, no
    // NUL terminator). Note: the UTF-8 lives inside `screen` (raw bytes);
    // counter keys here are ASCII, but the property still holds.
    bytes: Buffer.from('\x1b]2;éclair中文\x07tail'),
  },
  {
    name: 'counters-many',
    // Force the counter map to be non-trivially sorted: inject extra keys
    // out of insertion order to verify R3 sort.
    bytes: Buffer.from('hi'),
    mutate: (s) => {
      s.counters = { z: 9, a: 1, m: 5, b: 2, y: 8, c: 3 };
    },
  },
];

// ---------------------------------------------------------------------------
// 4. Round-trip harness
// ---------------------------------------------------------------------------
function hexHead(buf, n = 64) {
  return Buffer.from(buf).subarray(0, n).toString('hex');
}

function roundTrip(snap, label) {
  const enc1 = encode(snap);
  let dec;
  try {
    dec = decode(enc1);
  } catch (e) {
    process.stderr.write(`[${label}] decode failed: ${e.message}\n`);
    process.stderr.write(`[${label}] enc1=${hexHead(enc1)}...\n`);
    return { ok: false, payloadBytes: 0, encBytes: enc1.length };
  }
  let enc2;
  try {
    enc2 = encode(dec);
  } catch (e) {
    process.stderr.write(`[${label}] re-encode failed: ${e.message}\n`);
    return { ok: false, payloadBytes: 0, encBytes: enc1.length };
  }
  if (Buffer.compare(enc1, enc2) !== 0) {
    process.stderr.write(`[${label}] BYTE MISMATCH:\n`);
    process.stderr.write(`  enc1.len=${enc1.length} enc2.len=${enc2.length}\n`);
    process.stderr.write(`  enc1=${hexHead(enc1, 96)}\n`);
    process.stderr.write(`  enc2=${hexHead(enc2, 96)}\n`);
    return { ok: false, payloadBytes: snap.screen.length, encBytes: enc1.length };
  }
  return { ok: true, payloadBytes: snap.screen.length, encBytes: enc1.length };
}

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------
const start = Date.now();
const seeds = (process.env.PROBE_SEEDS ?? '1,2,3,4,5').split(',').map((s) => Number(s.trim()));
const count = Number.parseInt(process.env.PROBE_COUNT ?? '200', 10);
const length = Number.parseInt(process.env.PROBE_LENGTH ?? '256', 10);

let allOk = true;
const seedResults = [];

for (const seed of seeds) {
  const bytes = vtGrammarBytes(seed, count, length);
  const snap = fold(bytes);
  const r = roundTrip(snap, `seed=${seed}`);
  process.stdout.write(JSON.stringify({
    seed, count, payloadBytes: r.payloadBytes, encBytes: r.encBytes, encEqual: r.ok,
  }) + '\n');
  seedResults.push({ seed, ok: r.ok });
  if (!r.ok) allOk = false;
}

const replayResults = [];
for (const c of XTERM_REPLAY_CASES) {
  const snap = fold(c.bytes);
  if (c.mutate) c.mutate(snap);
  const r = roundTrip(snap, `xterm:${c.name}`);
  process.stdout.write(JSON.stringify({
    xtermCase: c.name, payloadBytes: r.payloadBytes, encBytes: r.encBytes, encEqual: r.ok,
  }) + '\n');
  replayResults.push({ name: c.name, ok: r.ok });
  if (!r.ok) allOk = false;
}

// Canonical-form cross-check (R3): two semantically equal snapshots built
// with different counter-key insertion orders MUST encode to identical
// bytes. This catches the bug that pure round-trip can't see (decode
// preserves write order, so a non-sorting encoder still round-trips).
const snapA = fold(Buffer.from('hi'));
snapA.counters = { z: 9, a: 1, m: 5, b: 2 };
const snapB = fold(Buffer.from('hi'));
snapB.counters = { a: 1, b: 2, m: 5, z: 9 };
const encA = encode(snapA);
const encB = encode(snapB);
const canonicalOk = Buffer.compare(encA, encB) === 0;
process.stdout.write(JSON.stringify({
  canonicalCrossCheck: 'counters-insertion-order',
  encABytes: encA.length, encBBytes: encB.length, encEqual: canonicalOk,
}) + '\n');
if (!canonicalOk) {
  process.stderr.write(`canonical mismatch:\n  A=${encA.toString('hex')}\n  B=${encB.toString('hex')}\n`);
  allOk = false;
}

process.stdout.write(JSON.stringify({
  ok: allOk,
  seedsTested: seedResults,
  xtermReplayCases: replayResults,
  durationMs: Date.now() - start,
  verdict: allOk ? 'GREEN' : 'RED',
}) + '\n');

process.exit(allOk ? 0 : 1);
