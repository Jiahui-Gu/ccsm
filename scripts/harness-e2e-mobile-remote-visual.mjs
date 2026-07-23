// Visual viewport proof for the mobile remote phone shell (composer/
// terminal-sync plan, Task 6 Step E): portrait, a simulated on-screen
// keyboard (visualViewport shrink), landscape, and the session drawer.
//
// Pre-req: `npm run build`.
// Run:    node scripts/harness-e2e-mobile-remote-visual.mjs
//
// "Keyboard open" is simulated purely as a `visualViewport` state change
// (a faked `window.visualViewport` installed via `page.addInitScript`,
// overridden on demand) — this harness never calls `focus()`/`blur()` on
// anything to try to summon a real software keyboard. The override still
// drives the SAME production code path (`mobileTerminalAdapter.ts`'s
// `visualViewport` listener, which sets the real `--app-height` /
// `--app-offset-top` CSS custom properties `mobile.css` consumes), so the
// actual CSS variables and terminal refit are genuinely exercised, not
// faked at the assertion layer.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import {
  rootDir,
  configuredRelayUrl,
  createSimulatedDesktop,
  generatePairingIdentity,
  reservePort,
  startWrangler,
  stopExactChild,
  cleanupWranglerLocalState,
  waitFor,
} from './probe-helpers/mobileRemoteHarness.mjs';

const SID = 'visual-e2e';
const MIN_TOUCH_TARGET = 44;
const ARTIFACT_DIR = path.join(rootDir, 'artifacts', 'mobile-remote');

let wrangler = null;
let browser = null;
let context = null;
let desktop = null;

function log(step) {
  console.log(`[mobile-remote-visual] ${step}`);
}

/**
 * Replaces `window.visualViewport` with a thin wrapper that passes through
 * the REAL native visual viewport (so native browser resizes — e.g. an
 * actual Playwright `setViewportSize` landscape rotation — keep working
 * exactly as in production) unless an explicit override is set via
 * `window.__ccsmSetVisualViewportOverride({ height, width, offsetTop,
 * offsetLeft } | null)`, which is the deterministic "on-screen keyboard"
 * simulation seam. Installed via `addInitScript` so it exists before any
 * of the app's own bundled JS runs (in particular before
 * `mobileTerminalAdapter.ts` ever reads `window.visualViewport`).
 */
async function installFakeVisualViewport(page) {
  await page.addInitScript(() => {
    const native = window.visualViewport;
    let override = null;
    const target = new EventTarget();
    const fake = {
      get height() {
        return override ? override.height : (native ? native.height : window.innerHeight);
      },
      get width() {
        return override ? override.width : (native ? native.width : window.innerWidth);
      },
      get offsetTop() {
        return override ? override.offsetTop : native ? native.offsetTop : 0;
      },
      get offsetLeft() {
        return override ? override.offsetLeft : native ? native.offsetLeft : 0;
      },
      get scale() {
        return native ? native.scale : 1;
      },
      addEventListener: (...args) => target.addEventListener(...args),
      removeEventListener: (...args) => target.removeEventListener(...args),
    };
    if (native) {
      native.addEventListener('resize', () => {
        if (!override) target.dispatchEvent(new Event('resize'));
      });
      native.addEventListener('scroll', () => {
        if (!override) target.dispatchEvent(new Event('scroll'));
      });
    }
    Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
    window.__ccsmSetVisualViewportOverride = (next) => {
      override = next;
      target.dispatchEvent(new Event('resize'));
    };
  });
}

async function setVisualViewportOverride(page, override) {
  await page.evaluate((value) => window.__ccsmSetVisualViewportOverride(value), override);
}

async function appHeightPx(page) {
  const raw = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
  );
  return raw.endsWith('px') ? Number.parseFloat(raw) : null;
}

async function rectOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }, selector);
}

async function visibleViewportBounds(page) {
  return page.evaluate(() => ({
    top: window.visualViewport.offsetTop,
    left: window.visualViewport.offsetLeft,
    bottom: window.visualViewport.offsetTop + window.visualViewport.height,
    right: window.visualViewport.offsetLeft + window.visualViewport.width,
  }));
}

async function assertWithinVisibleViewport(page, selector, label) {
  const [rect, viewport] = await Promise.all([rectOf(page, selector), visibleViewportBounds(page)]);
  assert.ok(rect, `${label}: "${selector}" must exist`);
  assert.ok(
    rect.top >= viewport.top - 0.5 && rect.bottom <= viewport.bottom + 0.5,
    `${label}: "${selector}" (top=${rect.top.toFixed(1)}, bottom=${rect.bottom.toFixed(1)}) must be vertically within the visible viewport [${viewport.top}, ${viewport.bottom}]`,
  );
  assert.ok(
    rect.left >= viewport.left - 0.5 && rect.right <= viewport.right + 0.5,
    `${label}: "${selector}" (left=${rect.left.toFixed(1)}, right=${rect.right.toFixed(1)}) must be horizontally within the visible viewport [${viewport.left}, ${viewport.right}]`,
  );
}

async function assertTouchTarget(page, selector, label) {
  const rect = await rectOf(page, selector);
  assert.ok(rect, `${label}: "${selector}" must exist`);
  assert.ok(rect.width >= MIN_TOUCH_TARGET - 0.5, `${label}: "${selector}" width ${rect.width.toFixed(1)}px must be >= 44px`);
  assert.ok(rect.height >= MIN_TOUCH_TARGET - 0.5, `${label}: "${selector}" height ${rect.height.toFixed(1)}px must be >= 44px`);
}

async function assertCoreLayout(page, label, { drawerOpen = false } = {}) {
  for (const selector of ['.phone-topbar', '.mobile-terminal', '.terminal-keybar', '.message-composer']) {
    await assertWithinVisibleViewport(page, selector, label);
  }
  await assertWithinVisibleViewport(page, '.composer-send', label);
  if (drawerOpen) {
    await assertWithinVisibleViewport(page, '.session-drawer__panel', label);
  }
  // Terminal actually visible (non-zero, real on-screen area).
  const terminalRect = await rectOf(page, '.mobile-terminal');
  assert.ok(terminalRect.width > 0 && terminalRect.height > 0, `${label}: terminal must have a visible, non-zero area`);

  // Touch targets: menu button, every discrete key, Send, and (when open)
  // the drawer's close button + at least one navigator row.
  await assertTouchTarget(page, '.phone-topbar__menu', label);
  const keyCount = await page.locator('.terminal-key').count();
  assert.ok(keyCount > 0, `${label}: expected at least one terminal key button`);
  for (let i = 0; i < keyCount; i += 1) {
    const rect = await page.locator('.terminal-key').nth(i).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    assert.ok(rect.width >= MIN_TOUCH_TARGET - 0.5, `${label}: terminal key #${i} width must be >= 44px`);
    assert.ok(rect.height >= MIN_TOUCH_TARGET - 0.5, `${label}: terminal key #${i} height must be >= 44px`);
  }
  await assertTouchTarget(page, '.composer-send', label);
  if (drawerOpen) {
    await assertTouchTarget(page, '.session-drawer__close', label);
    await assertTouchTarget(page, '[data-session-id]', label);
  }
}

async function currentPhoneDimensions(page) {
  return page.evaluate(() => window.__ccsmMobileTest?.getDimensions() ?? null);
}

async function main() {
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const configuredUrl = configuredRelayUrl();
  let relayUrl = configuredUrl;
  if (!relayUrl) {
    const port = await reservePort();
    const started = await startWrangler(port);
    wrangler = started.child;
    relayUrl = started.relayUrl;
  } else {
    log(`using public CCSM_RELAY_URL=${configuredUrl}`);
  }

  const pairing = generatePairingIdentity();
  desktop = createSimulatedDesktop(relayUrl, pairing, { sessions: [{ sid: SID, cwd: 'C:\\work\\visual-e2e' }] });

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack ?? error)));

  await installFakeVisualViewport(page);
  await page.goto(`${relayUrl}/?ccsmTest=1#pair=${pairing.roomId}.${pairing.secret}`);
  await waitFor('encrypted handshake', async () =>
    (await page.locator('.phone-topbar__connection').first().textContent()) === 'Connected',
  );
  await page.locator('.phone-topbar__name').filter({ hasText: SID }).waitFor();
  await waitFor('initial local phone fit', async () => (await currentPhoneDimensions(page)) !== null);

  // --- Portrait: 390x844 -------------------------------------------------
  await waitFor('portrait --app-height stabilizes', async () => (await appHeightPx(page)) === 844);
  await assertCoreLayout(page, 'portrait');
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'portrait.png') });
  const portrait = await currentPhoneDimensions(page);
  assert.ok(portrait?.rows && portrait?.cols, 'portrait: phone xterm must have real local cols/rows');
  assert.deepEqual(desktop.resizes, [], 'portrait: phone fit must not resize desktop authority');
  log('PASS portrait (390x844): layout, touch targets, terminal visible');

  // --- Keyboard-open: visualViewport shrinks to 390x520 ------------------
  await setVisualViewportOverride(page, { height: 520, width: 390, offsetTop: 0, offsetLeft: 0 });
  await waitFor('keyboard-open --app-height stabilizes', async () => (await appHeightPx(page)) === 520);
  await waitFor(
    'keyboard-open refits the local phone xterm',
    async () => (await currentPhoneDimensions(page))?.rows < portrait.rows,
  );
  await assertCoreLayout(page, 'keyboard-open');
  // Explicit, dedicated assertion (not just "within viewport" generically):
  // the keybar and composer must both sit entirely above y=520 — i.e. never
  // covered by the simulated keyboard.
  const keybarRect = await rectOf(page, '.terminal-keybar');
  const composerRect = await rectOf(page, '.message-composer');
  assert.ok(keybarRect.bottom <= 520.5, `keyboard-open: keybar bottom (${keybarRect.bottom}) must not be covered by the keyboard (<= 520)`);
  assert.ok(composerRect.bottom <= 520.5, `keyboard-open: composer bottom (${composerRect.bottom}) must not be covered by the keyboard (<= 520)`);
  const keyboard = await currentPhoneDimensions(page);
  assert.ok(
    keyboard.rows < portrait.rows,
    `keyboard-open: rows (${keyboard.rows}) must shrink from portrait rows (${portrait.rows})`,
  );
  assert.deepEqual(desktop.resizes, [], 'keyboard-open: local refit must not resize desktop authority');
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'keyboard-open.png') });
  log('PASS keyboard-open (390x520 visualViewport): keybar/composer stay above the simulated keyboard, terminal refit smaller');

  // Restore — clearing the override must resize back toward the portrait
  // dimensions (proving the resize pipeline reacts to BOTH directions, not
  // just the shrink).
  await setVisualViewportOverride(page, null);
  await waitFor('restored --app-height stabilizes', async () => (await appHeightPx(page)) === 844);
  await waitFor(
    'restored visualViewport refits the local phone xterm',
    async () => (await currentPhoneDimensions(page))?.rows === portrait.rows,
  );
  assert.deepEqual(desktop.resizes, [], 'restore: local refit must not resize desktop authority');
  log('PASS restoring the visualViewport restores local phone dimensions');

  // --- Landscape: 844x390 (a real Playwright viewport rotation) ----------
  await page.setViewportSize({ width: 844, height: 390 });
  await waitFor('landscape --app-height stabilizes', async () => (await appHeightPx(page)) === 390);
  await waitFor(
    'landscape refits the local phone xterm',
    async () => (await currentPhoneDimensions(page))?.cols > portrait.cols,
  );
  await assertCoreLayout(page, 'landscape');
  const landscape = await currentPhoneDimensions(page);
  assert.ok(
    landscape.cols > portrait.cols,
    `landscape: cols (${landscape.cols}) must exceed portrait cols (${portrait.cols})`,
  );
  assert.ok(
    landscape.rows < portrait.rows,
    `landscape: rows (${landscape.rows}) must be fewer than portrait rows (${portrait.rows})`,
  );
  assert.deepEqual(desktop.resizes, [], 'landscape: local refit must not resize desktop authority');
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'landscape.png') });
  log('PASS landscape (844x390): layout, touch targets, local fit reflects the oriented dimensions');

  // --- Drawer: back to portrait, drawer open ------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await waitFor('portrait --app-height restored before opening the drawer', async () => (await appHeightPx(page)) === 844);
  await page.getByRole('button', { name: 'Sessions menu' }).click();
  await page.locator('.session-drawer__panel').waitFor();
  await assertCoreLayout(page, 'drawer', { drawerOpen: true });
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'drawer.png') });
  log('PASS drawer (390x844, open): drawer + underlying shell all within the visible viewport, touch targets intact');

  assert.deepEqual(consoleErrors, [], 'no browser console errors across the whole run');
  assert.deepEqual(pageErrors, [], 'no browser pageerror events across the whole run');

  console.log('[mobile-remote-visual] PASS portrait, keyboard, landscape, drawer');
}

try {
  await main();
} catch (error) {
  console.error('[mobile-remote-visual] FAIL', error);
  process.exitCode = 1;
} finally {
  desktop?.close();
  await context?.close().catch(() => undefined);
  await browser?.close();
  await stopExactChild(wrangler);
  cleanupWranglerLocalState();
}

process.exit(process.exitCode ?? 0);
