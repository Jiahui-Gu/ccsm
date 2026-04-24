// Journey 5: rejection truly stops the agent.
//
// Expected user experience:
//   - User presses N to reject a permission.
//   - The block disappears (already covered in other probes).
//   - The renderer issues `agentResolvePermission(sessionId, requestId, 'deny')`
//     ONCE — this is what tells claude.exe to deny the tool call. Without it
//     the agent silently re-tries or hangs.
//   - The chat surfaces a visible trace that the call was denied — either a
//     "Permission denied" / "Rejected" status block, or the original waiting
//     block transitioned into a denied state. (NOT silently removed with no
//     trace — user must be able to scroll back and see what they declined.)
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PROBE = 'probe-e2e-permission-reject-stops-agent';

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

// Ensure a session exists.
await win.evaluate(() => {
  const s = window.__ccsmStore.getState();
  if (!s.activeId) s.createSession?.(null);
});
await win.waitForTimeout(200);

// Wrap the store action — see shortcut-scope probe for rationale (contextBridge
// freezes window.ccsm so property assignment is silently dropped).
await win.evaluate(() => {
  window.__permCalls = [];
  const store = window.__ccsmStore;
  const origAction = store.getState().resolvePermission;
  store.setState({
    resolvePermission: (sessionId, requestId, decision) => {
      window.__permCalls.push({ sessionId, requestId, decision, at: Date.now() });
      return origAction(sessionId, requestId, decision);
    }
  });
});

const sessionId = await win.evaluate(() => {
  const s = window.__ccsmStore.getState();
  s.appendBlocks(s.activeId, [{
    kind: 'waiting',
    id: 'wait-PROBE-REJECT',
    prompt: 'Bash dangerous',
    intent: 'permission',
    requestId: 'PROBE-REJECT',
    toolName: 'Bash',
    toolInput: { command: 'rm -rf /tmp/danger' }
  }]);
  return s.activeId;
});

const heading = win.locator('text=Permission required').first();
await heading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('heading not visible', app, ud.cleanup));

// Move focus off textarea so N triggers the hotkey.
await win.evaluate(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  document.body.focus?.();
});
await win.waitForTimeout(150);

await win.keyboard.press('n');

// Block must unmount.
await heading.waitFor({ state: 'detached', timeout: 3000 }).catch(() => fail('block still visible after N', app, ud.cleanup));
await win.waitForTimeout(300);

// CONTRACT 1: agentResolvePermission called exactly once with 'deny'.
const calls = await win.evaluate(() => window.__permCalls.slice());
if (calls.length !== 1) {
  fail(`expected exactly 1 IPC call, got ${calls.length}: ${JSON.stringify(calls)}`, app, ud.cleanup);
}
if (calls[0].requestId !== 'PROBE-REJECT' || calls[0].decision !== 'deny' || calls[0].sessionId !== sessionId) {
  fail(`wrong IPC payload: ${JSON.stringify(calls[0])}`, app, ud.cleanup);
}

// Wait a beat then re-check that no extra retry IPC fires (silent re-attempt).
await win.waitForTimeout(800);
const callsLater = await win.evaluate(() => window.__permCalls.slice());
if (callsLater.length !== 1) {
  fail(`renderer retried IPC after deny: ${JSON.stringify(callsLater)}`, app, ud.cleanup);
}

// CONTRACT 2: chat retains a visible "denied"/"rejected" trace for the request.
const chatText = await win.evaluate(() => {
  // Search any chat-area text. ChatStream column is broad — just grab body.
  return document.body.innerText;
});
const hasDeniedTrace = /permission denied|rejected|denied/i.test(chatText);
if (!hasDeniedTrace) {
  fail(`no visible "denied"/"rejected" trace remains in chat after rejection (chat body did not contain such text). Body excerpt: ${chatText.slice(0, 800)}`, app, ud.cleanup);
}

console.log(`\n[${PROBE}] OK: deny IPC fired once, no retry, chat retained denial trace`);
await app.close();
ud.cleanup();
