// scripts/dogfood-attach-redesign.mjs
//
// E2E probe for task #72 — attach UX model from docs/attach-redesign.html.
//
// Three-state model:
//   State 0  No session ever opened. No shell wrappers exist under host.
//   State 1  Cold start in progress. The "preparing" mask is visible; the
//            target shell is mid-build behind it.
//   State 2  Ready / z-stack. Each visited session has a long-lived wrapper
//            under the host. Switching between visited sessions is a pure
//            DOM flip (no mask, no IPC).
//
// Acceptance:
//   * First click on session A triggers cold start (State 1 visible) →
//     State 2 with mask hidden. A's wrapper is parented under the host.
//   * Resume sessions land at the bottom of the buffer on reveal.
//   * Click on session B (first time) → another cold start; A's wrapper
//     stays parented under the host (`display:none`).
//   * Click back on A → INSTANT SWITCH: no mask ever visible, A's
//     viewport matches what it was when the user left.
//   * Wrappers NEVER reparent across switches.
//   * Multi-switch A→B→A→B→C→A is well-behaved (all instant, no mask).
//
// Note on the seedSession helper: it calls `createSession` which auto-
// selects the new session. So seeding A immediately attaches A. We
// therefore seed sessions one at a time and run the per-session checks
// inline (vs. seed all up front).

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

async function readShellState(win) {
  return await win.evaluate(() => {
    const host = document.querySelector('[data-ccsm-shell-host]');
    const wrappers = host
      ? Array.from(host.querySelectorAll('[data-ccsm-shell-sid]'))
      : [];
    const outer = document.querySelector('[data-terminal-host]');
    const mask = outer ? outer.querySelector('[data-ccsm-cold-mask]') : null;
    const active = window.__ccsmTerm;
    const buf = active?.buffer?.active;
    return {
      hostFound: !!host,
      wrapperCount: wrappers.length,
      wrappers: wrappers.map((w) => ({
        sid: w.getAttribute('data-ccsm-shell-sid'),
        display: w.style.display,
        zIndex: w.style.zIndex,
        parentMatchesHost: w.parentElement === host,
      })),
      maskVisible: !!mask,
      activeViewportY: buf?.viewportY ?? null,
      activeBaseY: buf?.baseY ?? null,
      activeAtBottom:
        buf ? buf.baseY - buf.viewportY <= 1 : null,
      activeBufferType: buf?.type ?? null,
    };
  });
}

async function waitForState(win, predicate, { timeout = 15000, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await readShellState(win);
    if (predicate(last)) return last;
    await sleep(40);
  }
  throw new Error(
    `waitForState timed out [${label}]: last state = ${JSON.stringify(last)}`,
  );
}

// Poll mask visibility every 10ms over a window of `ms` milliseconds.
// Returns true if the mask was ever visible during that window. Used to
// catch the brief cold-start window — much tighter than 50ms polling.
async function watchMaskWhile(win, work, { tickMs = 10, maxTicks = 200 } = {}) {
  let sawMask = false;
  let stop = false;
  const poller = (async () => {
    for (let i = 0; i < maxTicks && !stop; i++) {
      const s = await readShellState(win).catch(() => null);
      if (s?.maskVisible) sawMask = true;
      await sleep(tickMs);
    }
  })();
  try {
    await work();
  } finally {
    stop = true;
    await poller;
  }
  return sawMask;
}

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ccsm-dogfood-attach-'));
  createIsolatedClaudeDir(tempDir);
  const { electronApp, win, userDataDir } = await launchCcsmIsolated({ tempDir });

  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };

  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    // ====== State 0 baseline ======
    // Before any seedSession runs, the registry should be empty. Note
    // `[data-ccsm-shell-host]` may not exist yet if no session is selected
    // (TerminalPane only mounts on active session); we just verify no
    // shell wrappers anywhere in the document.
    const wrappersBeforeAny = await win.evaluate(
      () => document.querySelectorAll('[data-ccsm-shell-sid]').length,
    );
    check(
      wrappersBeforeAny === 0,
      `State 0: expected 0 shell wrappers before any selectSession, got ${wrappersBeforeAny}`,
    );

    // ====== Cold-start A: mask shows up, then goes away ======
    // seedSession auto-selects, so wrap the seed call in the mask watcher.
    let sidA;
    const sawMaskDuringA = await watchMaskWhile(win, async () => {
      const r = await seedSession(win, { name: 'A', cwd: tempDir });
      sidA = r.sid;
      await waitForTerminalReady(win, sidA, { timeout: 45000 });
      await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30000 });
    });
    check(
      sawMaskDuringA,
      'cold-start A: expected the preparing mask visible at some point during cold start',
    );
    await dismissWelcomeSplash(win);

    const stateAfterA = await waitForState(
      win,
      (s) =>
        !s.maskVisible &&
        s.wrapperCount === 1 &&
        s.wrappers[0]?.sid === sidA &&
        s.wrappers[0]?.display === '',
      { timeout: 30000, label: 'A-ready' },
    );
    check(
      stateAfterA.wrappers[0]?.parentMatchesHost === true,
      'cold-start A: shell wrapper must be a direct child of [data-ccsm-shell-host]',
    );
    check(
      stateAfterA.activeAtBottom === true,
      `cold-start A: expected viewport pinned at bottom, got viewportY=${stateAfterA.activeViewportY}, baseY=${stateAfterA.activeBaseY}`,
    );

    // ====== Cold-start B: mask shows again ======
    let sidB;
    const sawMaskDuringB = await watchMaskWhile(win, async () => {
      const r = await seedSession(win, { name: 'B', cwd: tempDir });
      sidB = r.sid;
      await waitForTerminalReady(win, sidB, { timeout: 45000 });
    });
    check(sawMaskDuringB, 'cold-start B: expected the preparing mask during B cold start');
    const stateAfterB = await waitForState(
      win,
      (s) =>
        !s.maskVisible &&
        s.wrapperCount === 2 &&
        s.wrappers.find((w) => w.sid === sidB && w.display === '') &&
        s.wrappers.find((w) => w.sid === sidA && w.display === 'none'),
      { timeout: 30000, label: 'B-ready' },
    );
    check(
      stateAfterB.wrappers.every((w) => w.parentMatchesHost),
      'after B cold start: both A and B wrappers must remain parented under host (no reparent)',
    );

    // ====== Set up a scroll position on A so instant-switch preservation is observable ======
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
    await waitForState(win, (s) => s.wrappers.find((w) => w.sid === sidA)?.display === '', {
      timeout: 5000,
      label: 'A-after-return-1',
    });
    await sleep(200);
    await win.evaluate(async () => {
      const t = window.__ccsmTerm;
      // Leave alt-buffer if claude TUI entered it (normal buffer is the
      // only one with scrollable scrollback we can exercise here).
      await new Promise((resolve) => t.write('\x1b[?1049l', () => resolve()));
      for (let i = 0; i < 200; i++) {
        await new Promise((resolve) => t.write(`probe-filler ${i}\r\n`, () => resolve()));
      }
      // Now the WriteBuffer has fully drained — viewport is at bottom.
      // scrollLines(-40) is observable from here on.
      t.scrollLines(-40);
    });
    await sleep(300);
    const aBefore = await readShellState(win);
    check(
      aBefore.activeBufferType === 'normal',
      `A scroll-state setup: expected normal buffer, got ${aBefore.activeBufferType}`,
    );
    check(
      aBefore.activeAtBottom === false,
      `A scroll-state setup: expected viewport NOT at bottom after scrollLines(-40), viewportY=${aBefore.activeViewportY}, baseY=${aBefore.activeBaseY}`,
    );

    // ====== Instant switch A → B → A: mask never visible during return ======
    const sawMaskOnReturnToA = await watchMaskWhile(win, async () => {
      await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidB);
      await sleep(150);
      await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
      await sleep(200);
    });
    check(
      !sawMaskOnReturnToA,
      'instant switch A→B→A: mask must NEVER be visible for already-seen sessions',
    );

    const aAfterReturn = await readShellState(win);
    check(
      aAfterReturn.activeViewportY === aBefore.activeViewportY,
      `instant switch: viewportY must be preserved, got ${aBefore.activeViewportY}→${aAfterReturn.activeViewportY}`,
    );
    check(
      aAfterReturn.wrappers.find((w) => w.sid === sidA)?.display === '',
      'instant switch: A wrapper must have display:""',
    );
    check(
      aAfterReturn.wrappers.find((w) => w.sid === sidB)?.display === 'none',
      'instant switch: B wrapper must have display:"none"',
    );
    check(
      aAfterReturn.wrappers.every((w) => w.parentMatchesHost),
      'instant switch: wrappers must remain parented under host',
    );

    // ====== Cold-start C (still unvisited): mask shows again ======
    let sidC;
    const sawMaskDuringC = await watchMaskWhile(win, async () => {
      const r = await seedSession(win, { name: 'C', cwd: tempDir });
      sidC = r.sid;
      await waitForTerminalReady(win, sidC, { timeout: 45000 });
    });
    check(sawMaskDuringC, 'cold-start C: expected the preparing mask');
    await waitForState(
      win,
      (s) => !s.maskVisible && s.wrapperCount === 3,
      { timeout: 30000, label: 'C-ready' },
    );

    // ====== Multi-switch A→B→A→B→C→A: all instant after C cold start ======
    const switches = [sidA, sidB, sidA, sidB, sidC, sidA];
    const sawMaskInMultiSwitch = await watchMaskWhile(win, async () => {
      for (const target of switches) {
        await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), target);
        await sleep(60);
      }
    });
    check(
      !sawMaskInMultiSwitch,
      'multi-switch A→B→A→B→C→A: mask must never appear (all sessions visited)',
    );

    const finalState = await readShellState(win);
    check(
      finalState.wrapperCount === 3,
      `final: expected 3 shell wrappers (kept for whole renderer lifetime), got ${finalState.wrapperCount}`,
    );
    check(
      finalState.wrappers.every((w) => w.parentMatchesHost),
      'final: every wrapper still parented under host (no LRU eviction)',
    );
    const activeFinal = finalState.wrappers.find((w) => w.display === '');
    check(
      activeFinal?.sid === sidA,
      `final: A must be active, got ${activeFinal?.sid}`,
    );

    if (failures.length > 0) {
      console.error(`FAIL — ${failures.length} check(s) failed:`);
      for (const f of failures) console.error(`  - ${f}`);
      const logPath = path.join(userDataDir, 'logs', 'main.log');
      if (existsSync(logPath)) {
        const tail = readFileSync(logPath, 'utf8')
          .split('\n')
          .filter(
            (l) =>
              l.includes('shell.') ||
              l.includes('attach.state.transition') ||
              l.includes('cold-mask'),
          )
          .slice(-30);
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
