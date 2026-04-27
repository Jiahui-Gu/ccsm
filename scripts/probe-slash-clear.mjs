// Probe: /clear must wipe the current session in place.
//
// Bug fixed: handleClear used to call store.createSession(...), so each
// `/clear` added a sidebar row. CLI semantics demand the opposite — same
// session, empty transcript, fresh next-turn context.
//
// Coverage:
//   1. Send a few user messages so the transcript has content.
//   2. Run /clear.
//   3. Sidebar count is unchanged (no new session created).
//   4. The original session is still active.
//   5. Transcript was wiped — only the "Context cleared" status remains.
//      The previously-sent user blocks are gone.
//   6. Persisted resumeSessionId is dropped (next message starts fresh).
//
// Usage:
//   CCSM_DEV_PORT=4192 npm run dev:web   # in another shell
//   CCSM_DEV_PORT=4192 node scripts/probe-slash-clear.mjs
import { chromium } from 'playwright';

const PORT = process.env.CCSM_DEV_PORT ?? '4192';
const URL = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`\n[probe-slash-clear] FAIL: ${msg}`);
  process.exit(1);
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('aside', { timeout: 15_000 });

// Create a session so the input bar is wired up.
const newBtn = page.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 10_000 });
await newBtn.click();

const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });

// Reach into the renderer store: easier and more reliable than driving DOM
// for the "send some messages" setup (no real claude.exe available in the
// browser-only probe). We append local user blocks + flag startedSessions
// the same way a real turn would, then assert /clear undoes all of it.
const sidebarItems = page.locator('[role="option"]');
const beforeCount = await sidebarItems.count();
if (beforeCount < 1) fail(`expected at least one session in sidebar, got ${beforeCount}`);

const beforeState = await page.evaluate(() => {
  const w = /** @type {any} */ (window);
  const store = w.__ccsmStore ?? null;
  if (!store) return null;
  const s = store.getState();
  const sid = s.activeId;
  // Seed transcript and "started" state so we can assert /clear wipes them.
  store.setState((cur) => ({
    messagesBySession: {
      ...cur.messagesBySession,
      [sid]: [
        { kind: 'user', id: 'probe-u1', text: 'hello world' },
        { kind: 'assistant', id: 'probe-a1', text: 'hi back' },
        { kind: 'user', id: 'probe-u2', text: 'second turn' }
      ]
    },
    startedSessions: { ...cur.startedSessions, [sid]: true },
    statsBySession: {
      ...cur.statsBySession,
      [sid]: { turns: 2, inputTokens: 200, outputTokens: 100, costUsd: 0.005 }
    },
    sessions: cur.sessions.map((x) =>
      x.id === sid ? { ...x, resumeSessionId: 'cc-fake-resume' } : x
    )
  }));
  return { sid, count: s.sessions.length };
});

if (!beforeState) {
  fail('window.__ccsmStore not exposed; the dev build must expose it (see App.tsx).');
}

// Run /clear via the textarea so we exercise the real dispatch path.
await textarea.click();
await textarea.fill('/clear');
await page.waitForTimeout(60);
await page.keyboard.press('Escape'); // dismiss picker so Enter sends
await page.waitForTimeout(40);
await page.keyboard.press('Enter');
await page.waitForTimeout(250);

const afterCount = await sidebarItems.count();
if (afterCount !== beforeCount) {
  fail(`/clear must NOT add a session (had ${beforeCount}, now ${afterCount})`);
}

const afterState = await page.evaluate(() => {
  const store = /** @type {any} */ (window).__ccsmStore;
  const s = store.getState();
  const session = s.sessions.find((x) => x.id === s.activeId);
  return {
    activeId: s.activeId,
    sessionCount: s.sessions.length,
    blocks: s.messagesBySession[s.activeId] ?? [],
    started: s.startedSessions[s.activeId] === true,
    stats: s.statsBySession[s.activeId] ?? null,
    resumeSessionId: session?.resumeSessionId ?? null
  };
});

if (afterState.activeId !== beforeState.sid) {
  fail(`activeId changed: was ${beforeState.sid}, now ${afterState.activeId}`);
}
if (afterState.sessionCount !== beforeState.count) {
  fail(`session count changed: was ${beforeState.count}, now ${afterState.sessionCount}`);
}
if (afterState.blocks.length !== 1 || afterState.blocks[0].kind !== 'status' || afterState.blocks[0].title !== 'Context cleared') {
  fail(`expected exactly one status "Context cleared" block; got ${JSON.stringify(afterState.blocks)}`);
}
if (afterState.started) fail('startedSessions[id] should be cleared');
if (afterState.stats !== null) fail('statsBySession[id] should be cleared');
if (afterState.resumeSessionId) fail(`resumeSessionId should be dropped; still ${afterState.resumeSessionId}`);

// And the visible chat stream must not contain the old user text.
const stillSeesOld = await page.getByText('hello world').first().isVisible().catch(() => false);
if (stillSeesOld) fail('old transcript text still visible after /clear');

// Visible breadcrumb confirms /clear ran.
const banner = page.locator('[role="status"]').filter({ hasText: 'Context cleared' });
if (!(await banner.first().isVisible().catch(() => false))) {
  fail('"Context cleared" status banner not visible');
}

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-slash-clear] OK');
console.log(`  sidebar count unchanged at ${afterCount}`);
console.log(`  activeId preserved (${afterState.activeId})`);
console.log('  transcript wiped, "Context cleared" breadcrumb shown');
console.log('  startedSessions / statsBySession / resumeSessionId all dropped');

await browser.close();
