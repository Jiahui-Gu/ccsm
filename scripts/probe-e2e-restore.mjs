// E2E: persistence across app restart. This is the literal repro of the
// "click a previous session → see empty right pane" bug.
//
// Strategy:
//   1. Point electron at an empty, isolated user-data dir via CLI flag.
//   2. Launch #1: seed app_state with a non-trivial sidebar tree (custom
//      group, a session inside it, an unread draft on that session, an
//      `activeId` pointing at it) and the matching message rows.
//   3. Close the app.
//   4. Launch #2 with the same user-data dir. Without clicking anything,
//      assert:
//        a. the custom group + its session render in the sidebar tree
//        b. the session is the active selection (chat history visible)
//        c. the previously-typed draft is back in the composer
//      Then click the session and assert the seeded assistant marker
//      reappears (the original bug).
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

const commonEnv = { ...process.env, CCSM_PROD_BUNDLE: '1' };
const commonArgs = ['.', `--user-data-dir=${userDataDir}`];

const SESSION_ID = 's-probe-restore-1';
const CUSTOM_GROUP_ID = 'g-custom-restore';
const CUSTOM_GROUP_NAME = 'Probe Custom Group';
const SESSION_NAME = 'Probe session';
const DRAFT_TEXT = 'half-typed across restart — keep me alive';
const ASSISTANT_MARKER = 'RESTORED ASSISTANT MARKER';
const USER_MARKER = 'hello from probe';

// ---------- Launch #1: seed the db via IPC from main ----------
{
  const app = await electron.launch({ args: commonArgs, cwd: root, env: commonEnv });
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);

  const sampleBlocks = [
    { kind: 'user', id: 'u-1', text: USER_MARKER },
    { kind: 'assistant', id: 'a-1', text: ASSISTANT_MARKER }
  ];

  // Seed sidebar tree (custom group + default group + a session in the
  // custom group), persist activeId pointing at it, and write a draft to
  // the parallel `drafts` blob so the InputBar picks it up on next boot.
  const seeded = await win.evaluate(
    async ({ sid, gid, gname, sname, draft, blocks }) => {
      const api = window.ccsm;
      if (!api) return { ok: false, err: 'no window.ccsm' };
      const state = {
        version: 1,
        sessions: [
          {
            id: sid,
            name: sname,
            state: 'idle',
            cwd: '~',
            model: 'claude-opus-4',
            groupId: gid,
            agentType: 'claude-code'
          }
        ],
        groups: [
          { id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' },
          { id: gid, name: gname, collapsed: false, kind: 'normal' }
        ],
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
      await api.saveState(
        'drafts',
        JSON.stringify({ version: 1, drafts: { [sid]: draft } })
      );
      await api.saveMessages(sid, blocks);
      const roundtrip = await api.loadMessages(sid);
      return { ok: true, roundtripLen: roundtrip.length };
    },
    {
      sid: SESSION_ID,
      gid: CUSTOM_GROUP_ID,
      gname: CUSTOM_GROUP_NAME,
      sname: SESSION_NAME,
      draft: DRAFT_TEXT,
      blocks: sampleBlocks
    }
  );

  if (!seeded.ok) {
    await app.close();
    fail(`seed failed: ${seeded.err}`);
  }
  if (seeded.roundtripLen !== 2) {
    await app.close();
    fail(`expected 2 roundtripped blocks, got ${seeded.roundtripLen}`);
  }

  console.log('[probe-e2e-restore] launch #1: seeded sidebar tree, draft, and 2 message blocks');
  await app.close();
}

// ---------- Launch #2: assert restoration ----------
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

  // === a) sidebar tree: custom group label visible ========================
  const customGroupLabel = win.getByText(CUSTOM_GROUP_NAME).first();
  await customGroupLabel.waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
    const body = await win.evaluate(() => document.body.innerText.slice(0, 1500));
    console.error('--- body text ---\n' + body);
    console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
    await app.close();
    fail(`custom group "${CUSTOM_GROUP_NAME}" not rendered in sidebar after restart`);
  });

  // The session should appear in the sidebar — it was persisted under that
  // custom group.
  const sidebarItem = win.getByText(SESSION_NAME).first();
  await sidebarItem.waitFor({ state: 'visible', timeout: 5_000 }).catch(async () => {
    await app.close();
    fail(`sidebar session "${SESSION_NAME}" not visible after restart`);
  });

  // === b) active session: history must already be on screen WITHOUT a click
  //         (hydrateStore eagerly loadMessages(active) on boot).
  const marker = win.getByText(ASSISTANT_MARKER).first();
  await marker.waitFor({ state: 'visible', timeout: 5_000 }).catch(async () => {
    const dump = await win.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.innerText.slice(0, 1500) : '<no <main>>';
    });
    console.error('--- main innerText ---\n' + dump);
    console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
    await app.close();
    fail('active session history did not auto-render — activeId restoration regressed');
  });

  const userEcho = win.getByText(USER_MARKER).first();
  if (!(await userEcho.isVisible().catch(() => false))) {
    await app.close();
    fail('user message from previous session not rendered on restore');
  }

  // === c) draft: the half-typed text is back in the composer ==============
  const textarea = win.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });
  const draftAfterRestart = await textarea.inputValue();
  if (draftAfterRestart !== DRAFT_TEXT) {
    await app.close();
    fail(
      `draft did not survive app restart. ` +
        `expected=${JSON.stringify(DRAFT_TEXT)} got=${JSON.stringify(draftAfterRestart)}`
    );
  }

  // === Bonus: clicking the session is still safe (re-asserts marker) ======
  await sidebarItem.click();
  // Marker should still be on screen (we're just confirming the click path
  // does not erase what hydrate already loaded — guards against future
  // regressions where selectSession clears messagesBySession).
  if (!(await marker.isVisible().catch(() => false))) {
    await app.close();
    fail('clicking the active session erased its rendered history');
  }

  console.log('\n[probe-e2e-restore] OK');
  console.log(`  sidebar tree restored: custom group "${CUSTOM_GROUP_NAME}" + session "${SESSION_NAME}"`);
  console.log('  active session auto-loaded its history without a click');
  console.log(`  composer draft restored: ${JSON.stringify(DRAFT_TEXT.slice(0, 40))}`);
  console.log(`  assistant history rendered: "${ASSISTANT_MARKER}"`);
  console.log(`  user echo rendered:         "${USER_MARKER}"`);

  await app.close();
}

// Clean up tmp dir.
try {
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch {}
