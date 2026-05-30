// scripts/dogfood-bug-82-scrollbar.mjs
//
// Terminal scrollbar geometry probe (Approach A — self-drawn thumb).
//
// The terminal's scrollbar is no longer the native `.xterm-viewport` bar;
// it's drawn by <TerminalScrollbar/> as a PURE projection of xterm's
// buffer state (`buffer.active.viewportY` / `baseY` / `term.rows`) onto a
// thumb rect. Because there is no reverse DOM `scrollTop` sync, the thumb
// can't desync from the content — and crucially this lets us assert a
// DETERMINISTIC relation instead of the old bug-82 probe's flaky "thumb
// ended up at the bottom" check (which couldn't reliably FAIL — the race
// was sub-frame).
//
// Assertion: read the live buffer geometry AND the self-drawn thumb's
// `style.top` / `style.height`, then verify they satisfy the same pure
// geometry the unit tests pin:
//
//   total       = baseY + rows
//   thumbHeight = max(MIN_THUMB, H * rows / total)   (H = track height px)
//   thumbTop    = (H - thumbHeight) * viewportY / baseY
//
// If `baseY === 0` (no scrollback, e.g. claude is in the alt-buffer) the
// scrollbar is correctly absent and the probe passes vacuously.
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

// Keep in sync with `MIN_THUMB` in src/terminal/useTerminalScroll.ts.
const MIN_THUMB = 24;

async function readGeometry(win) {
  return await win.evaluate(() => {
    const t = window.__ccsmTerm;
    const track = document.querySelector('[data-terminal-scrollbar]');
    const thumb = document.querySelector('[data-terminal-scrollbar-thumb]');
    const trackRect =
      track instanceof HTMLElement ? track.getBoundingClientRect() : null;
    return {
      viewportY: t?.buffer?.active?.viewportY ?? null,
      baseY: t?.buffer?.active?.baseY ?? null,
      rows: t?.rows ?? null,
      bufferType: t?.buffer?.active?.type ?? null,
      trackHeight: trackRect ? trackRect.height : null,
      thumbPresent: thumb instanceof HTMLElement,
      thumbTop:
        thumb instanceof HTMLElement ? parseFloat(thumb.style.top) : null,
      thumbHeight:
        thumb instanceof HTMLElement ? parseFloat(thumb.style.height) : null,
    };
  });
}

function expectedThumb(g) {
  const total = g.baseY + g.rows;
  const rawHeight = (g.trackHeight * g.rows) / total;
  const thumbHeight = Math.min(
    g.trackHeight,
    Math.max(MIN_THUMB, rawHeight),
  );
  const travel = g.trackHeight - thumbHeight;
  const clampedViewportY = Math.max(0, Math.min(g.baseY, g.viewportY));
  const thumbTop = travel > 0 ? (travel * clampedViewportY) / g.baseY : 0;
  return { thumbTop, thumbHeight };
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

    const { sid } = await seedSession(win, { name: 'scrollbar', cwd: tempDir });
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sid);
    await waitForTerminalReady(win, sid, { timeout: 45000 });

    await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, {
      timeout: 30000,
    });
    await dismissWelcomeSplash(win).catch(() => {});
    await sleep(500);

    const g = await readGeometry(win);
    console.log(`geometry: ${JSON.stringify(g)}`);
    await captureScreenshot(win, 'cold-start', screenshotDir);

    if (g.baseY == null || g.rows == null) {
      console.error('FAIL: __ccsmTerm buffer geometry unavailable');
      process.exitCode = 1;
      return;
    }

    if (g.baseY <= 0) {
      console.log(
        `PASS (vacuous): no scrollback (baseY=${g.baseY}, ${g.bufferType} buffer) — ` +
          `scrollbar correctly ${g.thumbPresent ? 'STILL PRESENT (BUG!)' : 'absent'}`,
      );
      if (g.thumbPresent) {
        console.error('FAIL: scrollbar rendered with no scrollback');
        process.exitCode = 1;
      }
      return;
    }

    if (!g.thumbPresent || g.trackHeight == null) {
      console.error(
        `FAIL: scrollback exists (baseY=${g.baseY}) but no self-drawn thumb rendered`,
      );
      process.exitCode = 1;
      return;
    }

    const exp = expectedThumb(g);
    // 1px tolerance for sub-pixel rounding between the React style write
    // and getBoundingClientRect's track height.
    const dTop = Math.abs(g.thumbTop - exp.thumbTop);
    const dHeight = Math.abs(g.thumbHeight - exp.thumbHeight);
    console.log(
      `expected thumbTop=${exp.thumbTop.toFixed(2)} height=${exp.thumbHeight.toFixed(2)}; ` +
        `actual thumbTop=${g.thumbTop} height=${g.thumbHeight}; ` +
        `Δtop=${dTop.toFixed(2)} Δheight=${dHeight.toFixed(2)}`,
    );

    if (dTop <= 1 && dHeight <= 1) {
      console.log(
        `PASS: self-drawn thumb geometry matches f(viewportY=${g.viewportY}, ` +
          `baseY=${g.baseY}, rows=${g.rows}, H=${g.trackHeight})`,
      );
      return;
    }

    console.error(
      `FAIL: thumb geometry desynced from buffer. ` +
        `viewportY=${g.viewportY}/baseY=${g.baseY} rows=${g.rows} H=${g.trackHeight} ` +
        `(${g.bufferType} buffer). See src/terminal/useTerminalScroll.ts computeThumb.`,
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
