// User journey: a session has an unanswered AskUserQuestion block when the
// app is closed. After restart the QuestionBlock must remain FULLY interactive
// (keyboard nav + Enter to submit), and submission must reach a fresh agent.
//
// Strategy:
//   #1: seed sidebar tree + a `kind: 'question'` MessageBlock (with a stale
//       requestId from the dead agent) for the active session. Close.
//   #2: relaunch same userData. Assert the QuestionBlock heading renders, the
//       Submit button is ENABLED (not stuck "Submitted"), the radio options
//       are operable via ArrowDown/ArrowUp, and pressing Enter transitions
//       the block to "Submitted" without throwing.
//   Then capture pageerror / console.error for any thrown rejection from the
//   onSubmit handler — failure to send to a dead agent must NOT explode.
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
  console.error(`\n[probe-e2e-restore-journey-question] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-restore-q-'));
console.log(`[probe-e2e-restore-journey-question] userData = ${userDataDir}`);

const commonEnv = { ...process.env, CCSM_PROD_BUNDLE: '1' };
const commonArgs = ['.', `--user-data-dir=${userDataDir}`];

const SESSION_ID = 's-restore-q-1';
const GROUP_ID = 'g-default';
const STALE_REQ_ID = 'perm-stale-q-99';

const QUESTION_BLOCK = {
  kind: 'question',
  id: 'qb-1',
  requestId: STALE_REQ_ID,
  questions: [
    {
      question: 'Which language for the new module?',
      options: [
        { label: 'Python' },
        { label: 'TypeScript' },
        { label: 'Rust' }
      ]
    }
  ]
};

// Some context so the chat looks plausible.
const PRELUDE = [
  { kind: 'user', id: 'u-1', text: 'pick a language' },
  { kind: 'assistant', id: 'a-1', text: 'Let me ask…' },
  QUESTION_BLOCK
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
            name: 'Restore Q probe',
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
      return { ok: true, n: rt.length, lastKind: rt[rt.length - 1]?.kind };
    },
    { sid: SESSION_ID, gid: GROUP_ID, blocks: PRELUDE }
  );
  if (!seeded.ok) {
    await app.close();
    fail(`seed failed: ${seeded.err}`);
  }
  if (seeded.n !== 3 || seeded.lastKind !== 'question') {
    await app.close();
    fail(`expected 3 blocks ending in question, got n=${seeded.n} last=${seeded.lastKind}`);
  }
  console.log('[probe-e2e-restore-journey-question] launch #1: seeded question block');
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

  // (1) QuestionBlock heading must be visible.
  const heading = win.locator('text=Question awaiting answer').first();
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
    fail('QuestionBlock not rendered after restore');
  }

  // (2) Submit button must be present AND enabled (NOT stuck "Submitted").
  const submitBtn = win.getByRole('button', { name: /^submit answer$/i }).first();
  try {
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    // Maybe the block is locked into "Submitted" state — that's a bug too.
    const isSubmitted = await win
      .getByRole('button', { name: /^submitted$/i })
      .first()
      .isVisible()
      .catch(() => false);
    await app.close();
    fail(
      isSubmitted
        ? 'EXPECTED interactive Submit button; FOUND stuck "Submitted" state — block was rendered as readonly history'
        : 'no Submit button found after restore'
    );
  }
  if (await submitBtn.isDisabled()) {
    await app.close();
    fail('Submit button is disabled after restore — block is not interactive');
  }

  // (3) Radio options must be operable. Default selection is option 0 (Python).
  // Move down to TypeScript.
  const radios = win.locator('[role="radio"]');
  const radioCount = await radios.count();
  if (radioCount !== 3) {
    await app.close();
    fail(`expected 3 radio options, got ${radioCount}`);
  }
  // Focus the first radio explicitly (autoFocus may have been pre-empted by
  // some hydrate timing detail).
  await radios.first().focus();
  await win.keyboard.press('ArrowDown');
  await win.waitForTimeout(80);

  const focused = await win.evaluate(() => {
    const el = document.activeElement;
    if (!el) return { role: null, value: null };
    return { role: el.getAttribute('role'), value: el.getAttribute('value') };
  });
  if (focused.role !== 'radio' || focused.value !== '1') {
    await app.close();
    fail(
      `arrow-key navigation broken after restore: expected radio value=1, got ${JSON.stringify(focused)}`
    );
  }

  // (4) Spy on main-side IPC handlers. contextBridge freezes the renderer
  // proxy so we can't wrap `window.ccsm` from the renderer; instead we
  // re-register the relevant `ipcMain.handle()` channels on the main side
  // with a spy that records calls into a global, then delegates to the
  // original handler. We retrieve the recorded calls via a fresh ipcMain
  // handler dedicated to draining the spy.
  const wrapOk = await app.evaluate(({ ipcMain }) => {
    if (globalThis.__probeWrapInstalled) return true;
    globalThis.__probeCalls = { send: [], resolvePerm: [] };
    // Re-register the two channels we care about. Must remove existing
    // handler first because ipcMain.handle throws on duplicate registration.
    ipcMain.removeHandler('agent:send');
    ipcMain.handle('agent:send', async (_e, sessionId, text) => {
      globalThis.__probeCalls.send.push([sessionId, text]);
      // Don't actually spawn an agent — return the same shape as the real
      // handler (boolean success).
      return false;
    });
    ipcMain.removeHandler('agent:resolvePermission');
    ipcMain.handle('agent:resolvePermission', async (_e, sessionId, requestId, decision) => {
      globalThis.__probeCalls.resolvePerm.push([sessionId, requestId, decision]);
      return false;
    });
    ipcMain.removeHandler('__probe:drain');
    ipcMain.handle('__probe:drain', () => globalThis.__probeCalls);
    globalThis.__probeWrapInstalled = true;
    return true;
  });
  if (!wrapOk) {
    await app.close();
    fail('failed to install main-side IPC spies');
  }

  // Press Enter — must transition to Submitted, must NOT throw.
  const errorsBefore = errors.length;
  await win.keyboard.press('Enter');

  const submittedLabel = win.getByRole('button', { name: /^submitted$/i }).first();
  try {
    await submittedLabel.waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    await app.close();
    fail('after Enter the block did not transition to Submitted state');
  }

  // (5) No new pageerrors / console errors from the submission path.
  const newErrors = errors.slice(errorsBefore);
  if (newErrors.length > 0) {
    console.error('--- new errors after submit ---');
    for (const e of newErrors) console.error('  ' + e);
    await app.close();
    fail(
      `${newErrors.length} error(s) raised when submitting QuestionBlock against a stale agent — onSubmit must degrade gracefully`
    );
  }

  // (6) The submit MUST have actually attempted to deliver the answer to the
  // agent. A purely cosmetic state flip would lose the user's answer.
  const calls = await app.evaluate(() => globalThis.__probeCalls ?? { send: [], resolvePerm: [] });
  const sendCall = calls.send.find((args) => args[0] === SESSION_ID && /TypeScript/i.test(String(args[1])));
  if (!sendCall) {
    console.error('--- IPC calls observed ---');
    console.error(JSON.stringify(calls, null, 2));
    await app.close();
    fail('agentSend was not invoked with the chosen answer — answer was lost on submit');
  }
  // The stale requestId path — if invoked — should also be observable. It's
  // OK if the renderer chose NOT to call resolvePermission (the right move
  // when the agent is gone), but if it DID call it we want to know.
  console.log(`  agentSend invoked with answer: ${JSON.stringify(sendCall[1]).slice(0, 80)}`);
  if (calls.resolvePerm.length > 0) {
    console.log(`  agentResolvePermission also invoked ${calls.resolvePerm.length}x with stale requestId (no-op against dead agent)`);
  }

  console.log('\n[probe-e2e-restore-journey-question] OK');
  console.log('  QuestionBlock visible after restore');
  console.log('  options operable via keyboard');
  console.log('  Submit transitioned to "Submitted" with no thrown errors');

  await app.close();
}

try {
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch {}
