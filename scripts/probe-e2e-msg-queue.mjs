// E2E: queue 3 messages while a turn is running, then drain them in FIFO
// order. Existing probe-e2e-input-queue.mjs covers the 1-message happy path
// against a real claude.exe. This probe focuses on the 3-deep ordering
// contract, which is the part most likely to regress silently if the queue
// ever switches from array push/shift to something fancier (Set, debounced
// bag, etc).
//
// Pure renderer-side test: we drive the InputBar to do the 3 enqueues via
// real keyboard input (proves the InputBar's running-state branch routes to
// enqueueMessage), then exercise the dequeue contract by calling the store's
// public dequeueMessage one head at a time and asserting the chip count +
// FIFO order. The IPC-side drain (lifecycle.ts) is covered by
// probe-e2e-input-queue.mjs against a real SDK.
//
// Why we don't intercept window.ccsm: contextBridge.exposeInMainWorld
// freezes the surface, so renderer-side reassignment doesn't take. Observable
// store state is the contract that matters here.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-e2e-msg-queue] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-queue-'));
console.log(`[probe-e2e-msg-queue] userData = ${userDataDir}`);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

try { // ccsm-probe-cleanup-wrap

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15_000 });

  // Seed a started + running session so the first Enter goes to the queue
  // (InputBar.send() routes to enqueueMessage when running).
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: 's-q',
        name: 'queue-probe',
        state: 'idle',
        cwd: 'C:/x',
        model: 'claude-opus-4',
        groupId: 'g1',
        agentType: 'claude-code'
      }],
      activeId: 's-q',
      messagesBySession: {
        's-q': [
          { kind: 'user', id: 'u-0', text: 'first turn' },
          { kind: 'assistant', id: 'a-0', text: 'starting…' }
        ]
      },
      startedSessions: { 's-q': true },
      runningSessions: { 's-q': true }
    });
  });

  const textarea = win.locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 5000 });

  // Stop button visible — sanity check we're rendering the running state.
  const stopBtn = win.getByRole('button', { name: /^stop$/i });
  await stopBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => fail('Stop button missing — running state did not render', app));

  // Type + Enter three times. Each Enter must enqueue, not call agentSend.
  // We use the real keyboard path so we exercise InputBar.send()'s running
  // branch (which is the bit most prone to regression).
  // Enqueue 3 messages via the real UI keyboard path. We use
  // pressSequentially (single chars with React commits between) instead of
  // textarea.fill — the latter races with React's controlled-component reset
  // of the previous iteration's enqueue/clear cycle and ends up dropping or
  // concatenating messages. This is the production-like path: user types,
  // hits Enter, types again.
  const messages = ['queued one', 'queued two', 'queued three'];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const want = i + 1;
    // Wait for the composer to be empty before typing the next message.
    // The first iteration starts empty; later iterations need React to have
    // committed the post-enqueue clear from the previous loop.
    await win.waitForFunction(() => (document.querySelector('textarea')?.value ?? '') === '', null, { timeout: 3000 }).catch(() => {});
    await textarea.click();
    await textarea.fill(msg);
    // Sanity diagnostic: confirm the value landed AND running is still true.
    await win.waitForFunction((m) => document.querySelector('textarea')?.value === m, msg, { timeout: 2000 }).catch(async () => {
      const v = await win.evaluate(() => document.querySelector('textarea')?.value);
      fail(`pre-Enter textarea value mismatch: got ${JSON.stringify(v)} want ${JSON.stringify(msg)}`, app);
    });
    const running = await win.evaluate(() => !!window.__ccsmStore.getState().runningSessions['s-q']);
    if (!running) fail('running flag false at iteration ' + i, app);
    await textarea.press('Enter');
    await win.waitForFunction(
      (n) => (window.__ccsmStore.getState().messageQueues['s-q'] ?? []).length === n,
      want,
      { timeout: 3000 }
    ).catch(async () => {
      const len = await win.evaluate(() => (window.__ccsmStore.getState().messageQueues['s-q'] ?? []).length);
      const dump = await win.evaluate(() => (window.__ccsmStore.getState().messageQueues['s-q'] ?? []).map((m) => m.text));
      fail(`enqueue #${want} did not advance queue length (got ${len}, queue=${JSON.stringify(dump)})`, app);
    });
    // Wait for the composer to clear before typing the next message.
    await win.waitForFunction(() => (document.querySelector('textarea')?.value ?? '') === '', null, { timeout: 2000 }).catch(() => {});
  }

  // Chip text uses i18n format `+{{count}} queued`. Match the count.
  const chip = win.getByText(/\+3 queued/);
  await chip.waitFor({ state: 'visible', timeout: 3000 }).catch(async () => {
    const queueDump = await win.evaluate(() => window.__ccsmStore.getState().messageQueues);
    console.error('--- queue state ---\n' + JSON.stringify(queueDump, null, 2));
    fail('"+3 queued" chip never appeared after 3 Enters', app);
  });

  // Confirm queue order in the store matches insertion order.
  const queuedTexts = await win.evaluate(() =>
    (window.__ccsmStore.getState().messageQueues['s-q'] ?? []).map((m) => m.text)
  );
  if (JSON.stringify(queuedTexts) !== JSON.stringify(messages)) {
    fail(`queue order wrong after 3 Enters: got ${JSON.stringify(queuedTexts)}, want ${JSON.stringify(messages)}`, app);
  }

  // Composer should be empty after each enqueue.
  const composerValue = await textarea.inputValue();
  if (composerValue !== '') {
    fail(`composer should be empty after enqueue, got ${JSON.stringify(composerValue)}`, app);
  }

  // Drain head one at a time using the store's public dequeueMessage.
  // Assert FIFO order + chip count drops in lockstep.
  for (let i = 0; i < 3; i++) {
    const head = await win.evaluate(() => window.__ccsmStore.getState().dequeueMessage('s-q'));
    if (!head) fail(`dequeue #${i + 1} returned null — queue ran dry early`, app);
    if (head.text !== messages[i]) {
      fail(`dequeue #${i + 1} popped wrong message: got "${head.text}", expected "${messages[i]}"`, app);
    }
    await win.waitForTimeout(80);
    const remaining = await win.evaluate(() => (window.__ccsmStore.getState().messageQueues['s-q'] ?? []).length);
    const expectRemaining = 3 - i - 1;
    if (remaining !== expectRemaining) {
      fail(`after dequeue #${i + 1}, queue length should be ${expectRemaining}, got ${remaining}`, app);
    }
    // Chip should reflect remaining count: +N queued (or hidden when 0).
    if (expectRemaining > 0) {
      const partial = win.getByText(new RegExp(`\\+${expectRemaining} queued`));
      await partial.waitFor({ state: 'visible', timeout: 1500 }).catch(
        () => fail(`chip should show "+${expectRemaining} queued" after dequeue #${i + 1}`, app)
      );
    }
  }

  // After all 3 drains the queue must be empty.
  const finalQueue = await win.evaluate(() => window.__ccsmStore.getState().messageQueues['s-q']);
  if (finalQueue && finalQueue.length > 0) {
    fail(`queue not empty after 3 dequeues: ${JSON.stringify(finalQueue)}`, app);
  }

  // Chip should be gone (queueLength 0 hides the chip per InputBar render).
  await chip.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => fail('queue chip still visible after final dequeue', app));

  console.log('\n[probe-e2e-msg-queue] OK');
  console.log('  3 Enter-presses during running -> chip "+3 queued"');
  console.log('  dequeueMessage popped FIFO: ' + messages.join(' -> '));
  console.log('  chip count tracked dequeues, hidden when empty');

  await app.close();
} catch (err) {
  console.error('[probe-e2e-msg-queue] threw:', err);
  await app.close().catch(() => {});
  process.exit(1);
} finally {
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
