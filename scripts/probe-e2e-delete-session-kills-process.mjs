// Regression probe for Worker D finding #1 (subprocess lifecycle):
// deleting a session while its claude.exe child is live must kill the child.
// Before the fix, `deleteSession()` in the store cleared renderer state but
// never dispatched `agent:close`, so the spawned process kept running (and
// burning tokens) as a zombie until the app quit.
//
// Strategy:
//   - Launch Electron with an isolated userData dir + a real CLI present on
//     the machine (resolved through AGENTORY_CLAUDE_BIN / PATH by main).
//   - Seed a session and trigger agentStart through the live IPC bridge.
//     claude.exe sits at the stdio prompt waiting for a `user` frame — it
//     doesn't need a real prompt or network to exist as a process.
//   - Snapshot the pid via the dev-only `globalThis.__agentoryDebug` backdoor
//     installed in electron/main.ts (guarded by !app.isPackaged).
//   - Call the store's deleteSession action and then poll
//     `process.kill(pid, 0)` from the probe's node runtime — on Windows this
//     uses OpenProcess under the hood, and throws ESRCH once the child is
//     gone. If it still responds after 3 seconds we fail.
//
// If claude.exe is not installed/resolvable in this environment we exit 0
// with a SKIP banner — running this probe in CI without the binary should
// not fail the matrix, and dev machines always have it.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-e2e-delete-session-kills-process] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

function skip(msg) {
  console.log(`\n[probe-e2e-delete-session-kills-process] SKIP: ${msg}`);
  process.exit(0);
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    // Signal 0 is a liveness check on POSIX; on Windows Node maps it to
    // OpenProcess + check status. Throws on dead / missing process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-delete-'));
console.log(`[probe-e2e-delete-session-kills-process] userData = ${userDataDir}`);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  // AGENTORY_PROD_BUNDLE=1 routes main.ts to load the built renderer from
  // dist/renderer instead of webpack-dev-server on :4100 — lets this probe
  // run without a live `npm run dev:web` in the background.
  env: { ...process.env, NODE_ENV: 'development', AGENTORY_PROD_BUNDLE: '1' }
});

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__agentoryStore && !!window.agentory, null, {
    timeout: 15_000
  });

  // Seed a real session with a cwd that actually exists on disk so
  // `agent:start` in main.ts doesn't bounce us with CWD_MISSING.
  const cwd = root;
  const sessionId = 's-delete-probe';
  await win.evaluate(
    ({ sid, cwd }) => {
      const store = window.__agentoryStore;
      store.setState({
        groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
        sessions: [
          {
            id: sid,
            name: 'delete-probe',
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

  // Kick off the real agent spawn through the live IPC bridge.
  const startRes = await win.evaluate(
    async ({ sid, cwd }) =>
      await window.agentory.agentStart(sid, {
        cwd,
        permissionMode: 'default'
      }),
    { sid: sessionId, cwd }
  );
  if (!startRes || startRes.ok !== true) {
    // CLAUDE_NOT_FOUND → treat as skip (no binary on this host).
    if (startRes && startRes.errorCode === 'CLAUDE_NOT_FOUND') {
      skip(`claude CLI not resolvable on PATH; cannot verify subprocess lifecycle (${startRes.error})`);
    }
    fail(`agentStart failed: ${JSON.stringify(startRes)}`, app);
  }

  // Flip started/running in the store so deleteSession actually dispatches
  // agentClose (it short-circuits for never-spawned sessions).
  await win.evaluate((sid) => {
    const st = window.__agentoryStore.getState();
    st.markStarted(sid);
    st.setRunning(sid, true);
  }, sessionId);

  // Grab the child pid via the main-process debug backdoor. Poll briefly
  // because claude.exe's spawn-through-cmd-shim path on Windows has a tiny
  // lag between agentStart resolving and the pid becoming readable.
  let pid = null;
  for (let i = 0; i < 30; i++) {
    const pids = await app.evaluate(() => {
      const dbg = globalThis.__agentoryDebug;
      return dbg ? dbg.activeSessionPids() : null;
    });
    if (!pids) fail('globalThis.__agentoryDebug missing in main process', app);
    const row = pids.find((r) => r.sessionId === sessionId);
    if (row && typeof row.pid === 'number') {
      pid = row.pid;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!pid) fail('never observed a pid for the spawned session', app);
  console.log(`[probe-e2e-delete-session-kills-process] live pid = ${pid}`);

  if (!isPidAlive(pid)) {
    fail(`reported pid ${pid} was already dead before delete — spawner smoke failed`, app);
  }

  // Trigger the store's deleteSession — the path under test. This should
  // dispatch window.agentory.agentClose(sid) as a side effect.
  await win.evaluate((sid) => {
    window.__agentoryStore.getState().deleteSession(sid);
  }, sessionId);

  // Poll for the pid to go away. The spawner escalates SIGTERM → SIGKILL
  // after killGracePeriodMs (default 5s), but a soft interrupt usually lands
  // within a second.
  const deadline = Date.now() + 8_000;
  let dead = false;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      dead = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!dead) {
    fail(`pid ${pid} still alive 8s after deleteSession — zombie regression`, app);
  }

  // Double-check the main-process map also forgot the runner.
  const remaining = await app.evaluate(() => {
    const dbg = globalThis.__agentoryDebug;
    return dbg ? dbg.activeSessionCount() : -1;
  });
  if (remaining !== 0) {
    fail(`activeSessionCount=${remaining} after deleteSession; expected 0`, app);
  }

  console.log('\n[probe-e2e-delete-session-kills-process] OK');
  console.log(`  spawned claude pid=${pid} killed within 8s of deleteSession`);
  console.log('  activeSessionCount went to 0');

  await app.close();
} catch (err) {
  console.error('[probe-e2e-delete-session-kills-process] threw:', err);
  await app.close().catch(() => {});
  process.exit(1);
} finally {
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
