// MERGED INTO scripts/harness-perm.mjs (case id=permission-sequential-focus; see harness file).
// This per-file probe is kept as a breadcrumb. The runner skips it via MERGED_INTO_HARNESS.
// Journey 4: focus transfers cleanly from one permission to the next.
//
// Scenario: a permission appears, user resolves it (Y -> Allow), then before
// the user does anything else a second permission arrives. The Reject button
// of the SECOND block must auto-receive focus (safer-default focus policy
// already established by the first block's Reject-default behaviour). Focus
// must NOT remain on a stale element from the unmounted first block, and must
// NOT be on the document body / unrelated UI.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PROBE = 'probe-e2e-permission-sequential-focus';

function fail(msg, app, cleanup) {
  console.error(`\n[${PROBE}] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  if (cleanup) cleanup();
  process.exit(1);
}

const ud = isolatedUserData(PROBE);
const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, AGENTORY_PROD_BUNDLE: '1' }
});
app.process().stderr?.on('data', (d) => process.stderr.write(`[electron-stderr] ${d}`));
await app.evaluate(async ({ dialog }, fakeCwd) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeCwd] });
}, root);

const win = await appWindow(app, { timeout: 30_000 });
win.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

const newBtn = win.getByRole('button', { name: /new session/i }).first();
if (await newBtn.isVisible().catch(() => false)) {
  await newBtn.click();
  await win.waitForTimeout(1500);
}

// Ensure a session exists.
await win.evaluate(() => {
  const s = window.__agentoryStore.getState();
  if (!s.activeId) s.createSession?.(null);
});
await win.waitForTimeout(200);

// Inject first permission.
await win.evaluate(() => {
  const s = window.__agentoryStore.getState();
  s.appendBlocks(s.activeId, [{
    kind: 'waiting',
    id: 'wait-PROBE-SEQ-1',
    prompt: 'Bash 1',
    intent: 'permission',
    requestId: 'PROBE-SEQ-1',
    toolName: 'Bash',
    toolInput: { command: 'echo first' }
  }]);
});

const heading = win.locator('text=Permission required').first();
await heading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('first heading not visible', app, ud.cleanup));
await win.waitForTimeout(200);

// First block's Reject button should be focused (existing policy from
// probe-e2e-permission-prompt.mjs: safer default).
const firstFocus = await win.evaluate(() => {
  const el = document.activeElement;
  return {
    action: el?.getAttribute?.('data-perm-action') ?? null,
    inWaitingBlock: el?.closest?.('[data-block-id]')?.getAttribute('data-block-id') ?? null
  };
});
if (firstFocus.action !== 'reject') {
  fail(`first block: expected Reject focused, got ${JSON.stringify(firstFocus)}`, app, ud.cleanup);
}

// Press Y to resolve first permission.
await win.keyboard.press('y');
await heading.waitFor({ state: 'detached', timeout: 3000 }).catch(() => fail('first block did not unmount after Y', app, ud.cleanup));

// Inject second permission immediately.
await win.evaluate(() => {
  const s = window.__agentoryStore.getState();
  s.appendBlocks(s.activeId, [{
    kind: 'waiting',
    id: 'wait-PROBE-SEQ-2',
    prompt: 'Bash 2',
    intent: 'permission',
    requestId: 'PROBE-SEQ-2',
    toolName: 'Bash',
    toolInput: { command: 'echo second' }
  }]);
});

await heading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('second heading not visible', app, ud.cleanup));
// Allow time for autoFocus effect.
await win.waitForTimeout(400);

const secondFocus = await win.evaluate(() => {
  const el = document.activeElement;
  return {
    tag: el?.tagName?.toLowerCase() ?? null,
    action: el?.getAttribute?.('data-perm-action') ?? null,
    text: el?.textContent?.trim() ?? null,
    isConnected: !!el?.isConnected
  };
});

if (!secondFocus.isConnected) {
  fail(`focus is on a detached element: ${JSON.stringify(secondFocus)}`, app, ud.cleanup);
}
if (secondFocus.action !== 'reject') {
  fail(`second block: expected Reject focused, got ${JSON.stringify(secondFocus)}`, app, ud.cleanup);
}

// Bonus: pressing N should resolve THIS block (proves the focused element is
// indeed the new block's Reject, not a leftover handler).
await win.keyboard.press('n');
await heading.waitFor({ state: 'detached', timeout: 3000 }).catch(() => fail('second block did not unmount after N', app, ud.cleanup));

console.log(`\n[${PROBE}] OK: focus correctly transfers to second block's Reject`);
await app.close();
ud.cleanup();
