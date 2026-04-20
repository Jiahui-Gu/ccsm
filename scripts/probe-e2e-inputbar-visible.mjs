// Regression: a long chat (content taller than viewport) must NOT push the
// InputBar textarea off-screen. The root cause was ChatStream's scroll
// container being `flex-1` without `min-h-0` inside a `flex flex-col` main,
// so tall content blew up the flex item instead of scrolling internally.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-inputbar-visible] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);

await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 10000 });

await win.evaluate(() => {
  const store = window.__agentoryStore;
  if (!store) throw new Error('__agentoryStore not on window — dev build?');
  const many = [];
  for (let i = 0; i < 80; i++) {
    many.push({ kind: 'user', id: `u-${i}`, text: `message ${i} — ${'lorem '.repeat(12)}` });
    many.push({
      kind: 'assistant-md',
      id: `a-${i}`,
      text: `reply ${i}\n\n${'paragraph body '.repeat(20)}\n\n${'second paragraph '.repeat(15)}`
    });
  }
  store.setState({
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [
      {
        id: 's1',
        name: 's',
        state: 'idle',
        cwd: 'C:/x',
        model: 'claude-opus-4',
        groupId: 'g1',
        agentType: 'claude-code'
      }
    ],
    activeId: 's1',
    messagesBySession: { s1: many }
  });
});

await win.waitForTimeout(400);

const ta = win.locator('textarea').first();
try {
  await ta.waitFor({ state: 'visible', timeout: 3000 });
} catch {
  await app.close();
  fail('textarea not visible at all');
}

const { box, vh } = await win.evaluate(() => {
  const el = document.querySelector('textarea');
  if (!el) return { box: null, vh: window.innerHeight };
  const r = el.getBoundingClientRect();
  return { box: { top: r.top, bottom: r.bottom }, vh: window.innerHeight };
});

if (!box) { await app.close(); fail('no textarea element'); }
if (box.bottom > vh + 1) {
  await app.close();
  fail(`textarea extends below viewport: bottom=${box.bottom.toFixed(1)} vh=${vh}`);
}
if (box.top < 0 || box.top > vh) {
  await app.close();
  fail(`textarea top=${box.top.toFixed(1)} outside viewport (vh=${vh})`);
}

// Also confirm the user can actually click and type — true visibility test.
await ta.click();
await win.keyboard.type('hello');
const value = await ta.inputValue();
if (value !== 'hello') { await app.close(); fail(`type failed, got ${JSON.stringify(value)}`); }

console.log('\n[probe-e2e-inputbar-visible] OK');
console.log(`  textarea within viewport: top=${box.top.toFixed(1)} bottom=${box.bottom.toFixed(1)} vh=${vh}`);

await app.close();
