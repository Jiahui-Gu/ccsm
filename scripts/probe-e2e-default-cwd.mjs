// E2E: new session + send WITHOUT touching the cwd chip. The default cwd
// value is "~" (string literal), and on Windows Node's child_process.spawn
// rejects that cwd with ENOENT — which the SDK error-template translates
// into the misleading "Claude Code native binary not found" message.
//
// If main-process spawn fails, either:
//   - an error toast/log surfaces "native binary not found" / "ENOENT", OR
//   - no assistant block ever renders and the session stays stuck.
//
// Pass = assistant block renders within 30s. Fail = any of the above.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-default-cwd] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

const newBtn = win.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
await newBtn.click();

const textarea = win.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });

// DELIBERATELY skip the cwd chip — default cwd is "~".
await textarea.click();
await textarea.fill('hi');
await win.keyboard.press('Enter');

const assistant = win.locator('div.flex.gap-3.text-base').filter({
  has: win.locator('span:has-text("●")')
});

try {
  await assistant.first().waitFor({ state: 'visible', timeout: 30_000 });
} catch {
  const dump = await win.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.innerText.slice(0, 1500) : '<no <main>>';
  });
  console.error('--- main innerText ---\n' + dump);
  console.error('--- recent errors ---\n' + errors.slice(-15).join('\n'));
  await app.close();
  fail('no assistant block rendered — spawn with default cwd "~" likely failed (ENOENT → misleading "native binary not found")');
}

// Extra guard: scan collected console errors for the specific symptom.
const symptom = errors.find((e) => /native binary not found|ENOENT/i.test(e));
if (symptom) {
  await app.close();
  fail(`console reported spawn failure: ${symptom}`);
}

console.log('\n[probe-e2e-default-cwd] OK');
console.log('  sending with default cwd "~" produced an assistant reply');

await app.close();
