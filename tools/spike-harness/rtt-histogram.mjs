#!/usr/bin/env node
// rtt-histogram.mjs — read JSONL latency stream, output histogram + p50/p95/p99.
//
// Spike-harness helper pinned by spec ch14 §1.B (forever-stable contract).
// Used by ch14 §1.3, §1.4, §1.5 (HTTP/2 unary RTT histogram on loopback / UDS
// / named-pipe transports).
//
// Contract (FOREVER-STABLE — v0.4 may add flags, never rename/remove):
//
//   Usage:
//     rtt-histogram.mjs [--bucket-us=<int>]   bucket width in microseconds
//                                             (default 100)
//                       [--max-us=<int>]      histogram top-end (default 100000)
//
//   Reads NDJSON from stdin, one record per line:
//     {"rttUs": <int>}
//   Other fields ignored. Records missing rttUs are skipped (counted).
//
//   Output (stdout, single JSON line):
//     {"count":<int>,"skipped":<int>,
//      "minUs":<int>,"maxUs":<int>,"meanUs":<num>,
//      "p50Us":<int>,"p95Us":<int>,"p99Us":<int>,
//      "bucketUs":<int>,"buckets":[<count>,<count>,...]}
//
//   The buckets array has length ceil(maxUs / bucketUs) + 1; the final bucket
//   is the overflow bucket (>= maxUs).
//
//   Exit 0 always; exit 2 on bad arg.
//
// Layer-1: node: stdlib only (readline, util).

import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'bucket-us': { type: 'string', default: '100'    },
    'max-us':    { type: 'string', default: '100000' },
  },
  strict: true,
});

const bucketUs = Number(values['bucket-us']);
const maxUs    = Number(values['max-us']);
if (!Number.isFinite(bucketUs) || bucketUs <= 0) { process.stderr.write('bad --bucket-us\n'); process.exit(2); }
if (!Number.isFinite(maxUs)    || maxUs    <= 0) { process.stderr.write('bad --max-us\n');    process.exit(2); }

const nBuckets = Math.ceil(maxUs / bucketUs) + 1;
const buckets  = new Array(nBuckets).fill(0);
const samples  = [];
let skipped = 0;
let sum = 0;
let min = Infinity;
let max = -Infinity;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let rec;
  try { rec = JSON.parse(line); } catch { skipped++; return; }
  const v = rec.rttUs;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) { skipped++; return; }
  samples.push(v);
  sum += v;
  if (v < min) min = v;
  if (v > max) max = v;
  const idx = v >= maxUs ? nBuckets - 1 : Math.floor(v / bucketUs);
  buckets[idx]++;
});

rl.on('close', () => {
  const count = samples.length;
  if (count === 0) {
    process.stdout.write(JSON.stringify({
      count: 0, skipped, minUs: 0, maxUs: 0, meanUs: 0,
      p50Us: 0, p95Us: 0, p99Us: 0, bucketUs, buckets,
    }) + '\n');
    return;
  }
  samples.sort((a, b) => a - b);
  const pct = (p) => samples[Math.min(count - 1, Math.floor(p * count))];
  process.stdout.write(JSON.stringify({
    count,
    skipped,
    minUs:    min,
    maxUs:    max,
    meanUs:   sum / count,
    p50Us:    pct(0.50),
    p95Us:    pct(0.95),
    p99Us:    pct(0.99),
    bucketUs,
    buckets,
  }) + '\n');
});
