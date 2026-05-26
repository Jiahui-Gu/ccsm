// scripts/dogfood-bug-69-no-flicker.mjs
//
// Bug #69 regression probe — warm session-switch must NOT flicker the
// scrollbar.
//
// Background: PR #1374 (already on origin/main) restores
// `.xterm-viewport.scrollTop` after the warm reshow's reparent, but the
// restore happens AFTER webkit has zeroed the scrollTop on layout-tree
// detach. The user-visible symptom is the scrollbar thumb being at the
// TOP for the first 1–3 frames after a B → A switch, then jumping to the
// correct position. Even though the final state is right, the intermediate
// frames are perceptible as a flash.
//
// The fix (this PR) switches the registry from "reparent across hosts" to
// "display:none / display:'' on a single persistent host" so the wrapper
// never leaves the layout tree, webkit never zeroes scrollTop, and there
// is no frame at scrollTop=0 to clobber.
//
// This probe asserts the no-flicker invariant per-frame: it hooks
// requestAnimationFrame on the renderer side BEFORE the B → A click,
// records the `.xterm-viewport.scrollTop` at every frame for 600ms after
// the switch, and asserts that NONE of those samples sit at 0 (or any
// value other than the saved scrollTop). The presence of even one
// off-target frame fails the probe.
//
// Exit code 0 = PASS, 1 = FAIL.

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
    // The active wrapper is the one with display !== 'none'. There can be
    // multiple .xterm-viewport elements on the page (one per warm wrapper
    // under the new design) — pick the one whose ancestor wrapper is
    // visible.
    const wrappers = Array.from(document.querySelectorAll('[data-ccsm-shell-sid]'));
    const visible = wrappers.find((w) => w instanceof HTMLElement && w.style.display !== 'none');
    const vp = (visible ?? document).querySelector('.xterm-viewport');
    return {
      viewportY: b?.buffer?.active?.viewportY ?? b?.viewportY ?? null,
      baseY: b?.buffer?.active?.baseY ?? b?.baseY ?? null,
      bufferType: t?.buffer?.active?.type ?? null,
      scrollTop: vp instanceof HTMLElement ? vp.scrollTop : null,
      scrollHeight: vp instanceof HTMLElement ? vp.scrollHeight : null,
    };
  });
}

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ccsm-dogfood-69-'));
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

    // Drop claude's alt-screen so we get scrollable normal-buffer (the
    // surface where the bug is visible). Fill scrollback and scroll up so
    // .xterm-viewport.scrollTop is well above 0.
    await win.evaluate(() => {
      const t = window.__ccsmTerm;
      t.write('\x1b[?1049l');
      for (let i = 0; i < 200; i++) t.write(`bug69-filler ${i}\r\n`);
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

    // A → B (let B settle so the next A-show is the warm path)
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidB);
    await waitForTerminalReady(win, sidB, { timeout: 30000 });
    await sleep(500);

    // Install per-frame scrollTop sampler in the renderer BEFORE we click A.
    // Records the .xterm-viewport.scrollTop of sidA's wrapper at every RAF
    // for the configured duration. Stored on window.__bug69Samples for
    // post-switch readback.
    await win.evaluate((expectedSid) => {
      window.__bug69Samples = [];
      const startedAt = performance.now();
      const DURATION_MS = 800;
      const tick = () => {
        const wrappers = Array.from(document.querySelectorAll('[data-ccsm-shell-sid]'));
        // Find sidA's wrapper specifically (by data attr) so we sample the
        // entry whose scroll position we care about even mid-switch.
        const target = wrappers.find(
          (w) => w instanceof HTMLElement && w.getAttribute('data-ccsm-shell-sid') === expectedSid,
        );
        let scrollTop = null;
        let display = null;
        let connected = null;
        if (target instanceof HTMLElement) {
          display = target.style.display || '';
          connected = target.isConnected;
          const vp = target.querySelector('.xterm-viewport');
          if (vp instanceof HTMLElement) scrollTop = vp.scrollTop;
        }
        window.__bug69Samples.push({
          t: Math.round(performance.now() - startedAt),
          scrollTop,
          display,
          connected,
        });
        if (performance.now() - startedAt < DURATION_MS) {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    }, sidA);

    // Trigger the warm switch back to A.
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);

    // Wait long enough for the sampler to finish.
    await sleep(1200);

    const samples = await win.evaluate(() => window.__bug69Samples || []);
    const after = await readScrollState(win);

    console.log(`before: ${JSON.stringify(before)}`);
    console.log(`after:  ${JSON.stringify(after)}`);
    console.log(`sample count: ${samples.length}`);
    // Trim the firehose: log first 12 + last 4.
    const head = samples.slice(0, 12);
    const tail = samples.slice(-4);
    console.log('first frames:');
    for (const s of head) console.log(`  ${JSON.stringify(s)}`);
    if (samples.length > 16) {
      console.log('...');
      console.log('last frames:');
      for (const s of tail) console.log(`  ${JSON.stringify(s)}`);
    }

    const expected = before.scrollTop;
    // Allow ±2px tolerance for sub-pixel rounding from xterm's Viewport
    // refresh; anything more is a real visible mismatch.
    const TOLERANCE = 2;
    const bad = samples.filter(
      (s) =>
        s.scrollTop != null &&
        s.connected !== false &&
        s.display !== 'none' &&
        Math.abs(s.scrollTop - expected) > TOLERANCE,
    );

    // The post-settle position must also match the pre-switch position.
    const finalOk =
      after.viewportY === before.viewportY &&
      Math.abs((after.scrollTop ?? -1) - expected) <= TOLERANCE;

    if (bad.length > 0 || !finalOk) {
      console.error(
        `FAIL: bug #69 — warm switch flickers. ` +
          `${bad.length} frame(s) out of ${samples.length} had ` +
          `scrollTop != ${expected} (±${TOLERANCE}px). finalOk=${finalOk}.`,
      );
      console.error('bad frames (sample):');
      for (const b of bad.slice(0, 10)) console.error(`  ${JSON.stringify(b)}`);
      const logPath = path.join(userDataDir, 'logs', 'main.log');
      if (existsSync(logPath)) {
        const tail = readFileSync(logPath, 'utf8')
          .split('\n')
          .filter(
            (l) =>
              l.includes('warmHide') ||
              l.includes('warmShow') ||
              l.includes('attach.warm.shown') ||
              l.includes('terminal.warmDisplay'),
          )
          .slice(-12);
        console.error('--- main.log tail ---');
        for (const l of tail) console.error(l);
      }
      process.exitCode = 1;
      return;
    }
    console.log('PASS: all frames pinned to saved scrollTop.');
  } finally {
    await electronApp.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
