// Real end-to-end for env passthrough: parent ANTHROPIC_BASE_URL +
// ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) must flow through
// buildSpawnEnv into claude.exe so the CLI authenticates without needing a
// ~/.claude login in the isolated CLAUDE_CONFIG_DIR.
//
// Pass criteria:
//   - no error banner / "Not logged in" text in DOM
//   - at least one assistant text block rendered
//   - assistant text is non-empty and does not match the auth-failure banner
//
// Prints the final chat region innerText so the caller can attach it as
// evidence in the dogfood report.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const hasAuth =
  (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0) ||
  (process.env.ANTHROPIC_AUTH_TOKEN && process.env.ANTHROPIC_AUTH_TOKEN.length > 0);
if (!hasAuth) {
  console.error(
    '[probe-e2e-env-passthrough] FAIL: neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set in the parent env. Cannot run real e2e.'
  );
  process.exit(2);
}

const PROMPT = 'Reply with exactly the single word OK and nothing else.';

function fail(msg, extras) {
  console.error(`\n[probe-e2e-env-passthrough] FAIL: ${msg}`);
  if (extras) console.error(extras);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' },
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
await textarea.fill(PROMPT);
await win.keyboard.press('Enter');

// Wait up to 60s for assistant text. Heuristic: look for either a
// paragraph inside <main> containing the marker word OK (case-insensitive)
// or any text chunk past the user's own echoed prompt.
const deadline = Date.now() + 60_000;
let lastDump = '';
let assistantSeen = false;
while (Date.now() < deadline) {
  const snapshot = await win.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.innerText : '';
  });
  lastDump = snapshot;
  if (/not logged in/i.test(snapshot) || /please run .*\/login/i.test(snapshot)) {
    await app.close();
    fail('"Not logged in" banner present — env did not reach claude.exe', snapshot.slice(0, 1000));
  }
  // User message is the prompt. Look for content AFTER that prompt.
  const idx = snapshot.indexOf(PROMPT);
  const after = idx >= 0 ? snapshot.slice(idx + PROMPT.length) : snapshot;
  if (/\bOK\b/i.test(after) && after.trim().length > 2) {
    assistantSeen = true;
    break;
  }
  await win.waitForTimeout(500);
}

const finalDump = await win.evaluate(() => {
  const main = document.querySelector('main');
  return main ? main.innerText : '<no <main>>';
});

if (!assistantSeen) {
  console.error('--- main innerText (last snapshot) ---');
  console.error(lastDump.slice(0, 2000));
  console.error('--- console errors (last 10) ---');
  console.error(errors.slice(-10).join('\n'));
  await app.close();
  fail('no assistant "OK" reply within 60s');
}

console.log('\n[probe-e2e-env-passthrough] OK');
console.log('  prompt:', PROMPT);
console.log('  ---- final main innerText ----');
console.log(finalDump.slice(0, 2000));
console.log('  ---- end ----');

await app.close();
