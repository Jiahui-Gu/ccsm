// scripts/dogfood-bug-82-scrollbar.mjs
//
// Bug #82 dogfood probe — native `.xterm-viewport` scrollbar reconcile.
//
// The self-drawn <TerminalScrollbar/> projection was reverted; xterm owns
// the native `.xterm-viewport` scrollbar again. The #82 bug: when the user
// scrolls UP (viewportY < baseY) and then switches away to another session
// and back, the `display:none → ''` reveal makes webkit silently zero
// `.xterm-viewport.scrollTop` WITHOUT a scroll event. xterm's own state
// (`buffer.active.viewportY` / `baseY`) is unchanged, so the DOM scrollTop
// and xterm's ydisp drift apart: the scrollbar thumb snaps to the top while
// the content is still scrolled up.
//
// The fix forces `syncScrollArea(true)` at the showShell chokepoint, which
// rewrites `scrollTop = ydisp * rowHeight`. So after switch-away-and-back,
// the invariant must hold:
//
//   .xterm-viewport.scrollTop  ≈  viewportY * cellHeight
//
// The OLD (buggy) behavior is scrollTop === 0 while viewportY > 0 → Δ huge.
//
// Strategy:
//   1. Seed TWO sessions so we have something to switch to.
//   2. On session A: grow scrollback (small viewport), scroll UP so
//      viewportY < baseY (and scrollTop > 0).
//   3. Switch to B, then back to A (the display flip that triggers #82).
//   4. Read scrollTop vs viewportY*cellHeight; assert Δ is small.
//
// If baseY === 0 (no scrollback, e.g. alt-buffer) the probe passes
// vacuously — there's no scroll position to desync.
//
// Exit code 0 = PASS, 1 = FAIL.

import { mkdtempSync } from 'node:fs';
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

// Read the active xterm's native viewport scrollTop alongside xterm's own
// scroll state, so we can compare DOM scrollTop against ydisp*cellHeight.
async function readViewportState(win) {
  return await win.evaluate(() => {
    const t = window.__ccsmTerm;
    if (!t) return { ok: false, reason: 'no __ccsmTerm' };
    // The active wrapper is the one whose host is not display:none.
    const viewports = Array.from(
      document.querySelectorAll('.xterm-viewport'),
    ).filter((el) => {
      const wrap = el.closest('[data-ccsm-shell-sid]');
      return wrap instanceof HTMLElement && wrap.style.display !== 'none';
    });
    const vp = viewports[0] ?? document.querySelector('.xterm-viewport');
    if (!(vp instanceof HTMLElement)) return { ok: false, reason: 'no .xterm-viewport' };
    let cellHeight = null;
    try {
      const dims = t._core?._renderService?.dimensions?.css?.cell;
      if (dims && typeof dims.height === 'number') cellHeight = dims.height;
    } catch {
      /* best-effort */
    }
    return {
      ok: true,
      viewportY: t.buffer?.active?.viewportY ?? null,
      baseY: t.buffer?.active?.baseY ?? null,
      rows: t.rows ?? null,
      bufferType: t.buffer?.active?.type ?? null,
      scrollTop: vp.scrollTop,
      scrollHeight: vp.scrollHeight,
      clientHeight: vp.clientHeight,
      cellHeight,
    };
  });
}

async function captureScreenshot(win, label, outDir) {
  try {
    const file = path.join(outDir, `scrollbar-${label}.png`);
    await win.screenshot({ path: file, fullPage: false });
    console.log(`  screenshot: ${file}`);
    return file;
  } catch (e) {
    console.log(`  screenshot ${label} failed: ${e.message}`);
    return null;
  }
}

async function main() {
  const { tempDir } = await createIsolatedClaudeDir();
  const screenshotDir = mkdtempSync(path.join(tmpdir(), 'ccsm-scrollbar-shots-'));
  console.log(`screenshot dir: ${screenshotDir}`);

  const { electronApp, win } = await launchCcsmIsolated({ tempDir });

  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    // Small window so the cold-start snapshot overflows the viewport and
    // creates scrollback (baseY > 0) — the case where a scrollbar renders.
    await win.setViewportSize({ width: 600, height: 220 }).catch(() => {});
    await sleep(200);

    const a = await seedSession(win, { name: 'scrollbar-A', cwd: tempDir });
    const b = await seedSession(win, { name: 'scrollbar-B', cwd: tempDir });
    const sidA = a.sid;
    const sidB = b.sid;

    // Bring up A first and let it paint scrollback.
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
    await waitForTerminalReady(win, sidA, { timeout: 45000 });
    await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, {
      timeout: 30000,
    });
    await dismissWelcomeSplash(win).catch(() => {});
    await sleep(500);

    // Scroll UP on A so viewportY < baseY (and scrollTop > 0).
    await win.evaluate(() => {
      const t = window.__ccsmTerm;
      if (t && typeof t.scrollToTop === 'function') t.scrollToTop();
    });
    await sleep(300);

    const before = await readViewportState(win);
    console.log(`A scrolled-up: ${JSON.stringify(before)}`);
    await captureScreenshot(win, 'A-scrolled-up', screenshotDir);

    if (!before.ok || before.baseY == null) {
      console.error('FAIL: viewport state unavailable on A');
      process.exitCode = 1;
      return;
    }
    if (before.baseY <= 0) {
      console.log(
        `PASS (vacuous): no scrollback on A (baseY=${before.baseY}, ` +
          `${before.bufferType} buffer) — nothing to desync.`,
      );
      return;
    }

    // Switch B → back to A. The display:none → '' reveal is what triggers
    // #82's webkit scrollTop-zeroing.
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidB);
    await waitForTerminalReady(win, sidB, { timeout: 45000 });
    await sleep(400);
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
    await sleep(500);

    const after = await readViewportState(win);
    console.log(`A after switch-back: ${JSON.stringify(after)}`);
    await captureScreenshot(win, 'A-after-switchback', screenshotDir);

    if (!after.ok || after.cellHeight == null) {
      console.error('FAIL: viewport/cellHeight unavailable after switch-back');
      process.exitCode = 1;
      return;
    }

    const expectedScrollTop = after.viewportY * after.cellHeight;
    const delta = Math.abs(after.scrollTop - expectedScrollTop);
    // One cell of tolerance for sub-pixel rounding in xterm's _innerRefresh.
    const tol = after.cellHeight + 1;
    console.log(
      `viewportY=${after.viewportY} baseY=${after.baseY} cellH=${after.cellHeight} ` +
        `expectedScrollTop=${expectedScrollTop.toFixed(2)} actualScrollTop=${after.scrollTop} ` +
        `Δ=${delta.toFixed(2)} tol=${tol.toFixed(2)}`,
    );

    if (after.viewportY > 0 && after.scrollTop === 0) {
      console.error(
        'FAIL (#82 reproduced): scrollTop zeroed on reveal while ' +
          `viewportY=${after.viewportY} — native scrollbar desynced.`,
      );
      process.exitCode = 1;
      return;
    }

    if (delta <= tol) {
      console.log(
        `PASS: native viewport scrollTop tracks xterm ydisp after ` +
          `switch-away-and-back (reconcileView held).`,
      );
      return;
    }

    console.error(
      `FAIL: scrollTop desynced from viewportY*cellHeight after reveal ` +
        `(Δ=${delta.toFixed(2)} > tol=${tol.toFixed(2)}). ` +
        `See reconcileView in src/terminal/shellRegistry.ts.`,
    );
    process.exitCode = 1;
  } finally {
    await electronApp.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
