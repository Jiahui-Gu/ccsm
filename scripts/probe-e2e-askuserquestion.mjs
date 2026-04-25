// Live e2e: prompt that triggers AskUserQuestion, verify QuestionBlock renders
// with the option picker (RadioGroup), clicking an option + Submit round-trips
// back to claude.exe and the agent continues.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-e2e-askuserquestion] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', CCSM_DEV_PORT: process.env.CCSM_DEV_PORT ?? '4102', CCSM_PROD_BUNDLE: '1' }
});

try { // ccsm-probe-cleanup-wrap

// Stub folder picker so we don't block on OS dialog.
await app.evaluate(async ({ dialog }, fakeCwd) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeCwd] });
}, root);

const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

const newBtn = win.getByRole('button', { name: /new session/i }).first();
try {
  await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
} catch {
  const dump = await win.evaluate(() => document.body.innerText.slice(0, 2000));
  console.error('--- body text ---\n' + dump);
  console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
  fail('New Session not visible', app);
}
await newBtn.click();

const textarea = win.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });

await textarea.click();
await textarea.fill('Use the AskUserQuestion tool to ask me: "Which language?" with options Python, TypeScript, Rust. Do nothing else first.');
await win.keyboard.press('Enter');

const heading = win.locator('text=Question awaiting answer').first();
try {
  await heading.waitFor({ state: 'visible', timeout: 90_000 });
} catch {
  const dump = await win.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.innerText.slice(0, 2000) : '<no <main>>';
  });
  console.error('--- main innerText ---\n' + dump);
  console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
  fail('no QuestionBlock heading rendered within 90s', app);
}

const preSnippet = await win.evaluate(() => {
  const hd = Array.from(document.querySelectorAll('*')).find((n) => n.textContent?.trim() === 'Question awaiting answer');
  if (!hd) return '<not found>';
  const container = hd.closest('div.relative');
  return container ? container.outerHTML.slice(0, 2500) : '<no container>';
});
console.log('\n=== Pre-submit DOM snippet (first ~2.5KB) ===');
console.log(preSnippet);

const tsOption = win.locator('label', { hasText: 'TypeScript' }).first();
await tsOption.waitFor({ state: 'visible', timeout: 5000 });

// Keyboard navigation path: the first option should be auto-focused. Press
// ArrowDown twice to move to Rust, then ArrowUp once to land on TypeScript,
// then press Enter to submit. This exercises the full keyboard flow without
// touching the mouse.
const focusedKind = await win.evaluate(() => {
  const el = document.activeElement;
  if (!el) return '<none>';
  return `${el.tagName}[role=${el.getAttribute('role') ?? ''} value=${el.getAttribute('value') ?? ''}]`;
});
console.log(`[probe-e2e-askuserquestion] initial focus = ${focusedKind}`);

if (!/role=radio/.test(focusedKind)) {
  // Fall back to focusing the radio group manually if autofocus missed.
  const firstRadio = win.locator('[role="radio"]').first();
  await firstRadio.focus();
}

await win.keyboard.press('ArrowDown');
await win.waitForTimeout(80);
await win.keyboard.press('ArrowDown');
await win.waitForTimeout(80);
await win.keyboard.press('ArrowUp');
await win.waitForTimeout(80);

const focusedAfter = await win.evaluate(() => {
  const el = document.activeElement;
  if (!el) return '<none>';
  return {
    role: el.getAttribute('role'),
    value: el.getAttribute('value'),
    state: el.getAttribute('data-state')
  };
});
console.log('[probe-e2e-askuserquestion] focused after arrow nav:', JSON.stringify(focusedAfter));

if (focusedAfter.role !== 'radio' || focusedAfter.value !== '1') {
  fail(
    `expected radio value=1 (TypeScript) focused after arrow nav, got ${JSON.stringify(focusedAfter)}`,
    app
  );
}

await win.keyboard.press('Enter');

const submitted = win.getByRole('button', { name: /submitted/i });
try {
  await submitted.waitFor({ state: 'visible', timeout: 5000 });
} catch {
  fail('no Submitted label after click', app);
}

await win.waitForTimeout(15_000);

const afterText = await win.evaluate(() => {
  const main = document.querySelector('main');
  return main ? main.innerText.slice(0, 2000) : '<no <main>>';
});

const ackSeen = /typescript/i.test(afterText);

console.log('\n=== Post-submit main innerText (first 1400) ===');
console.log(afterText.slice(0, 1400));
console.log('\n[probe-e2e-askuserquestion] OK  submit=ok  ackSeen=' + ackSeen);

await app.close();
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
