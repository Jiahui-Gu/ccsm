// E2E: a session whose JSONL transcript represents a streamed assistant
// reply (multiple text content blocks coalesced into the final message)
// reopens after app restart with the full text rendered and NO streaming
// caret pulsing on the restored assistant block.
//
// Why this matters: live-streaming sets `streaming: true` on the in-flight
// assistant block to drive the caret animation. The store layer documents a
// sanitize step for this on JSONL load (`store.ts` ~line 1948): if a
// `streaming=true` flag survives the framesToBlocks projection it is forced
// to false on hydration, because nothing is actually streaming after a
// restart — leaving it true would pulse forever (regression #143 in the
// release notes). This probe is the on-disk version of that contract:
//   - the chat shows what the user actually saw (not blank, not partial)
//   - no perpetual pulse pseudo-element is in the DOM for the restored
//     assistant block
//   - text from BOTH content[] entries lands (multi-text-block coalescing
//     case — claude.exe persists multi-paragraph replies as a single
//     assistant frame whose `content` array has multiple {type:'text'} entries)
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { appWindow } from './probe-utils.mjs';

const PROBE = 'probe-e2e-restore-journey-streaming';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[${PROBE}] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-restore-stream-'));
const commonEnv = { ...process.env, CCSM_PROD_BUNDLE: '1' };
const commonArgs = ['.', `--user-data-dir=${userDataDir}`];

const SESSION_ID = 'a1b1c1d1-0000-4000-8000-0000000strm1';
const GROUP_ID = 'g-stream-restore';
const GROUP_NAME = 'Probe Streaming Group';
const SESSION_NAME = 'Probe streaming session';
const USER_MARKER = 'kick off the long reply';
const PART_A = 'STREAM-PART-A-FIRST-CHUNK';
const PART_B = 'STREAM-PART-B-SECOND-CHUNK';

const FIXTURE_CWD_PARENT = fs.mkdtempSync(
  path.join(os.tmpdir(), 'ccsm-probe-restore-stream-cwd-')
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
// Single assistant frame with TWO text content blocks — this is the
// post-stream finalization shape the CLI persists. assistantBlocks projects
// them as two assistant blocks with ids `${msgId}:c0` and `${msgId}:c1`.
const FRAMES = [
  {
    type: 'user',
    parentUuid: null,
    isSidechain: false,
    uuid: 'u-strm-1',
    cwd: FIXTURE_CWD,
    sessionId: SESSION_ID,
    timestamp: TS,
    message: { role: 'user', content: [{ type: 'text', text: USER_MARKER }] }
  },
  {
    type: 'assistant',
    session_id: SESSION_ID,
    parentUuid: 'u-strm-1',
    isSidechain: false,
    uuid: 'a-strm-1',
    cwd: FIXTURE_CWD,
    timestamp: TS,
    message: {
      id: 'msg-strm-1',
      role: 'assistant',
      model: 'claude-opus-4',
      content: [
        { type: 'text', text: PART_A },
        { type: 'text', text: PART_B }
      ]
    }
  }
];
const JSONL_PATH = path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`);
fs.writeFileSync(JSONL_PATH, FRAMES.map((f) => JSON.stringify(f)).join('\n') + '\n');
console.log(`[${PROBE}] planted fixture jsonl = ${JSONL_PATH}`);

let __ccsmCurrentApp = null;
try {

// Launch #1: seed.
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
  if (!seeded.ok || seeded.frames !== 2) {
    await app.close();
    fail(`seed/loadHistory roundtrip failed: ${JSON.stringify(seeded)}`);
  }
  await app.close();
}

// Launch #2: assert no caret on restored assistant block.
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

  // Both text parts must be on screen.
  const partA = win.getByText(PART_A).first();
  const partB = win.getByText(PART_B).first();
  await partA.waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
    const dump = await win.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.innerText.slice(0, 1500) : '<no <main>>';
    });
    console.error('--- main innerText ---\n' + dump);
    console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
    await app.close();
    fail('assistant text part A did not hydrate on restart');
  });
  if (!(await partB.isVisible().catch(() => false))) {
    await app.close();
    fail('assistant text part B did not render — multi-text-block coalescing regression');
  }

  // No streaming caret. The caret is `span.animate-pulse` placed inside the
  // in-flight assistant block. After restart, NO assistant block should
  // carry one — anywhere in the chat (#143 regression guard).
  const carets = await win.locator('span.animate-pulse').count();
  if (carets > 0) {
    await app.close();
    fail(`streaming caret survived restart: ${carets} pulsing element(s) in chat`);
  }

  // In-memory belt-and-braces: no assistant block has streaming=true.
  const streamingFlag = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore?.getState?.()?.messagesBySession?.[sid] ?? [];
    return blocks.some((b) => b.kind === 'assistant' && b.streaming === true);
  }, SESSION_ID);
  if (streamingFlag) {
    await app.close();
    fail('an assistant block has streaming=true after restart — sanitize step regressed');
  }

  console.log(`\n[${PROBE}] OK`);
  console.log('  multi-text streaming reply rendered fully after restart');
  console.log('  no animate-pulse caret in restored chat');
  console.log('  no assistant block carries streaming=true');
  await app.close();
}

try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
try { fs.rmSync(FIXTURE_CWD_PARENT, { recursive: true, force: true }); } catch {}
try { fs.rmSync(PROJECT_DIR, { recursive: true, force: true }); } catch {}
} finally { try { await __ccsmCurrentApp?.close(); } catch {} }
