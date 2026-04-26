// E2E probe — bug fix: in `default` permission mode the Bash tool ran with
// NO permission prompt UI within 30s.
//
// Root cause: CLI 2.x's local rule engine handles built-in tools
// (Bash/Write/Edit/...) entirely client-side; the SDK-style
// `--permission-prompt-tool stdio` flag is only consulted for "ask" tools
// (AskUserQuestion / ExitPlanMode). For everything else the CLI auto-allows
// based on its safe-command heuristics and never emits `can_use_tool`. So
// the renderer's PermissionPromptBlock had nothing to render.
//
// Fix (current — restored after PR #271 SDK migration): we register a
// `PreToolUse` SDK hook with matcher `.*` (electron/agent-sdk/sessions.ts).
// The CLI sends a `hook_callback` request for every tool invocation; our
// hook returns `permissionDecision: 'ask'` for non-passthrough tools, which
// forces the CLI to delegate to canUseTool (and thus our renderer
// prompt). AskUserQuestion / ExitPlanMode get `'allow'` from the hook so
// the renderer's bespoke UI stays the single source of truth for them.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedClaudeConfigDir } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const MARKER = 'permhook-perm-test-91827';
const NAME = 'probe-e2e-permission-prompt-default-mode';
// Real UUID required since PR-D (#274): the SDK now validates sessionId
// and emits `session_id_mismatch` warnings (creating mis-named JSONL
// transcripts) when given a non-UUID like the legacy `s-perm-default-1`.
const SESSION_ID = randomUUID();
const GROUP_ID = 'g-default';

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-perm-default-'));
console.log(`[${NAME}] userData = ${userDataDir}`);

// Sandbox CLAUDE_CONFIG_DIR. THIS PROBE IS THE WHOLE POINT of the sandbox
// fix: it asserts "permission prompt UI appears for `echo MARKER`". If the
// dev's real `~/.claude/settings.json` has `Bash(*)` or even `Bash(echo:*)`
// allowlisted, the upstream CLI auto-allows the call, no `can_use_tool` /
// hook_callback fires, no prompt UI renders, and this probe times out OR
// false-greens on a stale assertion. Empty-allowlist config dir restores
// the prompt path.
const cfg = isolatedClaudeConfigDir(`${NAME}`);
console.log(`[${NAME}] sandboxed CLAUDE_CONFIG_DIR = ${cfg.dir}`);

const commonArgs = ['.', `--user-data-dir=${userDataDir}`];
// Strip CLAUDECODE so the spawned claude.exe doesn't refuse-to-launch with
// "cannot run inside another Claude Code session". Probes that drive a real
// CLI must do this — the dogfood guide called it out repeatedly.
const env = {
  ...process.env,
  CCSM_PROD_BUNDLE: '1',
  CCSM_CLAUDE_CONFIG_DIR: cfg.dir,
};
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;

let appRef = null;
function fail(msg, extra) {
  console.error(`\n[${NAME}] FAIL: ${msg}`);
  if (extra) console.error(extra);
  if (appRef) appRef.close().catch(() => {});
  cfg.cleanup();
  process.exit(1);
}

const app = await electron.launch({ args: commonArgs, cwd: root, env });
appRef = app;

try { // ccsm-probe-cleanup-wrap
app.process().stderr?.on('data', (d) => process.stderr.write(`[electron-stderr] ${d}`));

const win = await appWindow(app, { timeout: 30_000 });
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);

// 1. Seed an active session in default permission mode + skip first-run UI.
const seeded = await win.evaluate(
  async ({ sid, gid }) => {
    const api = window.ccsm;
    if (!api) return { ok: false, err: 'no window.ccsm' };
    const state = {
      version: 1,
      sessions: [
        {
          id: sid,
          name: 'Permission default-mode probe',
          state: 'idle',
          cwd: '~',
          model: 'claude-opus-4',
          groupId: gid,
          agentType: 'claude-code',
        },
      ],
      groups: [{ id: gid, name: 'Sessions', collapsed: false, kind: 'normal' }],
      activeId: sid,
      model: 'claude-opus-4',
      permission: 'default',
      sidebarCollapsed: false,
      theme: 'system',
      fontSize: 'md',
      recentProjects: [],
      tutorialSeen: true,
    };
    await api.saveState('main', JSON.stringify(state));
    return { ok: true };
  },
  { sid: SESSION_ID, gid: GROUP_ID }
);
if (!seeded.ok) fail(`seed failed: ${seeded.err}`);
await app.close();

// 2. Relaunch — the seeded state restores. permission chip should read
//    "default", and the InputBar/textarea should render.
const app2 = await electron.launch({ args: commonArgs, cwd: root, env });
appRef = app2;
app2.process().stderr?.on('data', (d) => process.stderr.write(`[electron-stderr-2] ${d}`));

const win2 = await appWindow(app2, { timeout: 30_000 });
win2.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win2.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});
await win2.waitForLoadState('domcontentloaded');
await win2.waitForTimeout(3500);

// Explicit selectSession in case the restored state didn't auto-activate.
await win2.evaluate((sid) => {
  const s = window.__ccsmStore?.getState();
  if (s && typeof s.selectSession === 'function' && s.activeId !== sid) {
    s.selectSession(sid);
  }
}, SESSION_ID);
await win2.waitForTimeout(500);

const verifyMode = await win2.evaluate(() => {
  const s = window.__ccsmStore?.getState();
  return { permission: s?.permission, activeId: s?.activeId };
});
if (verifyMode.permission !== 'default') {
  fail(`permission mode did not restore to 'default'; got ${verifyMode.permission}`);
}
if (verifyMode.activeId !== SESSION_ID) {
  fail(`activeId did not restore; got ${verifyMode.activeId}`);
}

// 3. Submit a Bash prompt that auto-allowed before the fix.
const textarea = win2.locator('textarea').first();
await textarea.waitFor({ state: 'visible', timeout: 15_000 });
await textarea.click();
await textarea.fill(
  `Please run the bash command \`echo ${MARKER}\` using the Bash tool. I want to verify the permission prompt works.`
);
await win2.keyboard.press('Enter');

// 4. Within 30s the permission UI MUST appear. With the PreToolUse hook
//    wired (#94 fix), the CLI consults canUseTool for every Bash call and
//    the renderer renders the alertdialog deterministically.
const dialog = win2.locator('[role="alertdialog"]').first();
try {
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
} catch {
  fail(
    'no [role="alertdialog"] permission prompt UI within 30s — PreToolUse hook (#94) regression?'
  );
}

// PR #288 introduced per-tool titles ("Allow this bash command?") that
// replace the generic "Permission required" for known tools. Accept either
// — the assertion is "a recognisable permission heading is rendered", not
// the literal English of the fallback.
const headingHits = await dialog
  .locator('text=/Permission required|Allow this bash command\\?/')
  .first()
  .count();
if (headingHits === 0) fail('alertdialog visible but no recognisable permission heading');
const dialogText = (await dialog.innerText()).toLowerCase();
if (!dialogText.includes('bash') && !dialogText.includes(MARKER)) {
  fail(`prompt does not mention Bash or the marker; saw: ${dialogText.slice(0, 400)}`);
}

// 5. Click Allow.
const allowBtn = win2.locator('[data-perm-action="allow"]').first();
await allowBtn.waitFor({ state: 'visible', timeout: 5_000 });
await allowBtn.click();

// 6. Prompt detaches; bash output (marker) appears within 30s.
try {
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });
} catch {
  fail('alertdialog still attached 10s after clicking Allow');
}

const markerSeen = await (async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const has = await win2.evaluate((m) => document.body.innerText.includes(m), MARKER);
    if (has) return true;
    await win2.waitForTimeout(500);
  }
  return false;
})();
if (!markerSeen) {
  const dump = await win2.evaluate(() => document.body.innerText.slice(0, 2500));
  console.error('--- final body text ---');
  console.error(dump);
  fail(`marker "${MARKER}" never appeared in conversation within 30s of Allow click`);
}

// 7. Best-effort: running state should clear within 20s.
const stoppedRunning = await (async () => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const running = await win2.evaluate(() => {
      const s = window.__ccsmStore?.getState();
      if (!s) return false;
      const id = s.activeId;
      return id ? !!s.runningSessions?.[id] : false;
    });
    if (!running) return true;
    await win2.waitForTimeout(500);
  }
  return false;
})();
if (!stoppedRunning) console.warn(`[${NAME}] WARN: still in running state 20s after marker appeared`);

console.log(`\n[${NAME}] OK`);
console.log(
  `  - permission prompt rendered, allow clicked, marker "${MARKER}" appeared in chat`
);

await app2.close();
cfg.cleanup();
} finally { try { await appRef?.close(); } catch {} } // ccsm-probe-cleanup-wrap
