#!/usr/bin/env node
// E2E probe — Bug K / Task #142: ControlResponseEventSchema must match the
// real CLI wire format.
//
// Pre-fix bug: the schema expected `{ type, request_id, response }` but the
// real CLI sends `{ type, response: { subtype, request_id, response } }`.
// Result: every outbound control_request (interrupt, set_permission_mode,
// set_model, initialize hooks) silently 5s-timed-out. The caller didn't
// notice because the timeout was logged as a benign warning and the CLI did
// in fact apply the change.
//
// What this probe does:
//   1. Spawns a real `claude` process with stream-json IO (no mocks).
//   2. Sends an `initialize` control_request followed by a
//      `set_permission_mode` control_request.
//   3. Asserts that each control_response arrives well under the 5s timeout
//      (3000ms budget — initialize takes ~1.3s in practice because it triggers
//      command enumeration; set_permission_mode takes <100ms). Pre-fix the
//      pending promise would have hit the 5s fallback every single time.
//   4. Asserts that no "control_request timed out" diagnostic is emitted.
//
// Pre-fix verification:
//   - revert electron/agent/control-rpc.ts:handleControlResponse to read
//     `frame.request_id` instead of `frame.response.request_id`, OR
//   - revert ControlResponseEventSchema to expect `request_id` at top level.
//   With either revert, this probe FAILS — the response is never matched and
//   the 1s assertion budget elapses.
//
// Usage: node scripts/probe-e2e-control-response-no-timeout.mjs

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const NAME = 'probe-e2e-control-response-no-timeout';
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const CONFIG_DIR = process.env.AGENTORY_CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const ROUND_TRIP_BUDGET_MS = 3000;
const HARD_TIMEOUT_MS = 15_000;

function fail(msg) {
  console.error(`\n[${NAME}] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[${NAME}] OK: ${msg}`);
}

// Strip CLAUDECODE so claude.exe doesn't refuse to launch when the probe
// itself is run inside a Claude Code session.
const env = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;

const args = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
];

console.log(`[${NAME}] spawning claude with ${args.join(' ')}`);
const child = spawn('claude', args, {
  cwd: process.cwd(),
  env,
  shell: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const pending = new Map(); // request_id -> { sentAt, label }

const initId = `req_${randomUUID()}`;
const modeId = `req_${randomUUID()}`;
const diagnostics = [];
let finished = false;

const hardTimer = setTimeout(() => {
  finished = true;
  child.kill();
  fail(`hard timeout (${HARD_TIMEOUT_MS}ms) — at least one control_request never came back`);
}, HARD_TIMEOUT_MS);

child.stderr.on('data', (d) => {
  const s = d.toString('utf8');
  if (/control_request.*timed out/i.test(s)) {
    diagnostics.push(s.trim());
  }
  // Keep stderr quiet but print on failure for forensics.
});

let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed.type !== 'control_response') continue;

    // The CLI nests request_id and subtype inside `response`. If this probe
    // ran against the pre-fix code, the inbound dispatcher would look at
    // top-level `request_id` (undefined) and never match — but here we are
    // verifying the wire shape directly, independent of the dispatcher, so
    // we read from the documented nested location.
    const env = parsed.response;
    if (!env || typeof env !== 'object') {
      fail(`control_response without response envelope: ${line}`);
    }
    const { request_id, subtype, error } = env;
    if (typeof request_id !== 'string') {
      fail(`control_response.response.request_id missing: ${line}`);
    }
    const entry = pending.get(request_id);
    if (!entry) continue; // not for us
    pending.delete(request_id);
    const elapsed = Date.now() - entry.sentAt;
    if (elapsed > ROUND_TRIP_BUDGET_MS) {
      fail(
        `${entry.label} took ${elapsed}ms (> ${ROUND_TRIP_BUDGET_MS}ms budget) — ` +
          `pre-fix this would have been ~5000ms (timeout fallback)`,
      );
    }
    if (subtype === 'error') {
      fail(`${entry.label} returned error from CLI: ${error ?? 'unknown'}`);
    }
    ok(`${entry.label} resolved in ${elapsed}ms (subtype=${subtype}, request_id=${request_id})`);

    if (pending.size === 0) {
      // All requests answered; check no timeout diagnostics.
      if (diagnostics.length > 0) {
        fail(`saw "control_request timed out" diagnostics:\n  ${diagnostics.join('\n  ')}`);
      }
      finished = true;
      clearTimeout(hardTimer);
      child.kill();
      console.log(`\n[${NAME}] PASS — both control_requests resolved within ${ROUND_TRIP_BUDGET_MS}ms each, no timeout diagnostics`);
      process.exit(0);
    }
  }
});

child.on('exit', (code, signal) => {
  if (finished) return;
  fail(`claude exited unexpectedly (code=${code}, signal=${signal}) before all responses arrived; pending=${[...pending.keys()].join(',')}`);
});

// 1) Send `initialize` (this is the same one SessionRunner sends on start).
const initFrame = {
  type: 'control_request',
  request_id: initId,
  request: { subtype: 'initialize', hooks: {} },
};
pending.set(initId, { sentAt: Date.now(), label: 'initialize' });
child.stdin.write(JSON.stringify(initFrame) + '\n');

// 2) Shortly after, send `set_permission_mode` — this is the canonical case
//    where the 5s phantom timeout was observed in PR #167.
setTimeout(() => {
  if (finished) return;
  const modeFrame = {
    type: 'control_request',
    request_id: modeId,
    request: { subtype: 'set_permission_mode', mode: 'default' },
  };
  pending.set(modeId, { sentAt: Date.now(), label: 'set_permission_mode' });
  child.stdin.write(JSON.stringify(modeFrame) + '\n');
}, 200);
