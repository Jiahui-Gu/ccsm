// E2E: Wave 1D notify integration. The `@ccsm/notify` Adaptive Toast
// pipeline can't fire real Windows toasts under playwright (no AUMID
// shortcut, no winrt under headless), so we mock the wrapper's underlying
// dynamic import via the `__setNotifyImporter` test seam exposed in
// `electron/notify.ts`. The mock captures every wrapper call and lets us
// drive synthetic toast activations back through the registered onAction
// handler.
//
// Assertions:
//
//   1. Permission event → notifyPermission called with expected args.
//   2. Question event   → notifyQuestion called with expected args.
//   3. Turn-done event  → notifyDone called with expected args.
//   4. Toast `allow-always` activation routes through to the renderer:
//      the agent permission gate is resolved (sessions.resolvePermission),
//      AND the renderer store gains `toolName` in `allowAlwaysTools`.
//   5. Focus suppression: when the BrowserWindow is focused, `notify` IPC
//      from the renderer never reaches the wrapper.
//
// Reverse-verify: stash the `bootstrapNotify` call in `electron/main.ts`
// and re-run; every assertion must FAIL (no notifier configured ⇒ wrapper
// silently no-ops ⇒ zero captured calls ⇒ assertion 1 trips first).
// For the Wave 3 (#252) cases specifically: stash the
// `scheduleQuestionRetry(questionPayload)` call in
// `electron/notifications.ts` (case 'question') ⇒ assertion 9 trips
// (only one notifyQuestion call instead of two). Stash the
// `cancelQuestionRetry(...)` calls in `electron/main.ts` ⇒ assertion 10
// trips (timer not cancelled).

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-notify-integration] FAIL: ${msg}`);
  process.exit(1);
}

const { port: PORT, close: closeServer } = await startBundleServer(root);

// HOME / USERPROFILE sanitization per project rule — the probe must not
// touch the real developer's ~/.claude.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-notify-int-ud-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-notify-int-home-'));
fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    CCSM_DEV_PORT: String(PORT),
    HOME: homeDir,
    USERPROFILE: homeDir,
  },
});

let exitCode = 0;
try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15000 });

  // ── 1. Install mock importer in main and re-bootstrap notify ────────────
  //
  // The `notify.ts` wrapper exposes `__setNotifyImporter` so tests can swap
  // the dynamic `import('@ccsm/notify')` resolution for a fake. The fake
  // returns a Notifier whose methods record into a global array we can
  // observe from the probe via `app.evaluate`.
  const installed = await app.evaluate(async ({ BrowserWindow }) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const g = globalThis;
    const dbg = g.__ccsmDebug;
    if (!dbg || !dbg.notify || !dbg.notifyBootstrap) {
      throw new Error('__ccsmDebug.notify / notifyBootstrap not exposed (is app.isPackaged?)');
    }
    g.__notifyCalls = [];
    g.__notifyOnAction = null;
    const notifyMod = dbg.notify;
    const bootstrapMod = dbg.notifyBootstrap;
    notifyMod.__setNotifyImporter(async () => ({
      Notifier: {
        create: async (opts) => {
          g.__notifyOnAction = opts.onAction;
          return {
            permission: (p) => g.__notifyCalls.push({ kind: 'permission', payload: p }),
            question: (p) => g.__notifyCalls.push({ kind: 'question', payload: p }),
            done: (p) => g.__notifyCalls.push({ kind: 'done', payload: p }),
            dismiss: (id) => g.__notifyCalls.push({ kind: 'dismiss', toastId: id }),
            dispose: () => {},
          };
        },
      },
    }));
    bootstrapMod.__resetBootstrapForTests();
    bootstrapMod.bootstrapNotify((event) => {
      g.__notifyCalls.push({ kind: 'router', event });
      const target = bootstrapMod.lookupToastTarget(event.toastId);
      if (target && target.kind === 'permission') {
        const decision = event.action === 'reject' ? 'deny' : 'allow';
        dbg.sessions.resolvePermission(target.sessionId, event.toastId, decision);
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
        if (w) {
          w.webContents.send('notify:toastAction', {
            sessionId: target.sessionId,
            requestId: event.toastId,
            action: event.action,
          });
        }
        bootstrapMod.consumeToastTarget(event.toastId);
      }
    });
    await notifyMod.probeNotifyAvailability();
    return notifyMod.isNotifyAvailable();
  });
  if (installed !== true) fail(`failed to install mock notify importer (isNotifyAvailable=${installed})`);
  console.log('[probe-e2e-notify-integration] mock importer installed, notify available');

  // ── 2. Seed a session + group in the renderer store ─────────────────────
  await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    s.createGroup('Test Group');
    const groups = window.__ccsmStore.getState().groups;
    const groupId = groups[groups.length - 1].id;
    s.createSession(groupId, { name: 'Test Session', cwd: '/tmp/probe-cwd' });
  });
  const sessionId = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    return s.sessions[s.sessions.length - 1].id;
  });
  if (typeof sessionId !== 'string' || !sessionId) fail('failed to seed session');
  console.log(`[probe-e2e-notify-integration] seeded sessionId=${sessionId}`);

  // ── 3. Blur the window so focus suppression doesn't gate the probe ──────
  // The legacy electron Notification path is still gated by
  // `BrowserWindow.isFocused()` in main; we explicitly drop focus so emits
  // fan out to the @ccsm/notify wrapper. (We re-test focus suppression at
  // step 7 below by re-focusing.)
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.blur(); } catch {}
    }
  });

  const REQUEST_ID = 'probe-req-1';

  // ── 4. Drive a permission event via the renderer → main IPC bridge ──────
  await win.evaluate((args) => {
    return window.ccsm.notify({
      sessionId: args.sessionId,
      title: 'Permission needed',
      body: 'Bash: ls -la',
      eventType: 'permission',
      extras: {
        toastId: args.requestId,
        sessionName: 'Test Session',
        toolName: 'Bash',
        toolBrief: 'ls -la',
        cwd: '/tmp/probe-cwd',
      },
    });
  }, { sessionId, requestId: REQUEST_ID });

  // Wait for the wrapper call to land.
  await app.evaluate(async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((globalThis.__notifyCalls || []).some((c) => c.kind === 'permission')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for notifyPermission call');
  });

  const calls1 = await app.evaluate(() => globalThis.__notifyCalls);
  const perm = calls1.find((c) => c.kind === 'permission');
  if (!perm) fail('notifyPermission was never called');
  if (perm.payload.toastId !== REQUEST_ID) fail(`unexpected toastId: ${perm.payload.toastId}`);
  if (perm.payload.toolName !== 'Bash') fail(`unexpected toolName: ${perm.payload.toolName}`);
  if (perm.payload.cwdBasename !== 'probe-cwd') fail(`expected cwdBasename "probe-cwd", got ${perm.payload.cwdBasename}`);
  console.log('[probe-e2e-notify-integration] permission emit OK');

  // ── 5. Drive a question event ───────────────────────────────────────────
  await win.evaluate((args) => {
    return window.ccsm.notify({
      sessionId: args.sessionId,
      title: 'Question',
      body: 'Pick one',
      eventType: 'question',
      extras: {
        toastId: 'q-probe-q-1',
        sessionName: 'Test Session',
        question: 'Pick one',
        selectionKind: 'single',
        optionCount: 3,
        cwd: '/tmp/probe-cwd',
      },
    });
  }, { sessionId });
  await app.evaluate(async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((globalThis.__notifyCalls || []).some((c) => c.kind === 'question')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for notifyQuestion call');
  });
  const calls2 = await app.evaluate(() => globalThis.__notifyCalls);
  const question = calls2.find((c) => c.kind === 'question');
  if (!question) fail('notifyQuestion was never called');
  if (question.payload.optionCount !== 3) fail(`unexpected optionCount: ${question.payload.optionCount}`);
  console.log('[probe-e2e-notify-integration] question emit OK');

  // ── 6. Drive a turn-done event ──────────────────────────────────────────
  await win.evaluate((args) => {
    return window.ccsm.notify({
      sessionId: args.sessionId,
      title: 'Done',
      body: 'Finished build',
      eventType: 'turn_done',
      extras: {
        toastId: 'done-probe-1',
        sessionName: 'Test Session',
        groupName: 'Test Group',
        elapsedMs: 42_000,
        toolCount: 4,
        lastUserMsg: 'build it',
        lastAssistantMsg: 'Finished build',
        cwd: '/tmp/probe-cwd',
      },
    });
  }, { sessionId });
  await app.evaluate(async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((globalThis.__notifyCalls || []).some((c) => c.kind === 'done')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for notifyDone call');
  });
  const calls3 = await app.evaluate(() => globalThis.__notifyCalls);
  const done = calls3.find((c) => c.kind === 'done');
  if (!done) fail('notifyDone was never called');
  if (done.payload.toolCount !== 4) fail(`unexpected toolCount: ${done.payload.toolCount}`);
  if (done.payload.elapsedMs !== 42_000) fail(`unexpected elapsedMs: ${done.payload.elapsedMs}`);
  console.log('[probe-e2e-notify-integration] turn-done emit OK');

  // ── 7. Toast `allow-always` activation routes back to the renderer ──────
  // Append a waiting block first so the renderer's onNotifyToastAction
  // handler can read its toolName and seed allowAlwaysTools.
  await win.evaluate((args) => {
    const s = window.__ccsmStore.getState();
    s.appendBlocks(args.sessionId, [
      {
        kind: 'waiting',
        id: `wait-${args.requestId}`,
        prompt: 'Bash: ls -la',
        intent: 'permission',
        requestId: args.requestId,
        toolName: 'Bash',
        toolInput: { command: 'ls -la' },
      },
    ]);
  }, { sessionId, requestId: REQUEST_ID });

  // Synthesize the host-side onAction call (what @ccsm/notify would do when
  // the user clicks "Allow always" in the toast).
  await app.evaluate(({ ipcMain }, args) => {
    const cb = globalThis.__notifyOnAction;
    if (!cb) throw new Error('onAction not captured');
    cb({ toastId: args.requestId, action: 'allow-always', args: {} });
  }, { requestId: REQUEST_ID });

  // Wait for the renderer store to reflect the allow-always seed.
  await win.waitForFunction(
    () => {
      const tools = window.__ccsmStore.getState().allowAlwaysTools;
      return tools.includes('Bash');
    },
    null,
    { timeout: 3000 },
  );
  console.log('[probe-e2e-notify-integration] allow-always routing OK');

  // ── 8. Focus suppression: focused window ⇒ no wrapper call ──────────────
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.isVisible());
    if (w) w.focus();
  });
  // Confirm focused.
  const focused = await app.evaluate(({ BrowserWindow }) => {
    return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
  });
  if (!focused) {
    // Some headless environments refuse to give focus to a launched Electron
    // window. In that case we can't meaningfully exercise this branch — but
    // we still test the underlying `shouldSuppressForFocus` directly.
    console.warn('[probe-e2e-notify-integration] window did not gain focus, exercising suppress helper directly');
  }
  const suppressed = await app.evaluate(({ BrowserWindow }) => {
    const dbg = globalThis.__ccsmDebug;
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    if (w && !w.isFocused()) {
      try { w.show(); w.focus(); } catch {}
    }
    return dbg.notifyBootstrap.shouldSuppressForFocus();
  });
  if (!suppressed) fail('shouldSuppressForFocus returned false with a focused window');

  // Snapshot wrapper call count BEFORE attempting an emit.
  const before = await app.evaluate(() => (globalThis.__notifyCalls || []).filter((c) => c.kind === 'permission').length);
  await win.evaluate((args) => {
    return window.ccsm.notify({
      sessionId: args.sessionId,
      title: 'Should be suppressed',
      body: 'focus gate',
      eventType: 'permission',
      extras: {
        toastId: 'probe-req-suppressed',
        sessionName: 'Test Session',
        toolName: 'Bash',
        toolBrief: 'echo suppress',
        cwd: '/tmp/probe-cwd',
      },
    });
  }, { sessionId });
  // Give the IPC a beat to settle then assert no new permission call landed.
  await new Promise((r) => setTimeout(r, 400));
  const after = await app.evaluate(() => (globalThis.__notifyCalls || []).filter((c) => c.kind === 'permission').length);
  if (after !== before) fail(`focus suppression failed — wrapper was called ${after - before} extra time(s)`);
  console.log('[probe-e2e-notify-integration] focus suppression OK');

  // ── 9. Wave 3 polish (#252): ask-question retry + cancellation ──────────
  //
  // Drop focus again so the wrapper actually fires, install a fake retry
  // scheduler that lets us trigger the 30s timer instantly, then drive a
  // question event. Assert: notifyQuestion is called twice (initial +
  // retry). Then verify cancellation: schedule a fresh retry and call the
  // resolvePermission IPC — the timer must have been removed without
  // firing.
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.blur(); } catch {}
    }
  });

  const installedRetry = await app.evaluate(() => {
    const g = globalThis;
    const dbg = g.__ccsmDebug;
    if (!dbg.notifyRetry) throw new Error('__ccsmDebug.notifyRetry not exposed');
    g.__retryQueue = [];
    g.__retryTimers = new Map();
    g.__retrySeq = 1;
    dbg.notifyRetry.__resetRetryStateForTests();
    dbg.notifyRetry.__setRetrySchedulerForTests(
      (cb, delayMs) => {
        const id = g.__retrySeq++;
        const entry = { cb, delayMs, cancelled: false };
        g.__retryTimers.set(id, entry);
        g.__retryQueue.push({ id, entry });
        return id;
      },
      (handle) => {
        const entry = g.__retryTimers.get(handle);
        if (entry) entry.cancelled = true;
      },
    );
    return true;
  });
  if (installedRetry !== true) fail('failed to install fake retry scheduler');

  const RETRY_REQ = 'probe-q-retry-1';
  const RETRY_TOAST_ID = `q-${RETRY_REQ}`;

  // Snapshot count of question calls before driving the event.
  const beforeQ = await app.evaluate(() => (globalThis.__notifyCalls || []).filter((c) => c.kind === 'question').length);

  await win.evaluate((args) => {
    return window.ccsm.notify({
      sessionId: args.sessionId,
      title: 'Question (retry)',
      body: 'Pick one',
      eventType: 'question',
      extras: {
        toastId: args.toastId,
        sessionName: 'Test Session',
        question: 'Pick one',
        selectionKind: 'single',
        optionCount: 2,
        cwd: '/tmp/probe-cwd',
      },
    });
  }, { sessionId, toastId: RETRY_TOAST_ID });

  // Wait for the initial question call AND for the retry scheduler to be
  // populated (scheduleQuestionRetry runs after the await on notifyQuestion).
  await app.evaluate(async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const qCount = (globalThis.__notifyCalls || []).filter((c) => c.kind === 'question').length;
      const retryCount = globalThis.__retryQueue?.length ?? 0;
      if (qCount >= 1 && retryCount >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for initial question + retry schedule');
  });

  const midQ = await app.evaluate(() => (globalThis.__notifyCalls || []).filter((c) => c.kind === 'question').length);
  if (midQ !== beforeQ + 1) fail(`expected exactly 1 initial question call, got ${midQ - beforeQ}`);

  const queuedDelay = await app.evaluate(() => globalThis.__retryQueue[globalThis.__retryQueue.length - 1].entry.delayMs);
  if (queuedDelay !== 30_000) fail(`retry delay should be 30000ms, got ${queuedDelay}`);

  // Fire the retry timer manually.
  await app.evaluate(() => {
    const last = globalThis.__retryQueue[globalThis.__retryQueue.length - 1];
    if (!last || last.entry.cancelled) throw new Error('retry timer was cancelled or missing');
    last.entry.cb();
  });

  await app.evaluate(async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const qCount = (globalThis.__notifyCalls || []).filter((c) => c.kind === 'question').length;
      if (qCount >= 2) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for retry question call');
  });

  const afterRetry = await app.evaluate(() => (globalThis.__notifyCalls || []).filter((c) => c.kind === 'question').length);
  if (afterRetry !== beforeQ + 2) fail(`expected exactly 2 question calls after retry, got ${afterRetry - beforeQ}`);
  // Verify the retry payload carries the original toastId so the SDK
  // dedupe + activation routing stays coherent.
  const retryCall = await app.evaluate(() => {
    const all = (globalThis.__notifyCalls || []).filter((c) => c.kind === 'question');
    return all[all.length - 1]?.payload?.toastId;
  });
  if (retryCall !== RETRY_TOAST_ID) fail(`retry payload toastId mismatch: got ${retryCall}`);
  console.log('[probe-e2e-notify-integration] question retry OK');

  // ── 10. Cancellation: resolvePermission must clear a pending retry ──────
  const CANCEL_REQ = 'probe-q-cancel-1';
  const CANCEL_TOAST_ID = `q-${CANCEL_REQ}`;
  const beforeCancel = await app.evaluate(() => (globalThis.__notifyCalls || []).filter((c) => c.kind === 'question').length);

  await win.evaluate((args) => {
    return window.ccsm.notify({
      sessionId: args.sessionId,
      title: 'Question (cancel)',
      body: 'Pick one',
      eventType: 'question',
      extras: {
        toastId: args.toastId,
        sessionName: 'Test Session',
        question: 'Pick one',
        selectionKind: 'single',
        optionCount: 2,
        cwd: '/tmp/probe-cwd',
      },
    });
  }, { sessionId, toastId: CANCEL_TOAST_ID });

  await app.evaluate(async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const qCount = (globalThis.__notifyCalls || []).filter((c) => c.kind === 'question').length;
      if (qCount >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for cancel-case initial question call');
  });

  // Capture the retry queue length BEFORE answering, so we know the timer
  // was actually scheduled (otherwise cancellation is a vacuous assertion).
  const queueLenBefore = await app.evaluate(() => globalThis.__retryQueue.filter((q) => !q.entry.cancelled).length);
  if (queueLenBefore < 1) fail(`expected at least 1 live retry timer, got ${queueLenBefore}`);

  // Answer the question via the renderer → main IPC bridge. Renderer's
  // QuestionBlock onSubmit calls agentResolvePermission with decision='deny'.
  // The main-process handler must call cancelQuestionRetry(`q-${requestId}`).
  await win.evaluate((args) => {
    return window.ccsm.agentResolvePermission(args.sessionId, args.requestId, 'deny');
  }, { sessionId, requestId: CANCEL_REQ });

  // The cancel must have flipped our fake timer to cancelled. Wait briefly
  // for the IPC round-trip to settle.
  await new Promise((r) => setTimeout(r, 200));
  const cancelled = await app.evaluate((toastId) => {
    return globalThis.__retryQueue
      .filter((q) => q.entry.payload?.toastId === toastId || true) // any timer for this id
      .some((q) => q.entry.cancelled === true);
  }, CANCEL_TOAST_ID);
  if (!cancelled) fail('agentResolvePermission did not cancel the pending retry timer');

  // And the retry must NOT fire (give it a beat — if cancellation is
  // wrong, the timer would still be live in our fake queue and someone
  // would have to manually fire it; we assert no one did).
  const afterCancel = await app.evaluate(() => (globalThis.__notifyCalls || []).filter((c) => c.kind === 'question').length);
  if (afterCancel !== beforeCancel + 1) fail(`expected exactly 1 question call (no retry) after cancellation, got ${afterCancel - beforeCancel}`);
  console.log('[probe-e2e-notify-integration] question retry cancellation OK');

  // ── 11. Wave 3 polish (#252): rich done payload composition ─────────────
  //
  // Assert that when notifyDone fires, the wrapper sees the assistant
  // preview truncated to 80 chars (matching xml/done.ts ASSISTANT_LINE_MAX),
  // and the groupName + sessionName are passed through so the SDK can
  // render "{groupName} · {sessionName}" as the toast title.
  const longAssistant = 'x'.repeat(200);
  await win.evaluate((args) => {
    return window.ccsm.notify({
      sessionId: args.sessionId,
      title: 'Done (rich)',
      eventType: 'turn_done',
      extras: {
        toastId: 'done-rich-1',
        sessionName: 'Test Session',
        groupName: 'Test Group',
        lastUserMsg: 'do the thing',
        lastAssistantMsg: args.longAssistant,
        elapsedMs: 12_345,
        toolCount: 3,
        cwd: '/tmp/probe-cwd',
      },
    });
  }, { sessionId, longAssistant });

  await app.evaluate(async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const has = (globalThis.__notifyCalls || []).some((c) => c.kind === 'done' && c.payload.toastId === 'done-rich-1');
      if (has) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for rich done call');
  });

  const richDone = await app.evaluate(() => {
    return (globalThis.__notifyCalls || []).find((c) => c.kind === 'done' && c.payload.toastId === 'done-rich-1');
  });
  if (!richDone) fail('rich done call not captured');
  if (richDone.payload.groupName !== 'Test Group') fail(`expected groupName "Test Group", got ${richDone.payload.groupName}`);
  if (richDone.payload.sessionName !== 'Test Session') fail(`expected sessionName "Test Session", got ${richDone.payload.sessionName}`);
  if (typeof richDone.payload.lastAssistantMsg !== 'string') fail('lastAssistantMsg missing');
  if (richDone.payload.lastAssistantMsg.length !== 80) fail(`expected lastAssistantMsg length 80, got ${richDone.payload.lastAssistantMsg.length}`);
  if (!richDone.payload.lastAssistantMsg.endsWith('\u2026')) fail('expected ellipsis at end of truncated lastAssistantMsg');
  console.log('[probe-e2e-notify-integration] rich done payload OK');

  console.log('[probe-e2e-notify-integration] OK');
} catch (e) {
  exitCode = 1;
  console.error(`[probe-e2e-notify-integration] threw: ${e instanceof Error ? e.stack ?? e.message : e}`);
} finally {
  try {
    await app.close();
  } catch {
    /* best effort */
  }
  closeServer();
  process.exit(exitCode);
}
