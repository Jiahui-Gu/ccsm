// Verifies the minimal empty state: "Ready when you are." is visible and the
// four starter prompt cards are GONE (regression guard against reintroducing
// them). A fresh session shouldn't tell the user what to do — they know.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-empty-state-minimal] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', CCSM_PROD_BUNDLE: '1' }
});

try { // ccsm-probe-cleanup-wrap

const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 10000 });
await win.waitForTimeout(800);

// PR-I removed the first-run binary picker. The installer-corrupt banner is
// the only failure surface left; on a healthy install it stays hidden, which
// is what we assert below.
const installerCorrupt = await win.evaluate(
  () => window.__ccsmStore.getState().installerCorrupt
);
if (installerCorrupt) {
  await app.close();
  fail('installerCorrupt flag was set on cold launch — install pipeline is broken');
}

await win.evaluate(() => {
  window.__ccsmStore.setState({
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
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

// Starter cards must NOT appear. Their titles came from the old implementation.
for (const removed of ['Explain this codebase', 'Find and fix a bug', 'Add tests', 'Refactor for clarity']) {
  const n = await win.getByText(removed, { exact: false }).count();
  if (n > 0) { await app.close(); fail(`starter card "${removed}" still rendered (count=${n})`); }
}

// Working in <dir> line also gone.
const workingIn = await win.getByText(/Working in /i).count();
if (workingIn > 0) { await app.close(); fail('old "Working in …" line still rendered'); }

console.log('\n[probe-e2e-empty-state-minimal] OK');
console.log('  hero visible, no starter cards, no "Working in" line');
console.log('  installerCorrupt flag stayed false on cold launch');

await app.close();
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
