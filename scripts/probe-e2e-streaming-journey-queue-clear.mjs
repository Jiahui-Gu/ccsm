// Journey 3: Esc clears the message queue (3-deep, not just 1).
//
// Expectation: while running, queue 3 messages -> chip "+3 queued". Press
// Esc -> running interrupted AND messageQueues[sid] is emptied (chip gone).
//
// The 3-deep variant is what we care about: probe-e2e-esc-interrupt only
// validates 1 queued message; a regression that drops only the head (or
// dequeues one and clears the rest) would be missed there.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-e2e-streaming-journey-queue-clear] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

const ud = isolatedUserData('agentory-probe-stream-queueclear');
const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15_000 });

  const SID = 's-qclear';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: sid,
        name: 'queue-clear',
        state: 'idle',
        cwd: 'C:/x',
        model: 'claude-opus-4',
        groupId: 'g1',
        agentType: 'claude-code'
      }],
      activeId: sid,
      messagesBySession: {
        [sid]: [
          { kind: 'user', id: 'u-1', text: 'first turn' },
          { kind: 'assistant', id: 'a-1', text: 'streaming reply...' }
        ]
      },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true }
    });
  }, SID);

  const stopBtn = win.getByRole('button', { name: /^stop$/i });
  await stopBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => fail('Stop button missing — running not rendered', app));

  // Enqueue 3 messages via the store API (production code path; UI typing is
  // already covered by probe-e2e-msg-queue.mjs).
  const queueWanted = ['queued one', 'queued two', 'queued three'];
  await win.evaluate(([sid, msgs]) => {
    const st = window.__ccsmStore.getState();
    for (const m of msgs) st.enqueueMessage(sid, { text: m, attachments: [] });
  }, [SID, queueWanted]);
  await win.waitForTimeout(150);

  const chip = win.getByText(/\+3 queued/);
  await chip.waitFor({ state: 'visible', timeout: 3000 }).catch(() => fail('"+3 queued" chip never appeared', app));

  const preEscQueue = await win.evaluate(
    (sid) => (window.__ccsmStore.getState().messageQueues[sid] ?? []).map((m) => m.text),
    SID
  );
  if (JSON.stringify(preEscQueue) !== JSON.stringify(queueWanted)) {
    fail(`pre-Esc queue mismatch: got ${JSON.stringify(preEscQueue)}`, app);
  }

  // Press Esc.
  await win.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await win.waitForTimeout(250);

  const postEsc = await win.evaluate((sid) => {
    const st = window.__ccsmStore.getState();
    return {
      interrupted: !!st.interruptedSessions[sid],
      queueLen: (st.messageQueues[sid] ?? []).length,
      queueDump: (st.messageQueues[sid] ?? []).map((m) => m.text)
    };
  }, SID);
  if (!postEsc.interrupted) fail('interruptedSessions flag not set after Esc', app);
  if (postEsc.queueLen !== 0) {
    fail(`queue should be EMPTY after Esc, got len=${postEsc.queueLen}, contents=${JSON.stringify(postEsc.queueDump)}`, app);
  }

  // Chip must be gone.
  await chip.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => fail('"+3 queued" chip still visible after Esc', app));

  // No partial chips either (e.g. "+2 queued" if only head was dropped).
  for (const n of [1, 2]) {
    const remaining = win.getByText(new RegExp(`\\+${n} queued`));
    if (await remaining.count() > 0) {
      fail(`unexpected "+${n} queued" chip visible after Esc — partial drop, not full clear`, app);
    }
  }

  console.log('[probe-e2e-streaming-journey-queue-clear] OK');
  console.log('  3 enqueues -> chip +3 queued; Esc -> queue empty + chip gone');

  await app.close();
} catch (err) {
  console.error('[probe-e2e-streaming-journey-queue-clear] threw:', err);
  await app.close().catch(() => {});
  process.exit(1);
} finally {
  ud.cleanup();
}
