// scripts/dogfood-pr-1374-warm-scroll-preserved.mjs
//
// PR #1374 regression probe — `.xterm-viewport.scrollTop` must be preserved
// across A → B → A warm session switch.
//
// Background: webkit drops `.xterm-viewport` scrollTop when the warm
// entry's wrapper is reparented out of the layout tree (offscreen
// holder). xterm's logical viewportY survives the detour (the canvas
// keeps painting the right rows), but the DOM scrollbar thumb snaps to
// the top. User-visible symptom: "右侧的滚动条是永远置顶的" — task #49.
//
// Why this lives in its own dogfood script (not in harness-real-cli's
// switch-session-keeps-chat or in harness-ui terminal-pane-mounted):
//   * The real-cli case starts claude TUI, which enters alt-screen mode
//     within ~1s of attach. Alt-buffer has no scrollable scrollback, so
//     `.xterm-viewport.scrollTop` is pinned at 0 there and the bug is
//     unobservable. We need a normal-buffer state to exercise the
//     repro path the user actually saw (their scrollbar implies normal
//     buffer either pre-alt-switch or post-alt-exit).
//   * harness-ui keeps the per-case body small; this case needs a
//     second session + a real PTY pair + write/scroll/switch
//     choreography that's heavier than a wiring contract.
//
// Exit code 0 = PASS, 1 = FAIL (CI / pre-push gate compatible).

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  dismissWelcomeSplash,
  launchCcsmIsolated,
  seedSession,
  waitForTerminalReady,
  waitForXtermBuffer,
} from './probe-utils-real-cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readScrollState(win) {
  return await win.evaluate(() => {
    const t = window.__ccsmTerm;
    const b = t?.buffer?.active;
    const vp = document.querySelector('.xterm-viewport');
    return {
      viewportY: b?.viewportY ?? null,
      baseY: b?.baseY ?? null,
      bufferType: t?.buffer?.active?.type ?? null,
      scrollTop: vp instanceof HTMLElement ? vp.scrollTop : null,
      scrollHeight: vp instanceof HTMLElement ? vp.scrollHeight : null,
    };
  });
}

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ccsm-dogfood-1374-'));
  createIsolatedClaudeDir(tempDir);

  const { electronApp, win, userDataDir } = await launchCcsmIsolated({ tempDir });

  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    const { sid: sidA } = await seedSession(win, { name: 'A', cwd: tempDir });
    const { sid: sidB } = await seedSession(win, { name: 'B', cwd: tempDir });

    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
    await waitForTerminalReady(win, sidA, { timeout: 45000 });
    await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30000 });
    await dismissWelcomeSplash(win);

    // Drop claude's alt-screen state if it has gone there — we need to
    // exercise the normal-buffer scrollback path, which is the surface
    // the bug actually showed up on.
    await win.evaluate(() => {
      const t = window.__ccsmTerm;
      // \x1b[?1049l = leave alt buffer (xterm-defined private mode 1049).
      // Safe to send even if we're not in alt — it's a no-op there.
      t.write('\x1b[?1049l');
      for (let i = 0; i < 200; i++) t.write(`pr1374-filler ${i}\r\n`);
      t.scrollLines(-40);
    });
    await sleep(200);

    const before = await readScrollState(win);
    if (before.bufferType !== 'normal') {
      throw new Error(`expected normal buffer for repro, got ${before.bufferType}`);
    }
    if (!before.scrollTop || before.scrollTop <= 0) {
      throw new Error(`pre-switch setup failed: expected scrollTop > 0, got ${before.scrollTop}`);
    }

    // A → B → A
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidB);
    await waitForTerminalReady(win, sidB, { timeout: 30000 });
    await sleep(300);

    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
    await waitForTerminalReady(win, sidA, { timeout: 30000 });
    await sleep(600);

    const after = await readScrollState(win);

    const ok =
      after.viewportY === before.viewportY &&
      after.scrollTop === before.scrollTop;

    console.log(`before: ${JSON.stringify(before)}`);
    console.log(`after:  ${JSON.stringify(after)}`);

    if (!ok) {
      console.error(
        `FAIL: warm switch lost scroll state. ` +
          `viewportY ${before.viewportY}→${after.viewportY}, ` +
          `scrollTop ${before.scrollTop}→${after.scrollTop}. ` +
          `PR #1374 regressed — see src/terminal/xtermWarmRegistry.ts ` +
          `ensureAndShowEntry save/restore of savedScrollTop.`,
      );
      // surface log tail for debugging
      const logPath = path.join(userDataDir, 'logs', 'main.log');
      if (existsSync(logPath)) {
        const tail = readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((l) => l.includes('warmHide') || l.includes('warmShow') || l.includes('attach.warm.shown'))
          .slice(-10);
        console.error('--- main.log tail ---');
        for (const l of tail) console.error(l);
      }
      process.exitCode = 1;
      return;
    }
    console.log('PASS');
  } finally {
    await electronApp.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
