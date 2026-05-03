#!/usr/bin/env node
// child.mjs — runs inside the forked child_process for T9.6 PTY throughput spike.
//
// Spawns a `yes`-style workload through node-pty, feeds every chunk into a
// long-lived `@xterm/headless` Terminal, and emits periodic NDJSON progress
// records on stdout for the parent (probe.mjs) to aggregate.
//
// Forever-stable contract (per tools/spike-harness/README.md):
//
//   Args:
//     --duration-ms=<int>   default 10000
//     --cols=<int>          default 120
//     --rows=<int>          default 40
//     --report-ms=<int>     default 250  (sample interval)
//     --target-bytes=<int>  default 1073741824 (1 GiB) — record RSS when crossed
//
//   Stdout (NDJSON, one record per line):
//     {"type":"sample","tMs":<int>,"emittedBytes":<int>,
//      "rssBytes":<int>,"heapUsedBytes":<int>}
//     {"type":"target","atMs":<int>,"emittedBytes":<int>,"rssBytes":<int>}
//     {"type":"summary",...} (final, before exit)
//
//   Exit: 0 on clean stop; 1 on spawn/load failure.

import { parseArgs } from 'node:util';
import { spawn as ptySpawn } from 'node-pty';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;

const { values } = parseArgs({
  options: {
    'duration-ms':  { type: 'string', default: '10000' },
    cols:           { type: 'string', default: '120' },
    rows:           { type: 'string', default: '40' },
    'report-ms':    { type: 'string', default: '250' },
    'target-bytes': { type: 'string', default: String(1024 * 1024 * 1024) },
  },
  strict: true,
});

const DURATION_MS = Number(values['duration-ms']);
const COLS        = Number(values.cols);
const ROWS        = Number(values.rows);
const REPORT_MS   = Number(values['report-ms']);
const TARGET_B    = Number(values['target-bytes']);

function emit(rec) {
  process.stdout.write(JSON.stringify(rec) + '\n');
}

// Workload: an unbounded stream of "y\n". We use a Node one-liner so the
// behavior is identical on win32 / darwin / linux. This stands in for `yes`
// (and is effectively `yes | cat` because node-pty IS the cat: it just relays
// every byte the child writes to the controlling terminal).
const isWin = process.platform === 'win32';
const shell = process.execPath; // node binary, portable
const args  = [
  '-e',
  // Write 64 KiB chunks of 'y\n' to maximize throughput while staying within a
  // single write() boundary on the slave PTY.
  "const c=Buffer.alloc(65536,'y\\n');process.stdout.write(c);" +
  "setInterval(()=>process.stdout.write(c),0);",
];

let term;
try {
  term = ptySpawn(shell, args, {
    name: 'xterm-color',
    cols: COLS,
    rows: ROWS,
    cwd: process.cwd(),
    env: process.env,
    handleFlowControl: false,
  });
} catch (e) {
  emit({ type: 'fatal', stage: 'pty-spawn', error: String(e) });
  process.exit(1);
}

let xt;
try {
  xt = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: 1000,
    allowProposedApi: true,
  });
} catch (e) {
  emit({ type: 'fatal', stage: 'xterm-construct', error: String(e) });
  try { term.kill(); } catch { /* ignore */ }
  process.exit(1);
}

let emittedBytes = 0;
let targetHit = false;
const start = Date.now();

term.onData((d) => {
  // node-pty hands strings; convert to byte length via Buffer.byteLength to
  // count actual bytes on the wire (UTF-8). For ASCII workload this equals
  // d.length, but we keep the explicit measurement for honesty.
  const n = Buffer.byteLength(d, 'utf8');
  emittedBytes += n;
  // Feed the TTY bytes into the headless terminal — this is the work we are
  // measuring (parse + scroll + line buffer maintenance under realistic I/O).
  xt.write(d);
  if (!targetHit && emittedBytes >= TARGET_B) {
    targetHit = true;
    const mu = process.memoryUsage();
    emit({
      type: 'target',
      atMs: Date.now() - start,
      emittedBytes,
      rssBytes: mu.rss,
      heapUsedBytes: mu.heapUsed,
    });
  }
});

const sampleTimer = setInterval(() => {
  const mu = process.memoryUsage();
  emit({
    type: 'sample',
    tMs: Date.now() - start,
    emittedBytes,
    rssBytes: mu.rss,
    heapUsedBytes: mu.heapUsed,
  });
}, REPORT_MS);

const stopTimer = setTimeout(() => {
  clearInterval(sampleTimer);
  try { term.kill(); } catch { /* ignore */ }
  // Allow xterm.write() to drain its internal queue.
  setImmediate(() => {
    const mu = process.memoryUsage();
    const ms = Date.now() - start;
    emit({
      type: 'summary',
      durationMs: ms,
      emittedBytes,
      bytesPerSec: ms > 0 ? Math.round((emittedBytes * 1000) / ms) : 0,
      rssBytesEnd: mu.rss,
      heapUsedBytesEnd: mu.heapUsed,
      targetHit,
      cols: COLS,
      rows: ROWS,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    });
    process.exit(0);
  });
}, DURATION_MS);

term.onExit(() => {
  // Workload is unbounded; if it dies before duration we still emit a
  // truncated summary so the parent never stalls.
  if (!targetHit && emittedBytes === 0) {
    emit({ type: 'fatal', stage: 'pty-exit-empty' });
    clearTimeout(stopTimer);
    clearInterval(sampleTimer);
    process.exit(1);
  }
});

// Avoid hoarding stderr from node-pty (e.g. ConPTY warnings) — funnel any
// debug into stderr untouched; parent treats stderr as opaque.
