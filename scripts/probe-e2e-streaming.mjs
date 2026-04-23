// MERGED INTO scripts/harness-agent.mjs (case id=streaming; see harness file).
// This per-file probe is kept as a breadcrumb. The runner skips it via MERGED_INTO_HARNESS.
// Verify streaming UX:
// - calling streamAssistantText creates an assistant block with a streaming caret
// - subsequent deltas append text in place (no duplicate blocks)
// - appendBlocks with the same id finalizes (caret disappears, text replaced)
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-streaming] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});
const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 15000 });

// Make sure there's a session selected.
const sessionId = await win.evaluate(() => {
  const s = window.__agentoryStore.getState();
  if (s.sessions.length === 0) {
    s.createSession('~/streaming-probe');
  }
  return window.__agentoryStore.getState().activeId;
});
if (!sessionId) fail('no active session id');

// Simulate streaming: 3 deltas, then a finalize via appendBlocks.
await win.evaluate((sid) => {
  const st = window.__agentoryStore.getState();
  st.streamAssistantText(sid, 'msg-probe:c0', 'Hel', false);
  st.streamAssistantText(sid, 'msg-probe:c0', 'lo, ', false);
  st.streamAssistantText(sid, 'msg-probe:c0', 'world!', false);
}, sessionId);

await new Promise((r) => setTimeout(r, 200));

const midState = await win.evaluate((sid) => {
  const blocks = window.__agentoryStore.getState().messagesBySession[sid] ?? [];
  return blocks.map((b) => ({ id: b.id, kind: b.kind, text: b.text, streaming: b.streaming }));
}, sessionId);
const streamingBlocks = midState.filter((b) => b.id === 'msg-probe:c0');
if (streamingBlocks.length !== 1) fail(`expected 1 streaming block, got ${streamingBlocks.length}`);
if (streamingBlocks[0].text !== 'Hello, world!')
  fail(`expected text 'Hello, world!', got '${streamingBlocks[0].text}'`);
if (streamingBlocks[0].streaming !== true) fail('streaming flag not set');

// Caret should be visible in the DOM.
const caretCount = await win.locator('span.animate-pulse').count();
if (caretCount < 1) fail('streaming caret not rendered in DOM');

// Finalize via appendBlocks with the same id.
await win.evaluate((sid) => {
  window.__agentoryStore.getState().appendBlocks(sid, [
    { kind: 'assistant', id: 'msg-probe:c0', text: 'Final reply.' }
  ]);
}, sessionId);

await new Promise((r) => setTimeout(r, 200));

const finalState = await win.evaluate((sid) => {
  const blocks = window.__agentoryStore.getState().messagesBySession[sid] ?? [];
  return blocks.filter((b) => b.id === 'msg-probe:c0').map((b) => ({
    text: b.text,
    streaming: b.streaming
  }));
}, sessionId);
if (finalState.length !== 1) fail(`after finalize, expected 1 block, got ${finalState.length}`);
if (finalState[0].text !== 'Final reply.')
  fail(`expected finalized text 'Final reply.', got '${finalState[0].text}'`);
if (finalState[0].streaming) fail('streaming flag should be cleared after finalize');

const finalCaretCount = await win.locator('span.animate-pulse').count();
if (finalCaretCount !== 0) fail(`caret should disappear after finalize; found ${finalCaretCount}`);

console.log('[probe-e2e-streaming] OK');
console.log('  3 deltas coalesced into 1 block; caret shown then hidden on finalize');

await app.close();
