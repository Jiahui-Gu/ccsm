// Dogfood r2 fp8: tool-call rendering checks A-F.
// Drives a real CLI session through ccsm + verifies tool block render +
// permission dialog flow. NOT a regression probe — manual evidence capture.
//
// Output: docs/screenshots/dogfood-r2/fp8-tools/check-{a..f}-*.png
//         + report at docs/dogfood/r2/fp8-report.md
//
// Run: node scripts/probe-dogfood-r2-fp8-tools.mjs
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedClaudeConfigDir } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(REPO_ROOT, 'docs/screenshots/dogfood-r2/fp8-tools');
const USER_DATA = 'C:/temp/ccsm-dogfood-r2-fp8';
fs.mkdirSync(SHOT_DIR, { recursive: true });
fs.mkdirSync(USER_DATA, { recursive: true });

const TMP_TXT = 'C:/temp/fp8-edit-test.txt';
const TMP_WRITE = 'C:/temp/fp8-write-test.txt';
const TMP_GREP_DIR = 'C:/temp';
const PROBE_CWD = REPO_ROOT;

// Pre-seed file for Edit check
fs.writeFileSync(TMP_TXT, 'hello\n', 'utf8');
try { fs.unlinkSync(TMP_WRITE); } catch {}

// Sandboxed config dir so all tools must hit permission prompt unless allowed.
const cfg = isolatedClaudeConfigDir('ccsm-fp8');
console.log('[fp8] CLAUDE_CONFIG_DIR=', cfg.dir);
console.log('[fp8] userData=', USER_DATA);

const results = {};
function record(check, status, notes) {
  results[check] = { status, notes };
  console.log(`[fp8] ${check}: ${status} ${notes ? '— ' + notes : ''}`);
}

const launchArgs = [REPO_ROOT, `--user-data-dir=${USER_DATA}`];
const app = await electron.launch({
  args: launchArgs,
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    CCSM_PROD_BUNDLE: '1',
    CCSM_CLAUDE_CONFIG_DIR: cfg.dir,
    AGENTORY_E2E: '1',
  },
  timeout: 60_000,
});

let win;
try {
  win = await appWindow(app, { timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 30_000 });
  await win.waitForTimeout(800);
} catch (e) {
  console.error('[fp8] failed to bring up window:', e.message);
  await app.close();
  process.exit(1);
}

async function shoot(name) {
  const out = path.join(SHOT_DIR, `${name}.png`);
  await win.screenshot({ path: out });
  console.log(`[fp8] shot ${out}`);
  return out;
}

async function ensureSession({ id, name, mode = 'acceptEdits' }) {
  await win.evaluate(({ id, name, cwd }) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id, name, state: 'idle', cwd, model: 'claude-sonnet-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: id,
      messagesBySession: { [id]: [] },
      startedSessions: {},
      runningSessions: {},
    });
  }, { id, name, cwd: PROBE_CWD });
  const startRes = await win.evaluate(async ({ id, cwd, mode }) =>
    await window.ccsm.agentStart(id, { cwd, permissionMode: mode, sessionId: id }),
    { id, cwd: PROBE_CWD, mode });
  if (!startRes?.ok) throw new Error('agentStart failed: ' + JSON.stringify(startRes));
  return startRes;
}

async function send(id, text) {
  await win.evaluate(async ({ id, text }) => await window.ccsm.agentSend(id, text), { id, text });
}

async function waitForToolBlock(toolName, { timeout = 60_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const found = await win.evaluate((tn) => {
      const blocks = Array.from(document.querySelectorAll('[data-testid="tool-block-root"]'));
      return blocks.map(b => b.textContent?.slice(0, 200) || '').filter(t => t.toLowerCase().includes(tn.toLowerCase())).length;
    }, toolName);
    if (found > 0) return true;
    await win.waitForTimeout(400);
  }
  return false;
}

async function waitForPermissionPrompt({ timeout = 30_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const has = await win.evaluate(() => !!document.querySelector('[data-perm-action="allow"]'));
    if (has) return true;
    await win.waitForTimeout(300);
  }
  return false;
}

async function clickAllow() {
  await win.evaluate(() => {
    const btn = document.querySelector('[data-perm-action="allow"]');
    if (btn) btn.click();
  });
}

async function waitForIdle(id, { timeout = 60_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const running = await win.evaluate((id) => !!window.__ccsmStore.getState().runningSessions?.[id], id);
    if (!running) return true;
    await win.waitForTimeout(400);
  }
  return false;
}

async function getToolBlocks() {
  return await win.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('[data-testid="tool-block-root"]'));
    return blocks.map(b => ({
      text: (b.textContent || '').slice(0, 300),
      hasExpand: !!b.querySelector('button, [role="button"]'),
      rect: b.getBoundingClientRect(),
    }));
  });
}

// ─────────────── Check A: Read tool (auto-allow) ───────────────
try {
  const sid = 's-fp8-A';
  await ensureSession({ id: sid, name: 'fp8-A-read', mode: 'acceptEdits' });
  await send(sid, 'Read the file `package.json` in the current cwd and tell me only the version field.');
  const got = await waitForToolBlock('Read', { timeout: 90_000 });
  await waitForIdle(sid, { timeout: 90_000 });
  await win.waitForTimeout(800);
  await shoot('check-a-read');
  const blocks = await getToolBlocks();
  const hasRead = blocks.some(b => b.text.toLowerCase().includes('read'));
  record('A', got && hasRead ? 'PASS' : 'PARTIAL', `tool=Read got=${got} blocks=${blocks.length}`);
  await win.evaluate(async (id) => await window.ccsm.agentClose(id), sid);
} catch (e) {
  record('A', 'BUG', e.message);
}

// ─────────────── Check B: Bash tool (default mode → permission) ───────────────
try {
  const sid = 's-fp8-B';
  await ensureSession({ id: sid, name: 'fp8-B-bash', mode: 'default' });
  await send(sid, 'Run the shell command `git status` in the current cwd. Use the Bash tool.');
  const promptShown = await waitForPermissionPrompt({ timeout: 60_000 });
  if (promptShown) {
    await shoot('check-b-bash-permission');
    await clickAllow();
    await win.waitForTimeout(500);
  }
  const got = await waitForToolBlock('Bash', { timeout: 60_000 });
  await waitForIdle(sid, { timeout: 60_000 });
  await win.waitForTimeout(800);
  await shoot('check-b-bash-result');
  // Try expand/collapse
  const expandClicked = await win.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('[data-testid="tool-block-root"]'));
    for (const b of blocks) {
      if (!b.textContent?.toLowerCase().includes('bash')) continue;
      const btn = b.querySelector('button, [role="button"]');
      if (btn) { btn.click(); return true; }
    }
    return false;
  });
  await win.waitForTimeout(400);
  await shoot('check-b-bash-expanded');
  record('B', promptShown && got ? 'PASS' : 'PARTIAL', `prompt=${promptShown} bashBlock=${got} expandClicked=${expandClicked}`);
  await win.evaluate(async (id) => await window.ccsm.agentClose(id), sid);
} catch (e) {
  record('B', 'BUG', e.message);
}

// ─────────────── Check C: Edit tool (with permission, diff) ───────────────
try {
  const sid = 's-fp8-C';
  await ensureSession({ id: sid, name: 'fp8-C-edit', mode: 'default' });
  await send(sid, `Use the Edit tool to edit the file ${TMP_TXT} and replace the literal text 'hello' with 'world'. Do not read it first; just edit.`);
  const promptShown = await waitForPermissionPrompt({ timeout: 60_000 });
  if (promptShown) {
    await shoot('check-c-edit-permission');
    await clickAllow();
    await win.waitForTimeout(500);
  }
  const got = await waitForToolBlock('Edit', { timeout: 60_000 });
  await waitForIdle(sid, { timeout: 60_000 });
  await win.waitForTimeout(800);
  await shoot('check-c-edit-result');
  // Verify file changed on disk
  let diskOk = false;
  try {
    const after = fs.readFileSync(TMP_TXT, 'utf8');
    diskOk = after.includes('world');
  } catch {}
  record('C', promptShown && got && diskOk ? 'PASS' : 'PARTIAL', `prompt=${promptShown} editBlock=${got} diskHasWorld=${diskOk}`);
  await win.evaluate(async (id) => await window.ccsm.agentClose(id), sid);
} catch (e) {
  record('C', 'BUG', e.message);
}

// ─────────────── Check D: Write tool (new file) ───────────────
try {
  const sid = 's-fp8-D';
  await ensureSession({ id: sid, name: 'fp8-D-write', mode: 'default' });
  await send(sid, `Create a new file at ${TMP_WRITE} with exactly the content 'fp8 ok'. Use the Write tool.`);
  const promptShown = await waitForPermissionPrompt({ timeout: 60_000 });
  if (promptShown) {
    await shoot('check-d-write-permission');
    await clickAllow();
    await win.waitForTimeout(500);
  }
  const got = await waitForToolBlock('Write', { timeout: 60_000 });
  await waitForIdle(sid, { timeout: 60_000 });
  await win.waitForTimeout(800);
  await shoot('check-d-write-result');
  let diskOk = false;
  try {
    diskOk = fs.existsSync(TMP_WRITE) && fs.readFileSync(TMP_WRITE, 'utf8').includes('fp8 ok');
  } catch {}
  record('D', promptShown && got && diskOk ? 'PASS' : 'PARTIAL', `prompt=${promptShown} writeBlock=${got} diskExists=${diskOk}`);
  await win.evaluate(async (id) => await window.ccsm.agentClose(id), sid);
} catch (e) {
  record('D', 'BUG', e.message);
}

// ─────────────── Check E: Grep tool ───────────────
try {
  const sid = 's-fp8-E';
  await ensureSession({ id: sid, name: 'fp8-E-grep', mode: 'acceptEdits' });
  await send(sid, `Use the Grep tool to search for the literal string 'fp8' in the directory ${TMP_GREP_DIR}.`);
  const got = await waitForToolBlock('Grep', { timeout: 90_000 });
  await waitForIdle(sid, { timeout: 90_000 });
  await win.waitForTimeout(800);
  await shoot('check-e-grep-result');
  record('E', got ? 'PASS' : 'PARTIAL', `grepBlock=${got}`);
  await win.evaluate(async (id) => await window.ccsm.agentClose(id), sid);
} catch (e) {
  record('E', 'BUG', e.message);
}

// ─────────────── Check F: Multiple tool calls one turn ───────────────
try {
  const sid = 's-fp8-F';
  await ensureSession({ id: sid, name: 'fp8-F-multi', mode: 'acceptEdits' });
  await send(sid, 'Read package.json then read README.md (both in cwd) and tell me which file is bigger by character count.');
  await waitForIdle(sid, { timeout: 120_000 });
  await win.waitForTimeout(800);
  await shoot('check-f-multi-result');
  const blocks = await getToolBlocks();
  const readBlocks = blocks.filter(b => b.text.toLowerCase().includes('read'));
  record('F', readBlocks.length >= 2 ? 'PASS' : 'PARTIAL', `readBlocks=${readBlocks.length} totalBlocks=${blocks.length}`);
  await win.evaluate(async (id) => await window.ccsm.agentClose(id), sid);
} catch (e) {
  record('F', 'BUG', e.message);
}

await app.close();
cfg.cleanup();

// Write report
const reportPath = path.join(REPO_ROOT, 'docs/dogfood/r2/fp8-report.md');
const lines = [
  '# Dogfood r2 fp8 — tool-call rendering report',
  '',
  `Branch: dogfood-r2-fp8 | HEAD: ${process.env.GITHUB_SHA || '(local)'} | Date: ${new Date().toISOString()}`,
  `Installer reused from pool-6 (commit dc9dad9).`,
  `Screenshots: docs/screenshots/dogfood-r2/fp8-tools/`,
  '',
];
const allPass = Object.values(results).every(r => r.status === 'PASS');
const anyBug = Object.values(results).some(r => r.status === 'BUG');
const heading = anyBug ? '## fp8: BUG' : (allPass ? '## fp8: PASS' : '## fp8: PARTIAL');
lines.push(heading, '');
for (const k of ['A','B','C','D','E','F']) {
  const r = results[k] || { status: 'SKIP', notes: 'not run' };
  lines.push(`- Check ${k}: **${r.status}** — ${r.notes}`);
}
fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');
console.log('[fp8] wrote', reportPath);

const exitCode = anyBug ? 1 : 0;
process.exit(exitCode);
