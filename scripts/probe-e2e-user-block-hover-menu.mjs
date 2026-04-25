// E2E: hover over a user message block → the four action buttons (Edit /
// Retry / Copy / Truncate from here) become visible; clicking Copy lands the
// message text in the clipboard; clicking Truncate truncates every block at
// or after the user message AND drops `resumeSessionId` so the next send
// respawns claude.exe. Verifies the hover-only opacity transition isn't
// broken by jsdom's lack of group-hover (which is why the unit tests assert
// only DOM presence, not visibility).
//
// HOW TO RUN
// ──────────
// MUST be invoked from the main repo checkout
// (`C:\Users\jiahuigu\ccsm-research\ccsm`), NOT from a git worktree. The
// electron native binding (`better-sqlite3.node`) is built once into the
// main checkout's `node_modules` and the worktree-relative require path
// can't find it. Running the probe from a worktree fails on app spawn
// before the renderer ever loads.
//   $ cd C:\Users\jiahuigu\ccsm-research\ccsm
//   $ node scripts/probe-e2e-user-block-hover-menu.mjs
//
// We seed the store directly via window.__ccsmStore — this is a UX probe,
// not an end-to-end agent probe. The Edit/Retry actions touch the network
// path which is already covered by the vitest suite.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-user-block-hover-menu] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', CCSM_PROD_BUNDLE: '1' }
});

try { // ccsm-probe-cleanup-wrap

const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 10000 });

// Seed: one session with a previous assistant turn, then a user block we'll
// rewind from, then a follow-up assistant turn that should disappear.
const SAMPLE = 'PROBE_USER_TEXT please implement X';
await win.evaluate((sample) => {
  window.__ccsmStore.setState({
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [
      {
        id: 's1',
        name: 's',
        state: 'idle',
        cwd: 'C:/x',
        model: 'claude-opus-4',
        groupId: 'g1',
        agentType: 'claude-code',
        resumeSessionId: 'old-uuid'
      }
    ],
    activeId: 's1',
    startedSessions: { s1: true },
    messagesBySession: {
      s1: [
        { kind: 'assistant', id: 'a0', text: 'Earlier reply.' },
        { kind: 'user', id: 'u-rewind', text: sample },
        { kind: 'assistant', id: 'a1', text: 'Followup reply that should be truncated.' }
      ]
    }
  });
}, SAMPLE);
await win.waitForTimeout(300);

// The user block is identified by data-user-block-id="u-rewind".
const userRow = win.locator('[data-user-block-id="u-rewind"]');
await userRow.waitFor({ state: 'visible', timeout: 5000 });

// Hover → action group fades in (opacity-0 → opacity-100 on group-hover).
await userRow.hover();
await win.waitForTimeout(250);

const actions = userRow.locator('[data-testid="user-block-actions"]');
const opacity = await actions.evaluate((el) => getComputedStyle(el).opacity);
if (opacity !== '1') {
  await app.close();
  fail(`expected actions opacity=1 on hover, got ${opacity}`);
}

// All four buttons present and reachable.
const labels = ['Edit and resend', 'Retry', 'Copy message', 'Truncate from here'];
for (const label of labels) {
  const btn = actions.locator(`button[aria-label="${label}"]`);
  if ((await btn.count()) !== 1) {
    await app.close();
    fail(`expected exactly 1 button with aria-label="${label}"`);
  }
}

// Copy → clipboard.
await actions.locator('button[aria-label="Copy message"]').click();
await win.waitForTimeout(200);
const clip = await win.evaluate(() =>
  navigator.clipboard.readText().catch((e) => `ERR:${e.message}`)
);
if (!clip.includes('PROBE_USER_TEXT')) {
  await app.close();
  fail(`clipboard missing user text after Copy click (clip=${JSON.stringify(clip.slice(0, 80))})`);
}

// Truncate → cut. After click: only the prior assistant block remains,
// and the session's resumeSessionId is gone.
await actions.locator('button[aria-label="Truncate from here"]').click();
await win.waitForTimeout(300);

const after = await win.evaluate(() => {
  const s = window.__ccsmStore.getState();
  const blocks = s.messagesBySession.s1 ?? [];
  const sess = s.sessions.find((x) => x.id === 's1');
  return {
    blockIds: blocks.map((b) => b.id),
    resume: sess?.resumeSessionId ?? null,
    started: !!s.startedSessions.s1
  };
});
if (after.blockIds.length !== 1 || after.blockIds[0] !== 'a0') {
  await app.close();
  fail(`expected blocks=[a0] after Truncate, got ${JSON.stringify(after.blockIds)}`);
}
if (after.resume !== null) {
  await app.close();
  fail(`expected resumeSessionId=null after Truncate, got ${JSON.stringify(after.resume)}`);
}
if (after.started) {
  await app.close();
  fail(`expected startedSessions.s1=false after Truncate, got true`);
}

console.log('\n[probe-e2e-user-block-hover-menu] OK');
console.log('  hover reveals 4 actions, Copy → clipboard, Truncate → cut + clear resume');
await app.close();
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
