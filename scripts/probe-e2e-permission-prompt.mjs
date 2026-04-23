// MERGED INTO scripts/harness-perm.mjs (case id=permission-prompt; see harness file).
// This per-file probe is kept as a breadcrumb. The runner skips it via MERGED_INTO_HARNESS.
// Live e2e (renderer-only): inject a `waiting` permission block into the
// running renderer store and verify the new PermissionPromptBlock component
// renders EXPANDED with the expected keyboard behaviour. Bypasses the actual
// agent/claude.exe path since the sandbox intercepts destructive bash before
// the permission callback fires — that flow is covered by unit tests. This
// probe locks down the RENDER contract end-to-end in a real Electron window.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-e2e-permission-prompt] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', AGENTORY_DEV_PORT: process.env.AGENTORY_DEV_PORT ?? '4102' }
});
app.process().stderr?.on('data', (d) => process.stderr.write(`[electron-stderr] ${d}`));

await app.evaluate(async ({ dialog }, fakeCwd) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeCwd] });
}, root);

const win = await appWindow(app, { timeout: 30_000 });
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

// Ensure at least one session exists — click New Session if the empty state
// is showing.
const newBtn = win.getByRole('button', { name: /new session/i }).first();
if (await newBtn.isVisible().catch(() => false)) {
  await newBtn.click();
  await win.waitForTimeout(1500);
}

// Inject a fake permission block into the renderer store directly. Uses the
// public zustand hook on window for test access.
const injectResult = await win.evaluate(() => {
  const store = window.__agentoryStore;
  if (!store) return { ok: false, reason: 'no __agentoryStore on window' };
  const state = store.getState();
  const activeId = state.activeId;
  if (!activeId) return { ok: false, reason: 'no active session' };
  state.appendBlocks(activeId, [
    {
      kind: 'waiting',
      id: 'wait-PROBE-RID',
      prompt: 'Bash: rm -rf /tmp/probe',
      intent: 'permission',
      requestId: 'PROBE-RID',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /tmp/probe', description: 'Remove probe tmp dir' }
    }
  ]);
  return { ok: true, activeId };
});

if (!injectResult.ok) {
  const preloaded = await win.evaluate(() => typeof window.agentory !== 'undefined');
  fail(`cannot inject: ${injectResult.reason}, preload=${preloaded}`, app);
}

await win.waitForTimeout(500);

const heading = win.locator('text=Permission required').first();
try {
  await heading.waitFor({ state: 'visible', timeout: 5_000 });
} catch {
  const dump = await win.evaluate(() => document.body.innerText.slice(0, 2500));
  console.error('--- body ---\n' + dump);
  console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
  fail('no Permission required heading rendered', app);
}

const snapshot = await win.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('[data-perm-action]')).map((b) => ({
    action: b.getAttribute('data-perm-action'),
    label: b.textContent?.trim(),
    focused: b === document.activeElement
  }));
  const heading = Array.from(document.querySelectorAll('*')).find(
    (n) => n.textContent?.trim() === 'Permission required'
  );
  const container = heading?.closest('[role="alertdialog"]');
  return {
    buttons: btns,
    containerHTML: container ? container.outerHTML.slice(0, 2500) : '<no container>'
  };
});

console.log('\n=== Permission prompt DOM (first 2.5KB) ===');
console.log(snapshot.containerHTML);
console.log('\n[probe-e2e-permission-prompt] buttons:', JSON.stringify(snapshot.buttons));

if (snapshot.buttons.length !== 2) fail(`expected 2 perm buttons, got ${snapshot.buttons.length}`, app);
const reject = snapshot.buttons.find((b) => b.action === 'reject');
const allow = snapshot.buttons.find((b) => b.action === 'allow');
if (!reject || !/Reject \(N\)/i.test(reject.label ?? '')) fail(`bad reject label: ${reject?.label}`, app);
if (!allow || !/Allow \(Y\)/i.test(allow.label ?? '')) fail(`bad allow label: ${allow?.label}`, app);
if (!reject.focused) fail(`expected Reject focused; got ${JSON.stringify(snapshot.buttons)}`, app);

// Press N -> Reject. Block should disappear from DOM after resolvePermission removes it.
await win.keyboard.press('n');

try {
  await heading.waitFor({ state: 'detached', timeout: 3_000 });
} catch {
  fail('prompt still visible after pressing N', app);
}

// Now inject a second one and press Y.
await win.evaluate(() => {
  const store = window.__agentoryStore;
  const s = store.getState();
  s.appendBlocks(s.activeId, [
    {
      kind: 'waiting',
      id: 'wait-PROBE-RID-2',
      prompt: 'Bash: echo allowed',
      intent: 'permission',
      requestId: 'PROBE-RID-2',
      toolName: 'Bash',
      toolInput: { command: 'echo allowed' }
    }
  ]);
});
await win.waitForTimeout(400);
await heading.waitFor({ state: 'visible', timeout: 3_000 });
await win.keyboard.press('y');
try {
  await heading.waitFor({ state: 'detached', timeout: 3_000 });
} catch {
  fail('prompt still visible after pressing Y', app);
}

console.log('\n[probe-e2e-permission-prompt] OK: expanded=yes rejectFocused=yes keyboard Y/N works');

await app.close();
