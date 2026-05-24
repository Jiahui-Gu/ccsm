/* eslint-disable no-undef, no-unused-vars */
// Headless dogfood for Ctrl+MouseWheel terminal font-size zoom.
// MUST stay invisible per project policy (no visible window).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');

function log(...a) { console.log('[dogfood]', ...a); }

const app = await electron.launch({
  args: [repo],
  cwd: repo,
  env: {
    ...process.env,
    CCSM_E2E_HIDDEN: '1',
    CCSM_PROD_BUNDLE: '1',
    NODE_ENV: 'production',
    ELECTRON_DISABLE_GPU: '1',
  },
  timeout: 60000,
});

try {
  const isHidden = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((w) => !w.isVisible())
  );
  if (!isHidden) throw new Error('Dogfood opened a visible window - violates project policy');
  log('headless visibility OK');

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore?.getState?.()?.hydrated);
  log('hydrated');

  // Create two sessions via the store API.
  await win.evaluate(async () => {
    const st = window.__ccsmStore.getState();
    // Pre-existing sessions are fine; just make sure we have 2.
    while (window.__ccsmStore.getState().sessions.length < 2) {
      window.__ccsmStore.getState().createSession(null);
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  const sids = await win.evaluate(() =>
    window.__ccsmStore.getState().sessions.slice(0, 2).map((s) => s.id),
  );
  log('sids', sids);

  // Activate session A, wait for warm.
  await win.evaluate((sid) => window.__ccsmStore.getState().selectSession(sid), sids[0]);
  await win.waitForFunction(() => !!window.__ccsmTerm);
  // Quickly warm session B by selecting it then back.
  await win.evaluate((sid) => window.__ccsmStore.getState().selectSession(sid), sids[1]);
  await win.waitForFunction((sid) => {
    return window.__ccsmStore.getState().activeId === sid && !!window.__ccsmTerm;
  }, sids[1]);
  await win.evaluate((sid) => window.__ccsmStore.getState().selectSession(sid), sids[0]);
  await win.waitForFunction((sid) => {
    return window.__ccsmStore.getState().activeId === sid && !!window.__ccsmTerm;
  }, sids[0]);
  await win.waitForTimeout(300);

  const initial = await win.evaluate(() => {
    const t = window.__ccsmTerm;
    return { fontSize: t.options.fontSize };
  });
  log('initial fontSize', initial.fontSize);
  if (initial.fontSize !== 13) throw new Error(`expected initial fontSize=13, got ${initial.fontSize}`);

  // Helper: dispatch a wheel on the active host div.
  async function wheel(deltaY) {
    await win.evaluate((dy) => {
      const host = document.querySelector('[data-terminal-host] > div');
      if (!host) throw new Error('host not found');
      const evt = new WheelEvent('wheel', { deltaY: dy, ctrlKey: true, bubbles: true, cancelable: true });
      host.dispatchEvent(evt);
    }, deltaY);
    await win.waitForTimeout(60);
  }

  // Zoom in once.
  await wheel(-120);
  await win.waitForTimeout(200);
  let cur = await win.evaluate(() => window.__ccsmTerm.options.fontSize);
  log('after zoom-in 1x:', cur);
  if (cur !== 14) throw new Error(`expected 14, got ${cur}`);

  // Zoom out 3x → 13, 12, 11.
  await wheel(120);
  await win.waitForTimeout(200);
  await wheel(120);
  await win.waitForTimeout(200);
  await wheel(120);
  await win.waitForTimeout(300);
  cur = await win.evaluate(() => window.__ccsmTerm.options.fontSize);
  log('after zoom-out 3x:', cur);
  if (cur !== 11) throw new Error(`expected 11, got ${cur}`);

  // Persisted store value should also be 11.
  const storeVal = await win.evaluate(() => window.__ccsmStore.getState().terminalFontSizePx);
  if (storeVal !== 11) throw new Error(`store expected 11, got ${storeVal}`);
  log('store terminalFontSizePx', storeVal);

  // Switch to session B; assert its term picks up font 11 lazily on show.
  await win.evaluate((sid) => window.__ccsmStore.getState().selectSession(sid), sids[1]);
  await win.waitForFunction(
    (sid) => window.__ccsmStore.getState().activeId === sid,
    sids[1],
  );
  await win.waitForTimeout(400);
  const sessionBFontSize = await win.evaluate(() => window.__ccsmTerm.options.fontSize);
  log('session B fontSize after switch:', sessionBFontSize);
  if (sessionBFontSize !== 11) throw new Error(`session B expected 11, got ${sessionBFontSize}`);

  log('PASS');
} catch (err) {
  console.error('[dogfood] FAIL', err);
  process.exitCode = 1;
} finally {
  await app.close();
}
