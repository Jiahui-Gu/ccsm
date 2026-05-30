// scripts/dogfood-scrollbar-pinned-bottom.mjs
//
// Repro probe for the "scrollbar thumb is always pinned to the bottom" bug.
//
// User report: 现在任何时候滚动条都在底部 — the self-drawn terminal scrollbar
// thumb (src/components/TerminalScrollbar.tsx, driven by useTerminalScroll)
// never leaves the bottom of the track even after the user scrolls up.
//
// This probe drives the IDLE (no live claude output) path deterministically
// via REAL MOUSE WHEEL — which is how users actually scroll, and the path
// that reproduces the bug:
//   1. force the terminal into normal buffer
//   2. write enough lines to create scrollback (baseY > 0)
//   3. scroll the viewport to the bottom (live tail)
//   4. real mouse-wheel UP over the terminal host
//   5. read xterm buffer geometry (viewportY / baseY / rows), the track px
//      height, AND the rendered self-drawn thumb's style.top.
//
// Root cause this guards: xterm's `onScroll` emitter does NOT fire on
// mouse-wheel scroll (only on programmatic scroll / write-driven scroll).
// The self-drawn scrollbar originally subscribed only to `onScroll`, so the
// thumb stayed frozen at its last bottom position while the viewport scrolled
// up under the wheel — user symptom "任何时候滚动条都在底部". `useTerminalScroll`
// now also subscribes to `onRender` (fires per wheel tick) to catch this.
//
// Expectation after wheel-up: viewportY << baseY, so the thumb must sit WELL
// ABOVE the bottom — thumbTop ≈ travel*viewportY/baseY << travel. If the thumb
// is pinned at the bottom (thumbTop ≈ travel) while viewportY << baseY, the bug
// is present.
//
// Exit code 0 = PASS (thumb tracks viewportY), 1 = FAIL (thumb pinned to bottom).

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
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ccsm-scrollbar-pin-'));
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

    const { sid } = await seedSession(win, { name: 'pin', cwd: tempDir });
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
      for (let i = 0; i < 200; i++) t.write(`scrollbar-pin filler ${i}\r\n`);
    });
    await sleep(300);
    await win.evaluate(() => window.__ccsmTerm.scrollToBottom());
    await sleep(300);

    const beforeWheel = await readGeometry(win);
    console.log(`geometry at tail (before wheel): ${JSON.stringify(beforeWheel)}`);

    // Real mouse wheel UP over the terminal host — the path that exposes the
    // missing-onScroll bug. `term.scrollLines(...)` would NOT reproduce it.
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

    if (g.bufferType !== 'normal') {
      console.error(`SETUP FAIL: expected normal buffer, got ${g.bufferType}`);
      process.exitCode = 1;
      return;
    }
    if (g.baseY == null || g.baseY <= 0) {
      console.error(`SETUP FAIL: no scrollback (baseY=${g.baseY})`);
      process.exitCode = 1;
      return;
    }
    if (!g.thumbPresent || g.trackHeight == null) {
      console.error(`SETUP FAIL: no self-drawn thumb (baseY=${g.baseY})`);
      process.exitCode = 1;
      return;
    }
    if (g.viewportY >= g.baseY) {
      console.error(
        `SETUP FAIL: scroll-up did not move viewportY off the tail ` +
          `(viewportY=${g.viewportY} baseY=${g.baseY})`,
      );
      process.exitCode = 1;
      return;
    }

    const exp = expectedThumb(g);
    const bottomThreshold = exp.travel - 1; // "pinned to bottom" if >= this
    const dExpected = Math.abs(g.thumbTop - exp.thumbTop);

    console.log(
      `viewportY=${g.viewportY}/baseY=${g.baseY} travel=${exp.travel.toFixed(2)} ` +
        `expected thumbTop=${exp.thumbTop.toFixed(2)} actual thumbTop=${g.thumbTop} ` +
        `(Δ=${dExpected.toFixed(2)})`,
    );

    // Bug signature: scrolled up (viewportY << baseY) yet thumb sits at the
    // very bottom of the track.
    if (g.thumbTop >= bottomThreshold) {
      console.error(
        `FAIL (bug confirmed): thumb pinned to bottom. thumbTop=${g.thumbTop} ` +
          `>= travel-1=${bottomThreshold.toFixed(2)} while viewportY=${g.viewportY} ` +
          `<< baseY=${g.baseY}. Expected thumbTop≈${exp.thumbTop.toFixed(2)}. ` +
          `See src/terminal/useTerminalScroll.ts.`,
      );
      process.exitCode = 1;
      return;
    }

    if (dExpected > 2) {
      console.error(
        `FAIL: thumb not pinned but desynced from pure projection ` +
          `(actual=${g.thumbTop}, expected=${exp.thumbTop.toFixed(2)}).`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `PASS: thumb tracks viewportY after idle scroll-up ` +
        `(thumbTop=${g.thumbTop} ≈ expected ${exp.thumbTop.toFixed(2)}, ` +
        `well above bottom travel=${exp.travel.toFixed(2)}).`,
    );
  } finally {
    await electronApp.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
