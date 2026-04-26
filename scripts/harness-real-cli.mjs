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
import fs from 'node:fs';
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

/**
 * Bug: agent self-reports as "Claude Code (VS Code integration)" when the
 * user has the official Claude Code VS Code extension running, because the
 * bundled CLI scans `${CLAUDE_CONFIG_DIR}/ide/*.lock` and auto-attaches to
 * any companion whose workspaceFolders include the session cwd. ccsm sets
 * `CLAUDE_CODE_AUTO_CONNECT_IDE=false` in `electron/agent-sdk/sessions.ts`
 * `buildSdkEnv` to kill that gate. The unit test on the env-construction
 * path proves the env var lands on options.env, but does NOT prove the
 * bundled CLI still recognises the kill-switch — an SDK bump that renamed
 * or removed the env var would let the unit test stay green while the bug
 * recurs.
 *
 * Why this case scans the bundle instead of spawning + asserting on the
 * `system/init` `mcp_servers` array:
 *   - Triggering a real auto-attach requires a live websocket server that
 *     answers the bundled CLI's IDE handshake (the lockfile alone is not
 *     enough; the bundle's gate also requires
 *     `M.workspaceFolders.some(P => Hh.resolve(P).normalize("NFC") === cwd)`
 *     plus a successful `ws://127.0.0.1:<port>` connect with a matching
 *     `authToken`). On a clean dev machine without a real VS Code/Claude
 *     extension running, even removing the kill-switch leaves
 *     `mcp_servers: []` — so the negative assertion is vacuously true and
 *     would not detect a regression. Verified empirically by spawning the
 *     real CLI with `autoConnectIde:true` + a fake lockfile pointing at a
 *     bound TCP server: no handshake attempt was made.
 *   - The SDK ships the CLI as a single SEA executable
 *     (`@anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude.exe`).
 *     The string `CLAUDE_CODE_AUTO_CONNECT_IDE` is embedded in that bundle
 *     and is the SAME literal the kill-switch path reads at runtime
 *     (`yH(process.env.CLAUDE_CODE_AUTO_CONNECT_IDE)` /
 *     `a7(process.env.CLAUDE_CODE_AUTO_CONNECT_IDE)`). If a future SDK
 *     bump renames or removes the env var, the literal disappears from
 *     the bundle and this case fails — exactly the regression class the
 *     unit test misses.
 *
 * Run cost: ~250ms (one ReadFileSync + indexOf, no spawn).
 */
async function caseIdeAutoConnectKillSwitchPresent({ log }) {
  // Resolve the bundled CLI binary the SDK would actually spawn. We pin
  // to the platform package next to @anthropic-ai/claude-agent-sdk so this
  // tracks whatever version package.json locked in.
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const { createRequire } = await import('node:module');
  const require_ = createRequire(import.meta.url);
  let pkgRoot;
  try {
    pkgRoot = path.dirname(require_.resolve(`${platformPkg}/package.json`));
  } catch {
    log(`SKIP: ${platformPkg} not installed (no bundled CLI to scan)`);
    return;
  }
  const exe = path.join(pkgRoot, process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (!fs.existsSync(exe)) {
    log(`SKIP: ${exe} not found (bundled CLI absent)`);
    return;
  }

  // ASCII string scan — the env var is referenced as a property access
  // on `process.env`, so it appears as a contiguous ASCII literal in the
  // SEA bundle. indexOf is fast even on a 250 MB binary (~200ms).
  const needle = 'CLAUDE_CODE_AUTO_CONNECT_IDE';
  const buf = fs.readFileSync(exe);
  // toString('binary') maps each byte 1:1 to a JS char so indexOf works
  // on arbitrary binary content without UTF-8 decoding cost or corruption.
  const text = buf.toString('binary');
  const at = text.indexOf(needle);
  if (at < 0) {
    throw new Error(
      `bundled CLI at ${exe} no longer references "${needle}". ` +
      `The SDK likely renamed or removed the IDE auto-connect kill-switch — ` +
      `ccsm's fix in electron/agent-sdk/sessions.ts buildSdkEnv is now a no-op ` +
      `and "agent self-reports as VS Code integration" will recur. ` +
      `Re-scan claude.exe for the current opt-out and update buildSdkEnv to match.`,
    );
  }
  log(`bundled CLI references "${needle}" at offset ${at} (${(buf.length / 1e6).toFixed(0)} MB scanned) — kill-switch still recognised`);
}

/**
 * Task #312 / closes #290 / reopens what PR #346 hid.
 *
 * Regression guard: when the SDK-bundled CLI is launched with default
 * settingSources (i.e. ccsm omits the option, which loads user + project +
 * local settings — see node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
 * `Options.settingSources`), namespaced plugin commands declared via the
 * user's `~/.claude/settings.json` `enabledPlugins` map MUST execute via
 * the standard pass-through path. The CLI itself owns plugin discovery
 * and registration; the SDK's `plugins` option is only for SDK consumers
 * to inject EXTRA plugin paths.
 *
 * If a future SDK change moves plugin loading behind an opt-in flag, this
 * case fails — and ccsm has to wire `query({ options: { plugins: [...] }})`
 * to feed the user's installed plugin paths from commands-loader.ts.
 *
 * Why this case probes via stream-json instead of `--print`:
 *   - It mirrors what `electron/agent-sdk/sessions.ts` actually does (the
 *     SDK's own transport is stream-json over stdio).
 *   - `--print` shells out through the OS command line, which on Windows
 *     mangles `/superpowers:brainstorming` into a path. stream-json sends
 *     the literal string in a JSON-quoted `user` message — same as ccsm.
 *
 * Choice of test command: `/superpowers:brainstorming` (a SKILL command,
 * exposed as a slash because the user's `~/.claude/skills/` and the
 * superpowers plugin's bundled skills are loaded by the CLI). The
 * deprecated `/superpowers:brainstorm` (plugin command) returns a
 * deprecation banner that LOOKS like a "transport gap" — the canary phrase
 * in this case is therefore the absence of "deprecated and will be
 * removed", which is the literal banner the deprecated command emits.
 *
 * Pre-fix (PR #346 era): namespaced commands never reached the user
 * because the picker hid them and the InputBar bounced them locally with
 * an "Unknown command" toast. So the regression case here covers the
 * EXECUTION layer, not the UI layer (which the harness-ui case covers).
 *
 * Skips when no plugins/skills are installed in the test env's
 * CLAUDE_CONFIG_DIR — ccsm dev machines have them, CI may not.
 */
async function caseNamespacedCommandActuallyRuns({ log }) {
  // Pre-flight: confirm the user has the plugin installed. If not, skip
  // (don't fail) — we cover the contract on dev machines where it's set
  // up, and we'd rather know about a real regression than chase missing
  // test fixtures in CI.
  const installedManifest = path.join(CONFIG_DIR, 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(installedManifest)) {
    log(`SKIP: ${installedManifest} not present — no plugins installed in test env`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(installedManifest, 'utf8'));
  const hasSuperpowers = Object.keys(manifest.plugins ?? {}).some((k) =>
    k.startsWith('superpowers@')
  );
  if (!hasSuperpowers) {
    log(`SKIP: superpowers plugin not in ${installedManifest}`);
    return;
  }

  // Use the SDK-bundled binary (matches electron/agent-sdk/sessions.ts'
  // resolveClaudeInvocation when no system claude is present).
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const { createRequire } = await import('node:module');
  const require_ = createRequire(import.meta.url);
  let exe;
  try {
    const pkgRoot = path.dirname(require_.resolve(`${platformPkg}/package.json`));
    exe = path.join(pkgRoot, process.platform === 'win32' ? 'claude.exe' : 'claude');
  } catch {
    log(`SKIP: ${platformPkg} not installed`);
    return;
  }
  if (!fs.existsSync(exe)) {
    log(`SKIP: ${exe} not found`);
    return;
  }

  const HARD_TIMEOUT_MS = 90_000;

  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--allow-dangerously-skip-permissions',
  ];

  log(`spawning ${path.basename(exe)} ${args.join(' ')}`);
  const child = spawn(exe, args, {
    cwd: process.cwd(),
    env: claudeEnv(),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return await new Promise((resolve, reject) => {
    let finished = false;
    let assistantText = '';
    let resultPayload = null;
    let initSeen = false;
    let userSent = false;

    function done(err) {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      try { child.kill(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve();
    }

    const hardTimer = setTimeout(() => {
      done(new Error(
        `hard timeout (${HARD_TIMEOUT_MS}ms) — CLI never produced a result frame. ` +
        `initSeen=${initSeen} userSent=${userSent} assistantText so far: ${assistantText.slice(0, 200)} ` +
        `stderr tail: ${stderrBuf.slice(-300)}`,
      ));
    }, HARD_TIMEOUT_MS);

    let stderrBuf = '';
    child.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); });

    // Handshake: send a control_request initialize (matches what
    // electron/agent-sdk/sessions.ts does via the SDK transport). Without
    // it the CLI sits in input-format=stream-json mode waiting for the
    // initialize frame and never emits the `system/init` message.
    const initId = `req_${randomUUID()}`;
    try {
      child.stdin.write(JSON.stringify({
        type: 'control_request',
        request_id: initId,
        request: { subtype: 'initialize', hooks: {} },
      }) + '\n');
    } catch (e) {
      return done(new Error(`failed to write initialize: ${e.message}`));
    }

    // Send the user message immediately after init — the CLI buffers it
    // until handshake completes.
    function sendUser() {
      if (userSent) return;
      userSent = true;
      const userMsg = {
        type: 'user',
        message: {
          role: 'user',
          content: '/superpowers:brainstorming I want to build a small CLI tool',
        },
        parent_tool_use_id: null,
        session_id: '00000000-0000-0000-0000-000000000000',
      };
      try { child.stdin.write(JSON.stringify(userMsg) + '\n'); } catch (e) {
        return done(new Error(`failed to write user message: ${e.message}`));
      }
    }

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

        if (parsed.type === 'control_response') {
          // Handshake complete — fire the user message.
          sendUser();
          continue;
        }

        if (parsed.type === 'system' && parsed.subtype === 'init') {
          initSeen = true;
          // Some CLI versions emit init unsolicited; send if we haven't yet.
          sendUser();
          continue;
        }

        if (parsed.type === 'assistant' && parsed.message?.content) {
          for (const c of parsed.message.content) {
            if (c.type === 'text' && typeof c.text === 'string') {
              assistantText += c.text;
            }
          }
        }

        if (parsed.type === 'result') {
          resultPayload = parsed;
          // The deprecated /superpowers:brainstorm plugin command's
          // canonical reply is "deprecated and will be removed" — this is
          // the SAME phrase PR #346 misread as a transport failure. The
          // brainstorming SKILL invocation should NOT contain it.
          const lc = (assistantText + ' ' + (parsed.result ?? '')).toLowerCase();
          const sawDeprecationStub = lc.includes('deprecated and will be removed');
          // We also want a sign the slash command was UNDERSTOOD (not
          // bounced as plain text). Skill output varies wildly; threshold
          // is "any successful non-error result with non-empty text" —
          // pre-fix the model would have replied "I don't understand
          // /superpowers:..." or echoed back the prompt. The deprecation
          // canary above is the harder test.
          const isError = parsed.is_error === true || parsed.subtype === 'error';
          const hasContent = assistantText.trim().length > 0 ||
            (typeof parsed.result === 'string' && parsed.result.trim().length > 0);

          if (!userSent) {
            return done(new Error('result arrived before we sent the slash command'));
          }
          if (isError) {
            return done(new Error(
              `CLI returned error result: ${JSON.stringify(parsed).slice(0, 400)}`,
            ));
          }
          if (sawDeprecationStub) {
            return done(new Error(
              `assistant reply contained the "deprecated and will be removed" canary — ` +
              `either the wrong command was invoked, or the plugin/skill loading regressed. ` +
              `text: ${assistantText.slice(0, 300)}`,
            ));
          }
          if (!hasContent) {
            return done(new Error(
              `assistant produced no real content — likely the slash command was treated ` +
              `as plain prose. text: ${assistantText.slice(0, 300)} / result: ${String(parsed.result).slice(0, 200)}`,
            ));
          }
          log(`namespaced command produced ${assistantText.length}-char reply, no deprecation canary`);
          return done();
        }
      }
    });

    child.on('exit', (code, signal) => {
      if (finished) return;
      done(new Error(
        `CLI exited unexpectedly (code=${code}, signal=${signal}) before result. ` +
        `stderr tail: ${stderrBuf.slice(-400)}`,
      ));
    });

    child.on('error', (err) => {
      done(new Error(`spawn error: ${err.message}`));
    });
  });
}

// ---------- runner ----------
const cases = [
  { id: 'control-response-no-timeout', run: caseControlResponseNoTimeout },
  { id: 'ide-auto-connect-kill-switch-present', run: caseIdeAutoConnectKillSwitchPresent },
  { id: 'namespaced-command-actually-runs', run: caseNamespacedCommandActuallyRuns },
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
