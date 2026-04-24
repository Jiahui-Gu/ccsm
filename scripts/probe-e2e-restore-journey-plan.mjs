// User journey: a session has a pending Plan (ExitPlanMode) when the app is
// closed. After restart the PlanBlock must remain interactive — Approve and
// Reject buttons must work, the click must clear the block and reach the IPC
// for resolvePermission (since plans share the permission machinery).
//
// Strategy:
//   #1: seed `kind: 'waiting'` with intent='plan', non-empty plan field, stale
//       requestId. Block id MUST be `wait-${requestId}`.
//   #2: relaunch. Assert "Plan ready for review" + Approve + Reject render
//       and are enabled. Spy on agent:resolvePermission, click Approve,
//       assert block disappears + IPC was hit with decision='allow'.
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
  console.error(`\n[probe-e2e-restore-journey-plan] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-restore-plan-'));
console.log(`[probe-e2e-restore-journey-plan] userData = ${userDataDir}`);

const commonEnv = { ...process.env, CCSM_PROD_BUNDLE: '1' };
const commonArgs = ['.', `--user-data-dir=${userDataDir}`];

const SESSION_ID = 's-restore-plan-1';
const GROUP_ID = 'g-default';
const STALE_REQ_ID = 'perm-stale-plan-55';
const PLAN_MARKER = 'PROBE-PLAN-MARKER-XYZ';

const PLAN_BLOCK = {
  kind: 'waiting',
  id: `wait-${STALE_REQ_ID}`,
  prompt: 'Approve this plan?',
  intent: 'plan',
  requestId: STALE_REQ_ID,
  plan: `# Refactor steps\n\n1. ${PLAN_MARKER}\n2. update tests\n3. update docs\n`
};

const PRELUDE = [
  { kind: 'user', id: 'u-1', text: 'plan it out before doing anything' },
  { kind: 'assistant', id: 'a-1', text: 'Here is the plan…' },
  PLAN_BLOCK
];

// ---------- Launch #1: seed ----------
{
  const app = await electron.launch({ args: commonArgs, cwd: root, env: commonEnv });
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);

  const seeded = await win.evaluate(
    async ({ sid, gid, blocks }) => {
      const api = window.ccsm;
      if (!api) return { ok: false, err: 'no window.ccsm' };
      const state = {
        version: 1,
        sessions: [
          {
            id: sid,
            name: 'Restore Plan probe',
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
        permission: 'plan',
        sidebarCollapsed: false,
        theme: 'system',
        fontSize: 'md',
        recentProjects: [],
        tutorialSeen: true
      };
      await api.saveState('main', JSON.stringify(state));
      await api.saveMessages(sid, blocks);
      const rt = await api.loadMessages(sid);
      const last = rt[rt.length - 1];
      return {
        ok: true,
        n: rt.length,
        lastKind: last?.kind,
        lastIntent: last?.intent,
        hasPlan: !!last?.plan
      };
    },
    { sid: SESSION_ID, gid: GROUP_ID, blocks: PRELUDE }
  );
  if (!seeded.ok) {
    await app.close();
    fail(`seed failed: ${seeded.err}`);
  }
  if (seeded.lastKind !== 'waiting' || seeded.lastIntent !== 'plan' || !seeded.hasPlan) {
    await app.close();
    fail(`bad seed roundtrip: ${JSON.stringify(seeded)}`);
  }
  console.log('[probe-e2e-restore-journey-plan] launch #1: seeded plan block');
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

  // (1) PlanBlock heading + plan body must be visible.
  const heading = win.locator('text=Plan ready for review').first();
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
    fail('PlanBlock not rendered after restore');
  }
  const planMarker = win.locator(`text=${PLAN_MARKER}`).first();
  if (!(await planMarker.isVisible().catch(() => false))) {
    await app.close();
    fail(`plan body marker "${PLAN_MARKER}" not rendered after restore — plan field was dropped`);
  }

  // (2) Approve + Reject must be present AND enabled.
  const approveBtn = win.getByRole('button', { name: /approve plan/i }).first();
  const rejectBtn = win.getByRole('button', { name: /^reject$/i }).first();
  await approveBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
    await app.close();
    fail('Approve button not visible after restore');
  });
  await rejectBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
    await app.close();
    fail('Reject button not visible after restore');
  });
  if (await approveBtn.isDisabled()) {
    await app.close();
    fail('Approve button disabled after restore — block is rendered as readonly history');
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

  // (4) Click Approve. Block must disappear + IPC must be called with allow.
  const errorsBefore = errors.length;
  await approveBtn.click();
  try {
    await heading.waitFor({ state: 'hidden', timeout: 3000 });
  } catch {
    await app.close();
    fail('after Approve click the PlanBlock did NOT disappear — user is stuck with a permanent block');
  }

  const newErrors = errors.slice(errorsBefore);
  if (newErrors.length > 0) {
    console.error('--- new errors after Approve ---');
    for (const e of newErrors) console.error('  ' + e);
    await app.close();
    fail(`${newErrors.length} error(s) raised when approving plan against a stale agent`);
  }

  const calls = await app.evaluate(() => globalThis.__probeCalls ?? { resolvePerm: [] });
  const approveCall = calls.resolvePerm.find(
    (args) => args[0] === SESSION_ID && args[1] === STALE_REQ_ID && args[2] === 'allow'
  );
  if (!approveCall) {
    console.error('--- IPC calls observed ---');
    console.error(JSON.stringify(calls, null, 2));
    await app.close();
    fail('agent:resolvePermission was not invoked with (session, requestId, allow) — plan approval was lost');
  }
  console.log(`  agent:resolvePermission invoked: ${JSON.stringify(approveCall)}`);

  console.log('\n[probe-e2e-restore-journey-plan] OK');
  console.log('  PlanBlock heading + body + Approve/Reject all interactive after restore');
  console.log('  Approve cleared the block and reached IPC');

  await app.close();
}

try {
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch {}
