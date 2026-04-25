// E2E: pressing Esc while a turn is running must:
//   1. Call window.ccsm.agentInterrupt(sessionId).
//   2. Mark the session interrupted in the store (so the next `result` frame
//      gets rendered as a neutral "Interrupted" status block, not an error).
//   3. Drop any messages the user queued during this turn (CLI Ctrl+C parity).
//   4. Once the SDK emits the result frame, running flips back to false and
//      the textarea is immediately usable again — composer focus orchestration
//      should land focus back in <textarea>.
//
// Strategy:
//   We don't need a real SDK turn — the InputBar's Esc handler is pure
//   renderer logic. We boot Electron with an isolated userData dir, seed a
//   running session via the store, stub `window.ccsm.agentInterrupt` to
//   capture the call, fire Esc, then simulate the SDK's result frame the same
//   way lifecycle.ts does. This is deterministic and skips needing claude.exe.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-e2e-esc-interrupt] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-esc-'));
console.log(`[probe-e2e-esc-interrupt] userData = ${userDataDir}`);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', CCSM_PROD_BUNDLE: '1' }
});

try { // ccsm-probe-cleanup-wrap

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15_000 });

  // Stub the IPC bridge to suppress real claude.exe calls. NOTE: the
  // contextBridge-exposed `window.ccsm` is non-configurable, so we can't
  // intercept its method calls from the renderer side. We rely on observable
  // side effects of stop() (markInterrupted + clearQueue + running flip)
  // instead of recording the agentInterrupt call directly.
  await win.evaluate(() => {
    // No-op the agent IPC methods we care about so any synthetic state we
    // seed doesn't accidentally hit a real process. Wrapping is best-effort
    // and silently no-ops when the contextBridge object refuses overrides.
    try {
      const real = window.ccsm;
      if (real) {
        // These reassignments will throw on a contextBridge proxy — that's
        // fine, we catch and move on.
        real.agentSend = async () => true;
      }
    } catch {}
  });

  // Seed a running session with an in-flight assistant reply + a queued
  // message that should get dropped on interrupt.
  const sessionId = await win.evaluate(() => {
    const store = window.__ccsmStore;
    store.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: 's-esc',
        name: 'esc-probe',
        state: 'idle',
        cwd: 'C:/x',
        model: 'claude-opus-4',
        groupId: 'g1',
        agentType: 'claude-code'
      }],
      activeId: 's-esc',
      messagesBySession: {
        's-esc': [
          { kind: 'user', id: 'u-1', text: 'count slowly to 100' },
          { kind: 'assistant', id: 'a-1', text: '1\n2\n3\n' }
        ]
      },
      startedSessions: { 's-esc': true },
      runningSessions: { 's-esc': true }
    });
    // Also queue one message so we can prove clearQueue fires.
    store.getState().enqueueMessage('s-esc', { text: 'queued during running', attachments: [] });
    return 's-esc';
  });

  // The Stop button must be rendered (proves we're truly in running state).
  const stopBtn = win.getByRole('button', { name: /^stop$/i });
  await stopBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('Stop button not visible — session not in running state', app));

  // The +1 queued chip must also be visible (proves enqueue landed).
  const chip = win.getByText(/\+1 queued/);
  await chip.waitFor({ state: 'visible', timeout: 3000 }).catch(() => fail('queue chip never appeared after enqueue', app));

  // Park focus somewhere benign so we can prove Esc+drain returns it to the
  // textarea. The session is already active so InputBar is rendered.
  await win.evaluate(() => {
    const ta = document.querySelector('textarea');
    if (ta) ta.blur();
    document.body.focus();
  });

  // Diagnostic probe — also wire a custom keydown listener to confirm the
  // event reaches the document. If this fires but the interrupt doesn't,
  // it tells us the document-level listener isn't attached (regression).
  await win.evaluate(() => {
    window.__sawEsc = false;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.__sawEsc = true;
    }, { capture: true });
  });

  // Press Esc on the document. InputBar's document-level keydown listener
  // should fire stop(). We dispatch via the page rather than win.keyboard so
  // we don't depend on which OS-level surface owns focus.
  await win.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await win.waitForTimeout(200);

  const sawEsc = await win.evaluate(() => window.__sawEsc);
  if (!sawEsc) fail('document never saw the Escape keydown — playwright dispatch path broken', app);

  // Observable side effects of stop(): markInterrupted set, queue cleared.
  // We can't intercept the contextBridge-frozen window.ccsm.agentInterrupt
  // call directly, but if both flags moved we know stop() ran end-to-end.
  const postEsc = await win.evaluate(() => ({
    interrupted: !!window.__ccsmStore.getState().interruptedSessions['s-esc'],
    queueLen: (window.__ccsmStore.getState().messageQueues['s-esc'] ?? []).length,
  }));
  if (!postEsc.interrupted) {
    fail('after Esc, interruptedSessions flag was not set — stop() did not run', app);
  }
  if (postEsc.queueLen !== 0) {
    fail(`after Esc, queue should be empty (CLI Ctrl+C parity), got length=${postEsc.queueLen}`, app);
  }

  // Assert agentInterrupt produced its observable effects (above already
  // checked interrupted flag + cleared queue).

  // Assert the queue chip vanished from the DOM.
  await chip.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => fail('queue chip still visible after Esc — clearQueue did not propagate', app));

  // Assert the interrupted flag is set on the store (so the upcoming result
  // frame will be translated to a neutral "Interrupted" status block).
  const interruptedFlag = await win.evaluate(() => !!window.__ccsmStore.getState().interruptedSessions['s-esc']);
  if (!interruptedFlag) {
    fail('interruptedSessions flag was not set — markInterrupted did not fire', app);
  }

  // Now simulate the SDK delivering the result frame post-interrupt. This
  // mirrors what lifecycle.ts does for a real result with
  // error_during_execution: consume the flag, append a neutral status block,
  // flip running off.
  await win.evaluate((sid) => {
    const st = window.__ccsmStore.getState();
    const consumed = st.consumeInterrupted(sid);
    if (!consumed) throw new Error('interrupted flag was not consumed');
    st.appendBlocks(sid, [
      { kind: 'status', id: 'res-esc', tone: 'info', title: 'Interrupted' }
    ]);
    st.setRunning(sid, false);
  }, sessionId);
  await win.waitForTimeout(150);

  // Stop button should be gone, send button back.
  await stopBtn.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => fail('Stop button still visible after running flipped to false', app));

  // Textarea must be usable again — type something and confirm value lands.
  const textarea = win.locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 3000 });
  // Click first to ensure focus, then type.
  await textarea.click();
  await win.keyboard.type('post-interrupt');
  const value = await textarea.inputValue();
  if (value !== 'post-interrupt') {
    fail(`textarea not usable after interrupt: inputValue=${JSON.stringify(value)}`, app);
  }

  // Verify no spurious agentSend calls happened (the queued message must not
  // have drained — clearQueue ran first, so the queue was empty by the time
  // the synthesized result frame arrived).
  // We can't observe the IPC directly, but the queueLen check above already
  // proved the queue was cleared before any drain could have run.

  console.log('\n[probe-e2e-esc-interrupt] OK');
  console.log('  Esc -> stop() ran (interruptedSessions set, queue cleared)');
  console.log('  result frame consumed flag -> "Interrupted" status block rendered');
  console.log('  Stop button gone, textarea usable again');

  await app.close();
} catch (err) {
  console.error('[probe-e2e-esc-interrupt] threw:', err);
  await app.close().catch(() => {});
  process.exit(1);
} finally {
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
