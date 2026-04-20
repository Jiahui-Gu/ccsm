import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

await page.goto('http://localhost:4100/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const result = await page.evaluate(async () => {
  const out = { steps: [], errors: [], checks: {} };
  try {
    const useStore = window.__agentoryStore;
    if (!useStore) throw new Error('window.__agentoryStore missing');

    useStore.getState().createSession('~/probe');
    const sid = useStore.getState().activeId;
    out.steps.push(`session ${sid}`);

    // Force the session into waiting state (mimics SDK setting it).
    useStore.setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === sid ? { ...x, state: 'waiting' } : x))
    }));
    await new Promise((r) => setTimeout(r, 300));

    // Group row dot: aria-label="Waiting for response"
    const dot = document.querySelector('[aria-label="Waiting for response"]');
    out.checks.groupDotFound = !!dot;
    if (dot) {
      const cs = getComputedStyle(dot);
      out.checks.groupDotBg = cs.backgroundColor;
    }

    // AgentIcon halo: framer-motion sets box-shadow inline.
    const allMotionSpans = document.querySelectorAll('span.relative.inline-flex.shrink-0');
    let haloFound = false;
    for (const s of allMotionSpans) {
      const cs = getComputedStyle(s);
      if (cs.boxShadow && cs.boxShadow.includes('oklch')) {
        haloFound = true;
        out.checks.haloBoxShadow = cs.boxShadow;
        break;
      }
    }
    out.checks.haloFound = haloFound;
  } catch (e) {
    out.errors.push(String(e?.stack ?? e));
  }
  return out;
});

console.log('=== STEPS ===');
for (const s of result.steps) console.log('  -', s);
if (result.errors.length) {
  console.log('=== ERRORS ===');
  for (const e of result.errors) console.log(e);
}
console.log('\n=== CHECKS ===');
console.log(JSON.stringify(result.checks, null, 2));

console.log('\n=== CONSOLE / PAGE ERRORS ===');
for (const l of logs) console.log(l);

await browser.close();
