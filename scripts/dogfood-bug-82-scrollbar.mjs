// scripts/dogfood-bug-82-scrollbar.mjs
//
// Terminal scrollbar re-sync probe (native xterm `.xterm-viewport` bar).
//
// We dropped the self-drawn <TerminalScrollbar/> and went back to xterm's
// own native `.xterm-viewport` scrollbar (re-skinned via CSS in
// global.css), following ttyd's approach. The historical reason we ever
// self-drew was bug #82 (#1407): webkit zeroes `.xterm-viewport.scrollTop`
// on reflow / fit / reparent (panel switch), so the native thumb can
// desync from xterm's real buffer state. ttyd never hits this because it
// runs in a plain web page with no Electron multi-pane reparent.
//
// So this probe STRESSES exactly the #82-prone transitions and asserts the
// native scrollbar stays synced to the buffer after each:
//   - window resize + fit
//   - switch session A -> B -> A (reparent of the xterm host)
//   - cold start -> scroll to the middle -> fit
//
// "Synced" = the native viewport's normalized scroll position
//   scrollFrac = scrollTop / (scrollHeight - clientHeight)
// matches the buffer's normalized position
//   bufFrac    = viewportY / baseY
// within tolerance. xterm drives `scrollTop` from `viewportY/baseY`, so if
// #82 recurs (scrollTop zeroed but viewportY non-zero) the two fractions
// diverge and the probe FAILs with the measured numbers.
//
// If `baseY === 0` (no scrollback, e.g. claude is in the alt-buffer) the
// scrollbar is correctly absent and the relevant checks pass vacuously.
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

// Allowed divergence between the native scroll fraction and the buffer
// fraction. xterm's scrollTop is integer-pixel quantized against a
// cell-height grid, so a one-cell rounding error is expected; 0.06 (~6% of
// the track) comfortably covers that without masking a real #82 zeroing
// (which collapses scrollFrac to ~0 while bufFrac stays high).
const FRAC_TOLERANCE = 0.06;

async function readState(win) {
  return await win.evaluate(() => {
    const t = window.__ccsmTerm;
    const vp = document.querySelector('.xterm-viewport');
    const vpEl = vp instanceof HTMLElement ? vp : null;
    const baseY = t?.buffer?.active?.baseY ?? null;
    const viewportY = t?.buffer?.active?.viewportY ?? null;
    return {
      baseY,
      viewportY,
      rows: t?.rows ?? null,
      bufferType: t?.buffer?.active?.type ?? null,
      viewportPresent: !!vpEl,
      scrollTop: vpEl ? vpEl.scrollTop : null,
      scrollHeight: vpEl ? vpEl.scrollHeight : null,
      clientHeight: vpEl ? vpEl.clientHeight : null,
      // Sanity: a broken revert (overflow:hidden / pointer-events:none)
      // would null out native scrolling; surface the computed style so the
      // probe can FAIL loudly instead of silently "passing" a dead bar.
      overflowY: vpEl ? getComputedStyle(vpEl).overflowY : null,
      pointerEvents: vpEl ? getComputedStyle(vpEl).pointerEvents : null,
    };
  });
}

function fractions(s) {
  const denom = s.scrollHeight - s.clientHeight;
  const scrollFrac = denom > 0 ? s.scrollTop / denom : 0;
  const bufFrac = s.baseY > 0 ? s.viewportY / s.baseY : 0;
  return { scrollFrac, bufFrac, denom };
}

let failed = false;
function check(label, s) {
  // No scrollback -> bar correctly absent / inert.
  if (s.baseY == null || s.baseY <= 0) {
    console.log(`  [${label}] vacuous: baseY=${s.baseY} (${s.bufferType} buffer) — no scrollback`);
    return;
  }
  if (!s.viewportPresent) {
    console.error(`  [${label}] FAIL: scrollback exists (baseY=${s.baseY}) but no .xterm-viewport`);
    failed = true;
    return;
  }
  // Guard against a broken CSS revert that kills native scrolling.
  if (s.overflowY === 'hidden' || s.pointerEvents === 'none') {
    console.error(
      `  [${label}] FAIL: .xterm-viewport overflowY=${s.overflowY} pointerEvents=${s.pointerEvents} ` +
        `— native wheel/scroll would be dead (do NOT override these)`,
    );
    failed = true;
    return;
  }
  const { scrollFrac, bufFrac, denom } = fractions(s);
  const delta = Math.abs(scrollFrac - bufFrac);
  console.log(
    `  [${label}] baseY=${s.baseY} viewportY=${s.viewportY} ` +
      `scrollTop=${s.scrollTop}/${denom} -> scrollFrac=${scrollFrac.toFixed(3)} ` +
      `bufFrac=${bufFrac.toFixed(3)} Δ=${delta.toFixed(3)}`,
  );
  if (delta > FRAC_TOLERANCE) {
    console.error(
      `  [${label}] FAIL: native scrollbar desynced from buffer (#82 recurrence?) ` +
        `Δ=${delta.toFixed(3)} > ${FRAC_TOLERANCE}`,
    );
    failed = true;
  }
}

async function screenshot(win, label, outDir) {
  try {
    const file = path.join(outDir, `scrollbar-${label}.png`);
    await win.screenshot({ path: file, fullPage: false });
    console.log(`  screenshot: ${file}`);
  } catch (e) {
    console.log(`  screenshot ${label} failed: ${e.message}`);
  }
}

async function selectSession(win, sid) {
  await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sid);
  await sleep(400);
}

async function main() {
  const { tempDir } = await createIsolatedClaudeDir();
  const shotDir = mkdtempSync(path.join(tmpdir(), 'ccsm-scrollbar-shots-'));
  console.log(`screenshot dir: ${shotDir}`);

  const { electronApp, win } = await launchCcsmIsolated({ tempDir });

  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    // Small window so the cold-start snapshot overflows the viewport and
    // creates scrollback (baseY > 0).
    await win.setViewportSize({ width: 700, height: 240 }).catch(() => {});
    await sleep(200);

    const a = await seedSession(win, { name: 'scroll-A', cwd: tempDir });
    await selectSession(win, a.sid);
    await waitForTerminalReady(win, a.sid, { timeout: 45000 });
    await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30000 });
    await dismissWelcomeSplash(win).catch(() => {});
    await sleep(500);

    // Scroll to the middle of the scrollback so a desync (scrollTop->0)
    // would be detectable (bufFrac stays ~0.5 while scrollFrac collapses).
    await win.evaluate(() => {
      const t = window.__ccsmTerm;
      const b = t?.buffer?.active;
      if (b && b.baseY > 0) t.scrollToLine(Math.floor(b.baseY / 2));
    });
    await sleep(300);

    console.log('phase 1: cold start, scrolled to middle');
    check('cold-mid', await readState(win));
    await screenshot(win, 'cold-mid', shotDir);

    // Phase 2: window resize + fit (reflow). #82's classic trigger.
    await win.setViewportSize({ width: 1000, height: 520 }).catch(() => {});
    await sleep(500);
    await win.evaluate(() => {
      const t = window.__ccsmTerm;
      const b = t?.buffer?.active;
      if (b && b.baseY > 0) t.scrollToLine(Math.floor(b.baseY / 2));
    });
    await sleep(400);
    console.log('phase 2: after resize + scroll-to-middle');
    check('post-resize', await readState(win));
    await screenshot(win, 'post-resize', shotDir);

    // Phase 3: reparent — switch to a second session then back. The xterm
    // host is detached/reattached, which is the Electron-specific case ttyd
    // never exercises.
    const bSess = await seedSession(win, { name: 'scroll-B', cwd: tempDir });
    await selectSession(win, bSess.sid);
    await waitForTerminalReady(win, bSess.sid, { timeout: 45000 });
    await sleep(500);
    await selectSession(win, a.sid);
    await sleep(600);
    // Re-scroll A to the middle and confirm the native bar tracks it after
    // the reparent round-trip.
    await win.evaluate(() => {
      const t = window.__ccsmTerm;
      const b = t?.buffer?.active;
      if (b && b.baseY > 0) t.scrollToLine(Math.floor(b.baseY / 2));
    });
    await sleep(400);
    console.log('phase 3: after reparent A->B->A + scroll-to-middle');
    check('post-reparent', await readState(win));
    await screenshot(win, 'post-reparent', shotDir);

    // Phase 4: scroll to the very top, then fit again — the position webkit
    // is most likely to zero is a non-bottom one held across a reflow.
    await win.evaluate(() => window.__ccsmTerm?.scrollToTop?.());
    await sleep(200);
    await win.setViewportSize({ width: 760, height: 300 }).catch(() => {});
    await sleep(500);
    console.log('phase 4: scrolled to top, then resized');
    check('top-after-resize', await readState(win));
    await screenshot(win, 'top-after-resize', shotDir);

    if (failed) {
      console.error('\nRESULT: FAIL — native scrollbar desynced on at least one transition');
      process.exitCode = 1;
    } else {
      console.log('\nRESULT: PASS — native scrollbar stayed synced across resize/fit/reparent');
    }
  } finally {
    await electronApp.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
