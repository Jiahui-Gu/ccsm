// E2E: persistence across app restart. This is the literal repro of the
// "click a previous session → see empty right pane" bug, post-PR-H.
//
// PR-H removed the SQLite `messages` table and the `saveMessages` /
// `loadMessages` IPC. History is now sourced from the CLI's on-disk
// JSONL transcript at `~/.claude/projects/<slug(cwd)>/<sid>.jsonl`,
// loaded via `agent:load-history` (renderer: `window.ccsm.loadHistory`).
//
// Strategy:
//   1. Point electron at an empty, isolated user-data dir via CLI flag.
//   2. PLANT a JSONL fixture under a unique tmp cwd so `loadHistory(cwd, sid)`
//      can find a real transcript (jsonl-loader.ts uses `os.homedir()`
//      directly — HOME env override does NOT redirect it, so we plant under
//      the user's real `~/.claude/projects/`. The cwd is `mkdtemp`'d so
//      its slug is unique to this probe run; the fixture project dir is
//      removed in the cleanup block).
//   3. Launch #1: seed app_state with a non-trivial sidebar tree (custom
//      group, a session inside it pointing at our fixture cwd, an unread
//      draft on that session, an `activeId` pointing at it). The active
//      session's history loads from the planted JSONL on next boot.
//   4. Close the app.
//   5. Launch #2 with the same user-data dir. Without clicking anything,
//      assert:
//        a. the custom group + its session render in the sidebar tree
//        b. the session is the active selection (chat history visible —
//           hydrated from the JSONL on boot via loadHistory IPC)
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

// UUID-shaped sid so the renderer's session-id gate accepts it (PR-D
// invariant: ccsm-spawned sessions use UUID-shaped ids that map to their
// JSONL filename). Not strictly required for hydration-only testing, but
// matches what real users will have on disk.
const SESSION_ID = 'a1b1c1d1-0000-4000-8000-000000000001';
const CUSTOM_GROUP_ID = 'g-custom-restore';
const CUSTOM_GROUP_NAME = 'Probe Custom Group';
const SESSION_NAME = 'Probe session';
const DRAFT_TEXT = 'half-typed across restart — keep me alive';
const ASSISTANT_MARKER = 'RESTORED ASSISTANT MARKER';
const USER_MARKER = 'hello from probe';

// ── Plant a JSONL fixture at the path the renderer's `loadHistory(cwd,sid)`
// will look up. jsonl-loader.ts: `~/.claude/projects/<slug(cwd)>/<sid>.jsonl`
// where the slug rule replaces `/`, `\`, and `:` with `-`. We use a fresh
// mkdtemp cwd so our slug is unique to this probe run and won't collide
// with anything else in the user's `~/.claude/projects/`. The project dir
// we create is removed in the final cleanup block.
const FIXTURE_CWD_PARENT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-probe-restore-cwd-'));
const FIXTURE_CWD = path.join(FIXTURE_CWD_PARENT, 'project');
fs.mkdirSync(FIXTURE_CWD, { recursive: true });

function projectKeyFromCwd(cwd) {
  return cwd.replace(/[\\/:]/g, '-');
}

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const PROJECT_KEY = projectKeyFromCwd(FIXTURE_CWD);
const PROJECT_DIR = path.join(PROJECTS_ROOT, PROJECT_KEY);
fs.mkdirSync(PROJECT_DIR, { recursive: true });

const TS = new Date().toISOString();
const FRAMES = [
  {
    type: 'user',
    parentUuid: null,
    isSidechain: false,
    uuid: 'u-restore-1',
    cwd: FIXTURE_CWD,
    sessionId: SESSION_ID,
    timestamp: TS,
    message: { role: 'user', content: [{ type: 'text', text: USER_MARKER }] }
  },
  {
    type: 'assistant',
    session_id: SESSION_ID,
    parentUuid: 'u-restore-1',
    isSidechain: false,
    uuid: 'a-restore-1',
    cwd: FIXTURE_CWD,
    timestamp: TS,
    message: {
      id: 'msg-restore-1',
      role: 'assistant',
      model: 'claude-opus-4',
      content: [{ type: 'text', text: ASSISTANT_MARKER }]
    }
  }
];
const JSONL_PATH = path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`);
fs.writeFileSync(JSONL_PATH, FRAMES.map((f) => JSON.stringify(f)).join('\n') + '\n');
console.log(`[probe-e2e-restore] planted fixture jsonl = ${JSONL_PATH}`);

// Top-level tracker so the outer try/finally can close whichever scoped app
// happens to be live if the body throws. ccsm-probe-cleanup-wrap.
let __ccsmCurrentApp = null;
try { // ccsm-probe-cleanup-wrap

// ---------- Launch #1: seed app_state via IPC ----------
{
  const app = await electron.launch({ args: commonArgs, cwd: root, env: commonEnv });
  __ccsmCurrentApp = app;
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);

  // Seed sidebar tree (custom group + default group + a session in the
  // custom group with cwd pointing at our JSONL fixture), persist activeId
  // pointing at it, and write a draft to the parallel `drafts` blob so the
  // InputBar picks it up on next boot. NO message-table writes — history
  // sources from the JSONL on boot via `loadHistory`.
  const seeded = await win.evaluate(
    async ({ sid, gid, gname, sname, draft, cwd }) => {
      const api = window.ccsm;
      if (!api) return { ok: false, err: 'no window.ccsm' };
      const state = {
        version: 1,
        sessions: [
          {
            id: sid,
            name: sname,
            state: 'idle',
            cwd,
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
      // Sanity: confirm the loadHistory IPC sees our planted JSONL.
      const hist = await api.loadHistory(cwd, sid);
      return {
        ok: true,
        histOk: !!hist?.ok,
        frames: hist?.ok ? hist.frames.length : 0,
        err: hist?.ok ? null : hist?.error
      };
    },
    {
      sid: SESSION_ID,
      gid: CUSTOM_GROUP_ID,
      gname: CUSTOM_GROUP_NAME,
      sname: SESSION_NAME,
      draft: DRAFT_TEXT,
      cwd: FIXTURE_CWD
    }
  );

  if (!seeded.ok) {
    await app.close();
    fail(`seed failed: ${seeded.err}`);
  }
  if (!seeded.histOk || seeded.frames !== 2) {
    await app.close();
    fail(
      `loadHistory roundtrip wrong: ok=${seeded.histOk} frames=${seeded.frames} err=${seeded.err}. ` +
        `Planted JSONL at ${JSONL_PATH}; renderer's loadHistory(cwd,sid) did not return both fixture frames.`
    );
  }

  console.log('[probe-e2e-restore] launch #1: seeded sidebar tree + draft; verified JSONL roundtrip via loadHistory');
  await app.close();
}

// ---------- Launch #2: assert restoration ----------
{
  const app = await electron.launch({ args: commonArgs, cwd: root, env: commonEnv });
  __ccsmCurrentApp = app;
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
  //         (hydrateStore → loadMessages(active) → loadHistory(cwd, sid) on boot).
  const marker = win.getByText(ASSISTANT_MARKER).first();
  await marker.waitFor({ state: 'visible', timeout: 8_000 }).catch(async () => {
    const dump = await win.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.innerText.slice(0, 1500) : '<no <main>>';
    });
    console.error('--- main innerText ---\n' + dump);
    console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
    await app.close();
    fail('active session history did not auto-render from JSONL — activeId restoration or loadHistory hydration regressed');
  });

  const userEcho = win.getByText(USER_MARKER).first();
  if (!(await userEcho.isVisible().catch(() => false))) {
    await app.close();
    fail('user message from previous session not rendered on restore (framesToBlocks projection regressed)');
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
  console.log('  active session auto-loaded its history from JSONL via loadHistory IPC');
  console.log(`  composer draft restored: ${JSON.stringify(DRAFT_TEXT.slice(0, 40))}`);
  console.log(`  assistant history rendered: "${ASSISTANT_MARKER}"`);
  console.log(`  user echo rendered:         "${USER_MARKER}"`);

  await app.close();
}

// Clean up tmp dirs + fixture JSONL.
try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
try { fs.rmSync(FIXTURE_CWD_PARENT, { recursive: true, force: true }); } catch {}
try { fs.rmSync(PROJECT_DIR, { recursive: true, force: true }); } catch {}
} finally { try { await __ccsmCurrentApp?.close(); } catch {} } // ccsm-probe-cleanup-wrap
