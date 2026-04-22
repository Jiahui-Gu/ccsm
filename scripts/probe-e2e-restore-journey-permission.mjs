// User journey: a session has a pending PermissionPrompt block when the app
// is closed. After restart the block must remain interactive — Allow/Reject
// must be clickable, the click must visually clear the block (so the user
// isn't stuck staring at it forever), and the IPC must be exercised.
//
// Strategy:
//   #1: seed a `kind: 'waiting'` block with intent='permission' and a stale
//       requestId. Block id MUST be `wait-${requestId}` because the renderer
//       store keys removal off that exact id.
//   #2: relaunch. Assert "Permission required" heading + Allow + Reject
//       buttons render and are enabled. Spy on agent:resolvePermission and
//       click Allow. Block must disappear and IPC must be invoked.
//
// Run after `npm run build`.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-restore-journey-permission] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-restore-perm-'));
console.log(`[probe-e2e-restore-journey-permission] userData = ${userDataDir}`);

const commonEnv = { ...process.env, AGENTORY_PROD_BUNDLE: '1' };
const commonArgs = ['.', `--user-data-dir=${userDataDir}`];

const SESSION_ID = 's-restore-perm-1';
const GROUP_ID = 'g-default';
const STALE_REQ_ID = 'perm-stale-perm-77';

const PERM_BLOCK = {
  kind: 'waiting',
  id: `wait-${STALE_REQ_ID}`,
  prompt: 'Allow Bash to run "rm -rf node_modules"?',
  intent: 'permission',
  requestId: STALE_REQ_ID,
  toolName: 'Bash',
  toolInput: { command: 'rm -rf node_modules' }
};

const PRELUDE = [
  { kind: 'user', id: 'u-1', text: 'clean install please' },
  { kind: 'assistant', id: 'a-1', text: 'Need permission to remove node_modules first.' },
  PERM_BLOCK
];

// ---------- Launch #1: seed ----------
{
  const app = await electron.launch({ args: commonArgs, cwd: root, env: commonEnv });
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);

  const seeded = await win.evaluate(
    async ({ sid, gid, blocks }) => {
      const api = window.agentory;
      if (!api) return { ok: false, err: 'no window.agentory' };
      const state = {
        version: 1,
        sessions: [
          {
            id: sid,
            name: 'Restore Perm probe',
            state: 'waiting',
            cwd: '~',
            model: 'claude-opus-4',
            groupId: gid,
            agentType: 'claude-code'
          }
        ],
        groups: [{ id: gid, name: 'Sessions', collapsed: false, kind: 'normal' }],
        activeId: sid,
        model: 'claude-opus-4',
        permission: 'auto',
        sidebarCollapsed: false,
        theme: 'system',
        fontSize: 'md',
        recentProjects: [],
        tutorialSeen: true
      };
      await api.saveState('main', JSON.stringify(state));
      await api.saveMessages(sid, blocks);
      const rt = await api.loadMessages(sid);
      return { ok: true, n: rt.length, lastKind: rt[rt.length - 1]?.kind, lastIntent: rt[rt.length - 1]?.intent };
    },
    { sid: SESSION_ID, gid: GROUP_ID, blocks: PRELUDE }
  );
  if (!seeded.ok) {
    await app.close();
    fail(`seed failed: ${seeded.err}`);
  }
  if (seeded.n !== 3 || seeded.lastKind !== 'waiting' || seeded.lastIntent !== 'permission') {
    await app.close();
    fail(`bad seed roundtrip: ${JSON.stringify(seeded)}`);
  }
  console.log('[probe-e2e-restore-journey-permission] launch #1: seeded permission block');
  await app.close();
}

// ---------- Launch #2: assert interactivity preserved ----------
{
  const app = await electron.launch({ args: commonArgs, cwd: root, env: commonEnv });
  const win = await appWindow(app);
  const errors = [];
  win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
  });

  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(2000);

  // (1) PermissionPromptBlock heading must be visible.
  const heading = win.locator('text=Permission required').first();
  try {
    await heading.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    const dump = await win.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.innerText.slice(0, 1500) : '<no <main>>';
    });
    console.error('--- main innerText ---\n' + dump);
    console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
    await app.close();
    fail('PermissionPromptBlock not rendered after restore');
  }

  // (2) Allow + Reject buttons must be present AND enabled.
  const allowBtn = win.getByRole('button', { name: /allow/i }).first();
  const rejectBtn = win.getByRole('button', { name: /reject/i }).first();
  await allowBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
    await app.close();
    fail('Allow button not visible after restore');
  });
  await rejectBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
    await app.close();
    fail('Reject button not visible after restore');
  });
  if (await allowBtn.isDisabled()) {
    await app.close();
    fail('Allow button disabled after restore — block is rendered as readonly history (broken interactivity)');
  }
  if (await rejectBtn.isDisabled()) {
    await app.close();
    fail('Reject button disabled after restore — block is rendered as readonly history');
  }

  // (3) Spy on main-side IPC.
  const wrapOk = await app.evaluate(({ ipcMain }) => {
    if (globalThis.__probeWrapInstalled) return true;
    globalThis.__probeCalls = { resolvePerm: [] };
    ipcMain.removeHandler('agent:resolvePermission');
    ipcMain.handle('agent:resolvePermission', async (_e, sessionId, requestId, decision) => {
      globalThis.__probeCalls.resolvePerm.push([sessionId, requestId, decision]);
      return false;
    });
    globalThis.__probeWrapInstalled = true;
    return true;
  });
  if (!wrapOk) {
    await app.close();
    fail('failed to install IPC spy');
  }

  // (4) Click Allow. The block MUST disappear from the DOM (resolvePermission
  // in the store filters it out). And IPC must be called.
  const errorsBefore = errors.length;
  await allowBtn.click();
  // Heading should be gone — wait up to 3s.
  try {
    await heading.waitFor({ state: 'hidden', timeout: 3000 });
  } catch {
    await app.close();
    fail('after Allow click the PermissionPromptBlock did NOT disappear — user is stuck with a permanent block');
  }

  const newErrors = errors.slice(errorsBefore);
  if (newErrors.length > 0) {
    console.error('--- new errors after Allow ---');
    for (const e of newErrors) console.error('  ' + e);
    await app.close();
    fail(`${newErrors.length} error(s) raised when resolving permission against a stale agent`);
  }

  const calls = await app.evaluate(() => globalThis.__probeCalls ?? { resolvePerm: [] });
  const allowCall = calls.resolvePerm.find(
    (args) => args[0] === SESSION_ID && args[1] === STALE_REQ_ID && args[2] === 'allow'
  );
  if (!allowCall) {
    console.error('--- IPC calls observed ---');
    console.error(JSON.stringify(calls, null, 2));
    await app.close();
    fail('agent:resolvePermission was not invoked with (session, requestId, allow) — decision was lost');
  }
  console.log(`  agent:resolvePermission invoked: ${JSON.stringify(allowCall)}`);

  console.log('\n[probe-e2e-restore-journey-permission] OK');
  console.log('  PermissionPromptBlock visible + Allow/Reject enabled after restore');
  console.log('  Allow click cleared the block and reached IPC');

  await app.close();
}

try {
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch {}
