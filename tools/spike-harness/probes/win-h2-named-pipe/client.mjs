#!/usr/bin/env node
// client.mjs — http2 (h2c) client over a Windows named pipe, sustained-
// traffic soak driver.
//
// Spike T9.5: drives N req/sec against server.mjs for SPIKE_DURATION_SEC
// seconds (default 60 smoke; 3600 = 1h soak). Records p50/p95/p99 RTT,
// error count, and handle count snapshots every 60s. Win32-only.
//
// Forever-stable contract:
//
//   Usage:
//     client.mjs [--pipe=<name>]    default ccsm-spike (resolved to
//                                   \\?\pipe\<name>)
//                [--rate=<n>]       req/sec, default 10
//                [--duration=<sec>] overrides SPIKE_DURATION_SEC
//
//   Env:
//     SPIKE_DURATION_SEC   default 60 (smoke). 3600 = 1h soak.
//
//   Output (stdout, single trailing JSON line):
//     {"durationSec":<num>,"sent":<int>,"ok":<int>,"errors":<int>,
//      "p50Us":<int>,"p95Us":<int>,"p99Us":<int>,
//      "rssStartBytes":<int>,"rssEndBytes":<int>,"rssDeltaBytes":<int>,
//      "handleSnapshots":[{"tSec":<int>,"handleCount":<int|null>}],
//      "verdict":"PASS"|"FAIL","verdictReason":"<str>"}
//
//   Per-request RTT lines (NDJSON) go to stderr so they can be piped to
//   rtt-histogram.mjs without polluting the summary.
//
//   Exit codes: 0 PASS; 3 FAIL (errors > 1%, RSS > 50MB, or handle leak
//               > 5); 2 unsupported OS / bad arg; 1 connect failure.
//
// Note: there is no /proc/self/fd on Windows. We approximate "no leak" by
// sampling process._getActiveHandles().length — a Node-internal but stable-
// in-practice probe — and by the RSS-climb threshold. This matches the
// UDS spike's macOS path (where /proc is also absent and RSS carries the
// leak signal).
//
// Layer-1: node: stdlib only.

import { connect } from 'node:http2';
import * as net from 'node:net';
import { parseArgs } from 'node:util';
import { platform } from 'node:os';

if (platform() !== 'win32') {
  process.stderr.write('win-h2-named-pipe client: only supported on win32\n');
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    pipe:     { type: 'string', default: 'ccsm-spike' },
    rate:     { type: 'string', default: '10' },
    duration: { type: 'string' },
  },
  strict: true,
});

function resolvePipePath(input) {
  if (input.startsWith('\\\\?\\pipe\\') || input.startsWith('\\\\.\\pipe\\')) {
    return input;
  }
  return `\\\\?\\pipe\\${input}`;
}
const pipePath = resolvePipePath(values.pipe);
const rate = Number(values.rate);
const durationSec = Number(values.duration ?? process.env.SPIKE_DURATION_SEC ?? '60');
if (!Number.isFinite(rate) || rate <= 0) { process.stderr.write('bad --rate\n'); process.exit(2); }
if (!Number.isFinite(durationSec) || durationSec <= 0) { process.stderr.write('bad --duration\n'); process.exit(2); }

const session = connect('http://localhost', {
  createConnection: () => net.connect(pipePath),
});

session.on('error', (err) => {
  process.stderr.write(`session error: ${err.message}\n`);
});

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
  session.once('connect', () => { clearTimeout(t); resolve(); });
  session.once('error', (e) => { clearTimeout(t); reject(e); });
}).catch((e) => {
  process.stderr.write(`failed to connect: ${e.message}\n`);
  process.exit(1);
});

const samples = [];
let sent = 0;
let ok = 0;
let errors = 0;
const handleSnapshots = [];
const rssStart = process.memoryUsage().rss;

function handleCount() {
  // process._getActiveHandles is undocumented but has been a stable
  // Node-core probe across v18/v20/v22/v24. We tolerate its absence.
  try {
    if (typeof process._getActiveHandles === 'function') {
      return process._getActiveHandles().length;
    }
  } catch { /* fall through */ }
  return null;
}

function snapshot(tSec) {
  handleSnapshots.push({ tSec, handleCount: handleCount() });
}
snapshot(0);

function doRequest() {
  const start = process.hrtime.bigint();
  sent++;
  const req = session.request({ ':method': 'GET', ':path': '/ping' });
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const rttUs = Number((process.hrtime.bigint() - start) / 1000n);
    if (body === 'pong') {
      ok++;
      samples.push(rttUs);
      process.stderr.write(JSON.stringify({ rttUs }) + '\n');
    } else {
      errors++;
    }
  });
  req.on('error', () => { errors++; });
  req.end();
}

const intervalMs = 1000 / rate;
const startMs = Date.now();
const endMs = startMs + durationSec * 1000;

const reqTimer = setInterval(() => {
  if (Date.now() >= endMs) return;
  doRequest();
}, intervalMs);

const snapTimer = setInterval(() => {
  const tSec = Math.round((Date.now() - startMs) / 1000);
  snapshot(tSec);
}, 60_000);

await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
clearInterval(reqTimer);
clearInterval(snapTimer);

// Drain in-flight (cap 2s).
await new Promise((resolve) => setTimeout(resolve, Math.min(2000, intervalMs * 5)));

snapshot(durationSec);

session.close();

samples.sort((a, b) => a - b);
const pct = (p) => samples.length === 0 ? 0 : samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
const rssEnd = process.memoryUsage().rss;
const rssDelta = rssEnd - rssStart;

// Verdict thresholds (parity with T9.4 uds-h2c):
//   - error rate <= 1%
//   - RSS climb <= 50 MB
//   - if _getActiveHandles available, handle delta <= 5 (no leak)
const errRatio = sent === 0 ? 1 : errors / sent;
let verdict = 'PASS';
let verdictReason = 'thresholds met';
if (errRatio > 0.01) {
  verdict = 'FAIL';
  verdictReason = `error ratio ${(errRatio * 100).toFixed(2)}% > 1%`;
} else if (rssDelta > 50 * 1024 * 1024) {
  verdict = 'FAIL';
  verdictReason = `RSS climbed ${rssDelta} bytes > 50MB`;
} else {
  const haveHandles = handleSnapshots.filter((s) => s.handleCount !== null);
  if (haveHandles.length >= 2) {
    const hDelta = haveHandles[haveHandles.length - 1].handleCount - haveHandles[0].handleCount;
    if (hDelta > 5) {
      verdict = 'FAIL';
      verdictReason = `handle count climbed by ${hDelta} > 5 (leak)`;
    }
  }
}

process.stdout.write(JSON.stringify({
  durationSec,
  sent,
  ok,
  errors,
  p50Us: pct(0.50),
  p95Us: pct(0.95),
  p99Us: pct(0.99),
  rssStartBytes: rssStart,
  rssEndBytes: rssEnd,
  rssDeltaBytes: rssDelta,
  handleSnapshots,
  verdict,
  verdictReason,
}) + '\n');

process.exit(verdict === 'PASS' ? 0 : 3);
