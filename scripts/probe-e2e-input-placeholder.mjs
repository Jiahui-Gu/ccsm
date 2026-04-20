// Empty session -> placeholder is "Ask anything…" (not "Reply…").
// With messages -> placeholder becomes "Reply…".
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-input-placeholder] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, NODE_ENV: 'development' } });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 10000 });

await win.evaluate(() => {
  window.__agentoryStore.setState({
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
    activeId: 's1',
    messagesBySession: {}
  });
});
await win.waitForTimeout(300);

const ta = win.locator('textarea');
await ta.waitFor({ state: 'visible', timeout: 5000 });
const emptyPlaceholder = await ta.getAttribute('placeholder');
if (emptyPlaceholder !== 'Ask anything…') {
  await app.close();
  fail(`empty-session placeholder should be "Ask anything…", got ${JSON.stringify(emptyPlaceholder)}`);
}

await win.evaluate(() => {
  window.__agentoryStore.setState({
    messagesBySession: { s1: [{ kind: 'user', id: 'u1', text: 'hi' }] }
  });
});
await win.waitForTimeout(200);
const replyPlaceholder = await ta.getAttribute('placeholder');
if (replyPlaceholder !== 'Reply…') {
  await app.close();
  fail(`with-messages placeholder should be "Reply…", got ${JSON.stringify(replyPlaceholder)}`);
}

console.log('\n[probe-e2e-input-placeholder] OK');
console.log('  empty: "Ask anything…"  with-messages: "Reply…"');
await app.close();
