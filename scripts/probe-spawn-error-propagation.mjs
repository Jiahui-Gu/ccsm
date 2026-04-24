// Live probe for the post-spawn error propagation fix (task #235, follow-up
// to PR #206 review).
//
// Background: agent:start used to return {ok:true} as soon as spawn() handed
// back a pid, even if the child immediately exited with code != 0 (stale
// binPath, missing dependency, bad shim, ENOENT after spawn). The user then
// saw a chat that simply never streamed, with no diagnostic. This was the
// underlying class of bug behind the stale-binPath P0 (#224) — the only
// reason that one ever surfaced was the user manually noticing no reply.
//
// Fix (this PR): SessionRunner.start() now waits up to ~800ms after spawn
// for the child to either survive (presumed healthy) or die noisily.
// Early non-zero exits throw a typed ClaudeSpawnFailedError carrying the
// stderr tail; manager.start() translates it into
// {ok:false, errorCode:'CLI_SPAWN_FAILED', detail:<stderr tail>}.
// The renderer's existing AgentInitFailedBanner picks this up via
// setSessionInitFailure and shows "Agent failed to start" with the
// captured stderr context.
//
// What this probe asserts:
//   1. Pre-seed claudeBinPath at a fake binary that exits 1 immediately
//      with a recognisable stderr line.
//   2. Drive agent:start directly. Expect ok:false + errorCode
//      'CLI_SPAWN_FAILED' + a non-empty `detail` field that contains the
//      sentinel stderr line.
//   3. Drive setSessionInitFailure through the same code path the
//      InputBar uses, then assert the AgentInitFailedBanner mounts with
//      the "Agent failed to start" copy and the sentinel stderr string in
//      the body.
//
// Reverse-verify (documented in PR body): comment out the
// `detectEarlyFailure` block in electron/agent/sessions.ts → this probe
// MUST FAIL because agent:start returns ok:true and the banner never
// renders. Restore the block → probe MUST PASS.
//
// HOME / USERPROFILE are sanitized to a temp dir per project rule
// (~/.claude/projects/.../memory/project_probe_skill_injection.md): we
// never want the developer's local ~/.claude skills to leak into a child
// process the probe might spawn.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-spawn-error-propagation] FAIL: ${msg}`);
  process.exit(1);
}

const SENTINEL_STDERR = 'fake-claude-bailing-with-code-1';

// Build a fake claude "binary" that writes a recognisable line to stderr
// and exits 1 immediately. Mirrors the shape of a real CLI dying mid-init
// (e.g. missing native module, expired auth token, malformed config).
function writeFailingBinary(dir) {
  if (process.platform === 'win32') {
    const p = path.join(dir, 'fake-claude-fail.cmd');
    fs.writeFileSync(
      p,
      `@echo off\r\necho ${SENTINEL_STDERR} 1>&2\r\nexit /b 1\r\n`
    );
    return p;
  }
  const p = path.join(dir, 'fake-claude-fail.sh');
  fs.writeFileSync(p, `#!/bin/sh\nprintf '${SENTINEL_STDERR}\\n' >&2\nexit 1\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-spawn-error-'));
const fakeBin = writeFailingBinary(tmp);

const ud = isolatedUserData('probe-spawn-error-userdata');
// Sanitize HOME so the developer's ~/.claude skills do not leak into the
// spawned CLI's environment.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-spawn-error-home-'));

function cleanup() {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  try { ud.cleanup(); } catch {}
}

const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: {
    ...process.env,
    // Force-load the built renderer bundle (file://) instead of the dev
    // server. Without this, isDev=true in main.ts and Electron tries to
    // hit http://localhost:4100 which the probe never starts.
    AGENTORY_PROD_BUNDLE: '1',
    NODE_ENV: 'production',
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  },
});

// Empty PATH so the resolver can't fall through to a real claude on the
// developer's PATH and silently mask the bug.
await app.evaluate(async () => {
  process.env.PATH = '';
  process.env.path = '';
  if (process.platform === 'win32') process.env.PATHEXT = '.CMD;.EXE';
  delete process.env.AGENTORY_CLAUDE_BIN;
});

const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.agentory?.agentStart, null, {
  timeout: 10_000,
});

// Seed claudeBinPath via the same IPC the wizard's "browse" flow uses.
await win.evaluate(async (p) => {
  await window.agentory.saveState('claudeBinPath', p);
}, fakeBin);

// Sanity check the seed landed.
const seeded = await win.evaluate(async () => {
  return await window.agentory.loadState('claudeBinPath');
});
if (seeded !== fakeBin) {
  await app.close();
  cleanup();
  fail(`pre-seed failed: claudeBinPath read back as ${JSON.stringify(seeded)}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 1: agent:start IPC returns ok:false / CLI_SPAWN_FAILED / detail.
// ─────────────────────────────────────────────────────────────────────────
const startResult = await win.evaluate(async (cwd) => {
  return await window.agentory.agentStart('probe-spawn-error-session', { cwd });
}, root);

if (startResult.ok) {
  await app.close();
  cleanup();
  fail(
    'agent:start returned ok:true despite the fake binary exiting 1 ' +
      'immediately. The early-failure window in SessionRunner.start() ' +
      'is not detecting the post-spawn exit. ' +
      `Full result: ${JSON.stringify(startResult)}`
  );
}
if (startResult.errorCode !== 'CLI_SPAWN_FAILED') {
  await app.close();
  cleanup();
  fail(
    `agent:start returned the wrong errorCode. Expected CLI_SPAWN_FAILED, ` +
      `got ${JSON.stringify(startResult)}.`
  );
}
if (!startResult.detail || !String(startResult.detail).includes(SENTINEL_STDERR)) {
  await app.close();
  cleanup();
  fail(
    `agent:start CLI_SPAWN_FAILED detail does not contain the sentinel ` +
      `stderr line "${SENTINEL_STDERR}". ` +
      `detail=${JSON.stringify(startResult.detail)}.`
  );
}

console.log('\n[probe-spawn-error-propagation] phase 1 OK (ipc)');
console.log('  agent:start ok:false errorCode:CLI_SPAWN_FAILED detail contains sentinel');

// ─────────────────────────────────────────────────────────────────────────
// Phase 2: renderer banner surfaces the failure.
//
// Synthesize a session in the store, then drive the same setSessionInitFailure
// write that startSessionAndReconcile would do on a CLI_SPAWN_FAILED return.
// The AgentInitFailedBanner observes sessionInitFailures and renders.
// ─────────────────────────────────────────────────────────────────────────
await win.evaluate(async (cwd) => {
  const store = window.__agentoryStore;
  if (!store) throw new Error('__agentoryStore missing on window');
  store.setState((s) => ({
    sessions: [
      ...s.sessions.filter((sess) => sess.id !== 'probe-spawn-error-banner'),
      {
        id: 'probe-spawn-error-banner',
        title: 'probe',
        cwd,
        model: '',
        groupId: s.sessions[0]?.groupId ?? 'default',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        running: false,
      },
    ],
    activeId: 'probe-spawn-error-banner',
  }));
}, root);

await win.waitForTimeout(150);

await win.evaluate(async () => {
  const session = window.__agentoryStore.getState().sessions.find(
    (s) => s.id === 'probe-spawn-error-banner'
  );
  const res = await window.agentory.agentStart('probe-spawn-error-banner', {
    cwd: session.cwd,
  });
  if (res.ok) return;
  const errMessage =
    res.errorCode === 'CLI_SPAWN_FAILED' && res.detail
      ? `${res.error} — ${res.detail}`
      : res.error;
  window.__agentoryStore.getState().setSessionInitFailure(
    'probe-spawn-error-banner',
    {
      error: errMessage,
      errorCode: res.errorCode,
      searchedPaths: res.searchedPaths,
    }
  );
});

const banner = win.locator('[data-agent-init-failed-banner]').first();
await banner.waitFor({ state: 'visible', timeout: 5_000 }).catch(async () => {
  const dump = await win.evaluate(() => document.body.innerText.slice(0, 1500));
  console.error('--- body text at failure ---\n' + dump);
  console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
  await app.close();
  cleanup();
  fail(
    'AgentInitFailedBanner did not appear after agent:start ' +
      'returned CLI_SPAWN_FAILED. The renderer is not picking up ' +
      'the failure code path.'
  );
});

const bannerText = (await banner.textContent()) ?? '';
if (!/Agent failed to start/.test(bannerText)) {
  await app.close();
  cleanup();
  fail(
    `AgentInitFailedBanner text missing the expected headline. ` +
      `Got: ${JSON.stringify(bannerText.slice(0, 300))}`
  );
}
if (!bannerText.includes(SENTINEL_STDERR)) {
  await app.close();
  cleanup();
  fail(
    `AgentInitFailedBanner does not include the captured stderr tail ` +
      `("${SENTINEL_STDERR}"). The detail field is not flowing into the ` +
      `banner copy. Got: ${JSON.stringify(bannerText.slice(0, 300))}`
  );
}

console.log('[probe-spawn-error-propagation] phase 2 OK (banner)');
console.log('  AgentInitFailedBanner visible with stderr tail surfaced');

await app.close();
cleanup();

console.log('\n[probe-spawn-error-propagation] OK');
console.log('  errorCode:    CLI_SPAWN_FAILED propagated through ipc');
console.log('  ui:           "Agent failed to start" banner mounted with stderr detail');
