// E2E: a session whose JSONL transcript contains an `ExitPlanMode` tool_use
// reopens after app restart with the plan tool block rendered and the plan
// markdown content reachable in the DOM.
//
// Why this matters: ExitPlanMode is the live "approve this plan" interaction
// (lifecycle.ts surfaces it as a `kind: 'waiting'` block with `intent: 'plan'`
// so the user can Approve/Reject). After the turn finishes, the assistant's
// tool_use frame is what the CLI persists to disk. On restart, the renderer
// has only the JSONL — no live request — so the projection MUST land as a
// regular tool block carrying the plan text, otherwise restored sessions
// drop a chunk of the conversation that the user actually saw.
//
// Strategy follows probe-e2e-restore.mjs:
//   1. Plant a JSONL fixture under a unique tmp cwd whose slug under
//      `~/.claude/projects/` is unique to this run.
//   2. Launch #1 (isolated userData), seed sidebar tree + activeId pointing
//      at the planted session, close.
//   3. Launch #2, assert: tool block with `data-tool-name="ExitPlanMode"`
//      visible, plan marker text reachable in DOM, no waiting/plan card
//      (live-only block kind, never re-emitted from JSONL).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { appWindow } from './probe-utils.mjs';

const PROBE = 'probe-e2e-restore-journey-plan';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[${PROBE}] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-restore-plan-'));
const commonEnv = { ...process.env, CCSM_PROD_BUNDLE: '1' };
const commonArgs = ['.', `--user-data-dir=${userDataDir}`];

// UUID-shaped sid (PR #302 invariant).
const SESSION_ID = 'a1b1c1d1-0000-4000-8000-0000000plan1';
const GROUP_ID = 'g-plan-restore';
const GROUP_NAME = 'Probe Plan Group';
const SESSION_NAME = 'Probe plan session';
const TOOL_USE_ID = 'toolu_plan_restore_1';
const PLAN_MARKER = 'PLAN-MARKER-RESTORE-XYZ';
const PLAN_TEXT = `## Restore-plan probe\n\n1. Verify plan persistence\n2. ${PLAN_MARKER}\n3. Done`;

// Plant the JSONL the renderer's `loadHistory(cwd, sid)` will resolve.
const FIXTURE_CWD_PARENT = fs.mkdtempSync(
  path.join(os.tmpdir(), 'ccsm-probe-restore-plan-cwd-')
);
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
    uuid: 'u-plan-1',
    cwd: FIXTURE_CWD,
    sessionId: SESSION_ID,
    timestamp: TS,
    message: { role: 'user', content: [{ type: 'text', text: 'plan a refactor' }] }
  },
  {
    type: 'assistant',
    session_id: SESSION_ID,
    parentUuid: 'u-plan-1',
    isSidechain: false,
    uuid: 'a-plan-1',
    cwd: FIXTURE_CWD,
    timestamp: TS,
    message: {
      id: 'msg-plan-1',
      role: 'assistant',
      model: 'claude-opus-4',
      content: [
        {
          type: 'tool_use',
          id: TOOL_USE_ID,
          name: 'ExitPlanMode',
          input: { plan: PLAN_TEXT }
        }
      ]
    }
  }
];
const JSONL_PATH = path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`);
fs.writeFileSync(JSONL_PATH, FRAMES.map((f) => JSON.stringify(f)).join('\n') + '\n');
console.log(`[${PROBE}] planted fixture jsonl = ${JSONL_PATH}`);

let __ccsmCurrentApp = null;
try {

// Launch #1: seed sidebar + activeId.
{
  const app = await electron.launch({ args: commonArgs, cwd: root, env: commonEnv });
  __ccsmCurrentApp = app;
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);

  const seeded = await win.evaluate(
    async ({ sid, gid, gname, sname, cwd }) => {
      const api = window.ccsm;
      if (!api) return { ok: false, err: 'no window.ccsm' };
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
      return { ok: true, histOk: !!hist?.ok, frames: hist?.ok ? hist.frames.length : 0 };
    },
    { sid: SESSION_ID, gid: GROUP_ID, gname: GROUP_NAME, sname: SESSION_NAME, cwd: FIXTURE_CWD }
  );
  if (!seeded.ok || !seeded.histOk || seeded.frames !== 2) {
    await app.close();
    fail(`seed/loadHistory roundtrip failed: ${JSON.stringify(seeded)}`);
  }
  await app.close();
}

// Launch #2: assert plan tool block hydrated from JSONL.
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

  // Tool block root with the ExitPlanMode tool name in its header label.
  const toolName = win.locator('[data-type-scale-role="tool-name"]', { hasText: 'ExitPlanMode' }).first();
  await toolName.waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
    const dump = await win.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.innerText.slice(0, 1500) : '<no <main>>';
    });
    console.error('--- main innerText ---\n' + dump);
    console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
    await app.close();
    fail('ExitPlanMode tool block did not hydrate from JSONL on restart');
  });

  // Verify the plan content reached the projected block by reading the
  // store directly — the input text is what the renderer needs to draw the
  // plan, and reading from the store avoids depending on whether the user
  // expanded the tool block (collapsed by default).
  const planInStore = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore?.getState?.()?.messagesBySession?.[sid] ?? [];
    const tool = blocks.find((b) => b.kind === 'tool' && b.name === 'ExitPlanMode');
    return tool ? tool.input?.plan ?? null : null;
  }, SESSION_ID);
  if (typeof planInStore !== 'string' || !planInStore.includes(PLAN_MARKER)) {
    await app.close();
    fail(`plan input did not survive JSONL roundtrip: got ${JSON.stringify(planInStore?.slice?.(0, 80))}`);
  }

  // Bonus: no `kind:'waiting'` (live-only) block sneaks in from the JSONL.
  const noWaiting = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore?.getState?.()?.messagesBySession?.[sid] ?? [];
    return !blocks.some((b) => b.kind === 'waiting');
  }, SESSION_ID);
  if (!noWaiting) {
    await app.close();
    fail('a waiting/plan block leaked into restored session — should be tool block only');
  }

  console.log(`\n[${PROBE}] OK`);
  console.log('  ExitPlanMode tool block rendered after restart');
  console.log('  plan input preserved through JSONL → framesToBlocks projection');
  console.log('  no live-only waiting block leaked into restored history');
  await app.close();
}

try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
try { fs.rmSync(FIXTURE_CWD_PARENT, { recursive: true, force: true }); } catch {}
try { fs.rmSync(PROJECT_DIR, { recursive: true, force: true }); } catch {}
} finally { try { await __ccsmCurrentApp?.close(); } catch {} }
