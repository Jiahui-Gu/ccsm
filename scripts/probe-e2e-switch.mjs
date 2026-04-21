// E2E: after sending a message in session A, create session B, switch to it,
// then switch BACK to A — and the conversation must still be on screen.
//
// Catches the temp→real-session-id migration bug class: when the SDK returns
// a real session id and `replaceSession` swaps temp→real, every map keyed by
// session id (messagesBySession, customGroups, startedSessions, etc.) must be
// migrated. Missing one → the chat history disappears when the user
// navigates away and back. The user sees an empty session.
//
// Pure black-box: clicks + DOM reads only. Run after `npm run build`.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-switch] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

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

const PROMPT_A = 'reply with the single word: alpha';
const PROMPT_B = 'reply with the single word: beta';

async function clickNewSession() {
  const btn = win.getByRole('button', { name: /new session/i }).first();
  await btn.waitFor({ state: 'visible', timeout: 15_000 });
  await btn.click();
  await win.locator('textarea').waitFor({ state: 'visible', timeout: 5000 });
}

async function setCwdViaChip() {
  const chip = win.locator('[title="~"]').first();
  await chip.waitFor({ state: 'visible', timeout: 5000 });
  await chip.click();
  const browseItem = win.getByText('Browse folder…').first();
  await browseItem.waitFor({ state: 'visible', timeout: 3000 });
  await browseItem.click();
  await win.waitForTimeout(400);
}

async function sendPrompt(text) {
  const textarea = win.locator('textarea');
  await textarea.click();
  await textarea.fill(text);
  await win.keyboard.press('Enter');
  // Wait for SOME assistant block to render visible body text.
  const assistant = win.locator('div.flex.gap-3.text-base').filter({
    has: win.locator('span:has-text("●")')
  });
  await assistant.first().waitFor({ state: 'visible', timeout: 30_000 });
  // tiny settle so the temp→real id swap finishes after the SDK's first
  // system init message (this is the swap window we're trying to stress).
  await win.waitForTimeout(800);
}

// === Session A ===
await clickNewSession();
await setCwdViaChip();
await sendPrompt(PROMPT_A);

// Sanity: alpha echo + alpha-ish reply must be on screen RIGHT NOW.
if (!(await win.getByText(PROMPT_A).first().isVisible().catch(() => false))) {
  await app.close();
  fail('alpha user echo not visible right after sending');
}

// Capture what the chat looks like in session A so we can compare after
// the round-trip. We grab the <main> innerText — anything visible to the
// user is in there.
async function chatSnapshot() {
  return await win.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.innerText : '';
  });
}
const snapshotA_before = await chatSnapshot();
if (!snapshotA_before.includes(PROMPT_A)) {
  await app.close();
  fail('chat snapshot of session A missing alpha prompt');
}

// === Session B (this also forces sidebar to have ≥2 sessions to click
//     between, AND triggers another temp→real id swap once B starts) ===
await clickNewSession();
// session B is now active; A's chat should be off-screen
const aGoneFromMain = !(await win.getByText(PROMPT_A).first().isVisible().catch(() => false));
if (!aGoneFromMain) {
  await app.close();
  fail('after switching to session B, session A content still visible in <main>');
}
await setCwdViaChip();
await sendPrompt(PROMPT_B);

// === Switch BACK to session A by clicking it in the sidebar ===
// Sidebar session items use the session name. Newly created sessions get
// the name "New session", so we can't click by name (both are "New session").
// Instead use the snapshot row that ISN'T currently active. The simplest
// cross-platform way: query <aside> for elements containing "New session"
// and click the one that's NOT inside the currently active row.
//
// active row has stronger styling but no semantic marker. We rely on
// position: session A was created first → in newest-first sort order it's
// the SECOND "New session" entry in the sidebar.
// All session rows in the sidebar are <li> with class "group/sess".
// createSession unshifts → newest is at index 0. Session A was created
// before B, so A is at index 1.
const sessionCount = await win.locator('aside li').count();
if (sessionCount < 2) {
  await app.close();
  fail(`expected ≥2 sessions in sidebar, got ${sessionCount}`);
}
await win.locator('aside li').nth(1).click();
await win.waitForTimeout(800);

// === The actual assertion: A's chat is back on screen, intact ===
const snapshotA_after = await chatSnapshot();
if (!snapshotA_after.includes(PROMPT_A)) {
  console.error('--- snapshot A BEFORE switch ---\n' + snapshotA_before.slice(0, 800));
  console.error('--- snapshot A AFTER round-trip ---\n' + snapshotA_after.slice(0, 800));
  console.error('--- recent errors ---\n' + errors.slice(-10).join('\n'));
  await app.close();
  fail('session A lost its chat history after switching away and back (id-migration regression?)');
}
// Also check assistant body still rendered (not just user echo).
const assistantStillThere = await win
  .locator('div.flex.gap-3.text-base')
  .filter({ has: win.locator('span:has-text("●")') })
  .first()
  .isVisible()
  .catch(() => false);
if (!assistantStillThere) {
  await app.close();
  fail('assistant block in session A missing after round-trip');
}

console.log('\n[probe-e2e-switch] OK');
console.log('  session A retained alpha prompt + assistant reply across A→B→A');

await app.close();
