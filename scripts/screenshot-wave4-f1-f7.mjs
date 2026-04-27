// Screenshot capture for the two Wave 4 F1+F7 banners.
// Renders each banner state via the same store seeds the harness uses, then
// saves a PNG to /tmp/ so the PR body can reference them.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const app = await electron.launch({
  args: ['.'],
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production', CCSM_PROD_BUNDLE: '1' },
});

try {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15_000 });
  await win.setViewportSize({ width: 1100, height: 700 });

  // Suppress CLI-missing dialog.
  await win.evaluate(() => {
    window.__ccsmStore.setState({
    });
  });

  const SID = 's-shot';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'screenshot', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4-7', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [] },
    });
  }, SID);
  await win.waitForTimeout(250);

  // --- F1: diagnostic banner (error level) ---
  await win.evaluate((sid) => {
    window.__ccsmStore.getState().pushDiagnostic({
      sessionId: sid,
      level: 'error',
      code: 'init_failed',
      message: 'Agent initialize handshake failed — permission prompts may be degraded: control_request stream closed',
      timestamp: Date.now(),
    });
  }, SID);
  await win.waitForTimeout(400);
  await win.screenshot({ path: '/tmp/wave4-f1-diagnostic-banner.png' });
  console.log('wrote /tmp/wave4-f1-diagnostic-banner.png');

  // Dismiss and seed an init-failed banner for the F7 screenshot.
  await win.evaluate(() => {
    const st = window.__ccsmStore.getState();
    for (const d of st.diagnostics) st.dismissDiagnostic(d.id);
  });
  await win.waitForTimeout(200);

  // --- F7: init-failed banner ---
  await win.evaluate((sid) => {
    window.__ccsmStore.getState().setSessionInitFailure(sid, {
      error: 'spawn claude.exe EACCES: permission denied (C:\\Users\\me\\claude\\claude.exe)',
      errorCode: undefined,
      searchedPaths: [],
    });
  }, SID);
  await win.waitForTimeout(400);
  await win.screenshot({ path: '/tmp/wave4-f7-init-failed-banner.png' });
  console.log('wrote /tmp/wave4-f7-init-failed-banner.png');
} finally {
  await app.close();
}
