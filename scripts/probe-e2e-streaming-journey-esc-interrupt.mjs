// Journey 2: Esc interrupts a streaming reply cleanly.
//
// Expectation (see docs/journey-streaming-expectations.md):
//   - Esc during a stream halts further deltas.
//   - A neutral "Interrupted" status block appears (role=status, NOT alert).
//   - The streaming caret on the in-flight block disappears.
//   - Composer focus returns to the textarea.
//   - Stop button replaced by Send affordance (running flips to false).
//
// We model the SDK's two-step interrupt:
//   1. Renderer Esc handler calls stop() -> markInterrupted + clearQueue +
//      window.ccsm.agentInterrupt(sid).
//   2. The SDK eventually emits a result frame that lifecycle.ts translates
//      to a "status" block + setRunning(false). We synthesize step 2 by
//      calling the same store mutators (consumeInterrupted + appendBlocks +
//      setRunning) — the lifecycle.ts contract is what we're asserting.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData, startBundleServer } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-e2e-streaming-journey-esc-interrupt] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

const { port: PORT, close: closeServer } = await startBundleServer(root);
const ud = isolatedUserData('agentory-probe-stream-esc');
const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', CCSM_DEV_PORT: String(PORT) }
});

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15_000 });

  // PR-I removed the first-run CLI dialog; the only modal we still need to
  // wait out is whatever Tutorial / etc. might be open at boot.
  await win.waitForFunction(() => document.querySelector('[role="dialog"]') === null, null, { timeout: 5000 }).catch(() => {});

  const SID = 's-esc-stream';
  const BLOCK_ID = 'msg-esc:0';

  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: sid,
        name: 'esc-stream',
        state: 'idle',
        cwd: 'C:/x',
        model: 'claude-opus-4',
        groupId: 'g1',
        agentType: 'claude-code'
      }],
      activeId: sid,
      messagesBySession: {
        [sid]: [{ kind: 'user', id: 'u-1', text: 'count 1..30' }]
      },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true }
    });
  }, SID);

  // Wait for the chat surface to mount for this session before injecting deltas.
  await win.waitForFunction((sid) => {
    return window.__ccsmStore?.getState().activeId === sid && document.querySelector('textarea') !== null;
  }, SID, { timeout: 5000 });

  // Stream first 8 chunks before Esc.
  await win.evaluate(([sid, bid]) => {
    const st = window.__ccsmStore.getState();
    for (let i = 0; i < 8; i++) st.streamAssistantText(sid, bid, `c${i} `, false);
  }, [SID, BLOCK_ID]);
  await win.waitForTimeout(150);

  // Sanity: caret pulsing, Stop button visible.
  const caretMid = await win.locator('span.animate-pulse').count();
  if (caretMid < 1) {
    const dump = await win.evaluate(([sid, bid]) => {
      const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
      const block = blocks.find((b) => b.id === bid);
      return {
        block,
        bodyText: document.body.textContent?.slice(0, 800)
      };
    }, [SID, BLOCK_ID]);
    console.error('--- diagnostic ---\n' + JSON.stringify(dump, null, 2));
    fail('caret should be pulsing while streaming', app);
  }
  const stopBtn = win.getByRole('button', { name: /^stop$/i });
  await stopBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => fail('Stop button not visible mid-stream', app));

  const midText = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid)?.text;
  }, [SID, BLOCK_ID]);

  // Park focus elsewhere so we can prove focus returns post-interrupt.
  await win.evaluate(() => {
    const ta = document.querySelector('textarea');
    if (ta) ta.blur();
    document.body.focus();
  });

  // Press Esc — InputBar's document-level handler should run stop().
  await win.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await win.waitForTimeout(200);

  const interrupted = await win.evaluate((sid) => !!window.__ccsmStore.getState().interruptedSessions[sid], SID);
  if (!interrupted) fail('interruptedSessions flag not set after Esc', app);

  // Now simulate the SDK delivering the post-interrupt result frame —
  // identical to lifecycle.ts's translation (see probe-e2e-interrupt-banner).
  await win.evaluate(([sid, bid]) => {
    const st = window.__ccsmStore.getState();
    if (!st.consumeInterrupted(sid)) throw new Error('flag not consumed');
    // Mark the in-flight block as no-longer-streaming. The product contract:
    // the lifecycle layer must finalize / clear the streaming flag for the
    // last open block when interrupt arrives. We do it via appendBlocks with
    // the same id (the established finalize contract).
    const open = (st.messagesBySession[sid] ?? []).find((b) => b.id === bid);
    if (open) {
      st.appendBlocks(sid, [{ kind: 'assistant', id: bid, text: open.text ?? '' }]);
    }
    st.appendBlocks(sid, [{ kind: 'status', id: 'res-esc', tone: 'info', title: 'Interrupted' }]);
    st.setRunning(sid, false);
  }, [SID, BLOCK_ID]);
  await win.waitForTimeout(200);

  // Streaming caret must be gone.
  const caretAfter = await win.locator('span.animate-pulse').count();
  if (caretAfter !== 0) fail(`caret still pulsing after interrupt, found ${caretAfter}`, app);

  // The in-flight block's streaming flag must be false (block defined).
  const inflight = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid);
  }, [SID, BLOCK_ID]);
  if (!inflight) fail('in-flight block disappeared after interrupt — should remain visible with partial text', app);
  if (inflight.streaming) fail('in-flight block.streaming should be false after interrupt', app);
  if (inflight.text !== midText) fail(`in-flight text changed unexpectedly. before=${JSON.stringify(midText)} after=${JSON.stringify(inflight.text)}`, app);

  // Neutral status block in DOM via role=status, NOT inside role=alert.
  await win.waitForSelector('[role="status"]', { timeout: 3000 });
  const banner = await win.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[role="status"]'));
    const el = nodes.find((n) => n.textContent?.includes('Interrupted'));
    if (!el) return { found: false };
    return {
      found: true,
      hasAlert: !!el.closest('[role="alert"]'),
      text: el.textContent
    };
  });
  if (!banner.found) fail('"Interrupted" banner not rendered with role=status', app);
  if (banner.hasAlert) fail('"Interrupted" banner is inside role=alert — should be neutral', app);

  // Stop -> Send transition. Stop button gone.
  await stopBtn.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => fail('Stop button still visible after running cleared', app));

  // Composer focus must be back on the textarea, OR at minimum the textarea
  // must be usable (focusable + accepting input). Strictly assert the active
  // element is the textarea — that's the spec.
  await win.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', null, { timeout: 2000 }).catch(async () => {
    const tag = await win.evaluate(() => document.activeElement?.tagName);
    fail(`composer focus did not return to textarea after interrupt; activeElement=${tag}`, app);
  });

  // And typing actually lands in the composer.
  await win.keyboard.type('post-int');
  const val = await win.locator('textarea').inputValue();
  if (val !== 'post-int') fail(`textarea value should be 'post-int' after typing, got ${JSON.stringify(val)}`, app);

  console.log('[probe-e2e-streaming-journey-esc-interrupt] OK');
  console.log('  Esc -> caret cleared, neutral Interrupted banner, focus back to composer');

  await app.close();
} catch (err) {
  console.error('[probe-e2e-streaming-journey-esc-interrupt] threw:', err);
  await app.close().catch(() => {});
  process.exit(1);
} finally {
  closeServer();
  ud.cleanup();
}
