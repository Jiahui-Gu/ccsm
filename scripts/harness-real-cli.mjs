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
import { fileURLToPath } from 'node:url';

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

/**
 * Bug #288 / #309: "Truncate from here" then re-send produces SDK exit 1
 * ("Failed to start Claude") AND/OR an off-by-one truncation that drops the
 * clicked block too.
 *
 * Repro path the user reported (issue #288 / #309):
 *   1. fresh session, send 3 turns: "你好" / wait / "你好" / wait / "你好" / wait
 *   2. hover the SECOND user message → click "Truncate from here"
 *   3. send "你好" again — observe SDK error / agent never replies
 *
 * Why this lives in harness-real-cli (not harness-agent):
 *   The mock CLI used by harness-agent never exits with a non-zero code on
 *   re-spawn for a session_id whose JSONL already exists, so the previous
 *   bug-fix worker could not reproduce. The real bundled CLI binary owns
 *   session_id collision behaviour, JSONL state validation, and the resume
 *   handshake — all of which are bypassed by the mock.
 *
 * What this case does:
 *   1. Reserve a fresh UUID session_id under a temp cwd.
 *   2. Run THREE conversation turns by spawning the real bundled CLI with
 *      `--session-id <fixed-uuid>` + stream-json IO and a single
 *      "say only the word OK" prompt per turn (~1.5s/turn). Each turn
 *      writes user+assistant frames to `~/.claude/projects/<key>/<uuid>.jsonl`.
 *   3. Read the JSONL and assert it has 3 user lines + 3 assistant lines —
 *      proves the 3-turn baseline.
 *   4. Simulate ccsm's "Truncate from here on the 2nd user message" the way
 *      `src/stores/store.ts` `rewindToBlock` does it — i.e. update the
 *      in-memory view but DO NOT modify the JSONL on disk (current ccsm
 *      design: "The CLI's on-disk JSONL is intentionally untouched"). We
 *      ALSO do not write a `--session-id` collision check, because that is
 *      the same call ccsm makes via the SDK on the next agentStart.
 *   5. Spawn the CLI a fourth time with the SAME `--session-id` and send
 *      one more "say only the word OK" turn — this is what
 *      `startSessionAndReconcile` triggers when the user resends after
 *      truncate. Capture stderr + exit code + result frame.
 *
 * Assertions (current code → expected to FAIL, surfacing the bugs):
 *   A) After turn 3, JSONL has 3 user + 3 assistant frames. (baseline)
 *   B) The JSONL truncation simulation is a no-op (current ccsm behavior).
 *   C) The 4th spawn produces a `result` frame within budget AND exits 0
 *      AND emits no "Failed to start Claude" / spawn-error stderr.
 *
 * Failure mode A would mean repro env can't even drive 3 turns — bail.
 * Failure mode C is the #288 reproduction.
 *
 * Note on bug #309 (off-by-one): the off-by-one is purely a renderer-side
 * `Array.slice` boundary in `rewindToBlock`. It cannot be exercised from a
 * CLI-only harness because the renderer is the one computing the cut. It is
 * covered by `scripts/harness-agent.mjs` case `user-block-hover-menu` (real
 * Playwright-driven store + UI) and the unit tests in
 * `tests/user-block-hover-menu.test.tsx`. The harness-real-cli case is the
 * #288-side reproduction (CLI-side state interaction).
 *
 * Hard timeout: 60s for the whole case (4 spawns × ~1.5s warmup +
 * ~1-3s per turn). Skips silently on missing bundled CLI per the standard
 * harness convention.
 */
async function caseTruncateFromHereThenResendRealCli({ log }) {
  // Resolve the bundled CLI binary (matches sessions.ts'
  // resolveClaudeInvocation default path).
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

  // Use a temp cwd so the JSONL file we create is isolated from any real
  // user history. The CLI derives the project-key from cwd by replacing
  // [\\/:] with '-' (see jsonl-loader.ts projectKeyFromCwd).
  const tmpCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-truncate-')));
  const sessionId = randomUUID();
  const projectKey = tmpCwd.replace(/[\\/:]/g, '-');
  const jsonlPath = path.join(CONFIG_DIR, 'projects', projectKey, `${sessionId}.jsonl`);
  log(`tmp cwd: ${tmpCwd}`);
  log(`session_id: ${sessionId}`);
  log(`expected jsonl: ${jsonlPath}`);

  const PER_TURN_BUDGET_MS = 30_000;
  const PROMPT = 'Reply with only the word OK and nothing else.';

  /**
   * Spawn one CLI process and stream `nTurns` user messages through it.
   * Resolves with { exitCode, stderr, results[], errors }.
   *
   * `mode` controls how the conversation is keyed:
   *   - 'preset': `--session-id <uuid>` (fresh-session flow). REJECTED by
   *     the bundled CLI on respawn when the JSONL already exists with
   *     `"Error: Session ID <uuid> is already in use."` (exit 1).
   *   - 'resume': `--resume <uuid>` (the post-truncate flow after the
   *     `rewindToBlock` fix in `src/stores/store.ts`).
   */
  async function runConversation(label, nTurns, mode = 'preset') {
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
      '--input-format', 'stream-json',
      '--permission-mode', 'bypassPermissions',
      '--allow-dangerously-skip-permissions',
      ...(mode === 'resume' ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ];
    log(`[${label}] spawn ${path.basename(exe)} ${args.join(' ')} (turns=${nTurns})`);
    const child = spawn(exe, args, {
      cwd: tmpCwd,
      env: claudeEnv(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return await new Promise((resolve) => {
      let finished = false;
      const results = [];
      let stderrBuf = '';
      let exitCode = null;
      let exitSignal = null;
      let turnsSent = 0;
      let initSeen = false;
      let assistantTextThisTurn = '';

      function done(reason) {
        if (finished) return;
        finished = true;
        clearTimeout(hardTimer);
        try { child.kill(); } catch { /* ignore */ }
        setTimeout(() => {
          resolve({
            exitCode,
            exitSignal,
            stderr: stderrBuf,
            results,
            reason,
          });
        }, 80);
      }

      const hardTimer = setTimeout(
        () => done(`hard timeout ${PER_TURN_BUDGET_MS * nTurns}ms`),
        PER_TURN_BUDGET_MS * nTurns,
      );

      child.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); });
      child.on('exit', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        if (!finished) done(`process exit code=${code} signal=${signal}`);
      });
      child.on('error', (err) => {
        stderrBuf += `\n[spawn error] ${err.message}`;
        done(`spawn error: ${err.message}`);
      });

      // initialize handshake
      try {
        child.stdin.write(JSON.stringify({
          type: 'control_request',
          request_id: `req_${randomUUID()}`,
          request: { subtype: 'initialize', hooks: {} },
        }) + '\n');
      } catch (e) {
        return done(`failed to write initialize: ${e.message}`);
      }

      function sendNextTurn() {
        if (turnsSent >= nTurns) return;
        turnsSent += 1;
        assistantTextThisTurn = '';
        const userMsg = {
          type: 'user',
          message: { role: 'user', content: PROMPT },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
        log(`[${label}] sending turn ${turnsSent}/${nTurns}`);
        try {
          child.stdin.write(JSON.stringify(userMsg) + '\n');
        } catch (e) {
          done(`failed to write user message: ${e.message}`);
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

          if (parsed.type === 'control_response' && !initSeen) {
            initSeen = true;
            sendNextTurn();
            continue;
          }
          if (parsed.type === 'system' && parsed.subtype === 'init' && !initSeen) {
            initSeen = true;
            sendNextTurn();
            continue;
          }
          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const c of parsed.message.content) {
              if (c.type === 'text' && typeof c.text === 'string') {
                assistantTextThisTurn += c.text;
              }
            }
          }
          if (parsed.type === 'result') {
            results.push({
              turn: turnsSent,
              isError: parsed.is_error === true || parsed.subtype === 'error',
              text: assistantTextThisTurn,
            });
            if (turnsSent < nTurns) {
              // Schedule next turn after a short pause to let CLI settle.
              setTimeout(() => sendNextTurn(), 200);
            } else {
              setTimeout(() => done('all turns complete'), 800);
            }
          }
        }
      });
    });
  }

  function countJsonlMessages() {
    if (!fs.existsSync(jsonlPath)) return { user: 0, assistant: 0, total: 0, exists: false };
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim());
    let user = 0, assistant = 0;
    for (const line of lines) {
      try {
        const f = JSON.parse(line);
        if (f.type === 'user') user += 1;
        else if (f.type === 'assistant') assistant += 1;
      } catch { /* skip */ }
    }
    return { user, assistant, total: lines.length, exists: true };
  }

  // ---- Phase 1: 3-turn baseline in a single CLI process ----
  const baselineRun = await runConversation('baseline', 3, 'preset');
  log(`baseline: ${baselineRun.results.length} result frames, exit=${baselineRun.exitCode} reason="${baselineRun.reason}"`);
  if (baselineRun.stderr.trim()) log(`baseline stderr tail: ${baselineRun.stderr.slice(-300).replace(/\n/g, ' | ')}`);
  if (baselineRun.results.length < 3) {
    try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(
      `baseline did not produce 3 result frames (got ${baselineRun.results.length}). ` +
      `env can't drive 3-turn baseline. exit=${baselineRun.exitCode} reason=${baselineRun.reason} ` +
      `stderr: ${baselineRun.stderr.slice(-400)}`,
    );
  }
  if (baselineRun.results.some((r) => r.isError)) {
    try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`baseline turn(s) returned is_error: ${JSON.stringify(baselineRun.results)}`);
  }

  const baseline = countJsonlMessages();
  log(`baseline JSONL: user=${baseline.user} assistant=${baseline.assistant} total=${baseline.total}`);
  if (baseline.user < 3 || baseline.assistant < 3) {
    try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(
      `baseline JSONL incomplete: expected >=3 user + >=3 assistant, got user=${baseline.user} assistant=${baseline.assistant}.`,
    );
  }

  // ---- Phase 2: simulate ccsm "Truncate from here" — JSONL untouched ----
  // ccsm's rewindToBlock intentionally does NOT modify the on-disk JSONL —
  // it only mutates the in-memory store + persists a marker. From the CLI's
  // perspective the disk state is still the full transcript when the next
  // agentStart fires. We replicate that by doing nothing here.
  log(`truncate step: JSONL left intact at ${baseline.total} lines (mirrors store.rewindToBlock)`);

  // ---- Phase 3a: pre-fix path — respawn with --session-id (collision) ----
  // This is the BROKEN behavior: ccsm's pre-fix `rewindToBlock` cleared
  // `resumeSessionId`, so `startSessionAndReconcile` fell into the
  // `sessionId: <ccsm-uuid>` branch on the next agentStart. The bundled CLI
  // rejects that with "Session ID is already in use." (exit 1) when the
  // JSONL exists. This phase asserts the bug actually exists in the CLI
  // (otherwise the fix is solving a non-problem).
  const preFix = await runConversation('resend-pre-fix', 1, 'preset');
  log(`resend-pre-fix: results=${preFix.results.length} exit=${preFix.exitCode} reason="${preFix.reason}"`);
  if (preFix.stderr.trim()) log(`resend-pre-fix stderr: ${preFix.stderr.trim()}`);

  const preFixSawCollision = /Session ID .* is already in use/i.test(preFix.stderr);
  if (preFix.results.length > 0 || !preFixSawCollision) {
    try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(
      `BUG #288 NOT REPRODUCED: respawning with --session-id after JSONL exists did NOT trigger ` +
      `"Session ID is already in use." This case can't validate the fix. ` +
      `preFix.results=${preFix.results.length} stderr=${preFix.stderr.slice(-400)}`,
    );
  }
  log(`#288 reproduced: pre-fix path produces "Session ID is already in use" (exit ${preFix.exitCode}) — confirms bug`);

  // ---- Phase 3b: post-fix path — respawn with --resume (success) ----
  // This is the FIXED behavior: post-fix `rewindToBlock` sets
  // `resumeSessionId = sidOnDisk`, so `startSessionAndReconcile` falls into
  // the `resume: <uuid>` branch and the CLI accepts the existing JSONL.
  const postFix = await runConversation('resend-post-fix', 1, 'resume');
  log(`resend-post-fix: results=${postFix.results.length} exit=${postFix.exitCode} reason="${postFix.reason}"`);
  if (postFix.stderr.trim()) log(`resend-post-fix stderr tail: ${postFix.stderr.slice(-300).replace(/\n/g, ' | ')}`);

  // Cleanup temp cwd. JSONL under ~/.claude/projects/ stays for forensics.
  try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* ignore */ }

  if (postFix.results.length < 1) {
    throw new Error(
      `BUG #288 FIX BROKEN: respawn with --resume did NOT produce a result. ` +
      `exit=${postFix.exitCode} reason=${postFix.reason} stderr: ${postFix.stderr.slice(-500)}`,
    );
  }
  if (postFix.results[0].isError) {
    throw new Error(
      `BUG #288 FIX BROKEN: respawn with --resume returned is_error result. ` +
      `text: ${postFix.results[0].text.slice(0, 200)} stderr: ${postFix.stderr.slice(-300)}`,
    );
  }
  if (/Session ID .* is already in use/i.test(postFix.stderr)) {
    throw new Error(`BUG #288 FIX BROKEN: --resume path still hit the session-id collision`);
  }

  log(`PASS: pre-fix path repros #288; post-fix path resumes cleanly with new result`);
}

/**
 * cliBridge: spawn ttyd → claude pipeline, verify the HTTP port responds,
 * tree-kill, verify the process is gone.
 *
 * Why this lives here (not in harness-agent or its own probe):
 *   - cliBridge wraps the real bundled `ttyd.exe` + the user's installed
 *     `claude` CLI. The harness-real-cli convention already handles the
 *     "skip when claude not on PATH" gate and bypasses Electron entirely
 *     (no Playwright cost), which matches what we want to test: the
 *     spawn / port / kill mechanics, not the renderer wiring.
 *   - This case mirrors the production cliBridge code path 1:1
 *     (port 0 trick → spawn ttyd with -W -t fontSize=14 → HTTP probe →
 *     taskkill /F /T). Re-implementing inline keeps the harness JS-only
 *     (no tsx dep) and tests the protocol contract rather than the TS
 *     module structure (which the unit tests cover separately).
 *   - Placed in harness-real-cli per `feedback_e2e_prefer_harness` —
 *     stand-alone probes cost ~30s extra each.
 *
 * Skips when:
 *   - ttyd binary not present at `spike/ttyd-embed/bin/ttyd.exe` (e.g.
 *     a clean clone without the extracted binary). The CLI-presence gate
 *     at the top of this file already covers `claude` missing.
 *   - non-Windows (no bundled ttyd binary for mac/linux yet).
 */
async function caseCliBridgeTtydSpawnAndKill({ log }) {
  if (process.platform !== 'win32') {
    log(`SKIP: ttyd binary is win32-only for now`);
    return;
  }

  const REPO_ROOT = path.resolve(path.dirname(fileURLToPathLocal(import.meta.url)), '..');
  const ttydPath = path.join(REPO_ROOT, 'spike', 'ttyd-embed', 'bin', 'ttyd.exe');
  if (!fs.existsSync(ttydPath)) {
    log(`SKIP: ttyd binary missing at ${ttydPath}`);
    return;
  }

  // Claude resolution: same as cliBridge/claudeResolver.ts. Re-implementing
  // here so the harness exercises the same fall-through (cmd → bare).
  function findClaude() {
    for (const name of ['claude.cmd', 'claude']) {
      const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0) {
        const first = r.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
        if (first) return first.trim();
      }
    }
    return null;
  }
  const claudePath = findClaude();
  if (!claudePath) {
    log(`SKIP: claude not on PATH (where claude.cmd / where claude both failed)`);
    return;
  }
  log(`ttyd: ${ttydPath}`);
  log(`claude: ${claudePath}`);

  // pickFreePort — port-0 trick. Mirrors electron/cliBridge/portAllocator.ts.
  function pickFreePort() {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      import('node:net').then((net) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          const port = srv.address().port;
          srv.close(() => resolve(port));
        });
      });
    });
  }
  const port = await pickFreePort();
  log(`allocated port: ${port}`);

  // Use `--session-id <uuid>` to match cliBridge's openTtydForSession path.
  // Args mirror processManager.ts: `-i 127.0.0.1` is required to bind
  // loopback-only — without it ttyd binds 0.0.0.0 and Windows Defender
  // Firewall prompts on every spawn.
  const sid = randomUUID();
  const args = ['-p', String(port), '-i', '127.0.0.1', '-W', '-t', 'fontSize=14', claudePath, '--session-id', sid];
  log(`spawn: ttyd ${args.join(' ')}`);
  const proc = spawn(ttydPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let stderrBuf = '';
  proc.stderr.on('data', (b) => { stderrBuf += b.toString('utf8'); });

  // Give ttyd time to bind. The cliBridge module sleeps 200ms; we wait a bit
  // longer to keep the e2e green on slower machines (the CI Windows runner
  // can take 600ms-1s to bind on cold start).
  await new Promise((r) => setTimeout(r, 1500));

  if (proc.exitCode !== null) {
    throw new Error(
      `ttyd exited prematurely (code=${proc.exitCode}). stderr: ${stderrBuf.slice(-400)}`,
    );
  }

  // Probe the HTTP port: ttyd serves an HTML page at `/`. We just want to
  // confirm the server is accepting connections and returns 2xx.
  const httpOk = await new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    import('node:http').then((http) => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        resolve(status >= 200 && status < 400);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    });
  });
  if (!httpOk) {
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    throw new Error(
      `ttyd HTTP probe at http://127.0.0.1:${port}/ failed. stderr: ${stderrBuf.slice(-400)}`,
    );
  }
  log(`HTTP probe OK on 127.0.0.1:${port}`);

  // Tree-kill — Windows MUST use taskkill /T /F to reap the conpty + claude
  // child. Mirrors processManager.killTtydForSession.
  const ttydPid = proc.pid;
  spawnSync('taskkill', ['/F', '/T', '/PID', String(ttydPid)], {
    stdio: 'ignore',
    windowsHide: true,
  });

  // Wait for the OS to actually release the PID. exit event is the
  // canonical signal; fall back to a 3s deadline.
  await new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    const t = setTimeout(resolve, 3000);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });

  // Confirm via tasklist that the PID is gone (the proc.exitCode could be
  // set by Node having reaped its handle even if a stuck conpty is still
  // around — check the real OS state).
  const tl = spawnSync('tasklist', ['/FI', `PID eq ${ttydPid}`, '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  // tasklist with no match prints "INFO: No tasks are running ...".
  const stillAlive = tl.stdout.includes(String(ttydPid)) && /ttyd/i.test(tl.stdout);
  if (stillAlive) {
    throw new Error(
      `ttyd PID ${ttydPid} still present in tasklist after taskkill. Output: ${tl.stdout.slice(0, 300)}`,
    );
  }

  // Final HTTP probe — port should now refuse connections.
  const httpAfter = await new Promise((resolve) => {
    import('node:http').then((http) => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
  });
  if (httpAfter) {
    throw new Error(`ttyd port ${port} still serving HTTP after kill — process tree not reaped`);
  }

  log(`PASS: ttyd spawned, served HTTP on ${port}, killed via taskkill /T /F, port now closed`);
}

// fileURLToPath helper without an import-line edit — added late and we
// don't want to reshuffle the top of the file.
function fileURLToPathLocal(u) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return fileURLToPath(u);
}

// ---------- runner ----------
const cases = [
  { id: 'control-response-no-timeout', run: caseControlResponseNoTimeout },
  { id: 'ide-auto-connect-kill-switch-present', run: caseIdeAutoConnectKillSwitchPresent },
  { id: 'namespaced-command-actually-runs', run: caseNamespacedCommandActuallyRuns },
  { id: 'truncate-from-here-then-resend-real-cli', run: caseTruncateFromHereThenResendRealCli },
  { id: 'cli-bridge-ttyd-spawn-and-kill', run: caseCliBridgeTtydSpawnAndKill },
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
