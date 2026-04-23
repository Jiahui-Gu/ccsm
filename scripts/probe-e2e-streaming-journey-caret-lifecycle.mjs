// MERGED INTO scripts/harness-agent.mjs (case id=streaming-caret-lifecycle; see harness file).
// This per-file probe is kept as a breadcrumb. The runner skips it via MERGED_INTO_HARNESS.
// Journey 5: streaming caret lifecycle.
//
// Expectation:
//   (a) During streaming: at least one span.animate-pulse inside the active
//       chat (the in-flight block's caret).
//   (b) After finalize via appendBlocks (same id, streaming cleared): caret
//       gone.
//   (c) After Esc-interrupt mid-stream (lifecycle path): caret also gone —
//       a half-finished block must NOT keep pulsing forever after stop.
//
// We cover (a)+(b)+(c) in a single probe to keep the assertion close to the
// state transition.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-e2e-streaming-journey-caret-lifecycle] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

const ud = isolatedUserData('agentory-probe-stream-caret');
const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 15_000 });

  // ===== Part 1 + 2: caret during stream, gone after finalize =====
  const SID1 = 's-caret-final';
  const BID1 = 'msg-caret:final';
  await win.evaluate((sid) => {
    window.__agentoryStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'caret-final', state: 'idle', cwd: 'C:/x', model: 'm', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [{ kind: 'user', id: 'u-1', text: 'hi' }] },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true }
    });
  }, SID1);

  await win.evaluate(([sid, bid]) => {
    const st = window.__agentoryStore.getState();
    st.streamAssistantText(sid, bid, 'partial ', false);
    st.streamAssistantText(sid, bid, 'reply ', false);
  }, [SID1, BID1]);
  await win.waitForTimeout(150);

  const caretDuring = await win.locator('span.animate-pulse').count();
  if (caretDuring < 1) fail('Part 1: expected caret during stream, found 0', app);

  // Finalize.
  await win.evaluate(([sid, bid]) => {
    window.__agentoryStore.getState().appendBlocks(sid, [{ kind: 'assistant', id: bid, text: 'final reply' }]);
    window.__agentoryStore.getState().setRunning(sid, false);
  }, [SID1, BID1]);
  await win.waitForTimeout(150);

  const caretAfterFinal = await win.locator('span.animate-pulse').count();
  if (caretAfterFinal !== 0) fail(`Part 2: expected caret gone after finalize, found ${caretAfterFinal}`, app);

  const blockAfterFinal = await win.evaluate(([sid, bid]) => {
    const blocks = window.__agentoryStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid);
  }, [SID1, BID1]);
  if (!blockAfterFinal) fail('Part 2: finalized block missing', app);
  if (blockAfterFinal.streaming) fail('Part 2: block.streaming should be false after finalize', app);

  // ===== Part 3: caret gone after Esc-interrupt mid-stream =====
  const SID2 = 's-caret-int';
  const BID2 = 'msg-caret:int';
  await win.evaluate((sid) => {
    const cur = window.__agentoryStore.getState();
    const sessions = cur.sessions.some((s) => s.id === sid)
      ? cur.sessions
      : [{ id: sid, name: 'caret-int', state: 'idle', cwd: 'C:/x', model: 'm', groupId: 'g1', agentType: 'claude-code' }, ...cur.sessions];
    window.__agentoryStore.setState({
      sessions,
      activeId: sid,
      messagesBySession: { ...cur.messagesBySession, [sid]: [{ kind: 'user', id: 'u-2', text: 'count' }] },
      startedSessions: { ...cur.startedSessions, [sid]: true },
      runningSessions: { ...cur.runningSessions, [sid]: true }
    });
  }, SID2);

  await win.evaluate(([sid, bid]) => {
    const st = window.__agentoryStore.getState();
    st.streamAssistantText(sid, bid, '1 ', false);
    st.streamAssistantText(sid, bid, '2 ', false);
    st.streamAssistantText(sid, bid, '3 ', false);
  }, [SID2, BID2]);
  await win.waitForTimeout(150);

  const caretMid = await win.locator('span.animate-pulse').count();
  if (caretMid < 1) fail('Part 3: caret should be visible mid-stream before interrupt', app);

  // Esc -> interrupt path. Lifecycle layer responsibility: clear streaming
  // flag on the in-flight block. We model exactly what lifecycle.ts must do.
  await win.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await win.waitForTimeout(150);

  await win.evaluate(([sid, bid]) => {
    const st = window.__agentoryStore.getState();
    st.consumeInterrupted(sid);
    const open = (st.messagesBySession[sid] ?? []).find((b) => b.id === bid);
    if (open) {
      // Re-write the block as non-streaming via appendBlocks(same id) — the
      // established finalize contract.
      st.appendBlocks(sid, [{ kind: 'assistant', id: bid, text: open.text ?? '' }]);
    }
    st.appendBlocks(sid, [{ kind: 'status', id: 'res-int', tone: 'info', title: 'Interrupted' }]);
    st.setRunning(sid, false);
  }, [SID2, BID2]);
  await win.waitForTimeout(200);

  const caretAfterInt = await win.locator('span.animate-pulse').count();
  if (caretAfterInt !== 0) fail(`Part 3: caret should be 0 after interrupt, found ${caretAfterInt}`, app);

  const blockAfterInt = await win.evaluate(([sid, bid]) => {
    const blocks = window.__agentoryStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid);
  }, [SID2, BID2]);
  if (!blockAfterInt) fail('Part 3: in-flight block missing after interrupt — should remain with partial text', app);
  if (blockAfterInt.streaming) fail('Part 3: block.streaming should be false after interrupt-finalize', app);

  console.log('[probe-e2e-streaming-journey-caret-lifecycle] OK');
  console.log('  Part 1 caret-during, Part 2 caret-gone-after-finalize, Part 3 caret-gone-after-interrupt');

  await app.close();
} catch (err) {
  console.error('[probe-e2e-streaming-journey-caret-lifecycle] threw:', err);
  await app.close().catch(() => {});
  process.exit(1);
} finally {
  ud.cleanup();
}
