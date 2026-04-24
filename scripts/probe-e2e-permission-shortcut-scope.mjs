// MERGED INTO scripts/harness-perm.mjs (case id=permission-shortcut-scope; see harness file).
// This per-file probe is kept as a breadcrumb. The runner skips it via MERGED_INTO_HARNESS.
// Journey 2: Y/N hotkey scope.
//
// Expected user experience:
//   A. Permission block exists, focus is OUTSIDE textarea (e.g. on body) —
//      pressing Y triggers Allow, pressing N triggers Reject. The decision
//      is forwarded to agentResolvePermission(sessionId, requestId, 'allow'|'deny').
//   B. Permission block exists, focus is INSIDE the composer textarea —
//      pressing Y inserts the literal character "Y" into the textarea and
//      DOES NOT trigger Allow. The permission block remains pending.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PROBE = 'probe-e2e-permission-shortcut-scope';

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
win.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

const newBtn = win.getByRole('button', { name: /new session/i }).first();
if (await newBtn.isVisible().catch(() => false)) {
  await newBtn.click();
  await win.waitForTimeout(1500);
}
const cwdChip = win.locator('[title="~"]').first();
if (await cwdChip.isVisible().catch(() => false)) {
  await cwdChip.click();
  const browseItem = win.getByText('Browse folder…').first();
  await browseItem.waitFor({ state: 'visible', timeout: 3000 });
  await browseItem.click();
  await win.waitForTimeout(400);
}

// Ensure a session exists.
await win.evaluate(() => {
  const s = window.__ccsmStore.getState();
  if (!s.activeId) s.createSession?.(null);
});
await win.waitForTimeout(200);

// Install spy by wrapping the store's resolvePermission action — IPC layer
// (window.ccsm) is frozen by contextBridge so a property assignment
// silently no-ops. Wrapping the store action captures the same call.
await win.evaluate(() => {
  window.__permCalls = [];
  const store = window.__ccsmStore;
  const origAction = store.getState().resolvePermission;
  store.setState({
    resolvePermission: (sessionId, requestId, decision) => {
      window.__permCalls.push({ sessionId, requestId, decision });
      return origAction(sessionId, requestId, decision);
    }
  });
});

const textarea = win.locator('textarea').first();
await textarea.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('textarea not visible', app, ud.cleanup));

// ---- Case A: focus outside textarea, press Y -> Allow ----
const injA = await win.evaluate(() => {
  const s = window.__ccsmStore.getState();
  s.appendBlocks(s.activeId, [{
    kind: 'waiting',
    id: 'wait-PROBE-SCOPE-A',
    prompt: 'Bash A',
    intent: 'permission',
    requestId: 'PROBE-SCOPE-A',
    toolName: 'Bash',
    toolInput: { command: 'echo a' }
  }]);
  return s.activeId;
});
const heading = win.locator('text=Permission required').first();
await heading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('A: heading not visible', app, ud.cleanup));

// Move focus away from any textarea: blur active el and focus body.
await win.evaluate(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  document.body.focus?.();
});
await win.waitForTimeout(150);
// Sanity: focus must NOT be a textarea now.
const focusedTagA = await win.evaluate(() => document.activeElement?.tagName?.toLowerCase() ?? null);
if (focusedTagA === 'textarea') fail(`A: could not move focus off textarea (still ${focusedTagA})`, app, ud.cleanup);

await win.keyboard.press('y');
try {
  await heading.waitFor({ state: 'detached', timeout: 3000 });
} catch {
  fail('A: pressing Y outside textarea did not resolve the permission', app, ud.cleanup);
}
const callsAfterA = await win.evaluate(() => window.__permCalls.slice());
const allowCall = callsAfterA.find((c) => c.requestId === 'PROBE-SCOPE-A');
if (!allowCall || allowCall.decision !== 'allow') {
  fail(`A: expected allow IPC for PROBE-SCOPE-A, got ${JSON.stringify(callsAfterA)}`, app, ud.cleanup);
}

// ---- Case B: focus INSIDE textarea, press Y -> textarea gets "Y", perm stays pending ----
await win.evaluate(() => { window.__permCalls = []; });

await win.evaluate(() => {
  const s = window.__ccsmStore.getState();
  s.appendBlocks(s.activeId, [{
    kind: 'waiting',
    id: 'wait-PROBE-SCOPE-B',
    prompt: 'Bash B',
    intent: 'permission',
    requestId: 'PROBE-SCOPE-B',
    toolName: 'Bash',
    toolInput: { command: 'echo b' }
  }]);
});
await heading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('B: heading not visible', app, ud.cleanup));

await textarea.click();
await textarea.fill('hello');
const focusB = await win.evaluate(() => document.activeElement?.tagName?.toLowerCase());
if (focusB !== 'textarea') fail(`B: could not focus textarea (got ${focusB})`, app, ud.cleanup);

// Type a single Y key.
await win.keyboard.type('Y');
await win.waitForTimeout(250);

const taValue = await textarea.inputValue();
if (taValue !== 'helloY') {
  fail(`B: expected textarea to receive literal "Y" (helloY), got ${JSON.stringify(taValue)}`, app, ud.cleanup);
}
// Permission must still be pending.
const stillVisible = await heading.isVisible();
if (!stillVisible) fail('B: permission resolved while typing into textarea', app, ud.cleanup);
const callsAfterB = await win.evaluate(() => window.__permCalls.slice());
const leakedB = callsAfterB.find((c) => c.requestId === 'PROBE-SCOPE-B');
if (leakedB) fail(`B: hotkey fired despite focus inside textarea: ${JSON.stringify(leakedB)}`, app, ud.cleanup);

console.log(`\n[${PROBE}] OK: A=Y triggers allow off-textarea; B=Y types literal in-textarea`);
await app.close();
ud.cleanup();
