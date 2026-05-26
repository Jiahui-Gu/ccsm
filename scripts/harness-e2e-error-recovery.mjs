// Workflow group ④ — error-recovery e2e harness.
//
// Pins the two end-to-end recovery paths surfaced by the per-session warm
// xterm Overlay (`src/components/TerminalPane.tsx`):
//
//   1. pty-exit-overlay-retry   — user types `/exit` inside the claude TUI.
//      The pty exits cleanly (code 0, no signal). The renderer's
//      pty:exit fan-out drives `_applyPtyExit` → `classifyPtyExit` → 'clean',
//      and TerminalPane mounts the clean-exit overlay
//      (`data-pty-exit-kind="clean"`). Clicking Retry must spawn a NEW pty
//      under the SAME sid (sid stable, pid changes).
//
//   2. pty-crash-overlay-retry  — user's claude process is forcibly killed
//      from outside ccsm (we simulate by SIGKILL'ing the claude PID via
//      `process.kill` in the harness, using the pid surfaced by
//      `window.ccsmPty.list()`). pty:exit fires with `signal != null` →
//      `classifyPtyExit` → 'crashed'. Renderer mounts the crashed overlay
//      (`data-pty-exit-kind="crashed"`). Retry must spawn a NEW pty under
//      the SAME sid.
//
// Out of scope (per parent direction): `claude-missing-guide` — explicitly
// excluded. The ClaudeMissingGuide branch of App.tsx is covered by the
// `terminal-pane-mounted` case in harness-ui.mjs's fallback assertion.
//
// Group: shared. Both cases run in one isolated electron launch.
//
// Run: `node scripts/harness-e2e-error-recovery.mjs`
// Run one: `node scripts/harness-e2e-error-recovery.mjs --only=pty-exit-overlay-retry`

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  dismissFirstRunModals,
  launchCcsmIsolated,
  readXtermLines,
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
      console.log('Usage: node scripts/harness-e2e-error-recovery.mjs [--only=name1,name2] [--skip=name1,name2]');
      for (const c of CASE_REGISTRY) console.log('  -', c.name);
      process.exit(0);
    }
  }
  return out;
}

// ============================================================================
// Shared helpers
// ============================================================================

/** Look up the pty pid for a sid via window.ccsmPty.list(). Null on miss. */
async function getPtyPidForSid(win, sid) {
  return await win.evaluate(async (s) => {
    if (!window.ccsmPty || typeof window.ccsmPty.list !== 'function') return null;
    try {
      const arr = await window.ccsmPty.list();
      const entry = (arr || []).find((x) => x.sid === s);
      return entry && typeof entry.pid === 'number' ? entry.pid : null;
    } catch (_) {
      return null;
    }
  }, sid);
}

/**
 * Wait for `disconnectedSessions[sid]` to land in the renderer store. The
 * store slice is mutated by the module-level `pty.onExit` listener installed
 * in `xtermWarmRegistry`, so observing the store is the canonical proxy for
 * "the pty:exit IPC has been received AND classified". Returns the
 * `{kind, code, signal, at}` record.
 */
async function waitForPtyExitInStore(win, sid, { timeout = 60_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await win.evaluate((s) => {
      const useStore = window.__ccsmStore;
      if (!useStore) return null;
      return useStore.getState().disconnectedSessions[s] ?? null;
    }, sid);
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`waitForPtyExitInStore: disconnectedSessions[${sid}] never populated within ${timeout}ms (last=${JSON.stringify(last)})`);
}

/**
 * Wait for the TerminalPane overlay to mount with the expected exitKind.
 * Returns the matched DOM snapshot for diagnostic logging.
 */
async function waitForExitOverlay(win, sid, expectedKind, { timeout = 8_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await win.evaluate(({ s, kind }) => {
      const host = document.querySelector(`[data-terminal-host][data-active-sid="${s}"]`);
      if (!host) return { hostFound: false };
      // The overlay is rendered as an absolute-positioned sibling inside
      // the host. data-pty-exit-kind is the unique discriminator (only the
      // exit overlay carries it).
      const overlay = host.querySelector(`[data-pty-exit-kind="${kind}"]`);
      if (!overlay) {
        const anyOverlay = host.querySelector('[data-pty-exit-kind]');
        return {
          hostFound: true,
          overlayFound: false,
          observedKind: anyOverlay ? anyOverlay.getAttribute('data-pty-exit-kind') : null,
        };
      }
      // Hunt for the Retry button — copy varies across i18n, but it's the
      // only <button> sibling inside the overlay.
      const retry = overlay.querySelector('button');
      return {
        hostFound: true,
        overlayFound: true,
        kindAttr: overlay.getAttribute('data-pty-exit-kind'),
        hasRetry: !!retry,
        retryText: retry ? (retry.textContent || '').trim() : null,
      };
    }, { s: sid, kind: expectedKind });
    if (last.overlayFound) return last;
    await sleep(150);
  }
  throw new Error(
    `waitForExitOverlay: data-pty-exit-kind="${expectedKind}" overlay never mounted for sid=${sid} within ${timeout}ms (last=${JSON.stringify(last)})`,
  );
}

/**
 * Click the Retry button inside the exit overlay for the given sid. Returns
 * after the click; caller awaits the subsequent state transition.
 */
async function clickOverlayRetry(win, sid) {
  const clicked = await win.evaluate((s) => {
    const host = document.querySelector(`[data-terminal-host][data-active-sid="${s}"]`);
    if (!host) return { ok: false, reason: 'no-host' };
    const overlay = host.querySelector('[data-pty-exit-kind]');
    if (!overlay) return { ok: false, reason: 'no-overlay' };
    const retry = overlay.querySelector('button');
    if (!retry) return { ok: false, reason: 'no-retry-btn' };
    retry.click();
    return { ok: true };
  }, sid);
  if (!clicked.ok) throw new Error(`clickOverlayRetry: ${clicked.reason}`);
}

/**
 * Wait until a fresh pty exists under the same sid with a pid distinct
 * from `prevPid`. Used to verify Retry actually spawned a new pty rather
 * than just clearing the overlay.
 */
async function waitForNewPtyPid(win, sid, prevPid, { timeout = 45_000 } = {}) {
  const deadline = Date.now() + timeout;
  let lastPid = null;
  while (Date.now() < deadline) {
    lastPid = await getPtyPidForSid(win, sid);
    if (typeof lastPid === 'number' && lastPid !== prevPid) return lastPid;
    await sleep(200);
  }
  throw new Error(
    `waitForNewPtyPid: sid=${sid} pid did not change from prev=${prevPid} (current=${lastPid}) within ${timeout}ms`,
  );
}

// ============================================================================
// Case: pty-exit-overlay-retry
// ============================================================================

async function casePtyExitOverlayRetry({ win, tempDir }) {
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30_000 },
  );

  const { sid } = await seedSession(win, { name: 'exit-retry-probe', cwd: tempDir });
  if (!sid) throw new Error('seedSession returned no sid');
  await sleep(3000);
  await waitForTerminalReady(win, sid, { timeout: 60_000 });
  await waitForXtermBuffer(win, /trust|claude|welcome|│|╭|>/i, { timeout: 30_000 });
  await dismissFirstRunModals(win);

  const pidBefore = await getPtyPidForSid(win, sid);
  if (typeof pidBefore !== 'number') {
    throw new Error(`could not read initial pid for sid=${sid}: ${JSON.stringify(pidBefore)}`);
  }
  console.log(`[case=pty-exit-overlay-retry] initial pid=${pidBefore}`);

  // Drive `/exit`. claude's TUI registers the slash command and quits with
  // exit code 0 once it finishes its flush.
  //
  // We use the main-process IPC bridge (`window.ccsmPty.input(sid, data)`)
  // rather than `sendToClaudeTui` (which goes through xterm's
  // `triggerDataEvent` → `onData` → `ccsmPty.input`). Empirically, the
  // `triggerDataEvent` path is flaky in headless / xvfb: focus-state races
  // and `onData` listener-arming timing can drop the keystroke before it
  // reaches pty stdin, while the direct IPC call guarantees the bytes
  // land on the pty regardless of xterm focus. Direct IPC bypasses the
  // xterm focus/timing wrinkle while exercising the same downstream code
  // path (`ipcMain.handle('pty:input')` → `entry.pty.write(data)` in
  // `electron/ptyHost/lifecycle.ts`).
  const sendIpc = async (payload) => {
    return await win.evaluate(async ({ s, p }) => {
      if (!window.ccsmPty || typeof window.ccsmPty.input !== 'function') {
        return { ok: false, reason: 'ccsmPty.input unavailable' };
      }
      try {
        await window.ccsmPty.input(s, p);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) };
      }
    }, { s: sid, p: payload });
  };

  // Diagnostic: dump xterm buffer pre-exit so CI logs show what state
  // claude's TUI is actually in before we type `/exit`. Without this we
  // can only guess whether a modal is still up.
  {
    const linesPre = await readXtermLines(win, { lines: 40 }).catch(() => []);
    console.log(`[case=pty-exit-overlay-retry] pre-exit buffer (${linesPre.length} lines):`);
    for (const ln of linesPre) console.log(`  | ${ln}`);
  }

  const sent = await sendIpc('/exit\r');
  if (!sent.ok) {
    throw new Error(`ccsmPty.input('/exit\\r') failed: ${sent.reason}`);
  }

  // Poll for exit with progressive fallbacks. claude's TUI sometimes
  // doesn't react to `/exit\r` in headless CI (focus quirks, prompt-not-
  // ready races, or claude version differences). Try alternative clean-
  // exit triggers at intervals before giving up:
  //   t+15s: re-send `/exit\r`
  //   t+25s: send Ctrl+D (EOF) — standard POSIX clean-exit, bypasses TUI
  //          slash-command parsing entirely
  //   t+35s: send Ctrl+C followed by Ctrl+D (in case a prompt is mid-edit)
  //   t+45s: dump current buffer for diagnostic
  let exitRec = null;
  {
    const start = Date.now();
    const deadline = start + 60_000;
    const sched = [
      { at: 15_000, label: 're-send /exit\\r', fn: () => sendIpc('/exit\r') },
      { at: 25_000, label: 'send Ctrl+D (\\x04)', fn: () => sendIpc('\x04') },
      { at: 35_000, label: 'send Ctrl+C then Ctrl+D', fn: async () => {
        await sendIpc('\x03');
        await sleep(300);
        return sendIpc('\x04');
      } },
    ];
    let idx = 0;
    while (Date.now() < deadline) {
      exitRec = await win.evaluate((s) => {
        const useStore = window.__ccsmStore;
        if (!useStore) return null;
        return useStore.getState().disconnectedSessions[s] ?? null;
      }, sid);
      if (exitRec) break;
      const elapsed = Date.now() - start;
      while (idx < sched.length && elapsed >= sched[idx].at) {
        const step = sched[idx++];
        const r = await step.fn().catch((e) => ({ ok: false, reason: String(e) }));
        console.log(`[case=pty-exit-overlay-retry] fallback t+${Math.round(elapsed)}ms: ${step.label} -> ${JSON.stringify(r)}`);
      }
      await sleep(200);
    }
  }

  if (!exitRec) {
    // Dump xterm buffer so we can see what state the TUI is stuck in.
    const linesPost = await readXtermLines(win, { lines: 60 }).catch(() => []);
    console.log(`[case=pty-exit-overlay-retry] TIMEOUT buffer (${linesPost.length} lines):`);
    for (const ln of linesPost) console.log(`  | ${ln}`);
    throw new Error(`waitForPtyExitInStore: disconnectedSessions[${sid}] never populated within 60000ms after /exit + fallbacks`);
  }

  console.log(`[case=pty-exit-overlay-retry] store exit: ${JSON.stringify(exitRec)}`);
  if (exitRec.kind !== 'clean') {
    throw new Error(
      `expected exitKind="clean" after /exit, got "${exitRec.kind}" (code=${exitRec.code} signal=${exitRec.signal})`,
    );
  }

  // Renderer must mount the clean-exit overlay.
  const overlay = await waitForExitOverlay(win, sid, 'clean');
  if (!overlay.hasRetry) {
    throw new Error(`clean-exit overlay missing Retry button (overlay=${JSON.stringify(overlay)})`);
  }
  console.log(`[case=pty-exit-overlay-retry] clean overlay mounted, retry="${overlay.retryText}"`);

  // Click Retry → new pty under same sid.
  await clickOverlayRetry(win, sid);

  const pidAfter = await waitForNewPtyPid(win, sid, pidBefore, { timeout: 60_000 });
  console.log(`[case=pty-exit-overlay-retry] retry spawned new pid=${pidAfter} (was ${pidBefore})`);

  // The store's disconnectedSessions[sid] must clear once attach lands in
  // 'ready' (see resolveReadyOrExit's clearExit branch). Poll briefly.
  {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const cur = await win.evaluate((s) => {
        return window.__ccsmStore?.getState().disconnectedSessions[s] ?? null;
      }, sid);
      if (!cur) break;
      await sleep(200);
    }
  }

  // Sid stability: the renderer's activeId is the same sid we started with.
  const activeId = await win.evaluate(() => window.__ccsmStore.getState().activeId);
  if (activeId !== sid) {
    throw new Error(`activeId drifted across retry: expected ${sid}, got ${activeId}`);
  }
}

// ============================================================================
// Case: pty-crash-overlay-retry
// ============================================================================

async function casePtyCrashOverlayRetry({ win, tempDir }) {
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30_000 },
  );

  const { sid } = await seedSession(win, { name: 'crash-retry-probe', cwd: tempDir });
  if (!sid) throw new Error('seedSession returned no sid');
  await sleep(3000);
  await waitForTerminalReady(win, sid, { timeout: 60_000 });
  await waitForXtermBuffer(win, /trust|claude|welcome|│|╭|>/i, { timeout: 30_000 });
  await dismissFirstRunModals(win);

  const pidBefore = await getPtyPidForSid(win, sid);
  if (typeof pidBefore !== 'number') {
    throw new Error(`could not read initial pid for sid=${sid}: ${JSON.stringify(pidBefore)}`);
  }
  console.log(`[case=pty-crash-overlay-retry] initial pid=${pidBefore}`);

  // Force-kill the claude PID from OUTSIDE ccsm. On Windows node-pty wraps
  // claude.exe under a conhost/cmd helper, so SIGKILLing the reported pty.pid
  // may or may not reap claude.exe directly. We try multiple approaches:
  //   1. Platform-native taskkill /T /F on Windows (walks the tree).
  //   2. process.kill('SIGKILL') on POSIX.
  // Either path produces a non-zero exit signal that classifyPtyExit
  // categorises as 'crashed' (signal != null OR code !== 0).
  if (process.platform === 'win32') {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('taskkill', ['/T', '/F', '/PID', String(pidBefore)], { windowsHide: true });
    if (r.status !== 0) {
      // Best-effort fallback — process.kill on Windows maps to TerminateProcess
      // which still produces an abnormal exit.
      try { process.kill(pidBefore, 'SIGKILL'); } catch (_) { /* may already be dead */ }
    }
  } else {
    try { process.kill(pidBefore, 'SIGKILL'); } catch (_) { /* race-safe */ }
  }
  console.log(`[case=pty-crash-overlay-retry] sent SIGKILL to pid=${pidBefore}`);

  // pty:exit fires asynchronously; store records the disconnect.
  const exitRec = await waitForPtyExitInStore(win, sid, { timeout: 60_000 });
  console.log(`[case=pty-crash-overlay-retry] store exit: ${JSON.stringify(exitRec)}`);
  if (exitRec.kind !== 'crashed') {
    throw new Error(
      `expected exitKind="crashed" after external kill, got "${exitRec.kind}" (code=${exitRec.code} signal=${exitRec.signal})`,
    );
  }

  // Renderer must mount the crashed-exit overlay (red treatment).
  const overlay = await waitForExitOverlay(win, sid, 'crashed');
  if (!overlay.hasRetry) {
    throw new Error(`crashed-exit overlay missing Retry button (overlay=${JSON.stringify(overlay)})`);
  }
  console.log(`[case=pty-crash-overlay-retry] crashed overlay mounted, retry="${overlay.retryText}"`);

  // Click Retry → new pty under same sid.
  await clickOverlayRetry(win, sid);

  const pidAfter = await waitForNewPtyPid(win, sid, pidBefore, { timeout: 60_000 });
  console.log(`[case=pty-crash-overlay-retry] retry spawned new pid=${pidAfter} (was ${pidBefore})`);

  const activeId = await win.evaluate(() => window.__ccsmStore.getState().activeId);
  if (activeId !== sid) {
    throw new Error(`activeId drifted across retry: expected ${sid}, got ${activeId}`);
  }
}

// ============================================================================
// Registry
// ============================================================================

const CASE_REGISTRY = [
  { name: 'pty-exit-overlay-retry',  group: 'shared', run: casePtyExitOverlayRetry },
  { name: 'pty-crash-overlay-retry', group: 'shared', run: casePtyCrashOverlayRetry },
];

// ============================================================================
// Runner
// ============================================================================

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

  let isolated = null;
  let launched = null;
  try {
    isolated = await createIsolatedClaudeDir();
    launched = await launchCcsmIsolated({ tempDir: isolated.tempDir });
    const ctx = { electronApp: launched.electronApp, win: launched.win, tempDir: isolated.tempDir };
    console.log(`\n[HARNESS=error-recovery] shared launch ready (tempDir=${isolated.tempDir})`);
    for (const c of selected) {
      const t0 = Date.now();
      console.log(`\n[HARNESS=error-recovery] >>> case: ${c.name}`);
      try {
        await c.run(ctx);
        const ms = Date.now() - t0;
        results.push({ name: c.name, ok: true, ms });
        console.log(`[HARNESS=error-recovery] <<< PASS ${c.name} (${ms}ms)`);
      } catch (err) {
        const ms = Date.now() - t0;
        results.push({ name: c.name, ok: false, ms, error: String(err?.stack || err) });
        console.error(`[HARNESS=error-recovery] <<< FAIL ${c.name} (${ms}ms): ${err?.message || err}`);
      }
    }
  } finally {
    if (launched?.electronApp) try { await launched.electronApp.close(); } catch (_) { /* ignore */ }
    launched?.cleanup?.();
    isolated?.cleanup?.();
  }

  const totalMs = Date.now() - harnessStart;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('\n===== HARNESS=error-recovery SUMMARY =====');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(34)} ${r.ms}ms`);
  }
  console.log(`  total: ${passed}/${results.length} passed, ${(totalMs / 1000).toFixed(1)}s wall`);
  process.exit(failed === 0 ? 0 : 1);
}

const _entryUrlMain =
  process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (_entryUrlMain && import.meta.url === _entryUrlMain) {
  main().catch((err) => {
    console.error('[HARNESS=error-recovery] unhandled top-level error:', err?.stack || err);
    process.exit(1);
  });
}
