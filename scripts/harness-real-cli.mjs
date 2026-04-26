// Themed harness — REAL-CLI cluster.
//
// Mini-runner for cases that spawn the real `claude` CLI process via
// stream-json IO (no Electron, no Playwright). These cases are too cheap
// to justify a per-file probe (cold-spawn ~1.5s each) and share enough
// scaffolding (env scrub, JSONL line parser, hard-timeout) that bundling
// them into one harness eliminates duplication.
//
// This harness is INDEPENDENT of probe-helpers/harness-runner.mjs — that
// runner is built around an Electron BrowserWindow lifecycle which these
// cases don't use. Keeping the dispatcher local is ~80 LOC and avoids
// invented capability in the shared runner just for one harness.
//
// Cases (1):
//   - control-response-no-timeout (was probe-e2e-control-response-no-timeout.mjs)
//
// Run:        `node scripts/harness-real-cli.mjs`
// Run one:    `node scripts/harness-real-cli.mjs --only=control-response-no-timeout`
//
// CLI gating: if `claude` is not on PATH, the entire harness exits 0 with
// a "skipped" log line. Mirrors the harness-* convention — env problems
// are user-fixable, not test failures. Set `CCSM_REAL_CLI_REQUIRE=1` to
// force a hard fail when the CLI is missing (CI use).

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const NAME = 'harness-real-cli';

// ---------- arg parsing ----------
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const onlyId = onlyArg ? onlyArg.slice('--only='.length) : null;

// ---------- CLI presence gate ----------
function requiresClaudeBin() {
  // `where` on Windows, `which` on POSIX. We don't actually need the path —
  // just the exit code. shell:true keeps PATHEXT (.cmd/.exe) resolution.
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, ['claude'], { stdio: 'ignore', shell: true, windowsHide: true });
  return r.status === 0;
}

if (!requiresClaudeBin()) {
  if (process.env.CCSM_REAL_CLI_REQUIRE === '1') {
    console.error(`[${NAME}] FAIL: claude binary not found on PATH (CCSM_REAL_CLI_REQUIRE=1)`);
    process.exit(1);
  }
  console.log(`[${NAME}] SKIP: claude binary not on PATH — set CCSM_REAL_CLI_REQUIRE=1 to fail instead`);
  process.exit(0);
}

// ---------- shared spawn helpers ----------
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const CONFIG_DIR = process.env.CCSM_CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');

/**
 * Build the env that real `claude` expects when launched outside an
 * existing Claude Code session. CLAUDECODE/CLAUDE_CODE_ENTRYPOINT must be
 * stripped or the binary refuses to start with "already inside a Claude
 * session" — bites whenever the harness itself runs from a Claude Code
 * agent loop.
 */
function claudeEnv(extra = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR, ...extra };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

// ---------- cases ----------

/**
 * Bug K / Task #142: ControlResponseEventSchema must match the real CLI
 * wire format `{ type, response: { subtype, request_id, response } }`.
 *
 * Pre-fix: schema expected `{ type, request_id, response }` at top level —
 * every outbound control_request (initialize / interrupt / set_model /
 * set_permission_mode) silently 5s-timed-out.
 *
 * This case spawns a real claude with stream-json IO, sends `initialize`
 * + `set_permission_mode`, and asserts each control_response arrives in
 * < 3s with no "control_request timed out" diagnostic.
 *
 * Reverse-verify: revert handleControlResponse to read `frame.request_id`
 * (top level) — the 1s budget elapses and this case fails.
 */
async function caseControlResponseNoTimeout({ log }) {
  const ROUND_TRIP_BUDGET_MS = 3000;
  const HARD_TIMEOUT_MS = 15_000;

  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--permission-prompt-tool', 'stdio',
  ];

  log(`spawning claude with ${args.join(' ')}`);
  const child = spawn('claude', args, {
    cwd: process.cwd(),
    env: claudeEnv(),
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  const diagnostics = [];
  const initId = `req_${randomUUID()}`;
  const modeId = `req_${randomUUID()}`;

  return await new Promise((resolve, reject) => {
    let finished = false;

    function done(err) {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      try { child.kill(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve();
    }

    const hardTimer = setTimeout(() => {
      done(new Error(`hard timeout (${HARD_TIMEOUT_MS}ms) — at least one control_request never came back; pending=${[...pending.keys()].join(',')}`));
    }, HARD_TIMEOUT_MS);

    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      if (/control_request.*timed out/i.test(s)) {
        diagnostics.push(s.trim());
      }
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

        // Wire shape (documented): request_id is nested inside `response`.
        // We read it directly here — independent of the dispatcher under
        // test — to lock down the shape itself.
        const envelope = parsed.response;
        if (!envelope || typeof envelope !== 'object') {
          return done(new Error(`control_response without response envelope: ${line}`));
        }
        const { request_id, subtype, error } = envelope;
        if (typeof request_id !== 'string') {
          return done(new Error(`control_response.response.request_id missing: ${line}`));
        }
        const entry = pending.get(request_id);
        if (!entry) continue;
        pending.delete(request_id);
        const elapsed = Date.now() - entry.sentAt;
        if (elapsed > ROUND_TRIP_BUDGET_MS) {
          return done(new Error(
            `${entry.label} took ${elapsed}ms (> ${ROUND_TRIP_BUDGET_MS}ms budget) — ` +
            `pre-fix this would have been ~5000ms (timeout fallback)`,
          ));
        }
        if (subtype === 'error') {
          return done(new Error(`${entry.label} returned error from CLI: ${error ?? 'unknown'}`));
        }
        log(`${entry.label} resolved in ${elapsed}ms (subtype=${subtype}, request_id=${request_id})`);

        if (pending.size === 0) {
          if (diagnostics.length > 0) {
            return done(new Error(`saw "control_request timed out" diagnostics:\n  ${diagnostics.join('\n  ')}`));
          }
          log(`both control_requests resolved within ${ROUND_TRIP_BUDGET_MS}ms each, no timeout diagnostics`);
          return done();
        }
      }
    });

    child.on('exit', (code, signal) => {
      if (finished) return;
      done(new Error(`claude exited unexpectedly (code=${code}, signal=${signal}) before all responses arrived; pending=${[...pending.keys()].join(',')}`));
    });

    child.on('error', (err) => {
      done(new Error(`spawn error: ${err.message}`));
    });

    // 1) initialize (matches what SessionRunner sends on start).
    const initFrame = {
      type: 'control_request',
      request_id: initId,
      request: { subtype: 'initialize', hooks: {} },
    };
    pending.set(initId, { sentAt: Date.now(), label: 'initialize' });
    child.stdin.write(JSON.stringify(initFrame) + '\n');

    // 2) set_permission_mode — canonical case where the 5s phantom timeout
    //    was observed in PR #167.
    setTimeout(() => {
      if (finished) return;
      const modeFrame = {
        type: 'control_request',
        request_id: modeId,
        request: { subtype: 'set_permission_mode', mode: 'default' },
      };
      pending.set(modeId, { sentAt: Date.now(), label: 'set_permission_mode' });
      try { child.stdin.write(JSON.stringify(modeFrame) + '\n'); } catch (e) {
        done(new Error(`failed to write set_permission_mode: ${e.message}`));
      }
    }, 200);
  });
}

// ---------- runner ----------
const cases = [
  { id: 'control-response-no-timeout', run: caseControlResponseNoTimeout },
];

const selected = onlyId ? cases.filter((c) => c.id === onlyId) : cases;
if (onlyId && selected.length === 0) {
  console.error(`[${NAME}] FAIL: --only=${onlyId} matched no case. Available: ${cases.map((c) => c.id).join(', ')}`);
  process.exit(1);
}

console.log(`[${NAME}] running ${selected.length} case(s)${onlyId ? ` (--only=${onlyId})` : ''}`);

let failed = 0;
for (const c of selected) {
  const log = (msg) => console.log(`[${NAME}:${c.id}] ${msg}`);
  const started = Date.now();
  try {
    await c.run({ log });
    console.log(`[${NAME}] PASS  ${c.id} (${Date.now() - started}ms)`);
  } catch (err) {
    failed += 1;
    console.error(`[${NAME}] FAIL  ${c.id} (${Date.now() - started}ms): ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  }
}

if (failed > 0) {
  console.error(`\n[${NAME}] ${failed}/${selected.length} case(s) failed`);
  process.exit(1);
}
console.log(`\n[${NAME}] all ${selected.length} case(s) passed`);
process.exit(0);
