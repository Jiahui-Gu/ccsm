// E2E: user clicks New Session, picks cwd via dialog, types in textarea,
// presses Enter, and SEES the assistant reply rendered in DOM.
//
// Pure black-box: no store reads, no IPC reads. Start = button click, end =
// DOM contains assistant text. If the assistant block doesn't appear in the
// chat stream, this exits non-zero.
//
// Requires: ~/.claude/settings.json with a working ANTHROPIC_AUTH_TOKEN +
// ANTHROPIC_BASE_URL (run `claude /config` once).
// Run: `node scripts/probe-e2e-send.mjs`
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const FAKE_CWD = root.replace(/\\/g, '\\\\'); // escape for inline JS

function fail(msg) {
  console.error(`\n[probe-e2e-send] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

// 1) Stub the native folder-picker dialog in the MAIN process so the UI's
//    "Browse folder…" returns FAKE_CWD without opening a real OS dialog.
await app.evaluate(async ({ dialog }, fakeCwd) => {
  // monkey-patch on the live `dialog` module imported by main.ts
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

// 2) UI: click "New Session" in sidebar OR empty-state CTA — both paths exist
//    depending on whether the user already has sessions in the local DB.
const newBtn = win.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 15_000 }).catch(async () => {
  const html = await win.evaluate(() => document.body.innerText.slice(0, 600));
  console.error('--- body text at failure ---\n' + html);
  console.error('--- recent errors ---\n' + errors.slice(-10).join('\n'));
  await app.close();
  fail('"New Session" button not visible after 15s');
});
await newBtn.click();

// Wait for the chat surface to mount (textarea appears once a session is active)
const textarea = win.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
  fail('textarea did not appear after clicking New Session');
});

// 3) UI: change cwd via StatusBar's chip → "Browse folder…".
//    The cwd Chip is the first ChipMenu trigger in the StatusBar; its
//    `title` is the full cwd path. New session defaults to cwd "~".
const cwdChip = win.locator('[title="~"]').first();
await cwdChip.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
  await app.close();
  fail('cwd chip (title="~") not found');
});
await cwdChip.click();
const browseItem = win.getByText('Browse folder…').first();
await browseItem.waitFor({ state: 'visible', timeout: 3000 });
await browseItem.click();

// Give pickDirectory IPC + state update a beat to settle.
await win.waitForTimeout(400);

// 4) UI: type prompt and press Enter to send.
await textarea.click();
await textarea.fill('reply with the single word: pong');
await win.keyboard.press('Enter');

// 5) END = DOM. Wait for an assistant block to render visible text.
//    AssistantBlock structure: a flex row whose first child is "●" (the
//    glyph) followed by markdown body text. We wait for any text content
//    after the glyph to appear, up to 30s (cold-start + first round-trip).
const assistantText = win.locator('div.flex.gap-3.text-base').filter({
  has: win.locator('span:has-text("●")')
});

try {
  await assistantText.first().waitFor({ state: 'visible', timeout: 30_000 });
} catch {
  // Surface what IS on screen to make the failure debuggable.
  const dump = await win.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.innerText.slice(0, 1500) : '<no <main>>';
  });
  console.error('--- main innerText at failure ---\n' + dump);
  console.error('--- recent errors ---\n' + errors.slice(-10).join('\n'));
  await app.close();
  fail('no assistant block rendered within 30s');
}

// Sanity: assistant block has *some* visible text body (not just the glyph).
const bodyText = (await assistantText.first().innerText()).replace(/●/g, '').trim();
if (bodyText.length === 0) {
  await app.close();
  fail('assistant block rendered but contains no text body');
}

// Also assert the user's own message is on screen — catches local-echo regressions.
const userEcho = win.getByText('reply with the single word: pong').first();
const userVisible = await userEcho.isVisible().catch(() => false);
if (!userVisible) {
  await app.close();
  fail('user message echo missing from chat (appendBlocks regression)');
}

console.log(`\n[probe-e2e-send] OK`);
console.log(`  user echo:  visible`);
console.log(`  assistant:  "${bodyText.slice(0, 80).replace(/\s+/g, ' ')}..."`);

await app.close();
