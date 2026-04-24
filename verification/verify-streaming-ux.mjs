// One-shot verification (not a probe-e2e harness file).
// Verifies T0/T1/T2 visual states for the streaming UX fix:
//   T0: running + only user block  -> dots visible
//   T1: running + assistant streaming  -> dots gone, assistant text rendering
//   T2: running + assistant streaming + more text   -> text grew (incremental)
// We drive state via window.__ccsmStore (the dev shim) since
// running real claude.exe end-to-end is out of scope for this PR's
// verification (the spawner-arg fix is regression-guarded by unit test;
// the visible UI behavior is what we screenshot here).

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:4100/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 10000 });

// Wait for at least one session to exist (boot creates one), then grab id.
// In dev:web (no electron backend), boot may not create one — seed manually.
const sid = await page.evaluate(() => {
  const useStore = window.__ccsmStore;
  let s = useStore.getState();
  if (s.activeId) return s.activeId;
  // Seed minimal session into store directly so ChatStream has somewhere to render.
  const id = 's-verify';
  useStore.setState((prev) => ({
    activeId: id,
    sessions: [
      ...(prev.sessions ?? []),
      { id, name: 'verify', cwd: '.', createdAt: Date.now() }
    ],
    messagesBySession: { ...prev.messagesBySession, [id]: [] },
    runningSessions: { ...prev.runningSessions }
  }));
  return id;
});

console.log('active session id:', sid);

// --- T0: user just sent, no assistant block, running flips true ---
await page.evaluate((id) => {
  const useStore = window.__ccsmStore;
  useStore.setState((s) => ({
    messagesBySession: {
      ...s.messagesBySession,
      [id]: [{ kind: 'user', id: 'u-verify-1', text: 'Explain TCP three-way handshake in 300+ words. Do not use tools.' }]
    },
    runningSessions: { ...s.runningSessions, [id]: true }
  }));
}, sid);
await page.waitForTimeout(500);
const t0HasDots = await page.evaluate(() => !!document.querySelector('[data-testid="chat-thinking-dots"]'));
await page.screenshot({ path: path.join(here, 'T0-user-sent-dots-visible.png'), fullPage: false });
console.log('T0 dots visible:', t0HasDots);

// --- T1: first assistant token lands; dots should disappear ---
await page.evaluate((id) => {
  const useStore = window.__ccsmStore;
  useStore.setState((s) => ({
    messagesBySession: {
      ...s.messagesBySession,
      [id]: [
        ...s.messagesBySession[id],
        { kind: 'assistant', id: 'a-verify-1', text: 'The TCP', streaming: true }
      ]
    }
  }));
}, sid);
await page.waitForTimeout(200);
const t1HasDots = await page.evaluate(() => !!document.querySelector('[data-testid="chat-thinking-dots"]'));
await page.screenshot({ path: path.join(here, 'T1-first-token-dots-gone.png'), fullPage: false });
console.log('T1 dots visible (should be false):', t1HasDots);

// --- T2: simulate ~5s of incremental token growth ---
const chunks = [
  ' three-way handshake',
  ' is the procedure that establishes',
  ' a reliable connection between',
  ' two endpoints. The client begins',
  ' by sending a SYN segment to the server,',
  ' which responds with a SYN-ACK,',
  ' and the client finally acknowledges',
  ' with an ACK to complete the exchange.'
];
for (const c of chunks) {
  await page.evaluate(({ id, c }) => {
    const useStore = window.__ccsmStore;
    useStore.setState((s) => {
      const blocks = s.messagesBySession[id].slice();
      const last = blocks[blocks.length - 1];
      blocks[blocks.length - 1] = { ...last, text: last.text + c };
      return { messagesBySession: { ...s.messagesBySession, [id]: blocks } };
    });
  }, { id: sid, c });
  await page.waitForTimeout(500);
}
await page.screenshot({ path: path.join(here, 'T2-incremental-streaming.png'), fullPage: false });
const finalLen = await page.evaluate((id) => {
  const s = window.__ccsmStore.getState();
  const blocks = s.messagesBySession[id];
  return blocks[blocks.length - 1].text.length;
}, sid);
console.log('T2 final assistant text length:', finalLen);

// Sanity asserts.
const ok = t0HasDots === true && t1HasDots === false && finalLen > 100;
console.log('--- VERDICT ---');
console.log(ok ? 'PASS' : 'FAIL');
if (!ok) {
  console.log('logs:');
  for (const l of logs) console.log(' ', l);
  process.exitCode = 1;
}

await browser.close();
