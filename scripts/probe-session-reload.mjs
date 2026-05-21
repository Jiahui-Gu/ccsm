// Right-click "Reload session" diagnostic probe.
//
// Question this answers: when the user invokes `reloadSession(sid)` from
// the sidebar's right-click menu, does the renderer correctly:
//   1. kill the running pty (observable as a `pty:kill` IPC call), and
//   2. re-spawn a fresh pty for the same sid (observable as a NEW pid),
// while preserving the visible xterm host (same sid wired up after the
// reload — claude transcript continuation is the SDK's responsibility,
// out of scope here).
//
// Strategy:
//   1. Launch ccsm isolated + seed a session, wait for terminal ready.
//   2. Capture the pid of the spawned pty (read via `ccsmPty.get(sid)`
//      from the renderer; the main-process bridge already exposes pid).
//   3. Patch the `pty:kill` ipcMain handler to count invocations
//      (mirrors probe-paste-double-fire's pattern — `ccsmPty` is frozen
//      so we can't monkey-patch from the renderer).
//   4. Drive the store action: `useStore.getState().reloadSession(sid)`.
//   5. Wait for the attach effect to settle (poll `pty.get(sid)` until
//      pid changes from the pre-reload pid).
//   6. Assert: kill was called once, new pid differs from old pid, host
//      element still present with same data-active-sid.
//
// This is a workshop probe — it requires `npm run build` + a working
// claude binary. CI does NOT run it; reviewer runs locally to validate
// the reload path end-to-end.

import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
  seedSession,
  waitForTerminalReady,
  dismissFirstRunModals,
} from './probe-utils-real-cli.mjs';

async function main() {
  const { tempDir } = await createIsolatedClaudeDir();
  console.log('[probe] tempDir=', tempDir);

  const { electronApp, win } = await launchCcsmIsolated({ tempDir });

  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    const { sid } = await seedSession(win, { name: 'reload-probe', cwd: tempDir });
    if (!sid) throw new Error('seedSession returned empty sid');
    console.log('[probe] seeded sid=', sid);

    await new Promise((r) => setTimeout(r, 4000));
    await waitForTerminalReady(win, sid, { timeout: 60000 });
    await dismissFirstRunModals(win);

    // Patch pty:kill to count calls.
    await electronApp.evaluate(({ ipcMain }) => {
      const g = globalThis;
      g.__reloadProbeKills = [];
      const internal = ipcMain;
      const handlers = internal._invokeHandlers;
      const orig = handlers.get('pty:kill');
      if (!orig) {
        g.__reloadProbeError = 'no existing pty:kill handler';
        return;
      }
      handlers.set('pty:kill', async (event, ...args) => {
        const [killedSid] = args;
        g.__reloadProbeKills.push({ sid: killedSid, ts: Date.now() });
        return orig(event, ...args);
      });
      g.__reloadProbeReady = true;
    });
    const ipcReady = await electronApp.evaluate(() => ({
      ready: globalThis.__reloadProbeReady === true,
      error: globalThis.__reloadProbeError || null,
    }));
    console.log('[probe] ipcMain patch:', ipcReady);
    if (!ipcReady.ready) throw new Error('failed to patch ipcMain.handle for pty:kill');

    // Capture pre-reload pid.
    const preInfo = await win.evaluate(async (s) => {
      return await window.ccsmPty.get(s);
    }, sid);
    console.log('[probe] pre-reload info:', preInfo);
    if (!preInfo || typeof preInfo.pid !== 'number') {
      throw new Error('no pid for sid before reload — pty not running?');
    }
    const prePid = preInfo.pid;

    // Drive the action.
    await win.evaluate((s) => {
      const useStore = window.__ccsmStore;
      if (!useStore) throw new Error('window.__ccsmStore not ready');
      const { reloadSession } = useStore.getState();
      void reloadSession(s);
    }, sid);

    // Wait for the attach effect to spawn a new pty (different pid).
    const start = Date.now();
    let postInfo = null;
    while (Date.now() - start < 30000) {
      postInfo = await win
        .evaluate(async (s) => await window.ccsmPty.get(s), sid)
        .catch(() => null);
      if (postInfo && typeof postInfo.pid === 'number' && postInfo.pid !== prePid) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log('[probe] post-reload info:', postInfo);

    const kills = await electronApp.evaluate(() => globalThis.__reloadProbeKills.slice());
    console.log(`[probe] pty:kill invoked ${kills.length} time(s):`, kills);

    // Verify the host element is still rendered for this sid.
    const hostStillPresent = await win.evaluate(
      (s) => !!document.querySelector(`[data-terminal-host][data-active-sid="${s}"]`),
      sid,
    );
    console.log('[probe] host element present after reload:', hostStillPresent);

    console.log('\n[probe] === summary ===');
    console.log(`pre-reload pid:     ${prePid}`);
    console.log(`post-reload pid:    ${postInfo?.pid ?? '(none)'}`);
    console.log(`pty:kill calls:     ${kills.length}`);
    console.log(`host preserved:     ${hostStillPresent}`);

    const ok =
      kills.length >= 1 &&
      postInfo &&
      typeof postInfo.pid === 'number' &&
      postInfo.pid !== prePid &&
      hostStillPresent;
    console.log(`\n[probe] result:     ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) process.exitCode = 1;
  } finally {
    try { await electronApp.close(); } catch (_) { /* ignore */ }
  }
}

main().catch((e) => {
  console.error('[probe] failed:', e);
  process.exit(1);
});
