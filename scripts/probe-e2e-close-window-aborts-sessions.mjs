// Regression probe for Worker D finding #3 (subprocess lifecycle):
// closing the app window (the real-quit path, not minimize-to-tray) must
// tear down every live agent session before the Electron process exits.
// Before the fix, `app.before-quit` only flipped `isQuitting=true`; cleanup
// happened inside `window-all-closed`, which could miss the tray→Quit path
// (windows hidden, not closed). The fix pulls `sessions.closeAll()` forward
// into `before-quit` as a belt-and-suspenders guarantee.
//
// Scope (#77 follow-up): asserts the `before-quit` handler body, NOT the
// quit-path wiring. We emit `before-quit` directly on the app object and
// observe `sessions.closeAll()` running. The probe deliberately does not
// exercise tray→Quit, dock-Quit, or `app.quit() → window-all-closed →
// closeAll` secondary paths — those are quit-machinery wiring tests, out
// of scope here. If you regress those wirings this probe will not catch it.
//
// Liveness signal:
//   The legacy probe polled the OS pid via `process.kill(pid, 0)`. After
//   PR #271/#273 the agent runs through the SDK transport and the main
//   process no longer holds a child pid (`getPid()` returns undefined by
//   design). Instead we use `sessions.activeSessionCount()` exposed via the
//   `globalThis.__ccsmDebug` backdoor in main.ts as the liveness signal:
//   before triggering shutdown the count must be > 0; after the
//   `before-quit` handler runs it must be 0.
//
// False-pass guard (#77 A1): `count → 0` could also be satisfied by the CLI
// self-crashing during the 5s poll (the manager's onExit callback also
// removes the runner from the map). To distinguish handler-driven teardown
// from incidental CLI death, we baseline `__ccsmDebug.selfExitCount()` before
// `before-quit` fires and assert it didn't move during the poll. The counter
// only increments on the self-exit branch (when the runner is still in the
// map at onExit time) — close()/closeAll() delete first, so handler-driven
// teardown leaves the counter unchanged.
//
// Strategy:
//   - Launch Electron with an isolated userData dir.
//   - Spawn a real agent session via agentStart; assert active count > 0
//     through the debug backdoor.
//   - Drive the real-quit cleanup path by emitting `before-quit` on the
//     main-process app object (the same hook that fires on tray→Quit /
//     Cmd-Q). We don't call `app.quit()` because that would tear down the
//     Electron process and leave the probe with no surface to assert on.
//   - Poll `activeSessionCount()` until it goes to 0 or we time out.
//
// Falls back to SKIP if claude isn't resolvable on this host (same policy as
// the companion delete-session probe).
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
  console.error(`\n[probe-e2e-close-window-aborts-sessions] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

function skip(msg) {
  console.log(`\n[probe-e2e-close-window-aborts-sessions] SKIP: ${msg}`);
  process.exit(0);
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

try { // ccsm-probe-cleanup-wrap

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore && !!window.ccsm, null, {
    timeout: 15_000
  });

  const cwd = root;
  // Real UUID required since PR-D (#274): the SDK now validates sessionId
  // and emits `session_id_mismatch` warnings (creating mis-named JSONL
  // transcripts) when given a non-UUID like the legacy `s-close-probe`.
  const sessionId = randomUUID();
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

  // Confirm the runner registered in the main-process map. agentStart only
  // resolves ok:true after start() pushes the runner into `sessions.runners`,
  // but a tiny micro-task tail can still leave the count at 0 for a tick.
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
    `[probe-e2e-close-window-aborts-sessions] activeSessionCount before quit = ${countBefore}`
  );

  // Baseline the self-exit counter so we can detect false-pass via CLI
  // self-crash during the poll window (see #77 A1 in the header).
  const selfExitsBefore = await app.evaluate(() => {
    const dbg = globalThis.__ccsmDebug;
    return dbg && dbg.selfExitCount ? dbg.selfExitCount() : -1;
  });
  if (selfExitsBefore < 0) {
    fail('__ccsmDebug.selfExitCount missing — main.ts backdoor stale', app);
  }

  // Drive the real-quit cleanup path. Emitting `before-quit` synchronously
  // runs the same handler the tray menu's Quit item triggers:
  //   isQuitting = true; sessions.closeAll();
  // We deliberately do NOT call app.quit() here — that would tear down the
  // Electron process and leave us with no surface to verify against. The
  // cleanup itself is what we're testing; the actual exit is exercised by
  // every other e2e probe that calls `app.close()`.
  await app.evaluate(({ app: a }) => {
    a.emit('before-quit', { preventDefault() {}, defaultPrevented: false });
  });

  // Poll for activeSessionCount to drop to 0. closeAll() is synchronous in
  // the manager (it calls runner.close() and clears the map), so this
  // usually lands on the first read; allow up to 5s for the SDK transport's
  // own teardown to settle the runner-side abort.
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
      `activeSessionCount=${countAfter} 5s after before-quit; expected 0 — closeAll regression`,
      app
    );
  }

  // False-pass guard: a CLI self-crash during the poll would also drive the
  // count to 0 without the close handler ever running. Confirm the
  // self-exit counter didn't move.
  const selfExitsAfter = await app.evaluate(() => {
    const dbg = globalThis.__ccsmDebug;
    return dbg ? dbg.selfExitCount() : -1;
  });
  if (selfExitsAfter !== selfExitsBefore) {
    fail(
      `selfExitCount went ${selfExitsBefore} -> ${selfExitsAfter} during the ` +
        `before-quit poll window. The CLI self-exited; the close handler may ` +
        `not have run. Cannot distinguish handler-driven teardown from ` +
        `incidental CLI death — false pass.`,
      app
    );
  }

  console.log('\n[probe-e2e-close-window-aborts-sessions] OK');
  console.log(`  activeSessionCount went ${countBefore} -> 0 within 5s of before-quit`);

  await app.close();
} catch (err) {
  console.error('[probe-e2e-close-window-aborts-sessions] threw:', err);
  await app.close().catch(() => {});
  process.exit(1);
} finally {
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
