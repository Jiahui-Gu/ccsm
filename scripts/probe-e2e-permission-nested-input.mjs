// MERGED INTO scripts/harness-perm.mjs (case id=permission-nested-input; see harness file).
// This per-file probe is kept as a breadcrumb. The runner skips it via MERGED_INTO_HARNESS.
// Journey 6: nested toolInput object renders as readable summary.
//
// Expected user experience: when toolInput is `{ command: 'ls', flags: { a:
// true, l: true } }`, the permission UI shows the command (`ls`) AND a
// human-readable summary of `flags` (e.g. `a=true, l=true` or `{a: true, l:
// true}`), NEVER the JS coercion sentinel "[object Object]".
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PROBE = 'probe-e2e-permission-nested-input';

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

await win.evaluate(() => {
  const s = window.__agentoryStore.getState();
  if (!s.activeId) s.createSession?.(null);
});
await win.waitForTimeout(200);

await win.evaluate(() => {
  const s = window.__agentoryStore.getState();
  s.appendBlocks(s.activeId, [{
    kind: 'waiting',
    id: 'wait-PROBE-NESTED',
    prompt: 'Bash ls',
    intent: 'permission',
    requestId: 'PROBE-NESTED',
    toolName: 'Bash',
    toolInput: { command: 'ls', flags: { a: true, l: true } }
  }]);
});

const heading = win.locator('text=Permission required').first();
await heading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('heading not visible', app, ud.cleanup));
await win.waitForTimeout(300);

const inspect = await win.evaluate(() => {
  const heading = Array.from(document.querySelectorAll('*')).find(
    (n) => n.textContent?.trim() === 'Permission required'
  );
  const container = heading?.closest('[role="alertdialog"]');
  if (!container) return { ok: false };
  const text = container.textContent ?? '';
  return {
    ok: true,
    text,
    hasObjectObject: text.includes('[object Object]'),
    // Substring rather than \b...\b — DL renders <dt>command</dt><dd>ls</dd>
    // which yields the concatenated textContent "commandls", legitimately
    // containing "ls".
    hasCommand: text.includes('ls'),
    // For the nested `flags` object we expect the renderer to surface BOTH
    // the keys (a, l) and their truthy values somewhere in the body. Look
    // for the keyword "flags" plus at least one of the keys/values nearby.
    mentionsFlags: /flags/i.test(text),
    hasFlagA: /\ba\b/.test(text) && /true/i.test(text),
    hasFlagL: /\bl\b/.test(text)
  };
});

if (!inspect.ok) fail('container missing', app, ud.cleanup);
console.log(`[${PROBE}] inspect:`, JSON.stringify({ ...inspect, text: inspect.text.slice(0, 500) }));

if (inspect.hasObjectObject) {
  fail(`rendered "[object Object]" — nested toolInput not properly serialized. Text: ${inspect.text.slice(0, 500)}`, app, ud.cleanup);
}
if (!inspect.hasCommand) {
  fail(`command "ls" not visible in permission body. Text: ${inspect.text.slice(0, 500)}`, app, ud.cleanup);
}
if (!inspect.mentionsFlags) {
  fail(`nested key "flags" not surfaced in permission body — nested object dropped from render. Text: ${inspect.text.slice(0, 500)}`, app, ud.cleanup);
}
if (!(inspect.hasFlagA && inspect.hasFlagL)) {
  fail(`nested flag values not summarised (need keys a/l + true visible). Text: ${inspect.text.slice(0, 500)}`, app, ud.cleanup);
}

console.log(`\n[${PROBE}] OK: nested toolInput rendered without [object Object]`);
await app.close();
ud.cleanup();
