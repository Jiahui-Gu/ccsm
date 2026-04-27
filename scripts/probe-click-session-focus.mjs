// Probe: clicking a session in the sidebar should move keyboard focus into
// the InputBar textarea (matching Claude Desktop's behavior).
//
// Strategy: render against the webpack dev server (no Electron, no agent
// IPC needed — this is pure DOM/state behavior). Seed the zustand store
// with two synthetic sessions so we can click between them, then assert
// `document.activeElement === textarea` after each click.
//
// Usage: CCSM_DEV_PORT=4181 npm run dev:web (background), then
//   node scripts/probe-click-session-focus.mjs
import { chromium } from 'playwright';

const PORT = process.env.CCSM_DEV_PORT ?? '4181';
const URL = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`\n[probe-click-session-focus] FAIL: ${msg}`);
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

// Seed two sessions via the store directly so we don't need a real agent.
await page.evaluate(() => {
  const w = window;
  // Bypass the createSession helper because it triggers IPC paths in the
  // renderer; we only want sidebar rows to click.
  const useStore = w.__useStore || (w.useStore);
  // Fallback: trigger two clicks on the visible "New session" button.
});

// Trigger via the visible UI: two New Session clicks → two rows in sidebar.
// (createSession in the store doesn't bump focusInputNonce — only selecting
// existing sessions does — so the textarea won't auto-focus on creation,
// which is exactly what we want as a control case.)
const newBtn = page.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 10_000 });
await newBtn.click();
await page.waitForTimeout(150);
await newBtn.click();
await page.waitForTimeout(250);

// Sanity: textarea exists.
const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });

// Park focus somewhere benign (sidebar aside element) so we can detect
// that subsequent session clicks DO move focus into the textarea.
await page.evaluate(() => {
  const ta = document.querySelector('textarea');
  if (ta) ta.blur();
  document.body.focus();
});

const rows = page.locator('aside li[role="option"]');
const rowCount = await rows.count();
if (rowCount < 2) {
  await browser.close();
  fail(`expected ≥2 session rows in sidebar, got ${rowCount}`);
}

async function clickRowAndAssertFocus(idx, label) {
  await rows.nth(idx).click();
  // Give the React effect a tick to run.
  await page.waitForTimeout(120);
  const focused = await page.evaluate(() => {
    const ae = document.activeElement;
    return {
      tag: ae ? ae.tagName : null,
      isTextarea: !!ae && ae.tagName === 'TEXTAREA'
    };
  });
  if (!focused.isTextarea) {
    await browser.close();
    fail(`after clicking session ${label}, expected TEXTAREA to be focused, got ${focused.tag}`);
  }
  console.log(`  click session ${label}: activeElement=TEXTAREA OK`);
}

// Click row 0 (the second session, since createSession unshifts).
await clickRowAndAssertFocus(0, '#0');

// Move focus away again, then click the OTHER row to prove the behavior
// repeats per click (not just on activeId change).
await page.evaluate(() => {
  const ta = document.querySelector('textarea');
  if (ta) ta.blur();
  document.body.focus();
});
await clickRowAndAssertFocus(1, '#1');

// Re-clicking the SAME (already-active) session should still re-focus the
// textarea — the user clicked, the input should respond.
await page.evaluate(() => {
  const ta = document.querySelector('textarea');
  if (ta) ta.blur();
  document.body.focus();
});
await clickRowAndAssertFocus(1, '#1 (re-click same)');

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-click-session-focus] OK');
console.log('  sidebar click → InputBar textarea focused, verified for 2 rows + re-click');

await browser.close();
