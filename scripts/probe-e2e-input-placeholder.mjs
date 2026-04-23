// MERGED INTO scripts/harness-agent.mjs (case id=input-placeholder; see harness file).
// This per-file probe is kept as a breadcrumb. The runner skips it via MERGED_INTO_HARNESS.
// Empty session -> placeholder is "Ask anything…" (not "Reply…").
// With messages -> placeholder becomes "Reply…".
// Robustness extensions:
//   - Switching i18n language (zh) flips the placeholder to the zh string.
//   - After a long message stream, the placeholder still updates correctly
//     when the running flag toggles (Running… <-> Reply…).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-input-placeholder] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, NODE_ENV: 'development' } });
const win = await appWindow(app);
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

// --- Robustness #1: long message stream then running toggle ---
// Stuff the session with 200 blocks (mix of user / assistant) to mirror what
// users see after a long agent run. Placeholder logic must not regress on
// large arrays.
await win.evaluate(() => {
  const many = [];
  for (let i = 0; i < 200; i++) {
    many.push({ kind: i % 2 ? 'assistant' : 'user', id: `b-${i}`, text: `block ${i}` });
  }
  window.__agentoryStore.setState({ messagesBySession: { s1: many } });
});
await win.waitForTimeout(200);
const longReplyPh = await ta.getAttribute('placeholder');
if (longReplyPh !== 'Reply…') {
  await app.close();
  fail(`after long stream, placeholder should still be "Reply…", got ${JSON.stringify(longReplyPh)}`);
}

// Flip running on -> placeholder becomes the running string.
await win.evaluate(() => {
  window.__agentoryStore.getState().setRunning('s1', true);
});
await win.waitForTimeout(150);
const runningPh = await ta.getAttribute('placeholder');
if (!runningPh || !runningPh.includes('Esc')) {
  await app.close();
  fail(`running placeholder should mention Esc, got ${JSON.stringify(runningPh)}`);
}
// Flip back off.
await win.evaluate(() => {
  window.__agentoryStore.getState().setRunning('s1', false);
});
await win.waitForTimeout(150);
const backToReply = await ta.getAttribute('placeholder');
if (backToReply !== 'Reply…') {
  await app.close();
  fail(`after running off, placeholder should return to "Reply…", got ${JSON.stringify(backToReply)}`);
}

// --- Robustness #2: switch language to zh, placeholder must localize ---
// src/i18n/index.ts exposes the i18next singleton on window.__agentoryI18n
// (unconditional, not gated on NODE_ENV) so probes can flip language without
// going through the React hook tree.
const switched = await win.evaluate(async () => {
  // Wait briefly for the singleton to appear (i18n init runs at module load).
  for (let i = 0; i < 20 && !window.__agentoryI18n; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!window.__agentoryI18n) return { ok: false, err: 'window.__agentoryI18n missing' };
  await window.__agentoryI18n.changeLanguage('zh');
  return { ok: true, lang: window.__agentoryI18n.language };
});
if (!switched.ok) {
  console.log(`  [skip] could not switch language dynamically: ${switched.err}`);
} else {
  // After language change, the placeholder should be the zh string.
  // For an empty session the zh placeholder is "问点什么…", with-messages is
  // "回复…". Our session currently has 200 messages so we expect "回复…".
  await win.waitForTimeout(200);
  const zhPlaceholder = await ta.getAttribute('placeholder');
  if (zhPlaceholder !== '回复…') {
    await app.close();
    fail(`after switching to zh, with-messages placeholder should be "回复…", got ${JSON.stringify(zhPlaceholder)}`);
  }
  // Empty session zh check.
  await win.evaluate(() => window.__agentoryStore.setState({ messagesBySession: { s1: [] } }));
  await win.waitForTimeout(150);
  const zhEmpty = await ta.getAttribute('placeholder');
  if (zhEmpty !== '问点什么…') {
    await app.close();
    fail(`after switching to zh, empty placeholder should be "问点什么…", got ${JSON.stringify(zhEmpty)}`);
  }
  // Restore english so the probe leaves no global side-effects (defensive —
  // the app instance closes immediately after, but if anyone composes
  // probes this prevents bleed-through).
  await win.evaluate(async () => {
    if (window.__agentoryI18n) await window.__agentoryI18n.changeLanguage('en');
  });
}

console.log('\n[probe-e2e-input-placeholder] OK');
console.log('  empty: "Ask anything…"  with-messages: "Reply…"');
console.log('  long stream + running toggle: placeholder stays correct');
if (switched.ok) console.log('  zh: "问点什么…" / "回复…"');
await app.close();
