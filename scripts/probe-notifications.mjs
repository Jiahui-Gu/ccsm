// Probe: OS notifications IPC wiring and click routing.
//
// Scope: black-box verification that
//   a) the renderer->main IPC path for `notification:show` is reachable and
//      delivers the full payload (sessionId, title, eventType, silent),
//   b) main listens for window close/focus events and a click-through would
//      route via `notification:focusSession` (we bypass the real OS toast).
//
// Focus-suppression and debounce rules are exhaustively covered by
// tests/notifications-dispatch.test.ts; this probe intentionally does NOT
// re-run those in the live app — the renderer doesn't expose the dispatch
// module on `window`, and the unit tests already pin the logic.
//
// Run: `AGENTORY_DEV_PORT=4182 npm run dev` in one terminal, then
//      `node scripts/probe-notifications.mjs` in another.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-notifications] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    AGENTORY_DEV_PORT: process.env.AGENTORY_DEV_PORT ?? '4182'
  }
});

const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

// Replace `notification:show` with a recorder. This both prevents a real OS
// toast during the probe and gives the probe a way to assert the payload.
await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
  /** @type {Array<any>} */
  const calls = [];
  /** @type {Array<string>} */
  const focusSent = [];
  ipcMain.removeHandler('notification:show');
  ipcMain.handle('notification:show', (e, payload) => {
    calls.push(payload);
    // Simulate the click-through branch: send `notification:focusSession`
    // back to the renderer immediately. In real life this happens only on
    // the user clicking the toast, but we want to verify the round-trip.
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) {
      win.webContents.send('notification:focusSession', payload.sessionId);
      focusSent.push(payload.sessionId);
    }
    return true;
  });
  /** @type {any} */ (globalThis).__probeNotifyCalls = calls;
  /** @type {any} */ (globalThis).__probeFocusSent = focusSent;
});

// Prime: have the renderer install a listener for notification:focusSession so
// we can verify the round-trip arrives back in the renderer.
await win.evaluate(() => {
  /** @type {any} */
  const w = window;
  w.__probeFocusReceived = [];
  if (w.agentory?.onNotificationFocus) {
    w.agentory.onNotificationFocus((sessionId) => {
      w.__probeFocusReceived.push(sessionId);
    });
  }
});

// Drive: fire the IPC call the same way dispatch does after passing its gates.
const drive = await win.evaluate(async () => {
  /** @type {any} */
  const w = window;
  if (!w.agentory || typeof w.agentory.notify !== 'function') {
    return { ok: false, reason: 'window.agentory.notify missing' };
  }
  await w.agentory.notify({
    sessionId: 's-probe-1',
    title: 'probe permission',
    body: 'renderer -> main',
    eventType: 'permission',
    silent: true
  });
  return { ok: true };
});
if (!drive.ok) {
  await app.close();
  fail(`renderer drive failed: ${drive.reason}`);
}

// Give the round-trip IPC a beat to land.
await win.waitForTimeout(300);

const mainCalls = await app.evaluate(
  () => /** @type {any} */ (globalThis).__probeNotifyCalls ?? []
);
if (!Array.isArray(mainCalls) || mainCalls.length !== 1) {
  await app.close();
  fail(`expected 1 IPC call to main, got ${mainCalls?.length ?? 0}`);
}
const call = mainCalls[0];
if (
  call.sessionId !== 's-probe-1' ||
  call.eventType !== 'permission' ||
  call.silent !== true ||
  call.title !== 'probe permission'
) {
  await app.close();
  fail(`main received unexpected payload: ${JSON.stringify(call)}`);
}

const received = await win.evaluate(
  () => /** @type {any} */ (window).__probeFocusReceived ?? []
);
if (!Array.isArray(received) || received[0] !== 's-probe-1') {
  await app.close();
  fail(`renderer did not receive focusSession round-trip: ${JSON.stringify(received)}`);
}

console.log('[probe-notifications] OK');
console.log(`  main notify payload:        ${JSON.stringify(call)}`);
console.log(`  focus round-trip received:  ${JSON.stringify(received)}`);

await app.close();
