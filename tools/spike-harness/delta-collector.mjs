#!/usr/bin/env node
// delta-collector.mjs — collect PTY delta frames, dump NDJSON, assert seq contiguity.
//
// Spike-harness helper pinned by spec ch14 §1.B (forever-stable contract).
// Used by ch14 §1.7 (daemon-side delta collector for PTY throughput spike).
//
// Contract (FOREVER-STABLE — v0.4 may add flags, never rename/remove):
//
//   Usage:
//     delta-collector.mjs [--out=<ndjson-path>] [--expect-sha256=<hex>]
//
//     Reads delta frames as NDJSON from stdin, one JSON object per line:
//       {"seq": <int>, "payloadB64": "<base64>"}
//
//   Behavior:
//     1. For each input line, parse JSON; verify `seq` is contiguous from 0
//        (or from the first observed seq).
//     2. base64-decode `payloadB64`, append to a running SHA-256.
//     3. On stdin EOF, emit a single summary JSON line to stdout.
//     4. If --out is set, mirror raw input lines to that NDJSON file.
//     5. If --expect-sha256 is set, compare and exit non-zero on mismatch.
//
//   Output (stdout, last line, JSON):
//     {"frames":<int>,"firstSeq":<int>,"lastSeq":<int>,"gaps":[<int>,...],
//      "totalPayloadBytes":<int>,"sha256":"<hex>","ok":<bool>}
//
//   Exit 0 if seq contiguous AND (no expected SHA OR SHA matches);
//   exit 1 on any gap; exit 2 on SHA mismatch; exit 3 on parse error.
//
// Layer-1: node: stdlib only (readline, crypto, fs).

import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    out:               { type: 'string' },
    'expect-sha256':   { type: 'string' },
  },
  strict: true,
});

const sha = createHash('sha256');
const gaps = [];
let frames = 0;
let firstSeq = null;
let lastSeq = null;
let totalPayloadBytes = 0;

const mirror = values.out ? createWriteStream(values.out, { flags: 'w' }) : null;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

let parseError = null;

rl.on('line', (line) => {
  if (line.trim() === '') return;
  if (mirror) mirror.write(line + '\n');
  let frame;
  try {
    frame = JSON.parse(line);
  } catch (e) {
    parseError = e.message;
    return;
  }
  if (typeof frame.seq !== 'number' || typeof frame.payloadB64 !== 'string') {
    parseError = 'frame missing seq or payloadB64';
    return;
  }
  if (firstSeq === null) {
    firstSeq = frame.seq;
  } else if (frame.seq !== lastSeq + 1) {
    for (let s = lastSeq + 1; s < frame.seq; s++) gaps.push(s);
  }
  lastSeq = frame.seq;
  frames++;
  const buf = Buffer.from(frame.payloadB64, 'base64');
  totalPayloadBytes += buf.length;
  sha.update(buf);
});

rl.on('close', () => {
  if (mirror) mirror.end();
  if (parseError) {
    process.stderr.write('parse error: ' + parseError + '\n');
    process.exit(3);
  }
  const digest = sha.digest('hex');
  const ok = gaps.length === 0
    && (!values['expect-sha256'] || values['expect-sha256'] === digest);
  const summary = {
    frames,
    firstSeq:          firstSeq ?? -1,
    lastSeq:           lastSeq  ?? -1,
    gaps,
    totalPayloadBytes,
    sha256:            digest,
    ok,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
  if (gaps.length > 0) process.exit(1);
  if (values['expect-sha256'] && values['expect-sha256'] !== digest) process.exit(2);
  process.exit(0);
});
