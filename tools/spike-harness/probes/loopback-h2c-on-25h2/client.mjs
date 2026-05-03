#!/usr/bin/env node
// client.mjs — http2 (h2c) client over loopback TCP, sustained-traffic soak driver.
//
// Spike T9.3 (ch14 §1.3 phase 0.5): drives N req/sec against server.mjs for
// SPIKE_DURATION_SEC seconds (default 60 smoke; 3600 = 1h soak). Records
// p50/p95/p99 RTT, error count, and RSS delta. Per-RTT NDJSON goes to stderr
// for piping through tools/spike-harness/rtt-histogram.mjs.
//
// Forever-stable contract:
//
//   Usage:
//     client.mjs [--host=<addr>]      default 127.0.0.1
//                [--port=<int>]       required if --port-file not given
//                [--port-file=<path>] read port from this file if --port absent
//                [--rate=<n>]         req/sec, default 10
//                [--duration=<sec>]   overrides SPIKE_DURATION_SEC
//
//   Env:
//     SPIKE_DURATION_SEC   default 60 (smoke). 3600 = 1h soak.
//
//   Output (stdout, single trailing JSON line):
//     {"durationSec":<num>,"sent":<int>,"ok":<int>,"errors":<int>,
//      "p50Us":<int>,"p95Us":<int>,"p99Us":<int>,
//      "rssStartBytes":<int>,"rssEndBytes":<int>,"rssDeltaBytes":<int>,
//      "verdict":"PASS"|"FAIL","verdictReason":"<str>"}
//
//   Per-request RTT lines (NDJSON) go to stderr so they can be piped to
//   rtt-histogram.mjs without polluting the summary.
//
//   Exit codes: 0 PASS; 3 FAIL (errors > 1% or RSS climb > 50 MB);
//               2 bad arg / unsupported OS; 1 connect failure.
//
// Layer-1: node: stdlib only.

import { connect } from 'node:http2';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

if (platform() !== 'win32') {
  process.stderr.write(`loopback-h2c-on-25h2 client: non-win32 (${platform()}) — skipped\n`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    host:        { type: 'string', default: '127.0.0.1' },
    port:        { type: 'string' },
    'port-file': { type: 'string', default: join(tmpdir(), 'ccsm-loopback-h2c-port') },
    rate:        { type: 'string', default: '10' },
    duration:    { type: 'string' },
  },
  strict: true,
});

const host = values.host;
let port = values.port !== undefined ? Number(values.port) : NaN;
if (!Number.isFinite(port)) {
  try {
    port = Number(readFileSync(values['port-file'], 'utf8').trim());
  } catch (e) {
    process.stderr.write(`failed to read --port-file ${values['port-file']}: ${e.message}\n`);
    process.exit(2);
  }
}
if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  process.stderr.write('bad --port / --port-file content\n');
  process.exit(2);
}

const rate = Number(values.rate);
const durationSec = Number(values.duration ?? process.env.SPIKE_DURATION_SEC ?? '60');
if (!Number.isFinite(rate) || rate <= 0) { process.stderr.write('bad --rate\n'); process.exit(2); }
if (!Number.isFinite(durationSec) || durationSec <= 0) { process.stderr.write('bad --duration\n'); process.exit(2); }

const session = connect(`http://${host}:${port}`);

session.on('error', (err) => {
  process.stderr.write(`session error: ${err.message}\n`);
});

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
  session.once('connect', () => { clearTimeout(t); resolve(); });
  session.once('error',   (e) => { clearTimeout(t); reject(e); });
}).catch((e) => {
  process.stderr.write(`failed to connect: ${e.message}\n`);
  process.exit(1);
});

const samples = [];
let sent = 0;
let ok = 0;
let errors = 0;
const rssStart = process.memoryUsage().rss;

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

await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
clearInterval(reqTimer);

// Drain in-flight (cap 2s).
await new Promise((resolve) => setTimeout(resolve, Math.min(2000, intervalMs * 5)));

session.close();

samples.sort((a, b) => a - b);
const pct = (p) => samples.length === 0 ? 0 : samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
const rssEnd = process.memoryUsage().rss;
const rssDelta = rssEnd - rssStart;

// Verdict thresholds (mirrors uds-h2c probe; fd-snapshot dropped — Windows
// has no equivalent cheap probe and lsof / handle.exe would break Layer-1
// stdlib-only constraint):
//   - error rate <= 1 %
//   - RSS climb <= 50 MB
const errRatio = sent === 0 ? 1 : errors / sent;
let verdict = 'PASS';
let verdictReason = 'thresholds met';
if (errRatio > 0.01) {
  verdict = 'FAIL';
  verdictReason = `error ratio ${(errRatio * 100).toFixed(2)}% > 1%`;
} else if (rssDelta > 50 * 1024 * 1024) {
  verdict = 'FAIL';
  verdictReason = `RSS climbed ${rssDelta} bytes > 50MB`;
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
  rssEndBytes:   rssEnd,
  rssDeltaBytes: rssDelta,
  verdict,
  verdictReason,
}) + '\n');

process.exit(verdict === 'PASS' ? 0 : 3);
