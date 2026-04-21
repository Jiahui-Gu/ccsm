// Verify the first-run tutorial:
// - Shows when sessions=[] and tutorialSeen=false
// - Has Step 1/4 indicator and Skip button
// - Next advances; Done/Skip dismisses (markTutorialSeen → state flips)
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-tutorial] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, NODE_ENV: 'development' } });
const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 10000 });

await win.evaluate(() => {
  window.__agentoryStore.setState({ sessions: [], activeId: undefined, tutorialSeen: false });
});
await win.waitForTimeout(200);

// Step 1 visible.
const stepCounter = win.locator('text=/Step 1 of 4/i').first();
await stepCounter.waitFor({ state: 'visible', timeout: 5000 });
await win.locator('text=/A workbench for AI sessions/i').first().waitFor({ state: 'visible', timeout: 3000 });

// Skip button present.
const skipBtn = win.getByRole('button', { name: /^Skip$/ });
await skipBtn.waitFor({ state: 'visible', timeout: 3000 });

// Click Next 3 times to reach Step 4.
const nextBtn = win.getByRole('button', { name: /^Next$/ });
await nextBtn.click();
await win.waitForTimeout(150);
await nextBtn.click();
await win.waitForTimeout(150);
await nextBtn.click();
await win.waitForTimeout(200);

await win.locator('text=/Step 4 of 4/i').first().waitFor({ state: 'visible', timeout: 3000 });
await win.locator('text=/Ready when you are/i').first().waitFor({ state: 'visible', timeout: 3000 });

// On last step the inline "New Session" / "Import Session" buttons appear.
await win.getByRole('button', { name: /^New Session$/ }).first().waitFor({ state: 'visible', timeout: 3000 });
await win.getByRole('button', { name: /^Import Session$/ }).first().waitFor({ state: 'visible', timeout: 3000 });

// Click Done — tutorialSeen should flip and the panel should switch to the
// two big CTA buttons (no more step counter).
await win.getByRole('button', { name: /^Done$/ }).click();
await win.waitForTimeout(300);

const seen = await win.evaluate(() => window.__agentoryStore.getState().tutorialSeen);
if (!seen) { await app.close(); fail('Done did not set tutorialSeen=true'); }

const stillTutorial = await win.locator('text=/Step \\d of 4/i').count();
if (stillTutorial > 0) { await app.close(); fail('tutorial still rendered after Done'); }

console.log('\n[probe-e2e-tutorial] OK');
await app.close();
