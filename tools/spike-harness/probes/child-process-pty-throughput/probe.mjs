#!/usr/bin/env node
// T9.6 — child-process-pty-throughput probe.
//
// Spawns `child.mjs` under `node:child_process`, lets the child run a
// node-pty + @xterm/headless throughput loop, and aggregates the NDJSON
// progress stream into a single summary JSON line on stdout.
//
// This isolates the question "does node-pty + xterm-headless still saturate
// when sandboxed inside a child_process?" — i.e. the eventual v0.3 daemon
// pty-host fork boundary (Task #45 / T4.1).
//
// Forever-stable contract (per tools/spike-harness/README.md):
//
//   Args:    none
//   Env:
//     PROBE_DURATION_MS  default 10000  forwarded to child --duration-ms
//     PROBE_COLS         default 120
//     PROBE_ROWS         default 40
//     PROBE_REPORT_MS    default 250
//     PROBE_TARGET_BYTES default 1073741824 (1 GiB)
//     PROBE_NDJSON_OUT   if set, write the raw NDJSON progress stream there
//
//   Stdout (one JSON line):
//     {"ok":true, "platform":..., "arch":..., "nodeVersion":...,
//      "durationMs":..., "emittedBytes":..., "bytesPerSec":...,
//      "rssBytesPeak":..., "rssBytesEnd":..., "heapUsedBytesPeak":...,
//      "targetHit":<bool>, "targetAtMs":..., "rssAtTargetBytes":...,
//      "samples":<int>}
//   Exit: 0 success; 1 child failure / no progress.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'child.mjs');

const DURATION_MS  = process.env.PROBE_DURATION_MS  ?? '10000';
const COLS         = process.env.PROBE_COLS         ?? '120';
const ROWS         = process.env.PROBE_ROWS         ?? '40';
const REPORT_MS    = process.env.PROBE_REPORT_MS    ?? '250';
const TARGET_BYTES = process.env.PROBE_TARGET_BYTES ?? String(1024 * 1024 * 1024);

const ndjsonOut = process.env.PROBE_NDJSON_OUT
  ? createWriteStream(process.env.PROBE_NDJSON_OUT)
  : null;

// Spawn child via Node — explicitly child_process.spawn (NOT fork; fork
// implies an IPC channel and a Node-only target. We want plain spawn so the
// boundary mirrors the future daemon→pty-host process split).
const child = spawn(
  process.execPath,
  [
    CHILD,
    `--duration-ms=${DURATION_MS}`,
    `--cols=${COLS}`,
    `--rows=${ROWS}`,
    `--report-ms=${REPORT_MS}`,
    `--target-bytes=${TARGET_BYTES}`,
  ],
  { stdio: ['ignore', 'pipe', 'inherit'], env: process.env },
);

let buf = '';
let summary = null;
let target = null;
let samples = 0;
let rssPeak = 0;
let heapPeak = 0;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  if (ndjsonOut) ndjsonOut.write(chunk);
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'sample') {
      samples += 1;
      if (rec.rssBytes > rssPeak) rssPeak = rec.rssBytes;
      if (rec.heapUsedBytes > heapPeak) heapPeak = rec.heapUsedBytes;
    } else if (rec.type === 'target') {
      target = rec;
      if (rec.rssBytes > rssPeak) rssPeak = rec.rssBytes;
    } else if (rec.type === 'summary') {
      summary = rec;
    } else if (rec.type === 'fatal') {
      process.stderr.write(`child fatal: ${JSON.stringify(rec)}\n`);
    }
  }
});

child.on('exit', (code, signal) => {
  if (ndjsonOut) ndjsonOut.end();
  if (!summary) {
    process.stdout.write(JSON.stringify({
      ok: false,
      reason: 'child-no-summary',
      childExit: code,
      childSignal: signal,
      samples,
    }) + '\n');
    process.exit(1);
  }
  if (summary.rssBytesEnd > rssPeak) rssPeak = summary.rssBytesEnd;
  if (summary.heapUsedBytesEnd > heapPeak) heapPeak = summary.heapUsedBytesEnd;
  const out = {
    ok: true,
    platform:        summary.platform,
    arch:            summary.arch,
    nodeVersion:     summary.nodeVersion,
    cols:            summary.cols,
    rows:            summary.rows,
    durationMs:      summary.durationMs,
    emittedBytes:    summary.emittedBytes,
    bytesPerSec:     summary.bytesPerSec,
    mibPerSec:       Number((summary.bytesPerSec / (1024 * 1024)).toFixed(2)),
    rssBytesPeak:     rssPeak,
    rssMiBPeak:       Number((rssPeak / (1024 * 1024)).toFixed(2)),
    rssBytesEnd:      summary.rssBytesEnd,
    heapUsedBytesPeak: heapPeak,
    targetHit:       summary.targetHit,
    targetAtMs:      target ? target.atMs : null,
    rssAtTargetBytes: target ? target.rssBytes : null,
    rssAtTargetMiB:   target ? Number((target.rssBytes / (1024 * 1024)).toFixed(2)) : null,
    samples,
    childExit:       code,
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
});

child.on('error', (e) => {
  process.stdout.write(JSON.stringify({
    ok: false, reason: 'child-spawn-failed', error: String(e),
  }) + '\n');
  process.exit(1);
});
