// E2E: import session via the sidebar Import button + ImportDialog.
//
// Flow under test:
//   1. User clicks the sidebar Import button.
//   2. ImportDialog mounts and calls `import:scan` IPC; we mock that handler
//      in the MAIN process so the test does not depend on the user's real
//      ~/.claude/projects folder.
//   3. The fixture row appears in the dialog. User selects it, clicks Import.
//   4. Dialog closes. Sidebar gains a new session whose name = fixture title,
//      and the store reflects the new session backed by importSession() with
//      the resumeSessionId we mocked.
//
// Pure black-box for the dialog UI; the post-condition assertion uses the
// public __agentoryStore handle.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-import-session] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-import-'));

const FIXTURE = {
  sessionId: 'fixture-resume-id-12345',
  cwd: '/tmp/fixture-cwd',
  title: 'Fixture imported session',
  // mtime: ~ now, so it lands in the "Today" bucket.
  mtime: Date.now(),
  projectDir: '-tmp-fixture-cwd',
  model: 'claude-opus-4'
};

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

// Wait for the renderer window to mount FIRST — that guarantees the main
// process has finished registering the original `import:scan` IPC handler
// (those registrations sit inside whenReady → before createWindow). Only then
// is it safe to remove + re-register with our fixture.
const errors = [];
const win = await appWindow(app);
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 10_000 });

// Replace the `import:scan` IPC handler with one that returns our fixture.
// The renderer-side ImportDialog does no transformation beyond filtering out
// sessionIds that already exist in the store, so the fixture passes through.
await app.evaluate(async ({ ipcMain }, fixture) => {
  try { ipcMain.removeHandler('import:scan'); } catch {}
  ipcMain.handle('import:scan', () => [fixture]);
}, FIXTURE);

// Force a known starting state: zero sessions, tutorial seen — so the
// landing page renders the sidebar Import button and the dialog opens
// against a clean slate.
await win.evaluate(() => {
  window.__agentoryStore.setState({
    sessions: [],
    groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
    activeId: '',
    tutorialSeen: true
  });
});
await win.waitForTimeout(200);

const sessionsBefore = await win.evaluate(() => window.__agentoryStore.getState().sessions.length);
if (sessionsBefore !== 0) {
  await app.close();
  fail(`expected 0 sessions before import, got ${sessionsBefore}`);
}

// 1. Click the sidebar Import button (aria-label "Import session").
const importBtn = win.locator('aside').getByRole('button', { name: /import session/i }).first();
await importBtn.waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
  const html = await win.evaluate(() => document.body.innerText.slice(0, 800));
  console.error('--- body text ---\n' + html);
  await app.close();
  fail('sidebar Import button not visible');
});
await importBtn.click();

// 2. Dialog opens, fixture row should appear (title = "Fixture imported session").
const fixtureRow = win.getByText('Fixture imported session').first();
await fixtureRow.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
  const dump = await win.evaluate(() => document.body.innerText.slice(0, 1500));
  console.error('--- body at failure ---\n' + dump);
  console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
  await app.close();
  fail('fixture session row never appeared in ImportDialog');
});

// 3. Select it (clicking the row toggles the checkbox via the <li> handler).
await fixtureRow.click();
await win.waitForTimeout(120);

// 4. Click Import button. The dialog footer shows "Import 1" — match the
//    primary CTA by name (uses the i18n importN key, English template
//    "Import {{count}}").
const confirmBtn = win.getByRole('button', { name: /^Import 1$/ });
await confirmBtn.waitFor({ state: 'visible', timeout: 3000 });
await confirmBtn.click();

// 5. Wait for dialog to close + store to gain a new session.
await win.waitForFunction(
  () => window.__agentoryStore.getState().sessions.length === 1,
  null,
  { timeout: 5000 }
).catch(async () => {
  const sessions = await win.evaluate(() => window.__agentoryStore.getState().sessions);
  console.error('--- sessions after import ---\n' + JSON.stringify(sessions, null, 2));
  console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
  await app.close();
  fail('importing fixture did not produce exactly 1 session');
});

const newSession = await win.evaluate(() => window.__agentoryStore.getState().sessions[0]);
if (newSession.name !== FIXTURE.title) {
  await app.close();
  fail(`imported session name=${newSession.name}, expected ${FIXTURE.title}`);
}
if (newSession.cwd !== FIXTURE.cwd) {
  await app.close();
  fail(`imported session cwd=${newSession.cwd}, expected ${FIXTURE.cwd}`);
}

// 6. Sidebar should now show the imported session row.
const sidebarRow = win.locator('aside').getByText(FIXTURE.title).first();
const sidebarVisible = await sidebarRow.isVisible().catch(() => false);
if (!sidebarVisible) {
  await app.close();
  fail('imported session not visible in sidebar after import');
}

console.log('\n[probe-e2e-import-session] OK');
console.log('  sidebar Import button → ImportDialog opened');
console.log('  fixture row rendered, selected, Import (1) committed');
console.log(`  store gained 1 session: name="${newSession.name}", cwd="${newSession.cwd}"`);
console.log('  sidebar shows the imported session');

await app.close();

try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
