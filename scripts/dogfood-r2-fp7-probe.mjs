// Dogfood R2 — focus-point 7: Stop / interrupt during streaming.
//
// Drives a real electron app (prebuilt bundle) and exercises:
//   A — Stop button visibility during streaming
//   B — Stop actually interrupts (state cleanup)
//   C — Send next message after Stop (session still usable)
//   D — Stop with NO active stream (idempotent / button hidden)
//
// Approach: rather than spin a real claude.exe (slow, flaky on Windows in
// a worktree CI shape), we drive the renderer store directly to simulate
// streaming-in-progress, then drive the live UI to click Stop and assert
// store + DOM transitions. This mirrors what `caseEscInterrupt` in
// harness-agent.mjs already does, but exercises the user-facing path
// (the actual <button> click + screenshot trail) and writes
// dogfood-grade artifacts.
//
// Run: `node scripts/dogfood-r2-fp7-probe.mjs`

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'docs/screenshots/dogfood-r2/fp7-stop');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const summary = {
  startedAt: new Date().toISOString(),
  checks: {},
  notes: [],
};

function recordCheck(id, status, detail) {
  summary.checks[id] = { status, detail };
  console.log(`[fp7] check ${id}: ${status}${detail ? ` — ${detail}` : ''}`);
}

const SID = 's-fp7';

const app = await electron.launch({
  args: ['.'],
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    CCSM_PROD_BUNDLE: '1',
    CCSM_E2E_HIDDEN: '1',
  },
});

let exitCode = 0;
try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });

  // Pin English so name=/^stop$/i hits.
  await win.evaluate(async () => {
    try {
      if (window.__ccsmI18n && window.__ccsmI18n.language !== 'en') {
        await window.__ccsmI18n.changeLanguage('en');
      }
    } catch {}
  });

  // Seed an idle session first.
  await win.evaluate((sid) => {
    const store = window.__ccsmStore;
    store.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: sid, name: 'fp7-probe', state: 'idle', cwd: 'C:/x',
        model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code',
      }],
      activeId: sid,
      messagesBySession: { [sid]: [] },
      startedSessions: { [sid]: true },
      runningSessions: {},
      interruptedSessions: {},
      messageQueues: {},
      lastTurnEnd: {},
    });
  }, SID);
  await win.waitForTimeout(300);

  // Idle screenshot — Stop button must NOT be visible.
  await win.screenshot({ path: path.join(SHOTS_DIR, '01-idle.png'), fullPage: false });
  const stopBtnIdle = win.getByRole('button', { name: /^stop$/i });
  const stopVisibleIdle = await stopBtnIdle.isVisible().catch(() => false);
  if (stopVisibleIdle) {
    recordCheck('A-idle', 'FAIL', 'Stop button visible while session is idle');
  } else {
    recordCheck('A-idle', 'PASS', 'Stop hidden in idle');
  }

  // ---- Check D: Stop in idle is a no-op ---------------------------------
  // We can't click a hidden button, but we can assert the public stop()
  // contract is idempotent: invoking it via store/IPC path while running
  // is false should not flip interruptedSessions.
  await win.evaluate(async (sid) => {
    // Synthesize what stop() does (early return on !running). The real
    // function is a closure inside InputBar; we exercise the same guard.
    const st = window.__ccsmStore.getState();
    if (st.runningSessions && st.runningSessions[sid]) {
      throw new Error('precondition violation: session marked running before D');
    }
    // Call the actual ipc — should be a no-op handler-side too.
    if (window.ccsm && window.ccsm.agentInterrupt) {
      await window.ccsm.agentInterrupt(sid).catch(() => {});
    }
  }, SID);
  await win.waitForTimeout(200);
  const dPostState = await win.evaluate((sid) => ({
    interrupted: !!window.__ccsmStore.getState().interruptedSessions[sid],
    running: !!window.__ccsmStore.getState().runningSessions[sid],
  }), SID);
  if (dPostState.interrupted || dPostState.running) {
    recordCheck('D', 'FAIL', `unexpected state after idle interrupt: ${JSON.stringify(dPostState)}`);
  } else {
    recordCheck('D', 'PASS', 'idempotent agentInterrupt while idle');
  }

  // ---- Set up streaming state for Checks A/B ----------------------------
  await win.evaluate((sid) => {
    const store = window.__ccsmStore;
    store.setState({
      messagesBySession: {
        [sid]: [
          { kind: 'user', id: 'u-1', text: 'Count from 1 to 200 with one number per line, slowly.' },
          { kind: 'assistant', id: 'a-1', text: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n' },
        ],
      },
      runningSessions: { [sid]: true },
    });
  }, SID);
  await win.waitForTimeout(300);

  // ---- Check A: Stop button visible while streaming ---------------------
  const stopBtn = win.getByRole('button', { name: /^stop$/i });
  let stopVisible = false;
  try {
    await stopBtn.waitFor({ state: 'visible', timeout: 5000 });
    stopVisible = true;
  } catch {
    stopVisible = false;
  }
  await win.screenshot({ path: path.join(SHOTS_DIR, '02-streaming-stop-visible.png'), fullPage: false });
  recordCheck('A-streaming', stopVisible ? 'PASS' : 'FAIL', stopVisible ? 'Stop button visible during streaming' : 'Stop button NOT visible during streaming');

  // Capture the stop button's morph attribute as evidence (proof it's the
  // morph variant of Send).
  const morphState = await win.evaluate(() => {
    const btn = document.querySelector('button[data-morph-state]');
    return btn ? btn.getAttribute('data-morph-state') : null;
  });
  summary.notes.push(`button data-morph-state during stream = ${morphState}`);

  // ---- Check B: Click Stop, assert state cleanup ------------------------
  await stopBtn.click();
  await win.waitForTimeout(500);

  const postClick = await win.evaluate((sid) => ({
    interrupted: !!window.__ccsmStore.getState().interruptedSessions[sid],
    lastTurnEnd: window.__ccsmStore.getState().lastTurnEnd?.[sid] ?? null,
    queueLen: (window.__ccsmStore.getState().messageQueues[sid] ?? []).length,
    running: !!window.__ccsmStore.getState().runningSessions[sid],
    blockCount: (window.__ccsmStore.getState().messagesBySession[sid] ?? []).length,
    lastBlockKind: (() => {
      const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
      return blocks[blocks.length - 1]?.kind ?? null;
    })(),
  }), SID);
  summary.notes.push(`post-stop store snapshot: ${JSON.stringify(postClick)}`);

  // markInterrupted ran -> interruptedSessions[sid]=true and lastTurnEnd='interrupted'
  // running stays true until SDK result frame arrives. The assistant block
  // (a-1) must still be there (not deleted, not duplicated).
  if (postClick.interrupted && postClick.lastTurnEnd === 'interrupted' && postClick.blockCount === 2) {
    recordCheck('B', 'PASS', 'interrupt flag + lastTurnEnd set, assistant block preserved');
  } else {
    recordCheck('B', 'FAIL', `unexpected post-stop state: ${JSON.stringify(postClick)}`);
  }

  // Synthesize the SDK result frame the agent would normally deliver: append
  // an "Interrupted" status block + flip running false. This is what the real
  // streaming pipeline does when the interrupt IPC reaches the agent.
  await win.evaluate((sid) => {
    const st = window.__ccsmStore.getState();
    if (!st.consumeInterrupted(sid)) throw new Error('consumeInterrupted returned false');
    st.appendBlocks(sid, [{ kind: 'status', id: 'res-fp7', tone: 'info', title: 'Interrupted' }]);
    st.setRunning(sid, false);
  }, SID);
  await win.waitForTimeout(400);

  await win.screenshot({ path: path.join(SHOTS_DIR, '03-after-stop.png'), fullPage: false });

  // After running flips to false, the morph button should swap back to Send.
  // Use the exact aria-label ("Send message") to avoid colliding with the
  // per-user-block "Edit and resend" affordance.
  const sendBtnPostStop = win.getByRole('button', { name: 'Send message' });
  let sendBackVisible = false;
  try {
    await sendBtnPostStop.waitFor({ state: 'visible', timeout: 3000 });
    sendBackVisible = true;
  } catch {}
  if (!sendBackVisible) {
    recordCheck('B-morph-back', 'FAIL', 'Send button did not return after running flipped false');
  } else {
    recordCheck('B-morph-back', 'PASS', 'composer morphed back to Send');
  }

  // Continue-after-interrupt hint should be visible (task322).
  const hint = win.locator('[data-testid="continue-after-interrupt-hint"]');
  const hintVisible = await hint.isVisible().catch(() => false);
  if (hintVisible) {
    summary.notes.push('continue-after-interrupt hint rendered');
  } else {
    summary.notes.push('continue-after-interrupt hint NOT rendered (expected after stop with empty composer + interrupted lastTurnEnd)');
  }

  // ---- Check C: Send next message after Stop ----------------------------
  const textarea = win.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 3000 });
  await textarea.click();
  await win.keyboard.type('What number did you stop at?');
  await win.screenshot({ path: path.join(SHOTS_DIR, '04-typing-followup.png'), fullPage: false });
  const taValue = await textarea.inputValue();
  if (taValue !== 'What number did you stop at?') {
    recordCheck('C', 'FAIL', `composer not usable after stop, value=${JSON.stringify(taValue)}`);
  } else {
    // Don't actually click send (would require real claude.exe wiring); the
    // user-perceived contract is "I can compose + send a follow-up", which
    // means the textarea is interactable and the Send button is enabled.
    const sendEnabled = await sendBtnPostStop.isEnabled();
    if (!sendEnabled) {
      recordCheck('C', 'FAIL', 'Send button disabled after stop');
    } else {
      recordCheck('C', 'PASS', 'composer usable + Send enabled after stop');
    }
  }

  // Final sanity: the assistant block survived (no corruption).
  const finalBlocks = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.map((b) => ({ kind: b.kind, id: b.id, title: b.title ?? null }));
  }, SID);
  summary.notes.push(`final blocks: ${JSON.stringify(finalBlocks)}`);
  if (finalBlocks.length !== 3 || finalBlocks[0].kind !== 'user' || finalBlocks[1].kind !== 'assistant' || finalBlocks[2].kind !== 'status') {
    recordCheck('B-block-integrity', 'FAIL', `blocks corrupted: ${JSON.stringify(finalBlocks)}`);
  } else {
    recordCheck('B-block-integrity', 'PASS', 'user + assistant + interrupted-status blocks intact');
  }

  await win.screenshot({ path: path.join(SHOTS_DIR, '05-final.png'), fullPage: false });

  summary.finishedAt = new Date().toISOString();
  const allPass = Object.values(summary.checks).every((c) => c.status === 'PASS');
  summary.verdict = allPass ? 'PASS' : 'FAIL';
} catch (err) {
  exitCode = 1;
  summary.error = err instanceof Error ? err.stack || err.message : String(err);
  summary.verdict = 'ERROR';
  console.error('[fp7] probe error:', err);
} finally {
  await app.close().catch(() => {});
  fs.writeFileSync(path.join(SHOTS_DIR, 'probe-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`[fp7] verdict: ${summary.verdict}`);
  console.log(`[fp7] artifacts: ${SHOTS_DIR}`);
  process.exit(exitCode);
}
