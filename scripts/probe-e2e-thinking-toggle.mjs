// E2E: extended-thinking toggle through the slash-command palette.
//
// Drives the LIVE user flow end-to-end:
//   1. Boot app, install ipcMain spy on `agent:setMaxThinkingTokens`
//      (renderer-side `window.ccsm.agent.setMaxThinkingTokens` is bound by
//      contextBridge and not replaceable from the renderer; the spy must
//      live in the main process).
//   2. Seed an active session via `__ccsmStore.getState().createSession`.
//   3. Focus the InputBar textarea, type `/think` so the live picker opens
//      with the `/think` row visible.
//   4. Read the trailing `[data-testid="slash-think-switch"]` data-state —
//      proves the picker is rendering the current thinking-off state.
//   5. Capture pre-store state, click the switch (its pointer-events are
//      none, so the click bubbles to the row's onMouseDown which calls
//      `commitSlashCommand` → `clientHandler` → `setThinkingLevel`).
//   6. Wait for store to flip to default_on; the picker closed itself, so
//      re-type `/think` and verify the switch now reads "checked".
//   7. Click the row again (toggle off), verify reverts to off.
//   8. Verify the ipcMain spy received both toggle calls — proves the
//      `setMaxThinkingTokens` IPC actually fires from store.ts's fan-out.
//
// All previous source-imports (`page.evaluate(import('/src/...'))`) were
// removed: `startBundleServer` only serves `dist/renderer/`, so dynamic TS
// imports 404. Vitest covers registry-presence assertions
// (tests/thinking.test.ts); this probe owns the live UI flow.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-thinking-toggle] FAIL: ${msg}`);
  process.exit(1);
}

const { port: PORT, close: closeServer } = await startBundleServer(root);
const { dir: userDataDir, cleanup } = isolatedUserData('agentory-probe-thinking');

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    CCSM_DEV_PORT: String(PORT),
  },
});

try {
  const win = await appWindow(app);
  win.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.ccsm && !!window.__ccsmStore, null, {
    timeout: 20_000,
  });

  // Step 1: install ipcMain spy. Renderer-side window.ccsm methods are
  // contextBridge-bound and non-writable; spying must happen in main. We
  // remove + reinstall the existing handler to capture every call while
  // still echoing the upstream success shape.
  await app.evaluate(({ ipcMain }) => {
    const calls = (global.__thinkingIpcCalls = []);
    try {
      ipcMain.removeHandler('agent:setMaxThinkingTokens');
    } catch {}
    ipcMain.handle('agent:setMaxThinkingTokens', (_e, sessionId, tokens) => {
      calls.push({ sessionId, tokens });
      return { ok: true };
    });
  });

  // Step 2: seed a session. App.tsx renders an empty-state when sessions=[];
  // the InputBar lives inside ChatPane which is only mounted when there's an
  // active session, so we must createSession first. We also flip
  // `startedSessions[sid] = true` so store.ts:setThinkingLevel actually
  // dispatches the IPC fan-out (it short-circuits for un-started sessions
  // since otherwise there's no SDK Query handle to push the cap into).
  // Marking the session "started" without spawning the CLI is safe — the
  // ipcMain spy intercepts the call before it reaches the SDK.
  await win.evaluate(() => {
    const store = window.__ccsmStore;
    const s = store.getState();
    if (s.sessions.length === 0) s.createSession('~');
    const sid = store.getState().activeId;
    store.setState((prev) => ({
      startedSessions: { ...prev.startedSessions, [sid]: true },
    }));
  });

  // Wait for the InputBar textarea to mount.
  const textarea = win.locator('textarea[data-input-bar]');
  await textarea.waitFor({ state: 'visible', timeout: 10_000 });

  // Step 3: type `/think` so the live picker opens.
  await textarea.click();
  await textarea.fill('/think');

  // Step 4: live `/think` row should appear with the trailing switch in the
  // unchecked (off) state. Selector matches SlashCommandPicker.tsx:222.
  const switchEl = win.locator('[data-testid="slash-think-switch"]');
  await switchEl.waitFor({ state: 'visible', timeout: 5_000 });
  const stateBefore = await switchEl.getAttribute('data-state');
  if (stateBefore !== 'unchecked') {
    fail(`switch initial state expected 'unchecked', got '${stateBefore}'`);
  }

  // Capture pre-toggle store state.
  const pre = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    const sid = s.activeId;
    return {
      sid,
      level: s.thinkingLevelBySession[sid] ?? s.globalThinkingDefault,
    };
  });
  if (pre.level !== 'off') fail(`pre store level expected 'off', got '${pre.level}'`);

  // Step 5: click the switch. Inside SlashCommandPicker.tsx the trailing
  // <span> is `aria-hidden` with no pointer-events override on the inner
  // children — Playwright's .click() dispatches at the element center which
  // bubbles up to the row <button>'s onMouseDown handler (the row uses
  // onMouseDown, not onClick, but Playwright's click sequence includes a
  // pointerdown/mousedown that React routes through onMouseDown).
  await switchEl.click();

  // Wait for the store to reflect the toggle. The picker closes after the
  // commit (commitSlashCommand clears the textarea), so we read the store
  // directly.
  await win.waitForFunction(
    (sid) => {
      const s = window.__ccsmStore.getState();
      const lvl = s.thinkingLevelBySession[sid] ?? s.globalThinkingDefault;
      return lvl === 'default_on';
    },
    pre.sid,
    { timeout: 5_000 },
  );

  // Re-open picker and verify the switch reflects the new state.
  await textarea.click();
  await textarea.fill('/think');
  await switchEl.waitFor({ state: 'visible', timeout: 5_000 });
  const stateAfterOn = await switchEl.getAttribute('data-state');
  if (stateAfterOn !== 'checked') {
    fail(`after toggle-on switch state expected 'checked', got '${stateAfterOn}'`);
  }

  // Step 7: toggle off again.
  await switchEl.click();
  await win.waitForFunction(
    (sid) => {
      const s = window.__ccsmStore.getState();
      const lvl = s.thinkingLevelBySession[sid] ?? s.globalThinkingDefault;
      return lvl === 'off';
    },
    pre.sid,
    { timeout: 5_000 },
  );

  // Re-open and verify reverted to unchecked.
  await textarea.click();
  await textarea.fill('/think');
  await switchEl.waitFor({ state: 'visible', timeout: 5_000 });
  const stateAfterOff = await switchEl.getAttribute('data-state');
  if (stateAfterOff !== 'unchecked') {
    fail(`after toggle-off switch state expected 'unchecked', got '${stateAfterOff}'`);
  }

  // Step 8: verify ipcMain spy captured BOTH toggle IPC calls. The store's
  // setThinkingLevel fan-out (store.ts:1463) dispatches
  // agentSetMaxThinkingTokens; main's preload forwards to ipcMain. If the
  // store's IPC dispatch is broken, calls.length === 0.
  const ipcCalls = await app.evaluate(() => (global.__thinkingIpcCalls || []).slice());
  if (ipcCalls.length < 2) {
    fail(
      `expected >=2 setMaxThinkingTokens IPC calls (one per toggle), got ${ipcCalls.length}: ${JSON.stringify(ipcCalls)}`,
    );
  }
  // First call: turn ON → tokens > 0. Second: turn OFF → tokens === 0.
  // (Resolved value comes from getMaxThinkingTokensForModel in the store.)
  const onCall = ipcCalls[0];
  const offCall = ipcCalls[1];
  if (!(onCall.tokens > 0)) {
    fail(`first IPC call (toggle on) expected tokens > 0, got ${JSON.stringify(onCall)}`);
  }
  if (offCall.tokens !== 0) {
    fail(`second IPC call (toggle off) expected tokens === 0, got ${JSON.stringify(offCall)}`);
  }
  if (onCall.sessionId !== pre.sid || offCall.sessionId !== pre.sid) {
    fail(
      `IPC sessionId mismatch — expected ${pre.sid}, got on=${onCall.sessionId} off=${offCall.sessionId}`,
    );
  }

  console.log('\n[probe-e2e-thinking-toggle] OK');
  console.log('  /think live row toggles store off ↔ default_on');
  console.log('  Switch facsimile reflects state (unchecked ↔ checked)');
  console.log(`  setMaxThinkingTokens IPC fired: on tokens=${onCall.tokens}, off tokens=${offCall.tokens}`);
} finally {
  await app.close();
  closeServer();
  cleanup();
}
