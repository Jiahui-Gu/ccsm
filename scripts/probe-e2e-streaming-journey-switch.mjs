// Journey 1: stream survives a session switch and back.
//
// Expectation (see docs/journey-streaming-expectations.md):
//   Session A is mid-stream (chunks 1..10 delivered). User switches to
//   Session B. Chunks 11..30 keep arriving for A while B is on screen.
//   User switches back to A and sees the full 30-chunk reply, no torn /
//   duplicated blocks, then a finalize that clears the streaming caret.
//
// We don't spawn claude.exe — we drive the same store mutators
// (streamAssistantText / appendBlocks) the lifecycle layer drives in
// production. The point of the test is to prove that the renderer's
// store state for an inactive session keeps absorbing deltas correctly.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-e2e-streaming-journey-switch] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

const ud = isolatedUserData('agentory-probe-stream-switch');
console.log(`[probe-e2e-streaming-journey-switch] userData = ${ud.dir}`);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15_000 });

  // Seed two sessions in the same group, A active.
  await win.evaluate(() => {
    const store = window.__ccsmStore;
    store.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [
        {
          id: 's-A',
          name: 'session-A',
          state: 'idle',
          cwd: 'C:/x',
          model: 'claude-opus-4',
          groupId: 'g1',
          agentType: 'claude-code'
        },
        {
          id: 's-B',
          name: 'session-B',
          state: 'idle',
          cwd: 'C:/y',
          model: 'claude-opus-4',
          groupId: 'g1',
          agentType: 'claude-code'
        }
      ],
      activeId: 's-A',
      messagesBySession: {
        's-A': [{ kind: 'user', id: 'u-a', text: 'long reply please' }],
        's-B': [{ kind: 'user', id: 'u-b', text: 'unrelated' }]
      },
      startedSessions: { 's-A': true, 's-B': true },
      runningSessions: { 's-A': true, 's-B': false }
    });
  });

  // 30 unique chunks so we can prove every one landed.
  const CHUNKS = Array.from({ length: 30 }, (_, i) => `c${i.toString().padStart(2, '0')} `);
  const BLOCK_ID = 'msg-A-stream:0';

  // Helper to inject one delta to A.
  const inject = async (idx) => {
    await win.evaluate(
      ([sid, bid, text]) => window.__ccsmStore.getState().streamAssistantText(sid, bid, text, false),
      ['s-A', BLOCK_ID, CHUNKS[idx]]
    );
  };

  // Phase 1: deliver chunks 0..9 with A active and visible.
  for (let i = 0; i < 10; i++) await inject(i);
  await win.waitForTimeout(150);

  // Sanity: caret must be pulsing in A right now.
  const caretMid = await win.locator('span.animate-pulse').count();
  if (caretMid < 1) fail('expected streaming caret to be visible while A is mid-stream', app);

  // The block must exist with chunks 0..9 concatenated.
  const aMid = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    const matches = blocks.filter((b) => b.id === bid);
    return matches.map((b) => ({ text: b.text, streaming: b.streaming }));
  }, ['s-A', BLOCK_ID]);
  if (aMid.length !== 1) fail(`expected exactly 1 block with id ${BLOCK_ID}, got ${aMid.length}`, app);
  const expectedHalf = CHUNKS.slice(0, 10).join('');
  if (aMid[0].text !== expectedHalf) {
    fail(`mid-stream text mismatch on A: got ${JSON.stringify(aMid[0].text)} want ${JSON.stringify(expectedHalf)}`, app);
  }
  if (aMid[0].streaming !== true) fail('streaming flag should be true mid-stream', app);

  // Phase 2: switch to B. Use store mutator (matches the runtime path used
  // when sidebar click triggers selectSession). This is the moment that
  // historically breaks per-session reducers.
  await win.evaluate(() => window.__ccsmStore.setState({ activeId: 's-B' }));
  await win.waitForTimeout(150);

  // While on B, deliver chunks 10..24 to A. A is offscreen — store must
  // still absorb them.
  for (let i = 10; i < 25; i++) await inject(i);
  await win.waitForTimeout(150);

  // While on B, A must NOT have leaked into B's chat. B's user message and
  // nothing else.
  const bWhileAStreams = await win.evaluate(
    (sid) => (window.__ccsmStore.getState().messagesBySession[sid] ?? []).map((b) => ({
      kind: b.kind,
      id: b.id,
      text: b.text
    })),
    's-B'
  );
  const leakedToB = bWhileAStreams.find((b) => b.id === BLOCK_ID || (b.text ?? '').includes('c10'));
  if (leakedToB) {
    fail(`A's stream leaked into B: ${JSON.stringify(leakedToB)}`, app);
  }

  // The active view should be showing B. ChatStream renders the active
  // session's blocks; the block id BLOCK_ID belongs to A and should NOT be
  // discoverable via document text right now.
  const sawAStreamInDom = await win.evaluate(() => document.body.textContent?.includes('c14') ?? false);
  if (sawAStreamInDom) {
    fail('chunk c14 (delivered while on B) is visible in the DOM — chat is showing the wrong session', app);
  }

  // Phase 3: deliver remaining chunks 25..29, then switch back to A.
  for (let i = 25; i < 30; i++) await inject(i);
  await win.waitForTimeout(100);

  await win.evaluate(() => window.__ccsmStore.setState({ activeId: 's-A' }));
  await win.waitForTimeout(200);

  // After return, A's block must contain ALL 30 chunks contiguous, no torn
  // duplicates.
  const aFull = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    const matches = blocks.filter((b) => b.id === bid);
    return matches.map((b) => ({ text: b.text, streaming: b.streaming }));
  }, ['s-A', BLOCK_ID]);
  if (aFull.length !== 1) {
    fail(`after switch-back, expected exactly 1 block with id ${BLOCK_ID}, got ${aFull.length}`, app);
  }
  const expectedFull = CHUNKS.join('');
  if (aFull[0].text !== expectedFull) {
    fail(`full text mismatch on A after switch-back. got=${JSON.stringify(aFull[0].text)} want=${JSON.stringify(expectedFull)}`, app);
  }
  if (aFull[0].streaming !== true) fail('streaming flag should still be true (no finalize yet)', app);

  // Now the lifecycle layer would deliver a final assistant_message frame.
  // We finalize by appendBlocks with the same id (the established contract
  // exercised by probe-e2e-streaming.mjs).
  await win.evaluate(([sid, bid, text]) => {
    window.__ccsmStore.getState().appendBlocks(sid, [
      { kind: 'assistant', id: bid, text }
    ]);
    window.__ccsmStore.getState().setRunning(sid, false);
  }, ['s-A', BLOCK_ID, expectedFull]);
  await win.waitForTimeout(150);

  const aFinal = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.filter((b) => b.id === bid).map((b) => ({ text: b.text, streaming: b.streaming }));
  }, ['s-A', BLOCK_ID]);
  if (aFinal.length !== 1) fail(`after finalize, expected 1 block, got ${aFinal.length}`, app);
  if (aFinal[0].streaming) fail('streaming flag should be cleared after finalize', app);
  if (aFinal[0].text !== expectedFull) fail('finalized text mutated unexpectedly', app);

  const caretFinal = await win.locator('span.animate-pulse').count();
  if (caretFinal !== 0) fail(`caret should be gone after finalize, found ${caretFinal}`, app);

  console.log('[probe-e2e-streaming-journey-switch] OK');
  console.log(`  A absorbed all 30 chunks across a B-side detour, single block, finalize cleared caret`);

  await app.close();
} catch (err) {
  console.error('[probe-e2e-streaming-journey-switch] threw:', err);
  await app.close().catch(() => {});
  process.exit(1);
} finally {
  ud.cleanup();
}
