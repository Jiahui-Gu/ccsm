// User journey: a session was streaming an assistant reply when the app was
// killed mid-stream (e.g. crash, force-quit, OS reboot). On next launch the
// app must NOT render a permanently-spinning streaming caret on a block that
// will never be appended to again — the agent process is gone, the stream
// will never resume.
//
// Strategy:
//   #1: seed an `assistant` block with `streaming: true` + partial text.
//   #2: relaunch. Assertions:
//       a. Partial text is visible (we do NOT discard the user's content).
//       b. The streaming caret element (matched via its dedicated style:
//          inline-block w-[7px] h-[14px] animate-pulse) is NOT present.
//
// The minimal fix sanitizes the persisted streaming flag on load so the
// caret cannot pulse forever on a stream that will never resume.
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
  console.error(`\n[probe-e2e-restore-journey-streaming] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-restore-stream-'));
console.log(`[probe-e2e-restore-journey-streaming] userData = ${userDataDir}`);

const commonEnv = { ...process.env, CCSM_PROD_BUNDLE: '1' };
const commonArgs = ['.', `--user-data-dir=${userDataDir}`];

const SESSION_ID = 's-restore-stream-1';
const GROUP_ID = 'g-default';
const PARTIAL_MARKER = 'PROBE-PARTIAL-MID-STREAM-Q4Z';

const STREAMING_BLOCK = {
  kind: 'assistant',
  id: 'a-streaming-1',
  text: `Working on it… ${PARTIAL_MARKER} and then I'll`, // intentionally truncated
  streaming: true
};

const PRELUDE = [
  { kind: 'user', id: 'u-1', text: 'tell me a long story' },
  STREAMING_BLOCK
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
            name: 'Restore stream probe',
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
      const last = rt[rt.length - 1];
      return { ok: true, n: rt.length, lastKind: last?.kind, lastStreaming: last?.streaming };
    },
    { sid: SESSION_ID, gid: GROUP_ID, blocks: PRELUDE }
  );
  if (!seeded.ok) {
    await app.close();
    fail(`seed failed: ${seeded.err}`);
  }
  if (seeded.lastKind !== 'assistant' || seeded.lastStreaming !== true) {
    await app.close();
    fail(`bad seed roundtrip: ${JSON.stringify(seeded)}`);
  }
  console.log('[probe-e2e-restore-journey-streaming] launch #1: seeded streaming=true block');
  await app.close();
}

// ---------- Launch #2: assert no permanent spinning caret ----------
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

  // (1) Partial text must be visible — we are NOT asking the app to throw
  // away the user's content.
  const partial = win.locator(`text=${PARTIAL_MARKER}`).first();
  try {
    await partial.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    await app.close();
    fail(`partial assistant text not rendered after restore (marker="${PARTIAL_MARKER}")`);
  }

  // Give the app a beat to apply any sanitization on hydrate.
  await win.waitForTimeout(800);

  // (2) The streaming caret <span aria-hidden> with `animate-pulse` and the
  // 7x14 inline rectangle MUST not exist. The CSS class signature is brittle
  // but the only stream caret in the bundle is in AssistantBlock.
  const caretInfo = await win.evaluate(() => {
    // Match exactly the AssistantBlock streaming caret signature.
    const candidates = Array.from(
      document.querySelectorAll('span.animate-pulse[aria-hidden]')
    );
    return {
      count: candidates.length,
      classes: candidates.map((c) => c.className).slice(0, 5)
    };
  });

  // (3) Look for an interrupted-by-restart indicator (informational only).
  const interruptedSeen = await win.evaluate(() => {
    const t = document.body.innerText.toLowerCase();
    return /interrupt|restart|resumed|stopped/.test(t);
  });

  if (caretInfo.count > 0) {
    const dump = await win.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.innerText.slice(0, 1500) : '<no main>';
    });
    console.error('--- main innerText ---\n' + dump);
    console.error('--- caret matches ---\n' + JSON.stringify(caretInfo, null, 2));
    await app.close();
    fail(
      `streaming caret is still pulsing after restart on a stream that will never resume. ` +
        `The persisted streaming flag must be cleared on load (loadMessages sanitization). ` +
        `Found ${caretInfo.count} streaming-caret span(s).`
    );
  }

  console.log('\n[probe-e2e-restore-journey-streaming] OK');
  console.log(`  partial text visible (marker found)`);
  console.log(
    `  streaming caret cleanup: caretCount=${caretInfo.count}, interruptedIndicator=${interruptedSeen}`
  );

  await app.close();
}

try {
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch {}
