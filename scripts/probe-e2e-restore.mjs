// E2E: persistence across app restart. This is the literal repro of the
// "click a previous session → see empty right pane" bug.
//
// Strategy:
//   1. Point electron at an empty, isolated user-data dir via CLI flag.
//   2. Launch #1: create a session, send a user message, then DIRECTLY seed a
//      fake assistant block + persist via db:saveMessages. We cannot rely on
//      a real agent turn because the sandbox has no API key, but the bug is
//      in the RESTORE path, not the save path — save is covered by unit
//      tests. This probe's job is to prove the reload pulls rows back out of
//      sqlite and renders them.
//   3. Close the app.
//   4. Launch #2 with the same user-data dir. Click the session. Assert the
//      assistant text we seeded appears in the DOM.
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
  console.error(`\n[probe-e2e-restore] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-restore-'));
console.log(`[probe-e2e-restore] userData = ${userDataDir}`);

const commonEnv = { ...process.env, NODE_ENV: 'development' };
const commonArgs = ['.', `--user-data-dir=${userDataDir}`];

// ---------- Launch #1: seed the db via IPC from main ----------
{
  const app = await electron.launch({ args: commonArgs, cwd: root, env: commonEnv });
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);

  const SESSION_ID = 's-probe-restore-1';
  const sampleBlocks = [
    { kind: 'user', id: 'u-1', text: 'hello from probe' },
    { kind: 'assistant', id: 'a-1', text: 'RESTORED ASSISTANT MARKER' }
  ];

  // Write sessions list into app_state and messages table via real IPC, so
  // the second launch hydrates the store as if this was a prior real session.
  const seeded = await win.evaluate(
    async ({ sid, blocks }) => {
      const api = window.agentory;
      if (!api) return { ok: false, err: 'no window.agentory' };
      const state = {
        version: 1,
        sessions: [
          {
            id: sid,
            name: 'Probe session',
            state: 'idle',
            cwd: '~',
            model: 'claude-opus-4',
            groupId: 'g-default',
            agentType: 'claude-code'
          }
        ],
        groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
        activeId: '',
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
      const roundtrip = await api.loadMessages(sid);
      return { ok: true, roundtripLen: roundtrip.length };
    },
    { sid: SESSION_ID, blocks: sampleBlocks }
  );

  if (!seeded.ok) {
    await app.close();
    fail(`seed failed: ${seeded.err}`);
  }
  if (seeded.roundtripLen !== 2) {
    await app.close();
    fail(`expected 2 roundtripped blocks, got ${seeded.roundtripLen}`);
  }

  console.log('[probe-e2e-restore] launch #1: db seeded with 2 blocks');
  await app.close();
}

// ---------- Launch #2: click the session, assert history renders ----------
{
  const app = await electron.launch({ args: commonArgs, cwd: root, env: commonEnv });
  const win = await appWindow(app);
  const errors = [];
  win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
  });

  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);

  // The session should appear in the sidebar — it was persisted. Click it.
  const sidebarItem = win.getByText('Probe session').first();
  await sidebarItem.waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
    const body = await win.evaluate(() => document.body.innerText.slice(0, 800));
    console.error('--- body text ---\n' + body);
    console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
    await app.close();
    fail('sidebar session "Probe session" not visible after restart');
  });
  await sidebarItem.click();

  // Give selectSession's auto-load a moment to fetch + render.
  const marker = win.getByText('RESTORED ASSISTANT MARKER').first();
  try {
    await marker.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    const dump = await win.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.innerText.slice(0, 1500) : '<no <main>>';
    });
    console.error('--- main innerText ---\n' + dump);
    console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
    await app.close();
    fail('restored assistant marker did not render — session history is still empty');
  }

  // Also verify user echo is present.
  const userEcho = win.getByText('hello from probe').first();
  const userVisible = await userEcho.isVisible().catch(() => false);
  if (!userVisible) {
    await app.close();
    fail('user message from previous session not rendered on restore');
  }

  console.log('\n[probe-e2e-restore] OK');
  console.log('  session appeared in sidebar after restart');
  console.log('  assistant history rendered: "RESTORED ASSISTANT MARKER"');
  console.log('  user echo rendered:         "hello from probe"');

  await app.close();
}

// Clean up tmp dir.
try {
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch {}
