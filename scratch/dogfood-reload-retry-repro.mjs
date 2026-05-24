// scratch/dogfood-reload-retry-repro.mjs
//
// Independent log-driven repro of:
//   A. Sidebar context-menu "重启会话" silently fails (no fresh PTY).
//   B. Retry button on exit overlay does nothing visible.
//
// Strategy: launch ccsm headless (real claude bin), create a session, wait
// for banner, capture every renderer console line + main stdout/stderr line
// (timestamped, prefixed). Drive `reloadSession` via window.__ccsmStore;
// drive Retry via the same hook's `onRetry` (we trigger it through the
// store: we kill the pty, wait for overlay, then click the visible Retry
// button via Playwright). Type a key after each action and observe whether
// pty.input gets a fresh sid / whether main sees "no PTY".
//
// NOT a test — pure investigation. Prints a single timeline at the end.

import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
  waitForTerminalReady,
  dismissWelcomeSplash,
  seedSession,
} from '../scripts/probe-utils-real-cli.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ts = () => `[t=${((Date.now() - t0) / 1000).toFixed(2)}s]`;

const events = [];
function record(prefix, line) {
  // Trim noisy boilerplate. Keep anything mentioning sids / pty / attach /
  // reload / retry / spawn / kill / exit / warm / cold / disconnect.
  const s = String(line).replace(/\s+$/g, '');
  if (!s) return;
  events.push(`${ts()} [${prefix}] ${s}`);
}

const KEEP_RE = /pty\.|attach|reload|retry|spawn|kill|exit|warm|cold|disconnect|sid=|sessionId|onExit|onData|no PTY|ENOENT|EBADF|fail|throw|error|crash|term\.|Welcome|Tip|saved/i;

function recordFiltered(prefix, line) {
  const s = String(line).replace(/\s+$/g, '');
  if (!s) return;
  if (!KEEP_RE.test(s)) return;
  events.push(`${ts()} [${prefix}] ${s.slice(0, 400)}`);
}

async function main() {
  const { tempDir } = await createIsolatedClaudeDir();
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccsm-repro-cwd-'));

  record('runner', `launching ccsm, tempDir=${tempDir} cwd=${cwd}`);
  const { electronApp, win } = await launchCcsmIsolated({
    tempDir,
    env: { CCSM_E2E_HIDDEN: '1' },
  });

  // PSA enforcement: verify the launched window is OFFSCREEN before doing
  // any further work. Project policy: dogfood scripts must NEVER open a
  // visible window on the user's desktop.
  //
  // Important: the project's CCSM_E2E_HIDDEN=1 design positions the window
  // at (-32000, -32000) with `show:true` (so Chromium doesn't throttle
  // rAF / paint — see electron/window/createWindow.ts line 250+). So
  // `BrowserWindow.isVisible()` will return TRUE — we MUST instead check
  // the window's position is the project's offscreen sentinel (x <= -10000),
  // which IS the policy-compliant "hidden" pattern.
  const visibilityProbe = await electronApp.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    return wins.map((w) => {
      const bounds = w.getBounds();
      const skipTaskbar = w.isSkipTaskbar?.() ?? false;
      const offscreen = bounds.x <= -10000 && bounds.y <= -10000;
      return { x: bounds.x, y: bounds.y, skipTaskbar, offscreen };
    });
  });
  const allHidden = visibilityProbe.every((w) => w.offscreen);
  if (!allHidden) {
    await electronApp.close().catch(() => {});
    throw new Error(
      `Dogfood opened a visible window — violates project policy. CCSM_E2E_HIDDEN=1 was passed but window state is ${JSON.stringify(visibilityProbe)}.`,
    );
  }
  record('runner', `verified hidden: ${JSON.stringify(visibilityProbe)}`);

  // Tap main stdout/stderr.
  const proc = electronApp.process();
  proc?.stdout?.on('data', (b) =>
    String(b).split('\n').forEach((l) => recordFiltered('main', l)),
  );
  proc?.stderr?.on('data', (b) =>
    String(b).split('\n').forEach((l) => recordFiltered('main', l)),
  );

  // Tap renderer console.
  win.on('console', (msg) => {
    try {
      recordFiltered('renderer', `${msg.type()}: ${msg.text()}`);
    } catch {
      /* ignore */
    }
  });
  win.on('pageerror', (err) => record('renderer-err', err?.stack ?? String(err)));

  record('runner', 'creating session');
  const { sid } = await seedSession(win, { cwd, name: 'repro' });
  record('runner', `session sid=${sid}`);

  await waitForTerminalReady(win, sid, { timeout: 20000 }).catch((e) =>
    record('runner', `waitForTerminalReady threw: ${e.message}`),
  );
  await dismissWelcomeSplash(win, { maxAttempts: 3, settleMs: 500 }).catch(() => {});
  await sleep(2000);
  record('runner', '----- session ready -----');

  // Snapshot pid + entry presence BEFORE reload.
  const pre = await win.evaluate(async (sid) => {
    const pty = window.ccsmPty;
    const list = (await pty.list?.()) ?? [];
    const e = list.find((x) => x.sid === sid);
    return {
      ptyEntry: e ? { sid: e.sid, pid: e.pid } : null,
      hasWarmEntry: !!(window.__ccsmWarm?.get?.(sid)),
    };
  }, sid);
  record('runner', `PRE-RELOAD: ptyEntry=${JSON.stringify(pre.ptyEntry)} hasWarmEntry=${pre.hasWarmEntry}`);

  // -----------------------------------------------------------------
  // REPRO A: reload session
  // -----------------------------------------------------------------
  record('runner', '===== USER ACTION A: reloadSession (== context menu 重启会话) =====');
  await win.evaluate((sid) => {
    return window.__ccsmStore.getState().reloadSession(sid);
  }, sid);
  // Short sleep — long enough for cold attach to land (~150ms in practice),
  // short enough that the freshly-spawned PTY (which under headless claude
  // may exit again on its own) is still alive when we snapshot. The fix
  // signal is: did `terminal.warmEvict cause:"reload"` + a fresh
  // `terminal.warmAlloc` + cold-attach probes fire — those happen in the
  // first 200-300ms.
  await sleep(800);

  const postA = await win.evaluate(async (sid) => {
    const pty = window.ccsmPty;
    const list = (await pty.list?.()) ?? [];
    const e = list.find((x) => x.sid === sid);
    // Try to read any visible overlay text.
    const overlay = document.querySelector('[class*="absolute"]')?.textContent ?? '';
    const bodyText = document.body.textContent ?? '';
    return {
      ptyEntry: e ? { sid: e.sid, pid: e.pid } : null,
      hasWarmEntry: !!(window.__ccsmWarm?.get?.(sid)),
      overlayMentionsRetry: /Retry|重试|对话已保存|Attaching/i.test(bodyText),
      reloadNonce: window.__ccsmStore.getState().reloadNonce?.[sid] ?? 0,
      activeId: window.__ccsmStore.getState().activeId,
    };
  }, sid);
  record('runner', `POST-RELOAD: ${JSON.stringify(postA)}`);

  // Type a char — does pty.input flow to anything? Use the renderer's
  // input bridge directly (the path SessionRow doesn't use; equivalent to
  // what onData would do).
  record('runner', 'USER ACTION: type "a" via ccsmPty.input');
  const typeRes = await win.evaluate(async (sid) => {
    try {
      const r = await window.ccsmPty.input(sid, 'a');
      return { ok: true, r };
    } catch (e) {
      return { ok: false, err: String(e?.message ?? e) };
    }
  }, sid);
  record('runner', `pty.input(a) returned: ${JSON.stringify(typeRes)}`);
  await sleep(1500);

  // -----------------------------------------------------------------
  // REPRO B: kill → Retry overlay → click Retry
  // -----------------------------------------------------------------
  record('runner', '===== USER ACTION B SETUP: kill pty to surface exit overlay =====');
  const killRes = await win.evaluate(
    (sid) => window.ccsmPty.kill(sid),
    sid,
  );
  record('runner', `pty.kill returned: ${JSON.stringify(killRes)}`);
  await sleep(3000);

  const preRetry = await win.evaluate(async (sid) => {
    const list = (await window.ccsmPty.list?.()) ?? [];
    const e = list.find((x) => x.sid === sid);
    const bodyText = document.body.textContent ?? '';
    const disc = window.__ccsmStore.getState().disconnectedSessions?.[sid];
    return {
      ptyEntry: e ? { sid: e.sid, pid: e.pid } : null,
      hasWarmEntry: !!(window.__ccsmWarm?.get?.(sid)),
      disconnected: disc ? { kind: disc.kind, code: disc.code, signal: disc.signal } : null,
      hasOverlayText: /Retry|重试|对话已保存|saved to disk/i.test(bodyText),
    };
  }, sid);
  record('runner', `POST-KILL (overlay expected): ${JSON.stringify(preRetry)}`);

  record('runner', 'USER ACTION B: click Retry button');
  // Try locator; the button has text "Retry" in the exit overlay code path
  // (terminal.exitedRetry i18n string in zh = "重试", en = "Retry").
  const clicked = await win.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find((b) => /Retry|重试/i.test(b.textContent ?? ''));
    if (!btn) return { ok: false, reason: 'no-button-found', buttons: buttons.map((b) => b.textContent?.trim()) };
    btn.click();
    return { ok: true, label: btn.textContent };
  });
  record('runner', `retry click: ${JSON.stringify(clicked)}`);
  await sleep(5000);

  const postRetry = await win.evaluate(async (sid) => {
    const list = (await window.ccsmPty.list?.()) ?? [];
    const e = list.find((x) => x.sid === sid);
    const bodyText = document.body.textContent ?? '';
    const disc = window.__ccsmStore.getState().disconnectedSessions?.[sid];
    return {
      ptyEntry: e ? { sid: e.sid, pid: e.pid } : null,
      hasWarmEntry: !!(window.__ccsmWarm?.get?.(sid)),
      disconnected: disc ? { kind: disc.kind, code: disc.code } : null,
      stillHasOverlayText: /Retry|重试|对话已保存|saved to disk/i.test(bodyText),
    };
  }, sid);
  record('runner', `POST-RETRY: ${JSON.stringify(postRetry)}`);

  record('runner', 'USER ACTION: type "b" via ccsmPty.input after retry');
  const typeRes2 = await win.evaluate(async (sid) => {
    try {
      const r = await window.ccsmPty.input(sid, 'b');
      return { ok: true, r };
    } catch (e) {
      return { ok: false, err: String(e?.message ?? e) };
    }
  }, sid);
  record('runner', `pty.input(b) returned: ${JSON.stringify(typeRes2)}`);
  await sleep(1500);

  // Done — dump and exit.
  await electronApp.close().catch(() => {});

  console.log('\n========== TIMELINE ==========');
  for (const e of events) console.log(e);
  console.log('========== END TIMELINE ==========');
  console.log(`\nTotal events captured: ${events.length}`);

  // -----------------------------------------------------------------
  // Success-criterion assertions (PR #1361 fix verification)
  // -----------------------------------------------------------------
  // The original bug pattern: post-action `attach.warm.shown` with
  // cause:"retry" appears, no fresh `[main] spawn`, ptyEntry stays
  // null, overlay never goes away. The fix should produce the inverse.
  console.log('\n========== ASSERTIONS ==========');
  const eventText = events.join('\n');

  const checks = [];
  // --- A: reloadSession ---
  const reloadIdx = events.findIndex((e) => e.includes('USER ACTION A: reloadSession'));
  const setupBIdx = events.findIndex((e) => e.includes('USER ACTION B SETUP'));
  const eventsAfterReload = events.slice(reloadIdx + 1);
  const eventsBetweenReloadAndKill = events.slice(
    reloadIdx + 1,
    setupBIdx === -1 ? events.length : setupBIdx,
  );
  const retryIdx = events.findIndex((e) => e.includes('USER ACTION B: click Retry'));
  const eventsAfterRetry = events.slice(retryIdx + 1);
  void eventText;
  void eventsAfterReload;

  checks.push({
    name: 'A1: warmEvict cause:reload fired after reload action',
    pass: eventsBetweenReloadAndKill.some((e) =>
      /terminal\.warmEvict.*"cause":"reload"/.test(e),
    ),
    detail: '(warm entry torn down — without fix, this is absent)',
  });
  checks.push({
    name: 'A2: terminal.warmAlloc fired after reload (cold path allocated fresh entry)',
    pass: eventsBetweenReloadAndKill.some((e) => /terminal\.warmAlloc/.test(e)),
    detail: '(without fix, warmAlloc is absent — attach takes warm branch)',
  });
  checks.push({
    name: 'A3: attach.snapshot.applied fired after reload (cold attach completed)',
    pass: eventsBetweenReloadAndKill.some((e) => /attach\.snapshot\.applied/.test(e)),
    detail: '(without fix, no cold-attach probes fire)',
  });
  // The damning warm.shown cause:"retry" should NOT appear after the reload
  // action — the cold path should run instead.
  const warmShownRetryAfterReload = eventsBetweenReloadAndKill.find((e) =>
    /attach\.warm\.shown.*"cause":"retry"/.test(e),
  );
  checks.push({
    name: 'A4: no attach.warm.shown cause:retry after reload (cold path taken)',
    pass: !warmShownRetryAfterReload,
    detail: warmShownRetryAfterReload ?? 'absent — cold path executed',
  });
  checks.push({
    name: 'A5: pty.input(a) accepted post-reload',
    pass: typeRes?.ok === true && typeRes?.r?.ok !== false,
    detail: JSON.stringify(typeRes),
  });

  // --- B: Retry click ---
  const postRetryPid = postRetry.ptyEntry?.pid ?? null;
  checks.push({
    name: 'B1: warmEvict cause:retry fired after Retry click',
    pass: eventsAfterRetry.some((e) => /terminal\.warmEvict.*"cause":"retry"/.test(e)),
    detail: '(without fix, retry never tears down the stale warm entry)',
  });
  checks.push({
    name: 'B2: post-retry ptyEntry non-null (fresh PTY spawned)',
    pass: postRetryPid != null,
    detail: `postRetry.ptyEntry=${JSON.stringify(postRetry.ptyEntry)}`,
  });
  checks.push({
    name: 'B3: attach.snapshot.applied fired after Retry (cold path executed)',
    pass: eventsAfterRetry.some((e) => /attach\.snapshot\.applied/.test(e)),
    detail: '(without fix, no fresh attach happens)',
  });
  checks.push({
    name: 'B4: overlay text gone after Retry',
    pass: postRetry.stillHasOverlayText === false,
    detail: `stillHasOverlayText=${postRetry.stillHasOverlayText}`,
  });
  checks.push({
    name: 'B5: disconnectedSessions cleared post-retry',
    pass: postRetry.disconnected == null,
    detail: `disconnected=${JSON.stringify(postRetry.disconnected)}`,
  });
  checks.push({
    name: 'B6: state transitioned exit -> attaching on retry click',
    pass: eventsAfterRetry.some((e) =>
      /attach\.state\.transition.*"from":"exit".*"to":"attaching".*"reason":"retry"/.test(e),
    ),
    detail: '(synchronous overlay dismissal signal)',
  });
  checks.push({
    name: 'B7: pty.input(b) accepted post-retry',
    pass: typeRes2?.ok === true && typeRes2?.r?.ok !== false,
    detail: JSON.stringify(typeRes2),
  });

  let failed = 0;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) failed += 1;
    console.log(`  [${tag}] ${c.name}  ::  ${c.detail}`);
  }
  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  console.log('\n========== PARTIAL TIMELINE ==========');
  for (const e of events) console.log(e);
  process.exit(1);
});
