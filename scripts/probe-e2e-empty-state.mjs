// E2E: fresh session shows an empty state (not a blank pane) and the
// starter-prompt chips fill the InputBar textarea.
//
// Fixture: seed a single session directly into the store via
// window.__agentoryStore so we don't depend on SDK / spawn.
//
// What we verify:
//   1. With a session selected and no messages yet, the empty-state
//      hero ("Ready when you are.") is visible and all four starter
//      prompt cards render.
//   2. Clicking the first prompt card fills the textarea with the
//      prompt body (>20 chars sanity) and the textarea is focused.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-empty-state] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);

await win.evaluate(() => {
  const store = window.__agentoryStore;
  if (!store) throw new Error('__agentoryStore not on window — dev build?');
  store.setState({
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [
      {
        id: 's1',
        name: 'fresh',
        state: 'idle',
        cwd: 'C:/Users/jiahuigu/projects/agentory-next',
        model: 'claude-opus-4',
        groupId: 'g1',
        agentType: 'claude-code'
      }
    ],
    activeId: 's1',
    messagesBySession: {}
  });
});

await win.waitForTimeout(300);

const hero = win.getByText(/Ready when you are\./i);
try {
  await hero.first().waitFor({ state: 'visible', timeout: 5000 });
} catch {
  await app.close();
  fail('empty-state hero "Ready when you are." not visible');
}

const cards = win.locator('button').filter({ hasText: /Explain this codebase|Find and fix a bug|Add tests|Refactor for clarity/ });
const count = await cards.count();
if (count < 4) { await app.close(); fail(`expected 4 starter cards, got ${count}`); }

await cards.first().click();
await win.waitForTimeout(200);

const value = await win.locator('textarea').first().inputValue();
if (!value || value.length < 20) {
  await app.close();
  fail(`textarea did not fill from starter card click (got ${JSON.stringify(value)})`);
}

const focused = await win.evaluate(() => document.activeElement?.tagName === 'TEXTAREA');
if (!focused) { await app.close(); fail('textarea not focused after starter click'); }

console.log('\n[probe-e2e-empty-state] OK');
console.log('  empty-state visible; 4 starter cards render; first card fills + focuses textarea');

await app.close();
