#!/usr/bin/env node
// vt-grammar.mjs — weighted CSI / OSC / DCS sequence generator for snapshot fuzz.
//
// Spike-harness helper pinned by spec ch14 §1.B (forever-stable contract).
// Used by ch14 §1.8 corpus (C2): weighted grammar producing valid CSI/OSC/DCS
// sequences with parameter ranges sampled from the xterm-parser-spec table.
//
// Contract (FOREVER-STABLE — v0.4 may add flags, never rename/remove):
//
//   Usage:
//     vt-grammar.mjs [--count=<int>]      number of sequences to emit (default 1000)
//                    [--length=<int>]     target byte length per sequence (default 256)
//                    [--seed=<int>]       PRNG seed for reproducibility (default 1)
//                    [--out=<path>]       write to file instead of stdout
//
//   Behavior:
//     Emit `count` raw VT sequences concatenated to stdout (or file).
//     Sequence categories sampled with weights:
//       CSI (Control Sequence Introducer) ESC `[` … final-byte    weight 0.55
//       SGR (subset of CSI, m-final, colour params)                weight 0.20
//       OSC (Operating System Command)    ESC `]` … BEL|ST         weight 0.15
//       DCS (Device Control String)       ESC `P` … ST             weight 0.05
//       printable ASCII filler                                     weight 0.05
//
//   Output (stdout / file): raw bytes (binary), exactly `count` sequences.
//   Output (stderr, last line, JSON):
//     {"count":<int>,"length":<int>,"seed":<int>,"emittedBytes":<int>}
//
//   Exit 0 always (generator never fails); 2 on bad arg.
//
// Determinism: same --seed --count --length MUST produce byte-identical output
// across runs and OSes. This is forever-stable per ch14 §1.B.
//
// Layer-1: node: stdlib only (fs, util).

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    count:  { type: 'string', default: '1000' },
    length: { type: 'string', default: '256'  },
    seed:   { type: 'string', default: '1'    },
    out:    { type: 'string' },
  },
  strict: true,
});

const count  = Number(values.count);
const target = Number(values.length);
const seed   = Number(values.seed);

if (!Number.isFinite(count) || count <= 0)   { process.stderr.write('bad --count\n');  process.exit(2); }
if (!Number.isFinite(target) || target <= 0) { process.stderr.write('bad --length\n'); process.exit(2); }

// Mulberry32 PRNG — 32-bit, deterministic, no deps.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);

const ESC = 0x1B;
const BEL = 0x07;
const ST  = [0x1B, 0x5C]; // ESC \

const CSI_FINALS = [0x40, 0x41, 0x42, 0x43, 0x44, 0x48, 0x4A, 0x4B, 0x6D]; // @ A B C D H J K m
const PRINTABLE  = Array.from({ length: 95 }, (_, i) => 0x20 + i);

function pickWeighted() {
  const r = rand();
  if (r < 0.55) return 'CSI';
  if (r < 0.75) return 'SGR';
  if (r < 0.90) return 'OSC';
  if (r < 0.95) return 'DCS';
  return 'FILL';
}

function intStr(maxDigits) {
  const n = Math.floor(rand() * Math.pow(10, 1 + Math.floor(rand() * maxDigits)));
  return String(n);
}

function genCSI() {
  const parts = [ESC, 0x5B]; // ESC [
  const nParams = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < nParams; i++) {
    if (i > 0) parts.push(0x3B); // ;
    for (const ch of intStr(3)) parts.push(ch.charCodeAt(0));
  }
  parts.push(CSI_FINALS[Math.floor(rand() * CSI_FINALS.length)]);
  return parts;
}

function genSGR() {
  const parts = [ESC, 0x5B];
  const codes = [0, 1, 4, 7, 22, 24, 27, 30, 31, 32, 33, 34, 35, 36, 37,
                 38, 5, 39, 40, 41, 42, 90, 97];
  const n = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    if (i > 0) parts.push(0x3B);
    const c = codes[Math.floor(rand() * codes.length)];
    for (const ch of String(c)) parts.push(ch.charCodeAt(0));
  }
  parts.push(0x6D); // m
  return parts;
}

function genOSC() {
  const parts = [ESC, 0x5D]; // ESC ]
  for (const ch of intStr(2)) parts.push(ch.charCodeAt(0));
  parts.push(0x3B);
  // payload: random printable
  const payloadLen = Math.floor(rand() * 16);
  for (let i = 0; i < payloadLen; i++) {
    parts.push(PRINTABLE[Math.floor(rand() * PRINTABLE.length)]);
  }
  parts.push(BEL);
  return parts;
}

function genDCS() {
  const parts = [ESC, 0x50]; // ESC P
  const payloadLen = Math.floor(rand() * 32);
  for (let i = 0; i < payloadLen; i++) {
    parts.push(PRINTABLE[Math.floor(rand() * PRINTABLE.length)]);
  }
  for (const b of ST) parts.push(b);
  return parts;
}

function genFill() {
  const parts = [];
  for (let i = 0; i < 8; i++) {
    parts.push(PRINTABLE[Math.floor(rand() * PRINTABLE.length)]);
  }
  return parts;
}

const buf = [];
for (let i = 0; i < count; i++) {
  const seqBytes = [];
  while (seqBytes.length < target) {
    const cat = pickWeighted();
    let chunk;
    switch (cat) {
      case 'CSI':  chunk = genCSI();  break;
      case 'SGR':  chunk = genSGR();  break;
      case 'OSC':  chunk = genOSC();  break;
      case 'DCS':  chunk = genDCS();  break;
      default:     chunk = genFill(); break;
    }
    for (const b of chunk) seqBytes.push(b);
  }
  for (const b of seqBytes) buf.push(b);
}

const out = Buffer.from(buf);

if (values.out) {
  writeFileSync(values.out, out);
} else {
  process.stdout.write(out);
}

process.stderr.write(JSON.stringify({
  count, length: target, seed, emittedBytes: out.length,
}) + '\n');
