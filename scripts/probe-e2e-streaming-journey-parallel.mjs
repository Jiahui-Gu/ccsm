// Journey 4: parallel streams stay isolated per session.
//
// Expectation: deltas addressed to A only mutate A; deltas addressed to B
// only mutate B. Interleaved A/B/A/B/... bursts must NOT bleed across.
//
// Stress: we interleave 12 deltas (6 each) so any shared mutable streaming
// cursor in the reducer would corrupt one of them. Then finalize each and
// assert independent caret clearing.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-e2e-streaming-journey-parallel] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

const ud = isolatedUserData('agentory-probe-stream-parallel');
const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

try { // ccsm-probe-cleanup-wrap

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15_000 });

  const A = 's-par-A';
  const B = 's-par-B';
  const BID_A = 'msg-A:par';
  const BID_B = 'msg-B:par';

  await win.evaluate(([a, b]) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: a, name: 'A', state: 'idle', cwd: 'C:/x', model: 'm', groupId: 'g1', agentType: 'claude-code' },
        { id: b, name: 'B', state: 'idle', cwd: 'C:/y', model: 'm', groupId: 'g1', agentType: 'claude-code' }
      ],
      activeId: a,
      messagesBySession: {
        [a]: [{ kind: 'user', id: 'ua', text: 'A asks' }],
        [b]: [{ kind: 'user', id: 'ub', text: 'B asks' }]
      },
      startedSessions: { [a]: true, [b]: true },
      runningSessions: { [a]: true, [b]: true }
    });
  }, [A, B]);

  // Distinct chunk dictionaries so any cross-bleed is detectable.
  const A_CHUNKS = ['Aa ', 'Ab ', 'Ac ', 'Ad ', 'Ae ', 'Af '];
  const B_CHUNKS = ['Bp ', 'Bq ', 'Br ', 'Bs ', 'Bt ', 'Bu '];

  // Interleave: A0 B0 A1 B1 ... A5 B5
  for (let i = 0; i < 6; i++) {
    await win.evaluate(([sid, bid, text]) => window.__ccsmStore.getState().streamAssistantText(sid, bid, text, false), [A, BID_A, A_CHUNKS[i]]);
    await win.evaluate(([sid, bid, text]) => window.__ccsmStore.getState().streamAssistantText(sid, bid, text, false), [B, BID_B, B_CHUNKS[i]]);
  }
  await win.waitForTimeout(150);

  const aText = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid)?.text;
  }, [A, BID_A]);
  const bText = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid)?.text;
  }, [B, BID_B]);

  const wantA = A_CHUNKS.join('');
  const wantB = B_CHUNKS.join('');
  if (aText !== wantA) fail(`A text wrong: got ${JSON.stringify(aText)} want ${JSON.stringify(wantA)}`, app);
  if (bText !== wantB) fail(`B text wrong: got ${JSON.stringify(bText)} want ${JSON.stringify(wantB)}`, app);

  // Cross-bleed checks: A must contain ZERO B-chunks and vice versa.
  for (const c of B_CHUNKS) {
    if (aText.includes(c)) fail(`A's reply contains B's chunk ${JSON.stringify(c)}`, app);
  }
  for (const c of A_CHUNKS) {
    if (bText.includes(c)) fail(`B's reply contains A's chunk ${JSON.stringify(c)}`, app);
  }

  // Each session should have exactly 1 streaming assistant block (its own).
  const aBlocks = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.filter((b) => b.kind === 'assistant').map((b) => ({ id: b.id, streaming: b.streaming, text: b.text }));
  }, A);
  const bBlocks = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.filter((b) => b.kind === 'assistant').map((b) => ({ id: b.id, streaming: b.streaming, text: b.text }));
  }, B);
  if (aBlocks.length !== 1) fail(`A should have 1 assistant block, got ${aBlocks.length}: ${JSON.stringify(aBlocks)}`, app);
  if (bBlocks.length !== 1) fail(`B should have 1 assistant block, got ${bBlocks.length}: ${JSON.stringify(bBlocks)}`, app);
  if (aBlocks[0].id !== BID_A) fail(`A's only block has wrong id ${aBlocks[0].id}`, app);
  if (bBlocks[0].id !== BID_B) fail(`B's only block has wrong id ${bBlocks[0].id}`, app);
  if (!aBlocks[0].streaming || !bBlocks[0].streaming) fail('both should still be streaming pre-finalize', app);

  // Finalize A only — B should remain streaming.
  await win.evaluate(([sid, bid, text]) => {
    window.__ccsmStore.getState().appendBlocks(sid, [{ kind: 'assistant', id: bid, text }]);
    window.__ccsmStore.getState().setRunning(sid, false);
  }, [A, BID_A, wantA]);
  await win.waitForTimeout(150);

  // Switch view to A so we can confirm caret state for A is gone.
  await win.evaluate((sid) => window.__ccsmStore.setState({ activeId: sid }), A);
  await win.waitForTimeout(120);
  const caretAfterA = await win.locator('span.animate-pulse').count();
  if (caretAfterA !== 0) fail(`A's caret should be gone after finalize, found ${caretAfterA}`, app);

  // B should still be streaming in store; switch to B and confirm caret.
  const bStillStreaming = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.kind === 'assistant')?.streaming === true;
  }, B);
  if (!bStillStreaming) fail('B should still be streaming after only A was finalized', app);
  await win.evaluate((sid) => window.__ccsmStore.setState({ activeId: sid }), B);
  await win.waitForTimeout(150);
  const caretOnB = await win.locator('span.animate-pulse').count();
  if (caretOnB < 1) fail('B should still show caret', app);

  // Finalize B.
  await win.evaluate(([sid, bid, text]) => {
    window.__ccsmStore.getState().appendBlocks(sid, [{ kind: 'assistant', id: bid, text }]);
    window.__ccsmStore.getState().setRunning(sid, false);
  }, [B, BID_B, wantB]);
  await win.waitForTimeout(150);
  const caretFinal = await win.locator('span.animate-pulse').count();
  if (caretFinal !== 0) fail(`caret should be 0 after both finalize, got ${caretFinal}`, app);

  console.log('[probe-e2e-streaming-journey-parallel] OK');
  console.log('  A and B streamed interleaved, no bleed; carets cleared independently');

  await app.close();
} catch (err) {
  console.error('[probe-e2e-streaming-journey-parallel] threw:', err);
  await app.close().catch(() => {});
  process.exit(1);
} finally {
  ud.cleanup();
}
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
