// E2E: a session whose JSONL transcript contains an `AskUserQuestion`
// interaction reopens after app restart with the surrounding user/assistant
// turns rendered and NO duplicate question card on screen.
//
// Why this matters: AskUserQuestion is the live "card with options" widget
// powered by a permission-prompt round-trip. PR comment in
// `src/agent/stream-to-blocks.ts` documents the contract: when
// framesToBlocks projects a JSONL-persisted assistant tool_use named
// `AskUserQuestion`, it MUST NOT emit a runtime question block (those are
// keyed by a live `requestId` that no longer exists on restart — submitting
// the dead card would route through `agentSend` and hang claude.exe). The
// answered question/answer pair lives in the JSONL as a tool_use +
// tool_result that the projection silently drops; only the user prompt
// before and the assistant follow-up after carry over to the restored chat.
//
// Strategy: plant a JSONL with the full {prompt → AskUserQuestion → answer
// tool_result → assistant follow-up} shape, restart, assert (a) the
// assistant follow-up text is visible (chat is not blank), (b) no question
// card / option button leaked from the JSONL, (c) the in-memory store has
// no `kind:'question'` and no `kind:'waiting'` block for this session.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { appWindow } from './probe-utils.mjs';

const PROBE = 'probe-e2e-restore-journey-question';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[${PROBE}] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-restore-q-'));
const commonEnv = { ...process.env, CCSM_PROD_BUNDLE: '1' };
const commonArgs = ['.', `--user-data-dir=${userDataDir}`];

const SESSION_ID = 'a1b1c1d1-0000-4000-8000-00000000ques1';
const GROUP_ID = 'g-q-restore';
const GROUP_NAME = 'Probe Question Group';
const SESSION_NAME = 'Probe question session';
const TOOL_USE_ID = 'toolu_aq_restore_1';
const QUESTION_OPTION_LABEL = 'OPTION-LABEL-FROM-DEAD-CARD';
const FOLLOWUP_MARKER = 'FOLLOWUP-MARKER-AFTER-AQ';
const USER_PROMPT_MARKER = 'before-asking-the-question';

const FIXTURE_CWD_PARENT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-probe-restore-q-cwd-'));
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
    uuid: 'u-q-1',
    cwd: FIXTURE_CWD,
    sessionId: SESSION_ID,
    timestamp: TS,
    message: { role: 'user', content: [{ type: 'text', text: USER_PROMPT_MARKER }] }
  },
  {
    type: 'assistant',
    session_id: SESSION_ID,
    parentUuid: 'u-q-1',
    isSidechain: false,
    uuid: 'a-q-1',
    cwd: FIXTURE_CWD,
    timestamp: TS,
    message: {
      id: 'msg-q-1',
      role: 'assistant',
      model: 'claude-opus-4',
      content: [
        {
          type: 'tool_use',
          id: TOOL_USE_ID,
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Pick one',
                header: 'Pick',
                multiSelect: false,
                options: [
                  { label: QUESTION_OPTION_LABEL, description: 'choice A' },
                  { label: 'Option B', description: 'choice B' }
                ]
              }
            ]
          }
        }
      ]
    }
  },
  {
    type: 'user',
    parentUuid: 'a-q-1',
    isSidechain: false,
    uuid: 'u-q-2',
    cwd: FIXTURE_CWD,
    sessionId: SESSION_ID,
    timestamp: TS,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: TOOL_USE_ID,
          content: `Pick: ${QUESTION_OPTION_LABEL}`
        }
      ]
    }
  },
  {
    type: 'assistant',
    session_id: SESSION_ID,
    parentUuid: 'u-q-2',
    isSidechain: false,
    uuid: 'a-q-2',
    cwd: FIXTURE_CWD,
    timestamp: TS,
    message: {
      id: 'msg-q-2',
      role: 'assistant',
      model: 'claude-opus-4',
      content: [{ type: 'text', text: FOLLOWUP_MARKER }]
    }
  }
];
const JSONL_PATH = path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`);
fs.writeFileSync(JSONL_PATH, FRAMES.map((f) => JSON.stringify(f)).join('\n') + '\n');
console.log(`[${PROBE}] planted fixture jsonl = ${JSONL_PATH}`);

let __ccsmCurrentApp = null;
try {

// Launch #1: seed sidebar.
{
  const app = await electron.launch({ args: commonArgs, cwd: root, env: commonEnv });
  __ccsmCurrentApp = app;
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);
  const seeded = await win.evaluate(
    async ({ sid, gid, gname, sname, cwd }) => {
      const api = window.ccsm;
      if (!api) return { ok: false };
      const state = {
        version: 1,
        sessions: [
          { id: sid, name: sname, state: 'idle', cwd, model: 'claude-opus-4', groupId: gid, agentType: 'claude-code' }
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
      const hist = await api.loadHistory(cwd, sid);
      return { ok: true, frames: hist?.ok ? hist.frames.length : 0 };
    },
    { sid: SESSION_ID, gid: GROUP_ID, gname: GROUP_NAME, sname: SESSION_NAME, cwd: FIXTURE_CWD }
  );
  if (!seeded.ok || seeded.frames !== 4) {
    await app.close();
    fail(`seed/loadHistory roundtrip failed: ${JSON.stringify(seeded)}`);
  }
  await app.close();
}

// Launch #2: assert.
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

  // The trailing assistant text must render — that's how the user knows
  // their conversation came back, the AskUserQuestion just being a hidden
  // step in the middle.
  const followup = win.getByText(FOLLOWUP_MARKER).first();
  await followup.waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
    const dump = await win.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.innerText.slice(0, 1500) : '<no <main>>';
    });
    console.error('--- main innerText ---\n' + dump);
    console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
    await app.close();
    fail('assistant follow-up after AskUserQuestion did not hydrate on restart');
  });

  // The opening user message must also render.
  const userPrompt = win.getByText(USER_PROMPT_MARKER).first();
  if (!(await userPrompt.isVisible().catch(() => false))) {
    await app.close();
    fail('opening user message did not render on restart');
  }

  // No live AskUserQuestion card: option buttons / question block selectors
  // must be absent. The dead card would carry the option label as button
  // text — assert that the label is NOT visible as an interactive option.
  const liveOption = win.locator('[data-question-option]').first();
  if (await liveOption.isVisible().catch(() => false)) {
    await app.close();
    fail('a live question card leaked from JSONL — AskUserQuestion suppression contract broken');
  }

  // In-memory check: no `kind:'question'` / `kind:'waiting'` block for
  // this session. Tool-block fallback for malformed AskUserQuestion is
  // acceptable but should not happen here (input has parseable questions).
  const projection = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore?.getState?.()?.messagesBySession?.[sid] ?? [];
    return {
      kinds: blocks.map((b) => b.kind),
      hasQuestion: blocks.some((b) => b.kind === 'question'),
      hasWaiting: blocks.some((b) => b.kind === 'waiting'),
      // The suppressed tool_use should not appear as a tool block either,
      // since `parseQuestions` did parse the input fine.
      hasAQTool: blocks.some((b) => b.kind === 'tool' && b.name === 'AskUserQuestion')
    };
  }, SESSION_ID);
  if (projection.hasQuestion) {
    await app.close();
    fail(`question block leaked into restored projection: ${JSON.stringify(projection)}`);
  }
  if (projection.hasWaiting) {
    await app.close();
    fail(`waiting block leaked into restored projection: ${JSON.stringify(projection)}`);
  }
  if (projection.hasAQTool) {
    await app.close();
    fail(`AskUserQuestion fell through to a tool block — should be fully suppressed when parseable: ${JSON.stringify(projection)}`);
  }

  console.log(`\n[${PROBE}] OK`);
  console.log('  user prompt + assistant follow-up rendered around suppressed AskUserQuestion');
  console.log('  no live question card / waiting block / fallback tool block leaked');
  console.log(`  projected kinds: ${JSON.stringify(projection.kinds)}`);
  await app.close();
}

try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
try { fs.rmSync(FIXTURE_CWD_PARENT, { recursive: true, force: true }); } catch {}
try { fs.rmSync(PROJECT_DIR, { recursive: true, force: true }); } catch {}
} finally { try { await __ccsmCurrentApp?.close(); } catch {} }
