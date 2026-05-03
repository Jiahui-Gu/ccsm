#!/usr/bin/env node
// client.mjs — http2 (h2c) client over UDS, sustained-traffic soak driver.
//
// Spike T9.4: drives N req/sec against server.mjs for SPIKE_DURATION_SEC
// seconds (default 60 smoke; 3600 = 1h soak). Records p50/p95/p99 RTT,
// error count, and fd count snapshots every 60s.
//
// Forever-stable contract:
//
//   Usage:
//     client.mjs [--socket=<path>]   default /tmp/ccsm-spike.sock
//                [--rate=<n>]        req/sec, default 10
//                [--duration=<sec>]  overrides SPIKE_DURATION_SEC
//
//   Env:
//     SPIKE_DURATION_SEC   default 60 (smoke). 3600 = 1h soak.
//
//   Output (stdout, single trailing JSON line):
//     {"durationSec":<num>,"sent":<int>,"ok":<int>,"errors":<int>,
//      "p50Us":<int>,"p95Us":<int>,"p99Us":<int>,
//      "rssStartBytes":<int>,"rssEndBytes":<int>,"rssDeltaBytes":<int>,
//      "fdSnapshots":[{"tSec":<int>,"fdCount":<int|null>}],
//      "verdict":"PASS"|"FAIL","verdictReason":"<str>"}
//
//   Per-request RTT lines (NDJSON) go to stderr so they can be piped to
//   rtt-histogram.mjs without polluting the summary.
//
//   Exit codes: 0 PASS; 3 FAIL (errors > 1%, RSS > 50MB, or fd leak > 5);
//               2 bad arg; 1 connect failure.
//
// Layer-1: node: stdlib only.

import { connect } from 'node:http2';
import * as net from 'node:net';
import { parseArgs } from 'node:util';
import { readdirSync } from 'node:fs';
import { platform } from 'node:os';

if (platform() === 'win32') {
  process.stderr.write('uds-h2c client: win32 unsupported\n');
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    socket:   { type: 'string', default: '/tmp/ccsm-spike.sock' },
    rate:     { type: 'string', default: '10' },
    duration: { type: 'string' },
  },
  strict: true,
});

const socketPath = values.socket;
const rate = Number(values.rate);
const durationSec = Number(values.duration ?? process.env.SPIKE_DURATION_SEC ?? '60');
if (!Number.isFinite(rate) || rate <= 0) { process.stderr.write('bad --rate\n'); process.exit(2); }
if (!Number.isFinite(durationSec) || durationSec <= 0) { process.stderr.write('bad --duration\n'); process.exit(2); }

const session = connect('http://localhost', {
  createConnection: () => net.connect(socketPath),
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
const fdSnapshots = [];
const rssStart = process.memoryUsage().rss;

function fdCount() {
  // Linux only: /proc/self/fd. macOS/other: return null.
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
}

function snapshot(tSec) {
  fdSnapshots.push({ tSec, fdCount: fdCount() });
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

// Verdict thresholds:
//   - error rate <= 1%
//   - RSS climb <= 50 MB
//   - if /proc/self/fd available, fd count delta <= 5 (no leak)
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
  const linuxFds = fdSnapshots.filter((s) => s.fdCount !== null);
  if (linuxFds.length >= 2) {
    const fdDelta = linuxFds[linuxFds.length - 1].fdCount - linuxFds[0].fdCount;
    if (fdDelta > 5) {
      verdict = 'FAIL';
      verdictReason = `fd count climbed by ${fdDelta} > 5 (leak)`;
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
  fdSnapshots,
  verdict,
  verdictReason,
}) + '\n');

process.exit(verdict === 'PASS' ? 0 : 3);
