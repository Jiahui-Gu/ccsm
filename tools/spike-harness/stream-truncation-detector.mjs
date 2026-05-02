#!/usr/bin/env node
// stream-truncation-detector.mjs — server-stream consumer asserting no truncation.
//
// Spike-harness helper pinned by spec ch14 §1.B (forever-stable contract).
// Used by ch14 §1.3, §1.4, §1.5 (transport spikes — assert that under a
// configurable rate, no server-stream frames are dropped or truncated).
//
// Contract (FOREVER-STABLE — v0.4 may add flags, never rename/remove):
//
//   Usage:
//     stream-truncation-detector.mjs [--expect-count=<int>]
//                                    [--rate-hz=<int>]
//                                    [--timeout-ms=<int>]
//
//   Reads NDJSON frames from stdin, one per line:
//     {"seq": <int>, "ts": <unix-ms>, "len": <int>, ["payloadB64": "<b64>"]}
//
//   Behavior:
//     1. Verify `seq` strictly increases from the first observed value with
//        gap=1. Any missing seq → record gap; any duplicate → record dup.
//     2. If --expect-count is set, verify total frames received == expected.
//     3. If --rate-hz is set, compute observed rate from first/last ts and
//        flag if observed < 0.95 * expected.
//     4. If --timeout-ms passes without a new frame, treat as truncation.
//
//   Output (stdout, single JSON line on close):
//     {"frames":<int>,"firstSeq":<int>,"lastSeq":<int>,
//      "gaps":[<int>,...],"dups":[<int>,...],
//      "observedRateHz":<num>,"expectedRateHz":<num|null>,
//      "expectedCount":<int|null>,"truncated":<bool>,"ok":<bool>}
//
//   Exit 0 if !truncated && gaps.length===0 && dups.length===0
//          && (expectedCount === null || frames === expectedCount);
//   Exit 1 otherwise.
//
// Layer-1: node: stdlib only (readline, util).

import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'expect-count': { type: 'string' },
    'rate-hz':      { type: 'string' },
    'timeout-ms':   { type: 'string', default: '5000' },
  },
  strict: true,
});

const expectCount = values['expect-count'] ? Number(values['expect-count']) : null;
const expectRate  = values['rate-hz']      ? Number(values['rate-hz'])      : null;
const timeoutMs   = Number(values['timeout-ms']);

const gaps = [];
const dups = [];
const seen = new Set();
let frames = 0;
let firstSeq = null;
let lastSeq = null;
let firstTs = null;
let lastTs = null;
let truncated = false;
let timer = null;

function armTimer() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    truncated = true;
    process.stderr.write(`timeout: no frame for ${timeoutMs}ms\n`);
    rl.close();
  }, timeoutMs);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
armTimer();

rl.on('line', (line) => {
  armTimer();
  if (!line.trim()) return;
  let f;
  try { f = JSON.parse(line); } catch { return; }
  if (typeof f.seq !== 'number') return;
  frames++;
  if (firstSeq === null) {
    firstSeq = f.seq;
    firstTs = typeof f.ts === 'number' ? f.ts : null;
  } else if (f.seq <= lastSeq) {
    if (seen.has(f.seq)) dups.push(f.seq);
  } else if (f.seq !== lastSeq + 1) {
    for (let s = lastSeq + 1; s < f.seq; s++) gaps.push(s);
  }
  seen.add(f.seq);
  lastSeq = f.seq;
  if (typeof f.ts === 'number') lastTs = f.ts;
});

rl.on('close', () => {
  if (timer) clearTimeout(timer);
  const elapsedMs = (firstTs !== null && lastTs !== null && lastTs > firstTs)
    ? lastTs - firstTs : 0;
  const observedRateHz = elapsedMs > 0 ? (frames / (elapsedMs / 1000)) : 0;
  const ok = !truncated
    && gaps.length === 0
    && dups.length === 0
    && (expectCount === null || frames === expectCount)
    && (expectRate === null || observedRateHz >= 0.95 * expectRate);
  process.stdout.write(JSON.stringify({
    frames,
    firstSeq:       firstSeq ?? -1,
    lastSeq:        lastSeq  ?? -1,
    gaps,
    dups,
    observedRateHz,
    expectedRateHz: expectRate,
    expectedCount:  expectCount,
    truncated,
    ok,
  }) + '\n');
  process.exit(ok ? 0 : 1);
});
