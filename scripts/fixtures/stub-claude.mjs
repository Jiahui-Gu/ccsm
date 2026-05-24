#!/usr/bin/env node
// Stub-claude fixture for PR #1357 dogfood probes.
//
// Spec (from `scratch/dogfood-pr-1355.md` Round 2):
//   1. Emit a header line "stub-claude online".
//   2. Wait STUB_BURST_DELAY_MS (default 1500ms).
//   3. Emit 200 numbered lines "line 001" ... "line 200" (zero-padded so
//      lex order matches numeric).
//   4. Emit ">>> stub-claude ready" as the final sentinel.
//   5. Keep stdin open + 30s heartbeat (a single ASCII bell on stderr,
//      which xterm parser swallows silently) so node-pty doesn't reap us.
//
// Optional: writes one line per spawn to STUB_SENTINEL_FILE (if set) with
// the argv it was invoked with — proves the ccsm pty actually launched
// this binary via the claude.cmd shim on PATH.

import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const sentinelPath = process.env.STUB_SENTINEL_FILE;
if (sentinelPath) {
  try {
    appendFileSync(
      sentinelPath,
      JSON.stringify({ t: new Date().toISOString(), pid: process.pid, argv }) + '\n',
    );
  } catch {
    /* best-effort */
  }
}

const burstDelay = Number(process.env.STUB_BURST_DELAY_MS ?? 1500);

process.stdout.write('stub-claude online\r\n');

// Keep stdin open so node-pty's "child still alive" reaper is happy.
try {
  process.stdin.resume();
  process.stdin.on('data', () => {
    /* swallow — we don't echo or process input */
  });
} catch {
  /* ignore */
}

setTimeout(() => {
  // Burst: 200 zero-padded numbered lines.
  let out = '';
  for (let i = 1; i <= 200; i++) {
    const n = String(i).padStart(3, '0');
    out += `line ${n}\r\n`;
  }
  process.stdout.write(out);
  process.stdout.write('>>> stub-claude ready\r\n');
}, burstDelay);

// Heartbeat so node-pty + electron don't decide we exited mid-test.
const heartbeat = setInterval(() => {
  // Empty stderr write keeps the FD warm without polluting the TUI.
  try { process.stderr.write(''); } catch { /* ignore */ }
}, 30000);

const shutdown = () => {
  clearInterval(heartbeat);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown);
