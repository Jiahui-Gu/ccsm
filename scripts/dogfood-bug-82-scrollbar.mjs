// scripts/dogfood-bug-82-scrollbar.mjs
//
// Task #82 dogfood probe — cold-start `.xterm-viewport` scrollbar thumb
// must be at the bottom (matching the rendered content position), not
// at the top.
//
// Background: on cold-start the renderer writes claude's snapshot, runs
// `fit.fit()`, then calls `term.scrollToBottom()`. Without the rAF
// defer (PR for #82), the `.xterm-viewport.scrollTop` write fires
// before xterm's CanvasAddon / RenderService has reflowed the viewport
// element to its post-fit dimensions, so the write either no-ops or
// clamps to 0 — content paints at the bottom (correct, xterm tracks
// `viewportY` internally) but the native `::-webkit-scrollbar-thumb`
// sits at the top (desynced from the buffer).
//
// Assertion: after a cold start completes, `.xterm-viewport.scrollTop`
// must equal `scrollHeight - clientHeight` (±2px tolerance — Chromium
// rounds scroll geometry to integer device-pixel units, so the exact
// equality can be off by 1 on fractional-DPI configs).
//
// Honesty box: the underlying race (xterm dimension settle vs.
// scrollTop write) is sub-frame (<16ms). Playwright + headless paint
// timing differs from prod, and the post-attach `sleep(800)` here lets
// any pending paint settle long before we measure — so this probe
// reliably passes WITH the fix, but doesn't reliably FAIL without it.
// It is a non-regression sentinel + a vehicle for the before/after
// screenshot, NOT a direct race-condition reproducer. The real-time
// race-condition assertion lives in `tests/terminal/
// usePtyAttachShell.scrollDefer.test.tsx` which asserts the rAF
// call-order contract that the fix introduces.
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

async function readScrollState(win) {
  return await win.evaluate(() => {
    const vp = document.querySelector('.xterm-viewport');
    const t = window.__ccsmTerm;
    return {
      scrollTop: vp instanceof HTMLElement ? vp.scrollTop : null,
      scrollHeight: vp instanceof HTMLElement ? vp.scrollHeight : null,
      clientHeight: vp instanceof HTMLElement ? vp.clientHeight : null,
      viewportY: t?.buffer?.active?.viewportY ?? null,
      baseY: t?.buffer?.active?.baseY ?? null,
      bufferType: t?.buffer?.active?.type ?? null,
    };
  });
}

async function captureScreenshot(win, label, outDir) {
  try {
    const file = path.join(outDir, `bug-82-${label}.png`);
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
  const screenshotDir = mkdtempSync(path.join(tmpdir(), 'ccsm-bug82-shots-'));
  console.log(`screenshot dir: ${screenshotDir}`);

  const { electronApp, win } = await launchCcsmIsolated({ tempDir });

  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    // Shrink the window BEFORE creating the session so the very first
    // cold-start has to populate an overflowing snapshot into a small
    // viewport. That's the exact race the user hit (small / standard-
    // sized window, claude banner overflows): cold-start writes the
    // snapshot, fits, calls scrollToBottom — without the rAF defer the
    // `.xterm-viewport.scrollTop` write fires before the viewport
    // reflow lands and gets clamped to 0.
    await win.setViewportSize({ width: 600, height: 220 }).catch(() => {});
    await sleep(200);

    // Cold-start a brand new session.
    const { sid } = await seedSession(win, { name: 'bug82', cwd: tempDir });
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sid);
    await waitForTerminalReady(win, sid, { timeout: 45000 });

    // Wait for claude to render its welcome / prompt — confirms snapshot
    // write + first paint have landed.
    await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30000 });
    await dismissWelcomeSplash(win).catch(() => {});

    // Give the cold-start suffix (including the rAF defer + belt-and-
    // suspenders second rAF) plenty of time to complete.
    await sleep(800);

    const state = await readScrollState(win);
    console.log(`scroll state: ${JSON.stringify(state)}`);
    await captureScreenshot(win, 'cold-start', screenshotDir);

    if (
      state.scrollTop == null ||
      state.scrollHeight == null ||
      state.clientHeight == null
    ) {
      console.error('FAIL: .xterm-viewport not found in DOM after cold start');
      process.exitCode = 1;
      return;
    }

    // If the viewport has nothing to scroll (claude entered alt-buffer
    // immediately and the normal buffer never overflowed), there's no
    // bug to assert against — the scrollbar is correctly absent. Pass.
    if (state.scrollHeight <= state.clientHeight) {
      console.log(
        'PASS (vacuous): viewport content fits — no scrollbar to desync',
      );
      return;
    }

    const expected = state.scrollHeight - state.clientHeight;
    const delta = Math.abs(state.scrollTop - expected);
    if (delta <= 2) {
      console.log(
        `PASS: scrollTop=${state.scrollTop} ≈ scrollHeight-clientHeight=${expected} (Δ=${delta})`,
      );
      return;
    }
    console.error(
      `FAIL: scrollbar thumb desynced. scrollTop=${state.scrollTop}, ` +
        `scrollHeight-clientHeight=${expected}, Δ=${delta}px. ` +
        `xterm viewportY=${state.viewportY}/baseY=${state.baseY} ` +
        `(${state.bufferType} buffer). ` +
        `Expected scrollTop at the bottom after cold start — see ` +
        `src/terminal/usePtyAttachShell.ts runColdStartSuffix's rAF defer.`,
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
