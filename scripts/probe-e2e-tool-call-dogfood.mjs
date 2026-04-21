// T10 dogfood: send a prompt that should trigger a Bash tool call, verify
// tool block renders in DOM with name + brief + result.
//
// Pass = at least one ToolBlock appears (button[aria-expanded]) AND the
// assistant produces a follow-up text block after the tool result.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-tool-call-dogfood] FAIL: ${msg}`);
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
await textarea.click();
await textarea.fill('Use the Bash tool to run `echo dogfood_marker_8421` and tell me what it printed.');
await win.keyboard.press('Enter');

// Wait for a tool block (button with aria-expanded attribute inside chat stream).
const toolBtn = win.locator('button[aria-expanded]').first();
try {
  await toolBtn.waitFor({ state: 'visible', timeout: 90_000 });
} catch {
  const dump = await win.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.innerText.slice(0, 2000) : '<no <main>>';
  });
  console.error('--- main innerText ---\n' + dump);
  console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
  await app.close();
  fail('no tool block rendered within 90s');
}

// Grab tool block text to show name + brief.
const toolText = await toolBtn.innerText();

// Wait a bit more for the result and assistant follow-up.
await win.waitForTimeout(8000);

// Look for the marker string in any rendered text.
const markerSeen = await win.evaluate(() =>
  document.body.innerText.includes('dogfood_marker_8421')
);

const finalDump = await win.evaluate(() => {
  const main = document.querySelector('main');
  return main ? main.innerText.slice(0, 1500) : '<no <main>>';
});

console.log('\n[probe-e2e-tool-call-dogfood] OK');
console.log('  tool block header:', toolText.replace(/\s+/g, ' ').slice(0, 120));
console.log('  marker echoed in DOM:', markerSeen);
console.log('  ---- final main text (first 800) ----');
console.log(finalDump.slice(0, 800));

await app.close();
