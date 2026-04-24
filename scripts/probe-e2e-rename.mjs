// E2E: inline rename for sessions and groups via context menu.
//
// Covers the four exit paths the InlineRename input supports:
//   1. Enter → commits the trimmed draft to the store.
//   2. Escape → cancels; the store keeps the original name.
//   3. Empty / whitespace-only draft + Enter → cancels (treated as no-op).
//   4. Click outside → commits (mousedown capture-phase, since dnd-kit's
//      pointer listeners on ancestor rows can swallow the input's blur).
//   5. IME composition: pressing Enter while `isComposing` is true must NOT
//      commit (CJK candidate selection only). After composition ends,
//      Enter commits as usual.
//
// We exercise both session rename (under SessionRow) and group rename
// (under GroupRow) since they share InlineRename but live inside different
// host elements (li vs div) with different surrounding handlers.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData, seedStore } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-rename] FAIL: ${msg}`);
  process.exit(1);
}

const ud = isolatedUserData('agentory-probe-rename');
console.log(`[probe-e2e-rename] userData = ${ud.dir}`);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, CCSM_PROD_BUNDLE: '1' }
});
const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});
await win.waitForLoadState('domcontentloaded');

await seedStore(win, {
  groups: [
    { id: 'g1', name: 'Alpha',  collapsed: false, kind: 'normal' },
    { id: 'g2', name: 'Bravo',  collapsed: false, kind: 'normal' }
  ],
  sessions: [
    { id: 's1', name: 'first',  state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
    { id: 's2', name: 'second', state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
    { id: 's3', name: 'third',  state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g2', agentType: 'claude-code' }
  ],
  activeId: 's1'
});

async function bail(msg) {
  console.error('--- pageerrors ---\n' + errors.slice(-10).join('\n'));
  await app.close();
  ud.cleanup();
  fail(msg);
}

async function sessionName(id) {
  return await win.evaluate(
    (sid) => window.__ccsmStore.getState().sessions.find((s) => s.id === sid)?.name ?? null,
    id
  );
}
async function groupName(id) {
  return await win.evaluate(
    (gid) => window.__ccsmStore.getState().groups.find((g) => g.id === gid)?.name ?? null,
    id
  );
}

async function openSessionRename(sessionId) {
  const row = win.locator(`li[data-session-id="${sessionId}"]`).first();
  await row.click({ button: 'right' });
  await win.getByRole('menuitem', { name: /^Rename$/ }).first().click();
  const input = win.locator(`li[data-session-id="${sessionId}"] input`).first();
  await input.waitFor({ state: 'visible', timeout: 3000 });
  // InlineRename's mount effect runs focus()+select() asynchronously after
  // first paint. If we go straight to fill(), Playwright's value-set racing
  // the React-controlled re-render leaves the field stuck at the original
  // value. A real click() forces focus to settle in the input first.
  await input.click();
  return input;
}

async function openGroupRename(groupId) {
  const header = win.locator(`[data-group-header-id="${groupId}"]`).first();
  await header.click({ button: 'right' });
  await win.getByRole('menuitem', { name: /^Rename$/ }).first().click();
  const input = win.locator(`[data-group-header-id="${groupId}"] input`).first();
  await input.waitFor({ state: 'visible', timeout: 3000 });
  await input.click();
  return input;
}

// === Case 1: session Enter commits ===
{
  const input = await openSessionRename('s1');
  await input.fill('first renamed');
  await input.press('Enter');
  await win.waitForTimeout(200);
  const after = await sessionName('s1');
  if (after !== 'first renamed') await bail(`session Enter commit: expected "first renamed", got "${after}"`);
  // Input should be gone (rename mode exited).
  const stillEditing = await win.locator('li[data-session-id="s1"] input').count();
  if (stillEditing !== 0) await bail('session Enter commit: input still visible after commit');
}

// === Case 2: session Escape cancels ===
{
  const input = await openSessionRename('s2');
  await input.fill('should not stick');
  await input.press('Escape');
  await win.waitForTimeout(200);
  const after = await sessionName('s2');
  if (after !== 'second') await bail(`session Escape cancel: expected "second", got "${after}"`);
}

// === Case 3: empty / whitespace draft + Enter cancels (treated as no-op) ===
{
  const input = await openSessionRename('s2');
  await input.fill('   ');
  await input.press('Enter');
  await win.waitForTimeout(200);
  const after = await sessionName('s2');
  if (after !== 'second') await bail(`session whitespace Enter: expected name unchanged, got "${after}"`);
}

// === Case 4: click outside commits ===
{
  const input = await openSessionRename('s3');
  await input.fill('clicked away');
  // Click somewhere clearly outside — the new-session button at the top.
  await win.locator('aside button:has-text("New session")').first().click({ force: true });
  await win.waitForTimeout(250);
  const after = await sessionName('s3');
  if (after !== 'clicked away') await bail(`session click-outside commit: expected "clicked away", got "${after}"`);
}

// === Case 5: IME composition — Enter during isComposing must NOT commit ===
{
  const input = await openSessionRename('s1');
  // Start with empty so we can see typed composition.
  await input.fill('');
  // Manually fire compositionstart so React thinks IME is active; then a
  // keydown with isComposing=true; assert no commit; then compositionend +
  // Enter and assert commit.
  await win.evaluate(() => {
    const el = document.querySelector('li[data-session-id="s1"] input');
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  });
  // Type a candidate visually; the InlineRename's onChange fires when React
  // detects the input value has changed via its tracker. We must use the
  // native value setter, otherwise React skips the change because its
  // synthetic tracker still holds the prior value.
  await win.evaluate(() => {
    const el = document.querySelector('li[data-session-id="s1"] input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'ni hao');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Send Enter with isComposing=true; per the input's handler it should
  // bail out and NOT commit.
  await win.evaluate(() => {
    const el = document.querySelector('li[data-session-id="s1"] input');
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
      keyCode: 229
    });
    el.dispatchEvent(ev);
  });
  await win.waitForTimeout(150);
  // Store name should still be the previous committed value, NOT "ni hao".
  const midComp = await sessionName('s1');
  if (midComp !== 'first renamed') {
    await bail(`session IME composition Enter must not commit; expected "first renamed", got "${midComp}"`);
  }
  // End composition, then a normal Enter commits.
  await win.evaluate(() => {
    const el = document.querySelector('li[data-session-id="s1"] input');
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ni hao' }));
  });
  const valBefore = await win.locator('li[data-session-id="s1"] input').inputValue();
  if (valBefore !== 'ni hao') await bail(`session post-IME: input value should be "ni hao" before Enter, got "${valBefore}"`);
  await win.locator('li[data-session-id="s1"] input').focus();
  await win.locator('li[data-session-id="s1"] input').press('Enter');
  await win.waitForTimeout(200);
  const afterComp = await sessionName('s1');
  if (afterComp !== 'ni hao') {
    await bail(`session post-IME Enter commit: expected "ni hao", got "${afterComp}"`);
  }
}

// === Case 6: group Enter commits + Escape cancels ===
{
  const input = await openGroupRename('g1');
  await input.fill('Alpha+');
  await input.press('Enter');
  await win.waitForTimeout(200);
  const after = await groupName('g1');
  if (after !== 'Alpha+') await bail(`group Enter commit: expected "Alpha+", got "${after}"`);
}
{
  const input = await openGroupRename('g2');
  await input.fill('Charlie');
  await input.press('Escape');
  await win.waitForTimeout(200);
  const after = await groupName('g2');
  if (after !== 'Bravo') await bail(`group Escape cancel: expected "Bravo", got "${after}"`);
}

console.log('\n[probe-e2e-rename] OK');
console.log('  session: Enter commits / Escape cancels / whitespace cancels / click-outside commits');
console.log('  session: IME composition Enter does not commit; post-composition Enter does');
console.log('  group:   Enter commits / Escape cancels');

await app.close();
ud.cleanup();
