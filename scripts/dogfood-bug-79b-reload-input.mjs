// scripts/dogfood-bug-79b-reload-input.mjs
//
// Regression probe for Task #79b — "keyboard input dead after reload" on
// Windows. Asserts the end-to-end contract that survived the empirical
// root-cause investigation:
//
//   1. After `reloadSession(sid)`, main-side `pty.list()` contains the
//      freshly-spawned entry under the same sid for ≥2s post-reload.
//      (Pre-fix: the OLD pty's late `onExit` clobbers the fresh entry
//      because Windows `pty.kill('SIGKILL')` throws "Signals not
//      supported on windows" → entry async-reaped via `killProcessSubtree`
//      → OLD pty's natural onExit fires LATE → unconditional
//      `sessions.delete(sid)` evicts the LIVE fresh entry → every
//      subsequent `pty:input` IPC silently drops.)
//
//   2. After typing into the post-reload xterm via the normal onData →
//      `ccsmPty.input` IPC path, the xterm buffer reflects the input
//      (claude echoes / advances past the trust-folder prompt).
//
// Exit 0 = both invariants hold. Exit 1 = regression.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  dismissWelcomeSplash,
  launchCcsmIsolated,
  seedSession,
  sendToClaudeTui,
  waitForTerminalReady,
  waitForXtermBuffer,
} from './probe-utils-real-cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let exitCode = 0;
function fail(msg) { console.error('FAIL:', msg); exitCode = 1; }

async function main() {
  const { tempDir } = await createIsolatedClaudeDir();
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccsm-79b-cwd-'));

  const { electronApp, win } = await launchCcsmIsolated({
    tempDir,
    env: { CCSM_E2E_HIDDEN: '1' },
  });

  // Visibility guard — never open a visible window on the user's desktop.
  const visibilityProbe = await electronApp.evaluate(({ BrowserWindow }) => {
    return BrowserWindow.getAllWindows().map((w) => {
      const b = w.getBounds();
      return { x: b.x, y: b.y, offscreen: b.x <= -10000 && b.y <= -10000 };
    });
  });
  if (!visibilityProbe.every((w) => w.offscreen)) {
    await electronApp.close().catch(() => {});
    throw new Error(`window not offscreen: ${JSON.stringify(visibilityProbe)}`);
  }

  const { sid } = await seedSession(win, { cwd, name: 'bug-79b' });
  await waitForTerminalReady(win, sid, { timeout: 45000 });
  await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30000 });
  await dismissWelcomeSplash(win);
  await sleep(1500);

  // RELOAD.
  await win.evaluate((s) => window.__ccsmStore.getState().reloadSession(s), sid);
  await win.waitForFunction(
    (s) => (window.__ccsmStore.getState().reloadNonce[s] ?? 0) > 0,
    sid,
    { timeout: 20000 },
  );
  // Wait for mask to go off (cold-suffix complete).
  await win.waitForFunction(
    (s) => {
      const w = document.querySelector(`[data-ccsm-shell-sid="${s}"]`);
      const mask = w?.querySelector('[data-ccsm-shell-mask]');
      return mask instanceof HTMLElement && mask.style.display === 'none';
    },
    sid,
    { timeout: 30000 },
  );

  // INVARIANT 1: fresh pty entry stays in main's sessions map for ≥2s.
  // Pre-fix: the OLD pty's wedged-kill async-reap fires its natural
  // onExit LATE, unconditionally deletes the fresh entry under the same
  // sid. Listen at 0, 1s, 2s.
  const samples = [];
  for (const delay of [0, 1000, 2000]) {
    if (delay > 0) await sleep(delay);
    const list = await win.evaluate(() => window.ccsmPty.list());
    samples.push({ at: delay, entry: list.find((e) => e.sid === sid) ?? null });
  }
  console.log(`pty.list samples post-reload: ${JSON.stringify(samples)}`);
  const allPresent = samples.every((s) => s.entry != null);
  if (!allPresent) {
    fail(`fresh pty entry vanished from sessions map between mask-off and 2s post-reload: ${JSON.stringify(samples)}`);
  } else {
    console.log('PASS invariant 1: fresh pty entry survives in main sessions map');
  }

  // INVARIANT 2: keystrokes flow through to the fresh pty (claude advances
  // past the trust-folder prompt). Type "1" + Enter to trust the folder.
  const beforeBuf = await win.evaluate(() => {
    const t = window.__ccsmTerm;
    if (!t) return null;
    const buf = t.buffer.active;
    const lines = [];
    for (let i = 0; i < Math.min(buf.length, t.rows); i++) {
      const l = buf.getLine(buf.viewportY + i);
      if (l) lines.push(l.translateToString(true));
    }
    return lines.join('\n');
  });
  await sendToClaudeTui(win, '1');
  await sleep(300);
  await sendToClaudeTui(win, '\r');
  await sleep(2500);
  const afterBuf = await win.evaluate(() => {
    const t = window.__ccsmTerm;
    if (!t) return null;
    const buf = t.buffer.active;
    const lines = [];
    for (let i = 0; i < Math.min(buf.length, t.rows); i++) {
      const l = buf.getLine(buf.viewportY + i);
      if (l) lines.push(l.translateToString(true));
    }
    return lines.join('\n');
  });

  if (afterBuf === beforeBuf) {
    fail('xterm buffer did NOT change after typing "1"+Enter — pty input dead');
    console.error('--- buffer (unchanged):\n' + beforeBuf.slice(-500));
  } else {
    console.log('PASS invariant 2: xterm buffer advanced after keystroke');
  }

  await electronApp.close().catch(() => {});
}

main().then(() => process.exit(exitCode)).catch((err) => {
  console.error('FAIL:', err?.stack ?? err);
  process.exit(1);
});
