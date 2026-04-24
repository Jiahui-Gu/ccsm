// Verifies the minimal empty state: "Ready when you are." is visible and the
// four starter prompt cards are GONE (regression guard against reintroducing
// them). A fresh session shouldn't tell the user what to do — they know.
//
// Also guards: on automatic startup detection of Claude CLI, the success
// flash "Claude CLI detected" must NOT appear. That modal blip on every
// launch was noise — the success pane is reserved for in-dialog Retry/Browse
// feedback when the CLI was previously missing.
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
  env: { ...process.env, NODE_ENV: 'development' }
});

const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 10000 });

// Wait for the startup CLI check to settle (state leaves 'checking'). If the
// regression returns, the success flash pops here — give it a real chance to
// appear before we assert absence.
await win.waitForFunction(
  () => window.__ccsmStore.getState().cliStatus.state !== 'checking',
  null,
  { timeout: 10000 }
).catch(() => { /* fall through — assertion below will catch a stuck state if relevant */ });
await win.waitForTimeout(800);

const cliState = await win.evaluate(() => window.__ccsmStore.getState().cliStatus.state);
if (cliState === 'found') {
  // Only assert absence when CLI was actually detected — if CLI is genuinely
  // missing on this machine, the wizard is supposed to be visible and we
  // should not flag that as a regression.
  for (const phrase of ['Claude CLI detected', '已检测到 Claude CLI']) {
    const n = await win.getByText(phrase, { exact: false }).count();
    if (n > 0) {
      await app.close();
      fail(`startup success flash "${phrase}" leaked on automatic launch (count=${n}) — should only show after manual Retry/Browse from missing dialog`);
    }
  }
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
console.log('  no startup "Claude CLI detected" flash');

await app.close();
