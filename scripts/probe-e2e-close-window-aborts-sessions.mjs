// Regression probe for Worker D finding #3 (subprocess lifecycle):
// closing the app window (the real-quit path, not minimize-to-tray) must
// tear down every live claude.exe child before the Electron process exits.
// Before the fix, `app.before-quit` only flipped `isQuitting=true`; cleanup
// happened inside `window-all-closed`, which could miss the tray→Quit path
// (windows hidden, not closed). The fix pulls `sessions.closeAll()` forward
// into `before-quit` as a belt-and-suspenders guarantee.
//
// Strategy:
//   - Launch Electron with an isolated userData dir.
//   - Spawn a real claude.exe via agentStart; capture pid through the
//     `globalThis.__ccsmDebug` backdoor.
//   - Set `isQuitting=true` equivalent by calling `app.quit()` on the main
//     process — this bypasses the minimize-to-tray window.close hook and
//     drives the real shutdown path.
//   - After `app.close()` resolves, the probe's own node runtime polls
//     `process.kill(pid, 0)` until the child is gone or we time out.
//
// Falls back to SKIP if claude isn't resolvable on this host (same policy as
// the companion delete-session probe).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-e2e-close-window-aborts-sessions] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

function skip(msg) {
  console.log(`\n[probe-e2e-close-window-aborts-sessions] SKIP: ${msg}`);
  process.exit(0);
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-close-'));
console.log(`[probe-e2e-close-window-aborts-sessions] userData = ${userDataDir}`);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  // CCSM_PROD_BUNDLE=1 avoids a running webpack-dev-server dependency —
  // main.ts loads dist/renderer/index.html directly. The backdoor we rely on
  // is guarded by !app.isPackaged, so it still installs under this flag
  // because we're launched via `electron .` (never packaged).
  env: { ...process.env, NODE_ENV: 'development', CCSM_PROD_BUNDLE: '1' }
});

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore && !!window.ccsm, null, {
    timeout: 15_000
  });

  const cwd = root;
  const sessionId = 's-close-probe';
  await win.evaluate(
    ({ sid, cwd }) => {
      const store = window.__ccsmStore;
      store.setState({
        groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
        sessions: [
          {
            id: sid,
            name: 'close-probe',
            state: 'idle',
            cwd,
            model: 'claude-sonnet-4',
            groupId: 'g1',
            agentType: 'claude-code'
          }
        ],
        activeId: sid,
        messagesBySession: { [sid]: [] },
        startedSessions: {},
        runningSessions: {}
      });
    },
    { sid: sessionId, cwd }
  );

  const startRes = await win.evaluate(
    async ({ sid, cwd }) =>
      await window.ccsm.agentStart(sid, { cwd, permissionMode: 'default' }),
    { sid: sessionId, cwd }
  );
  if (!startRes || startRes.ok !== true) {
    if (startRes && startRes.errorCode === 'CLAUDE_NOT_FOUND') {
      skip(`claude CLI not resolvable on PATH (${startRes.error})`);
    }
    fail(`agentStart failed: ${JSON.stringify(startRes)}`, app);
  }

  // Wait for a real pid to appear in the main-process map.
  let pid = null;
  for (let i = 0; i < 30; i++) {
    const pids = await app.evaluate(() => {
      const dbg = globalThis.__ccsmDebug;
      return dbg ? dbg.activeSessionPids() : null;
    });
    if (!pids) fail('globalThis.__ccsmDebug missing in main process', app);
    const row = pids.find((r) => r.sessionId === sessionId);
    if (row && typeof row.pid === 'number') {
      pid = row.pid;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!pid) fail('never observed a pid for the spawned session', app);
  console.log(`[probe-e2e-close-window-aborts-sessions] live pid = ${pid}`);
  if (!isPidAlive(pid)) {
    fail(`reported pid ${pid} was already dead before quit — spawner smoke failed`, app);
  }

  // Drive the real-quit path. app.quit() emits `before-quit` → our hook
  // fires `sessions.closeAll()`, then window-all-closed + closeDb + actual
  // process exit. This mirrors the tray menu's Quit item, not a plain
  // window close (which minimize-to-tray would intercept).
  await app.evaluate(({ app: a }) => {
    a.quit();
  });

  // Let playwright's wrapper observe the electron process exit.
  await app.close().catch(() => {});

  // Poll from the probe's own runtime — claude.exe is a grandchild of this
  // process, so it outlives app.close() only if the parent leaked it. Give
  // the kernel up to 8s to reap on Windows (WMI reaping can be slow).
  const deadline = Date.now() + 8_000;
  let dead = false;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      dead = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!dead) {
    // Best-effort cleanup before failing so we don't leave a token-burning
    // zombie behind after a regression.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    fail(`pid ${pid} still alive 8s after app.quit() — orphan claude.exe regression`);
  }

  console.log('\n[probe-e2e-close-window-aborts-sessions] OK');
  console.log(`  spawned claude pid=${pid} died within 8s of app.quit()`);
} catch (err) {
  console.error('[probe-e2e-close-window-aborts-sessions] threw:', err);
  await app.close().catch(() => {});
  process.exit(1);
} finally {
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
