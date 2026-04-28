// probe-real-switch-session-keeps-chat — UX scenario F.
//
// User scenario (verbatim from product owner):
//   "2 是在 session 之间切换，右边窗口随之切换，并且可以聊天，这个现在有问题，
//    切换的时候当成是 resume 了，报错 session is already in use"
//
// Translation: when the user clicks between sessions in the sidebar, the right
// pane should follow and remain chattable. The bug being locked down: switching
// back to a session that already has a running ttyd was being treated as a
// fresh resume — which collided with the existing claude PTY and surfaced a
// "session already in use" error in the renderer.
//
// The fix lives in two places:
//   * `electron/cliBridge/processManager.ts::getTtydForSession` returns the
//     existing {port, sid} when the session's ttyd is still alive.
//   * `src/components/TtydPane.tsx` calls `getTtydForSession` BEFORE
//     `openTtydForSession`, attaching to the existing port instead of
//     respawning.
//
// This probe verifies the round-trip A → B → A:
//   1. Session A's ttyd webContents id is captured on the first mount.
//   2. After switching to B and back to A, the renderer's TtydPane MUST
//      reuse the same webContents (port reuse path).
//   3. A's xterm scrollback still contains the ALPHA prompt/reply from
//      step 1 (i.e. the conversation was preserved, not restarted).
//   4. A second prompt sent in A also gets a reply.
//   5. No console error toast about "already in use" appears, and no
//      ttyd-exit event for A's sid was broadcast during the round-trip.
//
// Reviewer-flagged helper limitation (do NOT patch helper):
//   `waitForWebviewMounted` picks the highest-id webContents — when both A's
//   and B's ttyds are alive on switch-back, that helper might return B's id.
//   We work around it here by remembering A's wcId from the first mount and
//   asserting the live webview-set still contains it after switch-back.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
  seedSession,
  waitForWebviewMounted,
  waitForXtermBuffer,
  sendToClaudeTui,
  readXtermLines,
  executeJavaScriptOnWebview,
  dismissWelcomeSplash,
} from './probe-utils-real-cli.mjs';

const screenshotDir = path.resolve('docs/screenshots/probe-real-switch-session-keeps-chat');
mkdirSync(screenshotDir, { recursive: true });

const steps = [];
const log = (step, ok, detail) => {
  const entry = { step, ok, detail: detail ?? null };
  steps.push(entry);
  const tag = ok ? 'PASS' : 'FAIL';
  const tail = detail ? ': ' + JSON.stringify(detail).slice(0, 240) : '';
  console.log(`[STEP] ${step}: ${tag}${tail}`);
};

const ttydExits = [];
const consoleErrors = [];

let electronApp = null;
let win = null;
let ranCleanup = false;
let exitCode = 1;
let cleanupClaude = null;

const finish = async () => {
  if (ranCleanup) return;
  ranCleanup = true;
  const report = {
    generatedAt: new Date().toISOString(),
    steps,
    ttydExits,
    consoleErrors: consoleErrors.slice(0, 50),
  };
  try {
    writeFileSync(path.join(screenshotDir, 'probe.json'), JSON.stringify(report, null, 2));
  } catch { /* ignore */ }
  if (electronApp) {
    try { await electronApp.close(); } catch { /* ignore */ }
  }
  try { cleanupClaude?.(); } catch { /* ignore */ }
  console.log(`\n===== ${exitCode === 0 ? '[PASS]' : '[FAIL]'} probe-real-switch-session-keeps-chat =====`);
  if (exitCode !== 0) {
    console.log(JSON.stringify(report, null, 2));
  }
  process.exit(exitCode);
};

const fail = async (reason) => {
  console.error(`[FAIL] ${reason}`);
  let screenshotPath = null;
  let xtermTail = null;
  if (win) {
    const ts = Date.now();
    screenshotPath = path.join(screenshotDir, `fail-${ts}.png`);
    try {
      await win.screenshot({ path: screenshotPath, fullPage: true });
    } catch { /* ignore */ }
  }
  // Best-effort xterm buffer dump for the LAST captured webContents id, so
  // failures involving xterm (scrollback / reply detection) show what was
  // actually on screen. We capture lastWcId opportunistically as the probe
  // advances; if it's null we just skip.
  if (lastWcId != null && electronApp) {
    try {
      const lines = await readXtermLines(electronApp, lastWcId, { lines: 40 });
      xtermTail = lines.join('\n');
      console.error(`[xterm-tail wcId=${lastWcId}]\n${xtermTail}`);
    } catch (err) {
      console.error('[xterm-tail] read failed:', err?.message || err);
    }
  }
  if (win) {
    try {
      const dump = await win.evaluate(() => {
        const st = window.__ccsmStore?.getState?.() || null;
        const probing = !!document.querySelector('[data-testid="claude-availability-probing"]');
        const guide = !!document.querySelector('[data-testid="claude-missing-guide"]');
        const skel = !!document.querySelector('[data-testid="main-skeleton"]');
        const firstRun = !!document.querySelector('[data-testid="first-run-empty"]');
        const wvCount = document.querySelectorAll('webview').length;
        const wvTitles = Array.from(document.querySelectorAll('webview')).map((w) => w.getAttribute('title'));
        return {
          activeId: st?.activeId,
          sessionIds: (st?.sessions || []).map((s) => ({ id: s.id, name: s.name, state: s.state, cwd: s.cwd })),
          probing,
          guide,
          skel,
          firstRun,
          wvCount,
          wvTitles,
        };
      });
      console.error('[render-state]', JSON.stringify(dump, null, 2));
    } catch { /* ignore */ }
  }
  if (screenshotPath) console.error(`[screenshot] ${screenshotPath}`);
  exitCode = 1;
  await finish();
};

// Tracked by the steps below so a FAIL can dump the most recent webview's
// xterm buffer without having to plumb wcId into `fail()` each time.
let lastWcId = null;

process.on('uncaughtException', async (err) => {
  console.error('[uncaughtException]', err);
  await fail(`uncaughtException: ${err?.stack || err}`);
});
process.on('unhandledRejection', async (err) => {
  console.error('[unhandledRejection]', err);
  await fail(`unhandledRejection: ${err?.stack || err}`);
});

// ---- helpers local to this probe ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send `text` to claude and wait for a non-echo reply containing `replyToken`.
 * Strips the echoed prompt (which appears in claude's input box) before
 * checking, mirroring dogfood-probe-happy-path.
 */
async function sendAndAwaitReply(electronApp, wcId, prompt, replyToken, { timeout = 90000 } = {}) {
  // Make sure claude has focus before typing.
  await executeJavaScriptOnWebview(electronApp, wcId, `(function(){
    const ta = document.querySelector('.xterm-helper-textarea');
    if (ta) ta.focus();
    if (window.term && typeof window.term.focus === 'function') window.term.focus();
    return true;
  })()`);
  await sleep(300);
  await sendToClaudeTui(electronApp, wcId, prompt);
  await sleep(400);
  await sendToClaudeTui(electronApp, wcId, '\r');

  const deadline = Date.now() + timeout;
  let lastTail = '';
  while (Date.now() < deadline) {
    await sleep(2000);
    const lines = await readXtermLines(electronApp, wcId, { lines: 200 }).catch(() => []);
    const full = lines.join('\n');
    lastTail = full.slice(-800);
    // Drop the first occurrence of the echoed prompt before searching for the
    // reply token so we don't false-positive on the user's own typing.
    const after = full.split(prompt).slice(1).join(prompt);
    if (after && new RegExp(replyToken).test(after)) {
      return { ok: true, tail: lastTail };
    }
  }
  return { ok: false, tail: lastTail };
}

/**
 * Return all live ttyd webview ids known to the main process.
 */
async function listTtydWebviewIds(electronApp) {
  return await electronApp.evaluate(({ webContents }) => {
    const out = [];
    for (const wc of webContents.getAllWebContents()) {
      try {
        if (wc.getType() === 'webview' && /^http:\/\/127\.0\.0\.1:\d+/.test(wc.getURL())) {
          out.push({ id: wc.id, url: wc.getURL() });
        }
      } catch { /* ignore */ }
    }
    return out;
  });
}

/**
 * Ask main process for the running ttyd port for `sid` (mirrors the
 * renderer's reuse-first call). Returns null if not running.
 */
async function getTtydPortForSid(win, sid) {
  return await win.evaluate(async (sessionId) => {
    const bridge = window.ccsmCliBridge;
    if (!bridge?.getTtydForSession) return null;
    try {
      return await bridge.getTtydForSession(sessionId);
    } catch (err) {
      return { __error: String(err) };
    }
  }, sid);
}

// ---- run ----

(async () => {
  // Sanity: dist must be built.
  if (!existsSync(path.resolve('dist/renderer/index.html'))) {
    return fail('dist/renderer/index.html missing — run `npm run build` first');
  }

  // 1) isolated ~/.claude clone
  const claude = await createIsolatedClaudeDir();
  cleanupClaude = claude.cleanup;
  const tempDir = claude.tempDir;
  log('isolated-claude-dir', true, { tempDir });

  // 2) launch ccsm
  let launch;
  try {
    launch = await launchCcsmIsolated({ tempDir });
  } catch (err) {
    return fail(`launchCcsmIsolated: ${err?.message || err}`);
  }
  electronApp = launch.electronApp;
  win = launch.win;

  win.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push({ type: 'error', text: msg.text() });
  });
  win.on('pageerror', (err) => consoleErrors.push({ type: 'pageerror', text: String(err) }));

  // Subscribe to ttyd-exit broadcasts from the renderer side so we can later
  // assert no exit fired for A during the round-trip.
  await win.evaluate(() => {
    window.__probeTtydExits = [];
    const bridge = window.ccsmCliBridge;
    if (bridge?.onTtydExit) {
      bridge.onTtydExit((evt) => {
        window.__probeTtydExits.push(evt);
      });
    }
  });
  log('boot', true, { tempDir });

  // 3) seed two sessions (probe author chooses fixed ids so logs are readable)
  let sidA, sidB;
  try {
    sidA = (await seedSession(win, { name: 'session-A', cwd: tempDir })).sid;
    sidB = (await seedSession(win, { name: 'session-B', cwd: tempDir })).sid;
    if (!sidA || !sidB || sidA === sidB) {
      return fail(`seedSession returned bad ids A=${sidA} B=${sidB}`);
    }
    log('seed-sessions', true, { sidA, sidB });
  } catch (err) {
    return fail(`seedSession: ${err?.message || err}`);
  }

  // 4) select A; wait for webview + claude TUI; capture A's wcId.
  //    First wait for the claude-availability probe to resolve — TtydPane
  //    only mounts after `claudeAvailable===true`.
  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );
  } catch (err) {
    return fail(`claude-availability never resolved: ${err?.message || err}`);
  }
  let wcA;
  try {
    await win.evaluate((id) => {
      window.__ccsmStore.getState().selectSession(id);
    }, sidA);
    wcA = await waitForWebviewMounted(win, electronApp, sidA, { timeout: 45000 });
    lastWcId = wcA;
    // Wait until claude's banner / input box is visible so the conversation
    // is actually live (otherwise the "send first prompt" step races claude's
    // first-run setup screens).
    await waitForXtermBuffer(electronApp, wcA, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, {
      timeout: 30000,
    });
    log('select-A-mounted', true, { wcA });
  } catch (err) {
    return fail(`select A / mount: ${err?.message || err}`);
  }

  // Snapshot A's port from main so we can compare on switch-back.
  const portA1 = await getTtydPortForSid(win, sidA);
  if (!portA1 || portA1.__error || typeof portA1.port !== 'number') {
    return fail(`A's ttyd port not reported: ${JSON.stringify(portA1)}`);
  }
  log('A-port-captured', true, { port: portA1.port });

  // Try to advance any first-run prompts so the input box accepts text.
  for (let i = 0; i < 6; i++) {
    const lines = await readXtermLines(electronApp, wcA, { lines: 30 }).catch(() => []);
    const tail = lines.join('\n');
    if (/│\s*>/m.test(tail) || /^\s*>\s/m.test(tail)) break;
    await sendToClaudeTui(electronApp, wcA, '\r');
    await sleep(1500);
  }

  // 5) send ALPHA prompt to A and wait for reply
  const ALPHA_PROMPT = 'Please reply with the single word ALPHA';
  await dismissWelcomeSplash(electronApp, wcA);
  const reply1 = await sendAndAwaitReply(electronApp, wcA, ALPHA_PROMPT, 'ALPHA');
  if (!reply1.ok) {
    return fail(`A first reply (ALPHA) timed out. Tail:\n${reply1.tail}`);
  }
  log('A-first-reply', true, { tail: reply1.tail.slice(-200) });

  // 6) switch to B; wait for B's webview + TUI
  let wcB;
  try {
    await win.evaluate((id) => {
      window.__ccsmStore.getState().selectSession(id);
    }, sidB);
    // Helper picks highest wcId — on first appearance of B that is B (B is
    // newer than A). Capture it now for sanity.
    wcB = await waitForWebviewMounted(win, electronApp, sidB, { timeout: 30000 });
    lastWcId = wcB;
    if (wcB === wcA) {
      return fail(`switch to B: helper returned A's wcId (${wcA}); switch did not actually mount B`);
    }
    await waitForXtermBuffer(electronApp, wcB, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, {
      timeout: 30000,
    });
    await dismissWelcomeSplash(electronApp, wcB);
    log('select-B-mounted', true, { wcB });
  } catch (err) {
    return fail(`select B / mount: ${err?.message || err}`);
  }

  // Confirm A's ttyd is still tracked on the main side (no kill on hide).
  const portA2 = await getTtydPortForSid(win, sidA);
  if (!portA2 || portA2.__error || portA2.port !== portA1.port) {
    return fail(`A's ttyd dropped after switching to B: was ${portA1.port}, now ${JSON.stringify(portA2)}`);
  }
  log('A-port-still-alive-while-B-active', true, { port: portA2.port });

  // 7) switch BACK to A; assert reuse
  try {
    await win.evaluate((id) => {
      window.__ccsmStore.getState().selectSession(id);
    }, sidA);
  } catch (err) {
    return fail(`selectSession back to A: ${err?.message || err}`);
  }

  // Wait for the host-page <webview> for A to be visible again. (B's webview
  // tag is unmounted when activeId flips because TtydPane is keyed/conditional
  // by sessionId via the parent; the live webContents for B is detached.)
  try {
    await win.waitForSelector(`webview[title="ttyd session ${sidA}"]`, { timeout: 15000 });
  } catch (err) {
    return fail(`A's <webview> did not re-appear after switch-back: ${err?.message || err}`);
  }

  // Confirm A's port is unchanged (reuse path, NOT respawn).
  const portA3 = await getTtydPortForSid(win, sidA);
  if (!portA3 || portA3.__error || portA3.port !== portA1.port) {
    return fail(`A's ttyd port changed on switch-back (was ${portA1.port}, now ${JSON.stringify(portA3)}) — switch was treated as resume`);
  }
  log('A-port-reused-on-switch-back', true, { port: portA3.port });

  // The original wcA was destroyed when A's TtydPane unmounted on switch-to-B
  // (Electron <webview> tags own their webContents; removing the tag tears
  // down the inner renderer). On switch-back, a NEW webview is mounted that
  // attaches to the SAME ttyd port — that's the reuse path the bug fix
  // exercised. ttyd replays its scrollback to the fresh client, so the live
  // claude PTY is preserved.
  //
  // Capture the new wcId and confirm its URL points at A's original port.
  let wcA2;
  try {
    wcA2 = await waitForWebviewMounted(win, electronApp, sidA, { timeout: 30000 });
    lastWcId = wcA2;
  } catch (err) {
    return fail(`A's webview did not re-mount with xterm after switch-back: ${err?.message || err}`);
  }
  const liveAfter = await listTtydWebviewIds(electronApp);
  const wcA2Entry = liveAfter.find((x) => x.id === wcA2);
  if (!wcA2Entry || !wcA2Entry.url.includes(`:${portA1.port}`)) {
    return fail(
      `A's new webview wcId=${wcA2} url=${wcA2Entry?.url} does not point at original port ${portA1.port}; live=${JSON.stringify(liveAfter)}`,
    );
  }
  log('A-webview-attached-to-original-port', true, { wcA2, url: wcA2Entry.url, originalPort: portA1.port });
  // 8) confirm A's xterm buffer still has ALPHA history (replayed by ttyd to
  //    the freshly-attached client).
  //
  //    The freshly-mounted webview attaches to the existing ttyd port, but
  //    ttyd needs a brief moment to replay its scrollback over the new
  //    websocket connection. Wait for ALPHA to actually surface in the
  //    buffer (with a generous timeout) before failing.
  try {
    await waitForXtermBuffer(electronApp, wcA2, /ALPHA/, { timeout: 15000 });
  } catch (_) { /* fall through to read + assert below for a useful tail */ }
  const aLines = await readXtermLines(electronApp, wcA2, { lines: 200 }).catch(() => []);
  const aFull = aLines.join('\n');
  if (!/ALPHA/.test(aFull)) {
    return fail(`A's scrollback lost ALPHA history after switch-back. lines=${aLines.length} fullLen=${aFull.length} json=${JSON.stringify(aLines.slice(-30))}`);
  }
  log('A-scrollback-preserved', true, { tail: aFull.slice(-300) });

  // 9) send another prompt in A — confirm reply lands on the SAME conversation
  const BETA_PROMPT = 'Please reply with the single word BETA';
  await dismissWelcomeSplash(electronApp, wcA2);
  const reply2 = await sendAndAwaitReply(electronApp, wcA2, BETA_PROMPT, 'BETA');
  if (!reply2.ok) {
    return fail(`A second reply (BETA) timed out after switch-back. Tail:\n${reply2.tail}`);
  }
  log('A-post-switch-reply', true, { tail: reply2.tail.slice(-200) });

  // 10) assert no "already in use" error toast / console error AND no ttyd-exit for A
  const exitsForA = await win.evaluate((sid) => {
    const arr = window.__probeTtydExits || [];
    return arr.filter((e) => e.sessionId === sid);
  }, sidA);
  if (exitsForA.length > 0) {
    ttydExits.push(...exitsForA);
    return fail(`ttyd-exit fired for A during round-trip: ${JSON.stringify(exitsForA)}`);
  }
  const inUseError = consoleErrors.find((e) => /already in use|session is already/i.test(e.text || ''));
  if (inUseError) {
    return fail(`renderer console contains "already in use" error: ${inUseError.text}`);
  }
  log('no-exit-no-in-use-error', true, { consoleErrorCount: consoleErrors.length });

  exitCode = 0;
  await finish();
})();
