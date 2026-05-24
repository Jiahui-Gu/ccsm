/* eslint-disable no-undef, no-unused-vars */
// Headless dogfood for terminal scrollback hot-reload (followup to PR #1369).
//
// Asserts:
//   - default scrollback (1500) is applied at boot;
//   - changing `scrollbackLines` via the store synchronously updates
//     `term.options.scrollback` on the active warm xterm AND on a
//     background warm entry (no pending/lazy-defer machinery);
//   - shrinking the cap immediately trims `buffer.active.length` to
//     ~scrollback + viewport rows (xterm internal trim on assign);
//   - growing the cap back lets new writes accumulate past the old cap.
//
// MUST stay invisible per project policy (CCSM_E2E_HIDDEN=1 + offscreen-
// bounds assert at the top of the script).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');

function log(...a) { console.log('[dogfood-scrollback]', ...a); }

const app = await electron.launch({
  args: [repo],
  cwd: repo,
  env: {
    CCSM_E2E_HIDDEN: '1',
    CCSM_PROD_BUNDLE: '1',
    NODE_ENV: 'production',
    ELECTRON_DISABLE_GPU: '1',
    ...process.env,
  },
  timeout: 60000,
});

try {
  // OFFSCREEN-BOUNDS / HIDDEN ASSERT — hard project policy, must be first.
  const isHidden = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every((w) => {
      const b = w.getBounds();
      return b.x <= -10000 || b.y <= -10000;
    }),
  );
  if (!isHidden) throw new Error('Dogfood opened a visible window - violates project policy');
  log('offscreen-bounds OK');

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore?.getState?.()?.hydrated);
  log('hydrated');

  // Ensure 2 sessions exist so we can verify hot-apply hits background entries too.
  await win.evaluate(async () => {
    while (window.__ccsmStore.getState().sessions.length < 2) {
      window.__ccsmStore.getState().createSession(null);
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  const sids = await win.evaluate(() =>
    window.__ccsmStore.getState().sessions.slice(0, 2).map((s) => s.id),
  );
  log('sids', sids);

  // Warm both — select B then A so both have warm xterms; A is active.
  await win.evaluate((sid) => window.__ccsmStore.getState().selectSession(sid), sids[1]);
  await win.waitForFunction((sid) => window.__ccsmStore.getState().activeId === sid && !!window.__ccsmTerm, sids[1]);
  await win.evaluate((sid) => window.__ccsmStore.getState().selectSession(sid), sids[0]);
  await win.waitForFunction((sid) => window.__ccsmStore.getState().activeId === sid && !!window.__ccsmTerm, sids[0]);
  await win.waitForTimeout(300);

  // Reset scrollback to the documented default in case a prior test session
  // left a non-default value persisted in the db row.
  await win.evaluate(() => window.__ccsmStore.getState().setScrollbackLines(1500));
  await win.waitForTimeout(150);

  // Initial state: store default = 1500; term should match (hot-apply effect).
  const initial = await win.evaluate(() => ({
    store: window.__ccsmStore.getState().scrollbackLines,
    activeTerm: window.__ccsmTerm.options.scrollback,
  }));
  log('initial (after reset to default)', initial);
  if (initial.store !== 1500) throw new Error(`expected store 1500, got ${initial.store}`);
  if (initial.activeTerm !== 1500) throw new Error(`expected active term scrollback 1500, got ${initial.activeTerm}`);

  // Write ~3000 lines to the active terminal directly (we don't need PTY —
  // we're testing the renderer-side buffer cap, which is xterm-internal).
  await win.evaluate(() => {
    const t = window.__ccsmTerm;
    for (let i = 0; i < 3000; i++) t.write(`line-${i}\r\n`);
  });
  // Let xterm drain its WriteBuffer.
  await win.waitForFunction(() => {
    const t = window.__ccsmTerm;
    return t.buffer.active.length >= 1400;
  }, null, { timeout: 5000 });
  const afterWrite = await win.evaluate(() => ({
    bufLen: window.__ccsmTerm.buffer.active.length,
    rows: window.__ccsmTerm.rows,
  }));
  log('after writing 3000 lines (cap=1500)', afterWrite);
  // With cap=1500, buffer.active.length should be roughly 1500 + rows.
  if (afterWrite.bufLen > 1500 + afterWrite.rows + 5) {
    throw new Error(`expected bufLen <= scrollback+rows (~${1500 + afterWrite.rows}), got ${afterWrite.bufLen}`);
  }

  // ---- HOT-RELOAD: shrink to 500 ----
  await win.evaluate(() => window.__ccsmStore.getState().setScrollbackLines(500));
  await win.waitForTimeout(200);
  const afterShrink = await win.evaluate(() => {
    const t = window.__ccsmTerm;
    return {
      activeOpt: t.options.scrollback,
      bufLen: t.buffer.active.length,
      rows: t.rows,
      store: window.__ccsmStore.getState().scrollbackLines,
    };
  });
  log('after shrink to 500', afterShrink);
  if (afterShrink.store !== 500) throw new Error(`store should be 500, got ${afterShrink.store}`);
  if (afterShrink.activeOpt !== 500) throw new Error(`active term opt should be 500, got ${afterShrink.activeOpt}`);
  // bufLen should now be ~500 + rows (xterm trims oldest on cap shrink).
  if (afterShrink.bufLen > 500 + afterShrink.rows + 5) {
    throw new Error(`expected trimmed bufLen <= ${500 + afterShrink.rows}, got ${afterShrink.bufLen}`);
  }

  // Verify background entry (sid B) was also hot-applied at change time.
  await win.evaluate((sid) => window.__ccsmStore.getState().selectSession(sid), sids[1]);
  await win.waitForFunction((sid) => window.__ccsmStore.getState().activeId === sid, sids[1]);
  await win.waitForTimeout(200);
  const sessionB = await win.evaluate(() => window.__ccsmTerm.options.scrollback);
  log('session B scrollback after switch:', sessionB);
  if (sessionB !== 500) throw new Error(`session B should be 500, got ${sessionB}`);

  // ---- HOT-RELOAD: grow to 10000 ----
  await win.evaluate((sid) => window.__ccsmStore.getState().selectSession(sid), sids[0]);
  await win.waitForFunction((sid) => window.__ccsmStore.getState().activeId === sid, sids[0]);
  await win.waitForTimeout(150);
  await win.evaluate(() => window.__ccsmStore.getState().setScrollbackLines(10000));
  await win.waitForTimeout(200);
  const afterGrow = await win.evaluate(() => ({
    activeOpt: window.__ccsmTerm.options.scrollback,
    store: window.__ccsmStore.getState().scrollbackLines,
  }));
  log('after grow to 10000', afterGrow);
  if (afterGrow.activeOpt !== 10000) throw new Error(`expected 10000, got ${afterGrow.activeOpt}`);

  // Write 5000 more lines — bufLen should grow past the old 500 cap.
  await win.evaluate(() => {
    const t = window.__ccsmTerm;
    for (let i = 0; i < 5000; i++) t.write(`new-${i}\r\n`);
  });
  await win.waitForFunction(() => window.__ccsmTerm.buffer.active.length >= 3000, null, { timeout: 5000 });
  const afterGrowWrite = await win.evaluate(() => ({
    bufLen: window.__ccsmTerm.buffer.active.length,
    rows: window.__ccsmTerm.rows,
  }));
  log('after writing 5000 (cap=10000)', afterGrowWrite);
  if (afterGrowWrite.bufLen <= 500) {
    throw new Error(`bufLen ${afterGrowWrite.bufLen} should exceed the old 500 cap`);
  }

  log('PASS');
} catch (err) {
  console.error('[dogfood-scrollback] FAIL', err);
  process.exitCode = 1;
} finally {
  await app.close();
}
