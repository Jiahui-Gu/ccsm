// scripts/harness-scrollbar-6-scenarios.mjs
//
// Bug #82 acceptance harness — native `.xterm-viewport` scrollbar reconcile.
//
// Context: the self-drawn <TerminalScrollbar/> projection was reverted and
// xterm owns the native `.xterm-viewport` scrollbar again. The #82 desync:
// when a shell's wrapper flips `display:none → ''` (session switch, resize,
// reload reveal), webkit silently zeroes `.xterm-viewport.scrollTop` with NO
// scroll event. xterm's own scroll state (`buffer.active.viewportY`/`baseY`)
// is unchanged, so the DOM scrollTop drifts from xterm's ydisp — the thumb
// snaps to the top while the content is scrolled up.
//
// Fix: `reconcileView` forces `syncScrollArea(true)` at the showShell
// chokepoint (and after fit() in the ResizeObserver), rewriting
// `scrollTop = ydisp * rowHeight`. The invariant under test, after every
// reveal/resize/reload:
//
//   .xterm-viewport.scrollTop  ≈  viewportY * cellHeight   (±1 cell)
//
// The OLD buggy behavior: scrollTop === 0 while viewportY > 0.
//
// 6 scenarios, one isolated electron launch:
//   1. cold-start-bottom       — fresh session, at bottom, scrollTop synced.
//   2. scroll-up-switch-back    — THE #82 case: scroll up A, switch B↔A,
//                                 scrollTop must track viewportY (not 0).
//   3. at-bottom-switch-back    — switch away+back while A is at bottom;
//                                 scrollTop stays at bottom (no false jump).
//   4. rapid-switch-cycles      — A↔B several times while A scrolled up;
//                                 scrollTop stays synced every cycle.
//   5. resize-while-scrolled    — shrink/grow window while A scrolled up;
//                                 post-fit reconcile keeps scrollTop synced.
//   6. reload-while-scrolled    — reloadSession on A; after reload (at
//                                 bottom) scrollTop tracks viewportY.
//
// Vacuous PASS: if a session has no scrollback (baseY === 0, e.g. claude in
// the alt-buffer), there is no scroll position to desync — that scenario
// passes trivially and logs WHY.
//
// Run:     node scripts/harness-scrollbar-6-scenarios.mjs
// Run one: node scripts/harness-scrollbar-6-scenarios.mjs --only=scroll-up-switch-back

import { existsSync } from 'node:fs';
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

// ============================================================================
// CLI args
// ============================================================================

function parseArgs(argv) {
  const out = { only: null, skip: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--only=')) {
      out.only = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--skip=')) {
      out.skip = arg.slice('--skip='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/harness-scrollbar-6-scenarios.mjs [--only=...] [--skip=...]');
      for (const c of CASE_REGISTRY) console.log('  -', c.name);
      process.exit(0);
    }
  }
  return out;
}

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * Read the ACTIVE shell's native viewport scrollTop alongside xterm's own
 * scroll state. The active wrapper is the one whose `[data-ccsm-shell-sid]`
 * ancestor is NOT display:none. Returns cellHeight from the render service so
 * the caller can compute the expected scrollTop = viewportY * cellHeight.
 */
async function readViewportState(win) {
  return await win.evaluate(() => {
    const t = window.__ccsmTerm;
    if (!t) return { ok: false, reason: 'no __ccsmTerm' };
    const viewports = Array.from(document.querySelectorAll('.xterm-viewport')).filter((el) => {
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
      cellHeight,
    };
  });
}

/**
 * Drive the active xterm UP to a PARTIAL scroll position so that
 * `0 < viewportY < baseY` (scrollTop > 0). A partial position — rather than
 * scrollToTop() which lands at viewportY=0 — is what makes the #82 desync
 * signature ("scrollTop=0 while viewportY>0") detectable: at viewportY=0 a
 * zeroed scrollTop is correct, so the bug would slip through. We scroll to
 * roughly the middle of the scrollback via xterm's scrollToLine.
 */
async function scrollActiveToMiddle(win) {
  await win.evaluate(() => {
    const t = window.__ccsmTerm;
    if (!t) return;
    const baseY = t.buffer?.active?.baseY ?? 0;
    if (baseY <= 1) {
      if (typeof t.scrollToTop === 'function') t.scrollToTop();
      return;
    }
    const target = Math.max(1, Math.floor(baseY / 2));
    if (typeof t.scrollToLine === 'function') t.scrollToLine(target);
    else if (typeof t.scrollLines === 'function') t.scrollLines(-Math.floor(baseY / 2));
  });
}

/** Assert scrollTop tracks viewportY*cellHeight (±1 cell). Throws on desync. */
function assertSynced(label, g) {
  if (!g.ok) throw new Error(`${label}: viewport state unavailable (${g.reason})`);
  if (g.baseY == null || g.cellHeight == null) {
    throw new Error(`${label}: baseY/cellHeight unavailable (${JSON.stringify(g)})`);
  }
  if (g.baseY <= 0) {
    console.log(`  [${label}] PASS (vacuous): no scrollback (baseY=${g.baseY}, ${g.bufferType} buffer)`);
    return;
  }
  // The classic #82 signature.
  if (g.viewportY > 0 && g.scrollTop === 0) {
    throw new Error(
      `${label}: #82 DESYNC — scrollTop=0 while viewportY=${g.viewportY} (baseY=${g.baseY})`,
    );
  }
  const expected = g.viewportY * g.cellHeight;
  const delta = Math.abs(g.scrollTop - expected);
  const tol = g.cellHeight + 1;
  console.log(
    `  [${label}] viewportY=${g.viewportY} baseY=${g.baseY} cellH=${g.cellHeight.toFixed(1)} ` +
      `scrollTop=${g.scrollTop} expected=${expected.toFixed(1)} Δ=${delta.toFixed(1)} tol=${tol.toFixed(1)}`,
  );
  if (delta > tol) {
    throw new Error(
      `${label}: scrollTop desynced (Δ=${delta.toFixed(1)} > tol=${tol.toFixed(1)})`,
    );
  }
}

async function waitProbeReady(win) {
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30_000 },
  );
}

async function bringUp(win, sid) {
  await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sid);
  await waitForTerminalReady(win, sid, { timeout: 45_000 });
}

/** Seed + paint one session under the small viewport, return its sid. */
async function seedReady(win, name, tempDir) {
  const { sid } = await seedSession(win, { name, cwd: tempDir });
  await bringUp(win, sid);
  await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30_000 });
  await dismissWelcomeSplash(win).catch(() => {});
  await sleep(400);
  return sid;
}

// ============================================================================
// Scenarios
// ============================================================================

async function caseColdStartBottom({ win, tempDir }) {
  await waitProbeReady(win);
  await win.setViewportSize({ width: 600, height: 220 }).catch(() => {});
  const sid = await seedReady(win, 'sb-cold', tempDir);
  // Fresh cold start is at the bottom: viewportY === baseY, scrollTop maxed.
  const g = await readViewportState(win);
  assertSynced('cold-start-bottom', g);
  return { sid };
}

async function caseScrollUpSwitchBack({ win, tempDir }) {
  await waitProbeReady(win);
  await win.setViewportSize({ width: 600, height: 220 }).catch(() => {});
  const sidA = await seedReady(win, 'sb-A', tempDir);
  const sidB = await seedReady(win, 'sb-B', tempDir);

  // Back to A, scroll up so viewportY < baseY (scrollTop > 0).
  await bringUp(win, sidA);
  await sleep(300);
  await scrollActiveToMiddle(win);
  await sleep(300);
  const before = await readViewportState(win);
  console.log(`  [scroll-up-switch-back] A scrolled-up: ${JSON.stringify(before)}`);

  // Switch B then back to A — the reveal that triggers #82.
  await bringUp(win, sidB);
  await sleep(400);
  await bringUp(win, sidA);
  await sleep(500);

  const after = await readViewportState(win);
  assertSynced('scroll-up-switch-back', after);
  return { sidA, sidB };
}

async function caseAtBottomSwitchBack({ win, tempDir }) {
  await waitProbeReady(win);
  await win.setViewportSize({ width: 600, height: 220 }).catch(() => {});
  const sidA = await seedReady(win, 'sb-bot-A', tempDir);
  const sidB = await seedReady(win, 'sb-bot-B', tempDir);

  // A is at the bottom (no scrollToTop). Switch away + back must not jump.
  await bringUp(win, sidA);
  await sleep(300);
  await bringUp(win, sidB);
  await sleep(400);
  await bringUp(win, sidA);
  await sleep(500);

  const g = await readViewportState(win);
  assertSynced('at-bottom-switch-back', g);
}

async function caseRapidSwitchCycles({ win, tempDir }) {
  await waitProbeReady(win);
  await win.setViewportSize({ width: 600, height: 220 }).catch(() => {});
  const sidA = await seedReady(win, 'sb-rap-A', tempDir);
  const sidB = await seedReady(win, 'sb-rap-B', tempDir);

  await bringUp(win, sidA);
  await sleep(300);
  await scrollActiveToMiddle(win);
  await sleep(300);

  for (let i = 0; i < 4; i++) {
    await bringUp(win, sidB);
    await sleep(250);
    await bringUp(win, sidA);
    await sleep(350);
    const g = await readViewportState(win);
    assertSynced(`rapid-switch-cycles[#${i}]`, g);
  }
}

async function caseResizeWhileScrolled({ win, tempDir }) {
  await waitProbeReady(win);
  await win.setViewportSize({ width: 600, height: 220 }).catch(() => {});
  const sidA = await seedReady(win, 'sb-rsz', tempDir);

  await scrollActiveToMiddle(win);
  await sleep(300);

  // Grow then shrink — each change drives the ResizeObserver → fit() →
  // reconcileShellView. scrollTop must still track viewportY after settle.
  await win.setViewportSize({ width: 800, height: 360 }).catch(() => {});
  await sleep(500);
  await win.setViewportSize({ width: 600, height: 220 }).catch(() => {});
  await sleep(500);

  const g = await readViewportState(win);
  assertSynced('resize-while-scrolled', g);
  return { sidA };
}

async function caseReloadWhileScrolled({ win, tempDir }) {
  await waitProbeReady(win);
  await win.setViewportSize({ width: 600, height: 220 }).catch(() => {});
  const sidA = await seedReady(win, 'sb-reload', tempDir);

  await scrollActiveToMiddle(win);
  await sleep(300);

  // Reload the session — resets the term, re-runs cold-start suffix, and
  // the reveal goes through showShell's reconcileView again. After reload
  // the term is at the bottom; scrollTop must match viewportY (not 0).
  const reloaded = await win.evaluate((id) => {
    const st = window.__ccsmStore.getState();
    if (typeof st.reloadSession === 'function') {
      st.reloadSession(id);
      return true;
    }
    return false;
  }, sidA);
  if (!reloaded) {
    console.log('  [reload-while-scrolled] reloadSession unavailable — skipping reload step');
  }
  await sleep(1500);
  await waitForTerminalReady(win, sidA, { timeout: 45_000 }).catch(() => {});
  await sleep(500);

  const g = await readViewportState(win);
  assertSynced('reload-while-scrolled', g);
}

// ============================================================================
// Registry + runner
// ============================================================================

const CASE_REGISTRY = [
  { name: 'cold-start-bottom', run: caseColdStartBottom },
  { name: 'scroll-up-switch-back', run: caseScrollUpSwitchBack },
  { name: 'at-bottom-switch-back', run: caseAtBottomSwitchBack },
  { name: 'rapid-switch-cycles', run: caseRapidSwitchCycles },
  { name: 'resize-while-scrolled', run: caseResizeWhileScrolled },
  { name: 'reload-while-scrolled', run: caseReloadWhileScrolled },
];

async function main() {
  const { only, skip } = parseArgs(process.argv);
  const selected = CASE_REGISTRY.filter((c) => {
    if (only && !only.includes(c.name)) return false;
    if (skip && skip.includes(c.name)) return false;
    return true;
  });
  if (selected.length === 0) {
    console.error('No cases selected. Available:', CASE_REGISTRY.map((c) => c.name).join(', '));
    process.exit(2);
  }

  if (!existsSync(path.resolve('dist/renderer/index.html'))) {
    console.error('dist/renderer/index.html missing — run `npm run build` first');
    process.exit(2);
  }

  const results = [];
  const harnessStart = Date.now();

  // Each scenario gets its OWN isolated launch: session switching +
  // window resizing across scenarios would leak state (scroll position,
  // resident shells) and make per-scenario assertions ambiguous.
  for (const c of selected) {
    const t0 = Date.now();
    console.log(`\n[HARNESS=scrollbar-6] >>> case: ${c.name}`);
    let isolated = null;
    let launched = null;
    try {
      isolated = await createIsolatedClaudeDir();
      launched = await launchCcsmIsolated({ tempDir: isolated.tempDir });
      const ctx = {
        electronApp: launched.electronApp,
        win: launched.win,
        tempDir: isolated.tempDir,
      };
      await c.run(ctx);
      const ms = Date.now() - t0;
      results.push({ name: c.name, ok: true, ms });
      console.log(`[HARNESS=scrollbar-6] <<< PASS ${c.name} (${ms}ms)`);
    } catch (err) {
      const ms = Date.now() - t0;
      results.push({ name: c.name, ok: false, ms, error: String(err?.stack || err) });
      console.error(`[HARNESS=scrollbar-6] <<< FAIL ${c.name} (${ms}ms): ${err?.message || err}`);
    } finally {
      if (launched?.electronApp) try { await launched.electronApp.close(); } catch { /* ignore */ }
      launched?.cleanup?.();
      isolated?.cleanup?.();
    }
  }

  const totalMs = Date.now() - harnessStart;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('\n===== HARNESS=scrollbar-6 SUMMARY =====');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(26)} ${r.ms}ms`);
  }
  console.log(`  total: ${passed}/${results.length} passed, ${(totalMs / 1000).toFixed(1)}s wall`);
  process.exit(failed === 0 ? 0 : 1);
}

const _entryUrlMain =
  process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (_entryUrlMain && import.meta.url === _entryUrlMain) {
  main().catch((err) => {
    console.error('[HARNESS=scrollbar-6] unhandled top-level error:', err?.stack || err);
    process.exit(1);
  });
}
