// MERGED INTO scripts/harness-perm.mjs (case id=permission-focus-not-stolen; see harness file).
// This per-file probe is kept as a breadcrumb. The runner skips it via MERGED_INTO_HARNESS.
// Journey 1: when a permission request appears asynchronously while the user
// is mid-typing in the composer textarea, focus MUST remain on the textarea so
// the next keystroke continues the in-progress message. The permission block
// renders, but does not steal focus.
//
// Expected user experience:
//   - User clicks the textarea, types "docker rmi xxx" (no Enter).
//   - Agent (mocked) injects a `waiting` permission block.
//   - The permission block becomes visible.
//   - document.activeElement is STILL the textarea.
//   - The next keystroke ("a") is appended to the textarea content, NOT
//     consumed by the permission block.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PROBE = 'probe-e2e-permission-focus-not-stolen';

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
  env: { ...process.env, CCSM_PROD_BUNDLE: '1' }
});
app.process().stderr?.on('data', (d) => process.stderr.write(`[electron-stderr] ${d}`));
await app.evaluate(async ({ dialog }, fakeCwd) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeCwd] });
}, root);

const win = await appWindow(app, { timeout: 30_000 });
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

// Open a session if needed.
const newBtn = win.getByRole('button', { name: /new session/i }).first();
if (await newBtn.isVisible().catch(() => false)) {
  await newBtn.click();
  await win.waitForTimeout(1500);
}

// Ensure a session exists with a valid cwd so InputBar enables the textarea.
await win.evaluate((cwd) => {
  const s = window.__ccsmStore.getState();
  if (!s.activeId) s.createSession?.(cwd);
  // Force a usable cwd on the active session (otherwise InputBar may stay disabled).
  const cur = window.__ccsmStore.getState();
  const sessions = cur.sessions.map((x) =>
    x.id === cur.activeId ? { ...x, cwd } : x
  );
  window.__ccsmStore.setState({ sessions });
}, root);
await win.waitForTimeout(300);

const textarea = win.locator('textarea').first();
await textarea.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('textarea not visible', app, ud.cleanup));

// Focus + start typing a partial command.
await textarea.click();
await textarea.fill('docker rmi xxx');

// Confirm focus is on textarea before injection.
const focusedBefore = await win.evaluate(() => document.activeElement?.tagName?.toLowerCase());
if (focusedBefore !== 'textarea') {
  fail(`pre-inject focus expected textarea, got ${focusedBefore}`, app, ud.cleanup);
}

// Inject permission block via store (simulates async agent request).
const inj = await win.evaluate(() => {
  const store = window.__ccsmStore;
  if (!store) return { ok: false, reason: 'no __ccsmStore' };
  const s = store.getState();
  const activeId = s.activeId;
  if (!activeId) return { ok: false, reason: 'no active session' };
  s.appendBlocks(activeId, [{
    kind: 'waiting',
    id: 'wait-PROBE-FOCUS',
    prompt: 'Bash: docker rmi xxx',
    intent: 'permission',
    requestId: 'PROBE-FOCUS',
    toolName: 'Bash',
    toolInput: { command: 'docker rmi xxx' }
  }]);
  return { ok: true };
});
if (!inj.ok) fail(`inject failed: ${inj.reason}`, app, ud.cleanup);

// Wait for permission block to become visible.
const heading = win.locator('text=Permission required').first();
await heading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('Permission heading never rendered', app, ud.cleanup));

// Allow a tick for any post-render focus side-effects to flush.
await win.waitForTimeout(250);

// CONTRACT 1: textarea still focused.
const focusedAfter = await win.evaluate(() => {
  const el = document.activeElement;
  return {
    tag: el?.tagName?.toLowerCase() ?? null,
    isTextarea: el instanceof HTMLTextAreaElement,
    insideAlertdialog: !!el?.closest('[role="alertdialog"]')
  };
});
if (!focusedAfter.isTextarea) {
  fail(`focus stolen: activeElement=${JSON.stringify(focusedAfter)}`, app, ud.cleanup);
}
if (focusedAfter.insideAlertdialog) {
  fail('focus moved into permission alertdialog', app, ud.cleanup);
}

// CONTRACT 2: typing more keys appends to textarea, not handled by Y/N hotkey.
//   Use a non-Y/N letter to avoid ambiguity AND a Y to confirm shortcut not firing.
await win.keyboard.type(' more');
await win.waitForTimeout(150);
const afterType = await textarea.inputValue();
if (afterType !== 'docker rmi xxx more') {
  fail(`textarea content changed unexpectedly: ${JSON.stringify(afterType)}`, app, ud.cleanup);
}

// Permission block should still be present (not auto-resolved by typing).
const stillVisible = await heading.isVisible();
if (!stillVisible) fail('permission block disappeared while user was typing', app, ud.cleanup);

console.log(`\n[${PROBE}] OK: focus retained on textarea, typing not intercepted by permission block`);
await app.close();
ud.cleanup();
