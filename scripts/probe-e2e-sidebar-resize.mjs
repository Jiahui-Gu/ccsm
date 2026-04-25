// E2E: sidebar/chat resizer.
//
// What we verify:
//   1. The vertical separator between Sidebar and the main pane responds to
//      a pointer drag, updating the sidebar's rendered width and the
//      store's `sidebarWidth`.
//   2. The width is clamped to [SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX] —
//      dragging way past the max should park at the max.
//   3. Double-click resets to SIDEBAR_WIDTH_DEFAULT.
//   4. The chosen width survives an electron restart with the same
//      userData dir — i.e. it's persisted, not just in-memory.
//
// SidebarResizer uses native pointer events on the document, so Playwright's
// `mouse.down/move/up` works here (unlike dnd-kit's PointerSensor).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-sidebar-resize] FAIL: ${msg}`);
  process.exit(1);
}

const ud = isolatedUserData('agentory-probe-sidebar-resize');
console.log(`[probe-e2e-sidebar-resize] userData = ${ud.dir}`);

const commonArgs = ['.', `--user-data-dir=${ud.dir}`];
// Opt out of CCSM_E2E_HIDDEN: this probe's drag-readback assertion
// (aside DOM width must track storeWidth in lockstep) needs the
// resize observer + layout pipeline to run synchronously with the
// pointermove dispatch. With show:true off-screen the layout
// occasionally lags by a frame and the readback comparison flakes.
// Visible window restores it. ~2s window pop during run-all-e2e.
const commonEnv = { ...process.env, CCSM_PROD_BUNDLE: '1', CCSM_E2E_HIDDEN: '0' };

async function asideWidth(win) {
  return await win.evaluate(() => {
    const a = document.querySelector('aside');
    return a ? Math.round(a.getBoundingClientRect().width) : -1;
  });
}
async function storeWidth(win) {
  return await win.evaluate(() => window.__ccsmStore.getState().sidebarWidth);
}
async function constants(win) {
  return await win.evaluate(() => {
    // Constants aren't on the store; read indirectly via a setter probe:
    // setSidebarWidth clamps to [MIN, MAX], so we round-trip extreme values
    // to recover the bounds. Cheaper than threading constants through the
    // window.
    const s = window.__ccsmStore;
    const before = s.getState().sidebarWidth;
    s.getState().setSidebarWidth(99999);
    const max = s.getState().sidebarWidth;
    s.getState().setSidebarWidth(0);
    const min = s.getState().sidebarWidth;
    s.getState().setSidebarWidth(before); // restore
    return { min, max };
  });
}

let chosenWidth;

// Top-level tracker so the outer try/finally can close whichever scoped app
// happens to be live if the body throws. ccsm-probe-cleanup-wrap.
let __ccsmCurrentApp = null;
try { // ccsm-probe-cleanup-wrap

// ---------- Launch #1: drag, verify, double-click reset, drag again ----------
{
  const app = await electron.launch({ args: commonArgs, cwd: root, env: commonEnv });
  __ccsmCurrentApp = app;
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore && document.querySelector('aside') !== null, null, { timeout: 20_000 });

  const { min, max } = await constants(win);
  console.log(`[probe-e2e-sidebar-resize] bounds: min=${min} max=${max}`);

  const initialW = await asideWidth(win);
  const initialStore = await storeWidth(win);
  if (initialW <= 0) {
    await app.close();
    ud.cleanup();
    fail(`fixture: aside width <=0 (${initialW})`);
  }

  // Locate the resizer (role="separator" aria-orientation="vertical").
  const resizer = win.locator('div[role="separator"][aria-orientation="vertical"]').first();
  await resizer.waitFor({ state: 'visible', timeout: 3000 });
  const rb = await resizer.boundingBox();
  if (!rb) {
    await app.close();
    ud.cleanup();
    fail('resizer has no bounding box');
  }
  const startX = rb.x + rb.width / 2;
  const y = rb.y + rb.height / 2;

  // === Case 1: drag right by +60px → store + DOM both grow by ~60. ===
  await win.mouse.move(startX, y);
  await win.mouse.down();
  await win.mouse.move(startX + 60, y, { steps: 10 });
  await win.mouse.up();
  await win.waitForTimeout(500); // let framer-motion's width tween settle
  const grownStore = await storeWidth(win);
  const grownDom = await asideWidth(win);
  if (Math.abs(grownStore - (initialStore + 60)) > 2) {
    await app.close();
    ud.cleanup();
    fail(`drag +60: storeWidth expected ~${initialStore + 60}, got ${grownStore}`);
  }
  if (Math.abs(grownDom - grownStore) > 4) {
    await app.close();
    ud.cleanup();
    fail(`drag +60: aside DOM width ${grownDom} doesn't track storeWidth ${grownStore}`);
  }

  // === Case 2: drag past the max — width should park at max. ===
  // Move toward the right edge of the window (not 5000px off-screen — once
  // the cursor leaves the window, pointermove stops firing on the
  // document-level listener and we'd stall mid-drag). Dispatch real
  // PointerEvents: SidebarResizer.onPointerDown is a React handler bound
  // to the separator and listens for `pointerdown` (button=0).
  const winSize = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const rb2 = await resizer.boundingBox();
  const startX2 = rb2.x + rb2.width / 2;
  await resizer.dispatchEvent('pointerdown', {
    button: 0, clientX: startX2, clientY: y, pointerType: 'mouse', pointerId: 1, isPrimary: true
  });
  const endX2 = winSize.w - 4;
  for (let i = 1; i <= 25; i++) {
    const px = startX2 + ((endX2 - startX2) * i) / 25;
    await win.evaluate(({ px, y }) => document.dispatchEvent(new PointerEvent('pointermove', {
      clientX: px, clientY: y, bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true
    })), { px, y });
    await win.waitForTimeout(8);
  }
  await win.evaluate(({ x, y }) => document.dispatchEvent(new PointerEvent('pointerup', {
    clientX: x, clientY: y, bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true
  })), { x: endX2, y });
  await win.waitForTimeout(200);
  const clamped = await storeWidth(win);
  if (clamped !== max) {
    await app.close();
    ud.cleanup();
    fail(`drag past max: storeWidth expected ${max}, got ${clamped} (winW=${winSize.w})`);
  }

  // === Case 3: double-click resets to default. ===
  // SIDEBAR_WIDTH_DEFAULT isn't exposed; round-trip via store (resetter).
  const defaultW = await win.evaluate(() => {
    const s = window.__ccsmStore;
    s.getState().resetSidebarWidth();
    return s.getState().sidebarWidth;
  });
  // Re-grow first, then double-click the resizer to reset back. Wait long
  // enough for the framer-motion width tween to settle so the resizer's
  // reported boundingBox matches its real hit-testing position.
  await win.evaluate((w) => window.__ccsmStore.getState().setSidebarWidth(w + 80), defaultW);
  await win.waitForTimeout(500);
  const rb3 = await resizer.boundingBox();
  await resizer.dblclick();
  await win.waitForTimeout(300);
  const reset = await storeWidth(win);
  if (reset !== defaultW) {
    await app.close();
    ud.cleanup();
    fail(`double-click reset: expected ${defaultW}, got ${reset} (rb3=${JSON.stringify(rb3)})`);
  }

  // === Case 4: choose a non-default width and confirm before quit. ===
  chosenWidth = Math.min(max, Math.max(min, defaultW + 73));
  await win.evaluate((w) => window.__ccsmStore.getState().setSidebarWidth(w), chosenWidth);
  // Persistence is debounced by `schedulePersist` — wait long enough for
  // the write to flush before we close the app, otherwise the next launch
  // will see the prior value.
  await win.waitForTimeout(1500);
  const finalStore = await storeWidth(win);
  if (finalStore !== chosenWidth) {
    await app.close();
    ud.cleanup();
    fail(`pre-quit storeWidth expected ${chosenWidth}, got ${finalStore}`);
  }
  console.log(`[probe-e2e-sidebar-resize] launch #1: chose width=${chosenWidth}`);

  await app.close();
}

// ---------- Launch #2: same userData → width restores to chosenWidth ----------
{
  const app = await electron.launch({ args: commonArgs, cwd: root, env: commonEnv });
  __ccsmCurrentApp = app;
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore && document.querySelector('aside') !== null, null, { timeout: 20_000 });
  const restored = await storeWidth(win);
  const restoredDom = await asideWidth(win);
  if (restored !== chosenWidth) {
    await app.close();
    ud.cleanup();
    fail(`after restart: storeWidth expected ${chosenWidth}, got ${restored}`);
  }
  if (Math.abs(restoredDom - chosenWidth) > 4) {
    await app.close();
    ud.cleanup();
    fail(`after restart: aside DOM width ${restoredDom} doesn't match restored store ${chosenWidth}`);
  }
  console.log(`[probe-e2e-sidebar-resize] launch #2: restored width=${restored} (DOM=${restoredDom})`);
  await app.close();
}

console.log('\n[probe-e2e-sidebar-resize] OK');
console.log('  drag updates sidebar width and store in lockstep');
console.log('  width clamps at the configured max');
console.log('  double-click resets to the default');
console.log('  width persists across app restart');

ud.cleanup();
} finally { try { await __ccsmCurrentApp?.close(); } catch {} } // ccsm-probe-cleanup-wrap
