// E2E: user clicks New Session, picks cwd via dialog, types in textarea,
// presses Enter, and SEES the assistant reply rendered in DOM.
//
// Pure black-box: no store reads, no IPC reads. Start = button click, end =
// DOM contains assistant text. If the assistant block doesn't appear in the
// chat stream, this exits non-zero.
//
// Phases (all share the SAME session to amortise the cold-start round-trip):
//   1. baseline — single-line "pong" prompt, asserts user echo + assistant text
//   2. multiline — Shift+Enter inserts a literal newline, send is on Enter
//   3. tricky chars — `<tag>`, backticks, emoji must echo verbatim (no HTML
//      injection, no markdown swallow of `< >` outside code, no surrogate-pair
//      mangling)
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

function fail(msg) {
  console.error(`\n[probe-e2e-send] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, AGENTORY_PROD_BUNDLE: '1' }
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
//    Targets the dedicated `data-cwd-chip` attribute so the probe is robust
//    to whatever the initial cwd label happens to be (history seeding can
//    pick up the user's home dir; the title is no longer guaranteed `~`).
const cwdChip = win.locator('[data-cwd-chip]').first();
await cwdChip.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
  await app.close();
  fail('cwd chip ([data-cwd-chip]) not found');
});
await cwdChip.click();
const browseItem = win.getByText('Browse folder…').first();
await browseItem.waitFor({ state: 'visible', timeout: 3000 });
await browseItem.click();

// Give pickDirectory IPC + state update a beat to settle.
await win.waitForTimeout(400);

// Helper: send `text` via the composer and wait until BOTH the user echo and
// at least one *new* assistant block are visible. We keep a running count of
// assistant blocks so subsequent phases don't false-positive on phase 1's
// reply still being on screen.
const assistantSelector = 'div.flex.gap-3.text-base';
async function countAssistantBlocks() {
  return await win.evaluate((sel) => {
    return document.querySelectorAll(sel).length;
  }, assistantSelector);
}

let assistantBaseline = await countAssistantBlocks();

async function sendAndWait(text, { label, timeoutMs = 60_000 } = {}) {
  await textarea.click();
  await textarea.fill(text);
  await win.keyboard.press('Enter');

  // user echo first — fast, deterministic, tells us the composer accepted it
  const echo = win.getByText(text, { exact: false }).first();
  await echo.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
    fail(`[${label}] user echo did not render: ${JSON.stringify(text).slice(0, 80)}`);
  });

  // Then wait for assistant count to advance past baseline.
  const deadline = Date.now() + timeoutMs;
  let now = assistantBaseline;
  while (Date.now() < deadline) {
    now = await countAssistantBlocks();
    if (now > assistantBaseline) break;
    await win.waitForTimeout(250);
  }
  if (now <= assistantBaseline) {
    const dump = await win.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.innerText.slice(0, 1500) : '<no <main>>';
    });
    console.error('--- main innerText at failure ---\n' + dump);
    console.error('--- recent errors ---\n' + errors.slice(-10).join('\n'));
    await app.close();
    fail(`[${label}] no new assistant block within ${timeoutMs}ms`);
  }
  assistantBaseline = now;
}

// === Phase 1: baseline ====================================================
await sendAndWait('reply with the single word: pong', { label: 'baseline' });
console.log('[probe-e2e-send] phase 1 (baseline) OK');

// === Phase 2: multiline ===================================================
// Shift+Enter must insert a newline INTO the textarea instead of sending.
await textarea.click();
await textarea.fill('');
await textarea.type('first line');
await win.keyboard.down('Shift');
await win.keyboard.press('Enter');
await win.keyboard.up('Shift');
await textarea.type('second line');
const composerValue = await textarea.inputValue();
if (composerValue !== 'first line\nsecond line') {
  await app.close();
  fail(`[multiline] Shift+Enter did not insert newline. composer=${JSON.stringify(composerValue)}`);
}
// Plain Enter sends.
await win.keyboard.press('Enter');
// Echo: only assert the unique tail token ("second line") — getByText with
// exact:false matches across line breaks.
const mlEcho = win.getByText('second line', { exact: false }).first();
await mlEcho.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
  await app.close();
  fail('[multiline] user echo did not render');
});
// Wait for the next assistant block.
{
  const deadline = Date.now() + 60_000;
  let now = assistantBaseline;
  while (Date.now() < deadline) {
    now = await countAssistantBlocks();
    if (now > assistantBaseline) break;
    await win.waitForTimeout(250);
  }
  if (now <= assistantBaseline) {
    await app.close();
    fail('[multiline] no new assistant block within 60s');
  }
  assistantBaseline = now;
}
console.log('[probe-e2e-send] phase 2 (multiline) OK');

// === Phase 3: tricky characters ===========================================
// `<tag>` must NOT be silently swallowed (would hint at unsanitised innerHTML
// somewhere); backticks must round-trip; the rocket emoji is a 4-byte
// surrogate pair and would split if any string slicing miscounted code units.
const tricky = 'echo this back literally please: <tag> `inline` 🚀';
await sendAndWait(tricky, { label: 'tricky' });
// Also assert the EXACT user-echo string is on screen (catches HTML stripping
// of `<tag>` between the textarea and the rendered user block).
const trickyEcho = win.getByText(tricky, { exact: true }).first();
const trickyVisible = await trickyEcho.isVisible().catch(() => false);
if (!trickyVisible) {
  // Fall back to per-token checks so we report what specifically dropped.
  const partials = ['<tag>', '`inline`', '🚀'];
  const present = await Promise.all(
    partials.map((p) => win.getByText(p, { exact: false }).first().isVisible().catch(() => false))
  );
  const dropped = partials.filter((_, i) => !present[i]);
  await app.close();
  fail(`[tricky] user echo missing exact match; missing fragments: ${dropped.join(', ') || '(layout-only)'}`);
}
console.log('[probe-e2e-send] phase 3 (tricky chars) OK');

console.log(`\n[probe-e2e-send] OK — 3/3 phases passed`);
await app.close();
