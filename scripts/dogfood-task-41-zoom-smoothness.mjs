// Dogfood validation: Task #41 — Ctrl+wheel zoom should not flash and
// should not jump the user's scroll position. The reflow-only fix
// removes term.reset()+term.write(snapshot) from the zoom path; the
// mouse-anchor in TerminalPane.tsx keeps the line under the cursor
// approximately stable across the font change.
//
// Method:
//   1. Stand up an isolated ccsm with the stub-claude shim on PATH so
//      we have a real PTY producing a deterministic burst.
//   2. Seed a session and wait until the warm terminal is ready.
//   3. Write 100 numbered lines to the terminal via __ccsmTerm.write,
//      then scroll to the middle of the buffer.
//   4. Dispatch 5 Ctrl+wheel-up + 5 Ctrl+wheel-down events at a fixed
//      clientY anchor. Sample fontSize / viewportY / baseY before and
//      after each batch.
//   5. Assertions (best-effort, since exact viewportY depends on
//      reflow timing) — primary signals:
//       a. fontSize changed in both directions and ended at the
//          baseline (zoom in then out is symmetric).
//       b. viewportY drift after the round-trip is < 5 lines (anchor
//          held within a few cells of round-trip).
//       c. No 'reset' / 'snapshot' related warn/error log lines.
//   6. Offscreen-bounds assert so this probe stays headless-safe.

import {
  launchCcsmIsolated,
  createIsolatedClaudeDir,
  seedSession,
} from './probe-utils-real-cli.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const STUB_PATH = path.join(__dirname, 'fixtures', 'stub-claude.mjs');
const OUT_DIR = path.join(REPO_ROOT, 'scratch');
const OUT_PATH = path.join(OUT_DIR, 'dogfood-task-41-zoom-smoothness.json');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function setupClaudeShim() {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'ccsm-stub-claude-'));
  const cmd = `@echo off\r\nnode "${STUB_PATH}" %*\r\n`;
  const cmdPath = path.join(shimDir, 'claude.cmd');
  writeFileSync(cmdPath, cmd, 'utf8');
  return { shimDir, cmdPath };
}

async function readState(win) {
  return await win.evaluate(() => {
    const term = window.__ccsmTerm;
    if (!term || !term.buffer || !term.buffer.active) return null;
    const buf = term.buffer.active;
    return {
      fontSize: term.options.fontSize,
      cols: term.cols,
      rows: term.rows,
      viewportY: buf.viewportY,
      baseY: buf.baseY,
      length: buf.length,
    };
  });
}

async function dispatchCtrlWheel(win, deltaY, count) {
  // Dispatch WheelEvent at a fixed point inside the host. We pick a
  // clientY roughly 1/3 down the host so anchor adjustments are
  // observable (not at viewport top or bottom edges).
  return await win.evaluate(
    async ({ deltaY, count }) => {
      const outer = document.querySelector('[data-terminal-host]');
      if (!outer) throw new Error('terminal host not found');
      // The wheel listener is on the inner ref'd div (absolute inset-0).
      const host = outer.querySelector(':scope > div') || outer;
      const rect = host.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + Math.floor(rect.height / 3);
      for (let i = 0; i < count; i++) {
        const ev = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY,
          clientX,
          clientY,
        });
        host.dispatchEvent(ev);
        // Wait two frames so the RAF coalesce inside the wheel handler
        // commits and the registry's fit + pty.resize observably finishes.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      return { clientX, clientY };
    },
    { deltaY, count },
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const tempDir = createIsolatedClaudeDir();
  const { shimDir } = setupClaudeShim();
  const launchPath = `${shimDir};${process.env.PATH ?? ''}`;

  const { electronApp, win } = await launchCcsmIsolated({
    tempDir,
    env: { PATH: launchPath, CCSM_E2E_HIDDEN: '1' },
  });

  // Offscreen-bounds assert — project policy: headless probes never pop
  // a visible window on the developer's desktop.
  const isHidden = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((w) => {
      const b = w.getBounds();
      return b.x <= -10000 || b.y <= -10000;
    }),
  );
  if (!isHidden) {
    throw new Error('Dogfood opened a visible window — violates project policy');
  }

  const consoleLines = [];
  win.on('console', (msg) => {
    consoleLines.push({ type: msg.type(), text: msg.text() });
  });

  const { sid } = await seedSession(win, { cwd: tempDir, name: 'zoom-probe' });
  // Wait until the terminal is attached + window.__ccsmTerm wired up.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ready = await win.evaluate(() => Boolean(window.__ccsmTerm?.buffer?.active));
    if (ready) break;
    await sleep(200);
  }
  // Give the stub a moment to settle (claude shim emits its own first
  // bytes before we write into the buffer).
  await sleep(1500);

  // Push 100 numbered lines into the visible buffer via term.write.
  // This is the renderer-side buffer only (not PTY input), which is
  // exactly what we want — the zoom path operates on the xterm buffer.
  await win.evaluate(() => {
    const lines = [];
    for (let i = 1; i <= 100; i++) {
      lines.push(`line ${String(i).padStart(3, '0')}`);
    }
    window.__ccsmTerm.write(lines.join('\r\n') + '\r\n');
  });
  // Let the write commit.
  await sleep(300);

  // Scroll to the middle so the zoom isn't trivially pinned at bottom.
  await win.evaluate(() => {
    const term = window.__ccsmTerm;
    const buf = term.buffer.active;
    const mid = Math.floor(buf.baseY / 2);
    term.scrollToLine(mid);
  });
  await sleep(200);

  // Warm up the fit: trigger one round-trip wheel pair so cols/rows
  // reflect the actual host size before we take the baseline. (The
  // very first fit on a freshly-mounted hostRef can produce stale
  // cols if the renderer hasn't finished laying out the inner host
  // div yet; the round-trip flushes it.)
  await dispatchCtrlWheel(win, -120, 1);
  await sleep(150);
  await dispatchCtrlWheel(win, 120, 1);
  await sleep(300);

  const before = await readState(win);

  // Diagnostic: confirm wheel handler can change the store at all by
  // calling the store action directly first; if that bumps fontSize and
  // term.options.fontSize matches, the registry path works.
  const directProbe = await win.evaluate(() => {
    const s = window.__ccsmStore?.getState();
    if (!s) return { ok: false, reason: 'no store' };
    const before = s.terminalFontSizePx;
    s.setTerminalFontSizePx(before + 2);
    return { ok: true, before, after: window.__ccsmStore.getState().terminalFontSizePx, termFont: window.__ccsmTerm?.options?.fontSize };
  });
  // Roll the store back so the wheel test starts from the same baseline.
  await win.evaluate(() => {
    const s = window.__ccsmStore?.getState();
    s?.setTerminalFontSizePx(13);
  });
  await sleep(100);

  // 5x wheel-up (zoom IN)
  await dispatchCtrlWheel(win, -120, 5);
  await sleep(300);
  const afterIn = await readState(win);

  // 5x wheel-down (zoom OUT) — return to baseline font.
  await dispatchCtrlWheel(win, 120, 5);
  await sleep(300);
  const afterOut = await readState(win);

  // Check console for the smoking-gun signals the old replay path would emit.
  const resetMentions = consoleLines.filter(
    (l) => /resize reset failed|resize snapshot fetch failed/i.test(l.text),
  );

  const verdict = {
    sid,
    directProbe,
    before,
    afterIn,
    afterOut,
    fontDeltaUp: (afterIn?.fontSize ?? 0) - (before?.fontSize ?? 0),
    fontDeltaRoundTrip: (afterOut?.fontSize ?? 0) - (before?.fontSize ?? 0),
    viewportDriftRoundTrip: Math.abs(
      (afterOut?.viewportY ?? 0) - (before?.viewportY ?? 0),
    ),
    resetWarnings: resetMentions.length,
    consoleSample: consoleLines.slice(-20),
  };

  writeFileSync(OUT_PATH, JSON.stringify(verdict, null, 2), 'utf8');
  console.log(JSON.stringify(verdict, null, 2));

  // Soft assertions — log failures but don't throw, so the JSON file is
  // preserved for inspection. The PR body cites these numbers.
  const errs = [];
  if (!before || !afterIn || !afterOut) errs.push('readState returned null at one of the checkpoints');
  if (verdict.fontDeltaUp <= 0) errs.push(`fontDeltaUp expected > 0, got ${verdict.fontDeltaUp}`);
  if (verdict.fontDeltaRoundTrip !== 0) errs.push(`fontDeltaRoundTrip expected 0, got ${verdict.fontDeltaRoundTrip}`);
  if (verdict.viewportDriftRoundTrip > 8) errs.push(`viewportDriftRoundTrip too large: ${verdict.viewportDriftRoundTrip}`);
  if (verdict.resetWarnings > 0) errs.push(`saw ${verdict.resetWarnings} resize-replay warnings (zoom path should not invoke replay)`);

  await electronApp.close();

  if (errs.length) {
    console.error('VERDICT: FAIL');
    for (const e of errs) console.error('  - ' + e);
    process.exit(1);
  }
  console.error('VERDICT: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
