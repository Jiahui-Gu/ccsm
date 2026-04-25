// Regression probe for Worker D finding #1 (subprocess lifecycle):
// deleting a session while its agent is live must tear down the runner.
// Before the fix, `deleteSession()` in the store cleared renderer state but
// never dispatched `agent:close`, so the spawned process kept running (and
// burning tokens) as a zombie until the app quit.
//
// Liveness signal:
//   The legacy probe polled the OS pid via `process.kill(pid, 0)`. After
//   PR #271/#273 the agent runs through the SDK transport and the main
//   process no longer holds a child pid (`getPid()` returns undefined by
//   design). Instead we use `sessions.activeSessionCount()` exposed via the
//   `globalThis.__ccsmDebug` backdoor in main.ts as the liveness signal:
//   before delete the count must be > 0; after delete it must drop to 0.
//
// False-pass guard (#77 A1): `count → 0` could also be satisfied by the CLI
// self-crashing during the 5s poll (the manager's onExit callback also
// removes the runner from the map). To distinguish handler-driven teardown
// from incidental CLI death, we baseline `__ccsmDebug.selfExitCount()`
// before deleteSession and assert it didn't move during the poll. The
// counter only increments when onExit fires while the runner is still in
// the map — close() deletes first, so handler-driven teardown leaves the
// counter unchanged.
//
// Strategy:
//   - Launch Electron with an isolated userData dir + a real CLI present on
//     the machine (resolved through CCSM_CLAUDE_BIN / PATH by main).
//   - Seed a session and trigger agentStart through the live IPC bridge.
//     The SDK runner sits at the stdio prompt waiting for a `user` frame —
//     it doesn't need a real prompt or network to exist.
//   - Assert `activeSessionCount() > 0` via the debug backdoor.
//   - Call the store's deleteSession action and poll the backdoor until
//     the count drops to 0 (or we time out).
//
// If claude.exe is not installed/resolvable in this environment we exit 0
// with a SKIP banner — running this probe in CI without the binary should
// not fail the matrix, and dev machines always have it.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
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

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-delete-'));
console.log(`[probe-e2e-delete-session-kills-process] userData = ${userDataDir}`);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  // CCSM_PROD_BUNDLE=1 routes main.ts to load the built renderer from
  // dist/renderer instead of webpack-dev-server on :4100 — lets this probe
  // run without a live `npm run dev:web` in the background.
  env: { ...process.env, NODE_ENV: 'development', CCSM_PROD_BUNDLE: '1' }
});

try { // ccsm-probe-cleanup-wrap

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore && !!window.ccsm, null, {
    timeout: 15_000
  });

  // Seed a real session with a cwd that actually exists on disk so
  // `agent:start` in main.ts doesn't bounce us with CWD_MISSING.
  const cwd = root;
  // Real UUID required since PR-D (#274): the SDK now validates sessionId
  // and emits `session_id_mismatch` warnings (creating mis-named JSONL
  // transcripts) when given a non-UUID like the legacy `s-delete-probe`.
  const sessionId = randomUUID();
  await win.evaluate(
    ({ sid, cwd }) => {
      const store = window.__ccsmStore;
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
      await window.ccsm.agentStart(sid, {
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
    const st = window.__ccsmStore.getState();
    st.markStarted(sid);
    st.setRunning(sid, true);
  }, sessionId);

  // Confirm the runner registered in the main-process map. agentStart only
  // resolves ok:true after start() pushes the runner into the map, but a
  // tiny micro-task tail can still leave the count at 0 for a tick.
  let countBefore = 0;
  for (let i = 0; i < 30; i++) {
    countBefore = await app.evaluate(() => {
      const dbg = globalThis.__ccsmDebug;
      return dbg ? dbg.activeSessionCount() : -1;
    });
    if (countBefore === -1) fail('globalThis.__ccsmDebug missing in main process', app);
    if (countBefore > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (countBefore <= 0) {
    fail(`activeSessionCount=${countBefore} after agentStart; expected > 0`, app);
  }
  console.log(
    `[probe-e2e-delete-session-kills-process] activeSessionCount before delete = ${countBefore}`
  );

  // Baseline self-exit counter for the false-pass guard (see header).
  const selfExitsBefore = await app.evaluate(() => {
    const dbg = globalThis.__ccsmDebug;
    return dbg && dbg.selfExitCount ? dbg.selfExitCount() : -1;
  });
  if (selfExitsBefore < 0) {
    fail('__ccsmDebug.selfExitCount missing — main.ts backdoor stale', app);
  }

  // Trigger the store's deleteSession — the path under test. This should
  // dispatch window.ccsm.agentClose(sid) as a side effect, which calls
  // sessions.close(sid) in the manager and removes the runner from the map.
  await win.evaluate((sid) => {
    window.__ccsmStore.getState().deleteSession(sid);
  }, sessionId);

  // Poll for activeSessionCount to drop to 0. The IPC round-trip + SDK
  // transport teardown usually lands within a few hundred ms; 5s is a
  // generous ceiling.
  const deadline = Date.now() + 5_000;
  let countAfter = countBefore;
  while (Date.now() < deadline) {
    countAfter = await app.evaluate(() => {
      const dbg = globalThis.__ccsmDebug;
      return dbg ? dbg.activeSessionCount() : -1;
    });
    if (countAfter === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (countAfter !== 0) {
    fail(
      `activeSessionCount=${countAfter} 5s after deleteSession; expected 0 — zombie regression`,
      app
    );
  }

  // False-pass guard: a CLI self-crash during the poll would also drive the
  // count to 0 without deleteSession's IPC round-trip ever firing.
  const selfExitsAfter = await app.evaluate(() => {
    const dbg = globalThis.__ccsmDebug;
    return dbg ? dbg.selfExitCount() : -1;
  });
  if (selfExitsAfter !== selfExitsBefore) {
    fail(
      `selfExitCount went ${selfExitsBefore} -> ${selfExitsAfter} during the ` +
        `deleteSession poll window. The CLI self-exited; the close path may ` +
        `not have run. Cannot distinguish handler-driven teardown from ` +
        `incidental CLI death — false pass.`,
      app
    );
  }

  console.log('\n[probe-e2e-delete-session-kills-process] OK');
  console.log(`  activeSessionCount went ${countBefore} -> 0 within 5s of deleteSession`);

  await app.close();
} catch (err) {
  console.error('[probe-e2e-delete-session-kills-process] threw:', err);
  await app.close().catch(() => {});
  process.exit(1);
} finally {
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
