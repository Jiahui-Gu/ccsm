// scripts/dogfood-scrollbar-wheel-tracks-thumb.mjs
//
// Architecture probe for the self-drawn terminal scrollbar (PR #1442 +
// follow-up). Proves the thumb is bound to xterm's `buffer.active.viewportY`
// — the single source of truth — so it follows EVERY scroll input, including
// the one that was broken: real mouse wheel.
//
// The bug this guards: xterm's `onScroll` emitter does NOT fire on
// mouse-wheel (or middle-mouse-button) scrolling — that path goes through
// DOM scroll + repaint, mutating `viewportY` without an event. The original
// scrollbar subscribed only to discrete xterm events, so the thumb froze at
// its last position while the viewport scrolled up under the wheel
// (user symptom "任何时候滚动条都在底部" / thumb pinned to bottom). PR #1448
// tried to patch this by adding an `onRender` subscription — still
// whack-a-mole, middle-mouse stayed broken. This probe verifies the
// architecture-level fix: `useTerminalScroll` now samples buffer geometry on
// a requestAnimationFrame loop, so the thumb tracks `viewportY` regardless
// of which input changed it.
//
// Steps:
//   1. force the terminal into normal buffer
//   2. write enough lines to create scrollback (baseY > 0)
//   3. scroll the viewport to the bottom (live tail) — thumb rests at bottom
//   4. real mouse-wheel UP over the terminal host (win.mouse.wheel)
//   5. read xterm geometry (viewportY / baseY / rows), the track px height,
//      AND the rendered self-drawn thumb's style.top
//   6. assert: viewportY moved off the tail, the thumb MOVED off the bottom,
//      and thumbTop matches the pure projection f(viewportY,...) within ~1px.
//
// NOTE on middle-mouse: Playwright cannot synthesize the OS-level
// middle-button autoscroll gesture, but middle-mouse scrolling goes through
// the exact same `viewportY`-without-`onScroll` code path that the mouse
// wheel exercises here. Driving the wheel proves both are covered by the
// single rAF binding.
//
// Exit code 0 = PASS (thumb tracks viewportY after wheel), 1 = FAIL.

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

const MIN_THUMB = 24; // keep in sync with useTerminalScroll.ts

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

// Mirror of computeThumb() in src/terminal/useTerminalScroll.ts — the pure
// projection the rendered thumb must match.
function expectedThumb(g) {
  const total = g.baseY + g.rows;
  const rawHeight = (g.trackHeight * g.rows) / total;
  const thumbHeight = Math.min(g.trackHeight, Math.max(MIN_THUMB, rawHeight));
  const travel = g.trackHeight - thumbHeight;
  const clampedViewportY = Math.max(0, Math.min(g.baseY, g.viewportY));
  const thumbTop = travel > 0 ? (travel * clampedViewportY) / g.baseY : 0;
  return { thumbTop, thumbHeight, travel };
}

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ccsm-scrollbar-wheel-'));
  createIsolatedClaudeDir(tempDir);

  const { electronApp, win } = await launchCcsmIsolated({ tempDir });

  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    await win.setViewportSize({ width: 700, height: 400 }).catch(() => {});
    await sleep(200);

    const { sid } = await seedSession(win, { name: 'wheel', cwd: tempDir });
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sid);
    await waitForTerminalReady(win, sid, { timeout: 45000 });
    await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, {
      timeout: 30000,
    });
    await dismissWelcomeSplash(win).catch(() => {});
    await sleep(500);

    // Force normal buffer + create scrollback, then scroll to the bottom
    // (live tail) so the thumb's resting position is the bottom of the track.
    await win.evaluate(() => {
      const t = window.__ccsmTerm;
      t.write('\x1b[?1049l'); // leave alt buffer (no-op if already normal)
      for (let i = 0; i < 200; i++) t.write(`scrollbar-wheel filler ${i}\r\n`);
    });
    await sleep(300);
    await win.evaluate(() => window.__ccsmTerm.scrollToBottom());
    await sleep(300);

    const beforeWheel = await readGeometry(win);
    console.log(`geometry at tail (before wheel): ${JSON.stringify(beforeWheel)}`);

    if (beforeWheel.bufferType !== 'normal') {
      console.error(`SETUP FAIL: expected normal buffer, got ${beforeWheel.bufferType}`);
      process.exitCode = 1;
      return;
    }
    if (beforeWheel.baseY == null || beforeWheel.baseY <= 0) {
      console.error(`SETUP FAIL: no scrollback (baseY=${beforeWheel.baseY})`);
      process.exitCode = 1;
      return;
    }
    if (!beforeWheel.thumbPresent || beforeWheel.trackHeight == null) {
      console.error(`SETUP FAIL: no self-drawn thumb (baseY=${beforeWheel.baseY})`);
      process.exitCode = 1;
      return;
    }
    const expBefore = expectedThumb(beforeWheel);
    // Thumb should be resting at the bottom at the live tail.
    if (beforeWheel.thumbTop < expBefore.travel - 2) {
      console.error(
        `SETUP FAIL: thumb not at bottom before wheel ` +
          `(thumbTop=${beforeWheel.thumbTop}, expected≈${expBefore.travel.toFixed(2)})`,
      );
      process.exitCode = 1;
      return;
    }

    // Real mouse wheel UP over the terminal host — the path that mutates
    // viewportY WITHOUT emitting onScroll. `term.scrollLines(...)` would NOT
    // reproduce the broken input path.
    const host = await win.$('[data-terminal-host]');
    const box = await host.boundingBox();
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 12; i++) {
      await win.mouse.wheel(0, -120);
      await sleep(40);
    }
    await sleep(400);

    const g = await readGeometry(win);
    console.log(`geometry after real wheel-up x12: ${JSON.stringify(g)}`);

    if (g.viewportY >= g.baseY) {
      console.error(
        `SETUP FAIL: wheel did not move viewportY off the tail ` +
          `(viewportY=${g.viewportY} baseY=${g.baseY})`,
      );
      process.exitCode = 1;
      return;
    }

    const exp = expectedThumb(g);
    const bottomThreshold = exp.travel - 1; // "pinned to bottom" if >= this
    const dExpected = Math.abs(g.thumbTop - exp.thumbTop);
    const movedOffBottom = beforeWheel.thumbTop - g.thumbTop;

    console.log(
      `viewportY=${g.viewportY}/baseY=${g.baseY} travel=${exp.travel.toFixed(2)} ` +
        `expected thumbTop=${exp.thumbTop.toFixed(2)} actual thumbTop=${g.thumbTop} ` +
        `(Δproj=${dExpected.toFixed(2)}) moved up by ${movedOffBottom.toFixed(2)}px`,
    );

    // Bug signature: scrolled up (viewportY << baseY) yet thumb sits at the
    // very bottom of the track.
    if (g.thumbTop >= bottomThreshold) {
      console.error(
        `FAIL (bug present): thumb pinned to bottom after wheel. ` +
          `thumbTop=${g.thumbTop} >= travel-1=${bottomThreshold.toFixed(2)} ` +
          `while viewportY=${g.viewportY} << baseY=${g.baseY}. ` +
          `Expected thumbTop≈${exp.thumbTop.toFixed(2)}. ` +
          `See src/terminal/useTerminalScroll.ts (rAF sampling loop).`,
      );
      process.exitCode = 1;
      return;
    }

    if (dExpected > 1.5) {
      console.error(
        `FAIL: thumb moved but desynced from pure projection ` +
          `(actual=${g.thumbTop}, expected=${exp.thumbTop.toFixed(2)}, Δ=${dExpected.toFixed(2)}).`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `PASS: wheel-up moved the thumb off the bottom by ${movedOffBottom.toFixed(2)}px ` +
        `and thumbTop=${g.thumbTop} ≈ projection ${exp.thumbTop.toFixed(2)} ` +
        `(Δ=${dExpected.toFixed(2)}px, well above bottom travel=${exp.travel.toFixed(2)}).`,
    );
  } finally {
    await electronApp.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
