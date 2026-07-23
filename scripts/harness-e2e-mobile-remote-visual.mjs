// Visual viewport + geometry-authority proof for the phone remote shell.
//
// Pre-req: `npm run build`.
// Run:    node scripts/harness-e2e-mobile-remote-visual.mjs
//
// Assertions:
// - canonical geometry stays desktop-owned (120x30) across portrait, keyboard,
//   restored portrait, landscape, and zoom;
// - phone never emits session.resize;
// - horizontal pan, left-edge affordance, 24px rail, >=44px thumb/controls;
// - scrollbar track jump + thumb drag move logical viewport;
// - helper/composer focus is not stolen by viewport changes;
// - canonical geometry changes only when desktop sends one resize barrier.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

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
const CANONICAL_GEOMETRY = Object.freeze({ cols: 120, rows: 30, epoch: 0 });
const BARRIER_GEOMETRY = Object.freeze({ cols: 160, rows: 36, epoch: 1 });
const ARTIFACT_DIR = path.join(rootDir, 'artifacts', 'mobile-remote');

let wrangler = null;
let browser = null;
let context = null;
let desktop = null;

function log(step) {
  console.log(`[mobile-remote-visual] ${step}`);
}

async function installFakeVisualViewport(page) {
  await page.addInitScript(() => {
    const native = window.visualViewport;
    let override = null;
    const target = new EventTarget();
    const fake = {
      get height() {
        return override?.height ?? (native ? native.height : window.innerHeight);
      },
      get width() {
        return override?.width ?? (native ? native.width : window.innerWidth);
      },
      get offsetTop() {
        return override?.offsetTop ?? (native ? native.offsetTop : 0);
      },
      get offsetLeft() {
        return override?.offsetLeft ?? (native ? native.offsetLeft : 0);
      },
      get scale() {
        return override?.scale ?? (native ? native.scale : 1);
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
      target.dispatchEvent(new Event('scroll'));
    };
  });
}

async function setVisualViewportOverride(page, override) {
  await page.evaluate((value) => window.__ccsmSetVisualViewportOverride(value), override);
}

function getSyncState(page) {
  return page.evaluate(() => window.__ccsmMobileTest.getSyncState());
}

async function waitForBridge(page) {
  await page.waitForFunction(() => typeof window.__ccsmMobileTest !== 'undefined', undefined, {
    timeout: 15_000,
  });
}

async function waitForCanonicalGeometry(page, label) {
  await waitFor(
    `${label}: canonical 120x30 is installed`,
    async () => {
      const state = await getSyncState(page);
      return (
        state.phase === 'live' &&
        state.geometry?.cols === CANONICAL_GEOMETRY.cols &&
        state.geometry?.rows === CANONICAL_GEOMETRY.rows &&
        state.geometry?.epoch === CANONICAL_GEOMETRY.epoch
      );
    },
    20_000,
  );
}

async function waitForBarrierGeometry(page, label) {
  await waitFor(
    `${label}: desktop barrier geometry is installed`,
    async () => {
      const state = await getSyncState(page);
      return (
        state.phase === 'live' &&
        state.geometry?.cols === BARRIER_GEOMETRY.cols &&
        state.geometry?.rows === BARRIER_GEOMETRY.rows &&
        state.geometry?.epoch === BARRIER_GEOMETRY.epoch
      );
    },
    20_000,
  );
}

async function assertGeometry(page, label, geometry) {
  const state = await getSyncState(page);
  assert.deepEqual(state.geometry, geometry, `${label}: installed geometry must match`);
}

function assertNoSessionResizeMessages(desktopInstance, label) {
  assert.equal(
    desktopInstance.receivedMessages.some((message) => message?.type === 'session.resize'),
    false,
    `${label}: phone must never emit session.resize`,
  );
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

async function assertWithinVisibleViewport(page, selector, label, options = {}) {
  const horizontalMode = options.horizontal ?? 'full';
  const [rect, viewport] = await Promise.all([rectOf(page, selector), visibleViewportBounds(page)]);
  assert.ok(rect, `${label}: "${selector}" must exist`);
  assert.ok(
    rect.top >= viewport.top - 0.5 && rect.bottom <= viewport.bottom + 0.5,
    `${label}: "${selector}" must be vertically within visible viewport`,
  );
  if (horizontalMode === 'intersect') {
    assert.ok(
      rect.right > viewport.left + 0.5 && rect.left < viewport.right - 0.5,
      `${label}: "${selector}" must intersect visible viewport horizontally`,
    );
  } else {
    assert.ok(
      rect.left >= viewport.left - 0.5 && rect.right <= viewport.right + 0.5,
      `${label}: "${selector}" must be horizontally within visible viewport`,
    );
  }
}

async function assertTouchTarget(page, selector, label) {
  const rect = await rectOf(page, selector);
  assert.ok(rect, `${label}: "${selector}" must exist`);
  assert.ok(
    rect.width >= MIN_TOUCH_TARGET - 0.5,
    `${label}: "${selector}" width must be >= ${MIN_TOUCH_TARGET}px`,
  );
  assert.ok(
    rect.height >= MIN_TOUCH_TARGET - 0.5,
    `${label}: "${selector}" height must be >= ${MIN_TOUCH_TARGET}px`,
  );
}

async function assertCoreLayout(page, label, options = {}) {
  const wideContainers = options.wideContainers ?? false;
  for (const selector of ['.phone-topbar', '.mobile-terminal', '.terminal-keybar', '.message-composer']) {
    await assertWithinVisibleViewport(page, selector, label, {
      horizontal: wideContainers ? 'intersect' : 'full',
    });
  }
  await assertWithinVisibleViewport(page, '.composer-send', label, {
    horizontal: wideContainers ? 'intersect' : 'full',
  });
  await assertTouchTarget(page, '.phone-topbar__menu', label);
  await assertTouchTarget(page, '.composer-send', label);
}

async function readTerminalViewportMetrics(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.mobile-terminal');
    const viewport = document.querySelector('.mobile-terminal__viewport');
    if (!root || !viewport) return null;
    return {
      hasLeftEdgeAffordanceClass: root.classList.contains('mobile-terminal--left-edge-affordance-visible'),
      scrollLeft: viewport.scrollLeft,
      maxHorizontalOffset: Math.max(0, viewport.scrollWidth - viewport.clientWidth),
      gridWidth: viewport.scrollWidth,
      viewportWidth: viewport.clientWidth,
    };
  });
}

async function setHorizontalOffset(page, offsetPx) {
  await page.evaluate((offset) => {
    const viewport = document.querySelector('.mobile-terminal__viewport');
    if (!viewport) return;
    viewport.scrollLeft = offset;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, offsetPx);
}

async function assertScrollbarGeometry(page, label) {
  const railRect = await rectOf(page, '.mobile-terminal-scrollbar__rail');
  const thumbRect = await rectOf(page, '.mobile-terminal-scrollbar__thumb');
  assert.ok(railRect, `${label}: scrollbar rail must exist`);
  assert.ok(thumbRect, `${label}: scrollbar thumb must exist`);
  assert.ok(Math.abs(railRect.width - 24) <= 1.5, `${label}: scrollbar rail width must stay ~24px`);
  assert.ok(thumbRect.height >= MIN_TOUCH_TARGET - 0.5, `${label}: scrollbar thumb height must be >= 44px`);
}

async function assertTerminalOverflowGeometry(page, label) {
  const metrics = await readTerminalViewportMetrics(page);
  assert.ok(metrics, `${label}: terminal viewport must exist`);
  assert.ok(metrics.maxHorizontalOffset > 0, `${label}: horizontal extent must be positive`);
  assert.ok(
    metrics.gridWidth > metrics.viewportWidth,
    `${label}: canonical pixel grid width must exceed physical viewport width`,
  );
  return metrics;
}

async function assertPanToRightEdge(page, label) {
  const beforePan = await assertTerminalOverflowGeometry(page, `${label} pre-pan`);
  await setHorizontalOffset(page, beforePan.maxHorizontalOffset);
  await waitFor(
    `${label}: horizontal pan reaches right edge`,
    async () => {
      const metrics = await readTerminalViewportMetrics(page);
      if (!metrics) return false;
      const clampedMax = Math.max(0, metrics.maxHorizontalOffset);
      return metrics.scrollLeft >= Math.max(0, clampedMax - 2);
    },
    10_000,
  );
  const afterPan = await readTerminalViewportMetrics(page);
  assert.ok(afterPan, `${label}: terminal viewport must still exist after pan`);
  const clampedMax = Math.max(0, afterPan.maxHorizontalOffset);
  assert.ok(
    afterPan.scrollLeft >= Math.max(0, clampedMax - 2),
    `${label}: scrollLeft must reach clamped horizontal max`,
  );
  assert.ok(
    afterPan.hasLeftEdgeAffordanceClass,
    `${label}: right-edge pan must show noninteractive left-edge affordance`,
  );
}

async function resetSetPointerCaptureProbe(page, label) {
  const armed = await page.evaluate(() => {
    const rail = document.querySelector('.mobile-terminal-scrollbar__rail');
    if (!rail || typeof rail.setPointerCapture !== 'function') return false;
    const key = '__ccsmPointerCaptureProbe';
    if (!rail[key]) {
      const original = rail.setPointerCapture.bind(rail);
      rail[key] = { count: 0 };
      rail.setPointerCapture = (pointerId) => {
        rail[key].count += 1;
        rail[key].lastPointerId = pointerId;
        return original(pointerId);
      };
    }
    rail[key].count = 0;
    rail[key].lastPointerId = null;
    return true;
  });
  assert.equal(armed, true, `${label}: scrollbar rail setPointerCapture probe must arm`);
}

async function readSetPointerCaptureProbe(page) {
  return page.evaluate(() => {
    const rail = document.querySelector('.mobile-terminal-scrollbar__rail');
    if (!rail) return { count: 0, lastPointerId: null };
    const probe = rail.__ccsmPointerCaptureProbe;
    if (!probe) return { count: 0, lastPointerId: null };
    return { count: probe.count ?? 0, lastPointerId: probe.lastPointerId ?? null };
  });
}

async function assertFocusPreserved(page, label, focusedDescriptor) {
  const active = await activeElementDescriptor(page);
  assert.equal(active, focusedDescriptor, `${label}: focus must remain on allowed target`);
  assert.doesNotMatch(active, /xterm-helper-textarea/, `${label}: helper textarea must not receive focus`);
}

async function assertScrollbarTrackJumpAndThumbDrag(page, label, options = {}) {
  const expectedFocus = options.expectedFocus ?? null;
  const expectedGeometry = options.expectedGeometry ?? null;
  const provePointerCapture = options.provePointerCapture ?? false;
  const scrollbar = page.getByRole('scrollbar', { name: 'Terminal output scroll position' });
  const initialValMax = Number(await scrollbar.getAttribute('aria-valuemax'));
  assert.ok(initialValMax > 0, `${label}: vertical range must be scrollable`);
  const initialValNow = Number(await scrollbar.getAttribute('aria-valuenow'));

  const railBox = await page.locator('.mobile-terminal-scrollbar__rail').boundingBox();
  assert.ok(railBox, `${label}: scrollbar rail must have a bounding box`);
  await page.mouse.click(
    railBox.x + railBox.width / 2,
    railBox.y + railBox.height * 0.15,
  );
  await waitFor(
    `${label}: track jump updates aria-valuenow`,
    async () => Number(await scrollbar.getAttribute('aria-valuenow')) !== initialValNow,
    10_000,
  );
  const afterJump = Number(await scrollbar.getAttribute('aria-valuenow'));
  assert.notEqual(afterJump, initialValNow, `${label}: track jump should change logical viewport position`);

  if (provePointerCapture) {
    await resetSetPointerCaptureProbe(page, label);
  }

  const thumbBox = await page.locator('.mobile-terminal-scrollbar__thumb').boundingBox();
  assert.ok(thumbBox, `${label}: scrollbar thumb must have a bounding box`);
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    thumbBox.x + thumbBox.width / 2,
    Math.max(railBox.y + 8, thumbBox.y - 80),
    { steps: 8 },
  );
  await page.mouse.up();
  await waitFor(
    `${label}: thumb drag updates aria-valuenow`,
    async () => Number(await scrollbar.getAttribute('aria-valuenow')) !== afterJump,
    10_000,
  );
  const afterDrag = Number(await scrollbar.getAttribute('aria-valuenow'));
  assert.notEqual(afterDrag, afterJump, `${label}: thumb drag should change logical viewport position`);

  if (provePointerCapture) {
    const pointerCapture = await readSetPointerCaptureProbe(page);
    assert.ok(pointerCapture.count > 0, `${label}: thumb drag must invoke setPointerCapture`);
  }
  if (expectedGeometry) {
    await assertGeometry(page, `${label} geometry`, expectedGeometry);
  }
  if (expectedFocus) {
    await assertFocusPreserved(page, label, expectedFocus);
  }
}

async function activeElementDescriptor(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label') ?? '';
    const classes = [...el.classList].slice(0, 2).join('.');
    return `${tag}${classes ? `.${classes}` : ''}[aria=${aria}]`;
  });
}

async function assertNoBrowserErrors(consoleErrors, pageErrors, label) {
  assert.deepEqual(consoleErrors, [], `${label}: no browser console errors`);
  assert.deepEqual(pageErrors, [], `${label}: no browser page errors`);
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
    log('using configured public relay');
  }

  const pairing = generatePairingIdentity();
  desktop = createSimulatedDesktop(relayUrl, pairing, {
    sessions: [{ sid: SID, cwd: 'C:\\work\\visual-e2e' }],
  });

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
  await waitForBridge(page);
  await waitFor(
    'encrypted handshake',
    async () => (await page.locator('.phone-topbar__connection').first().textContent()) === 'Connected',
  );
  await waitFor('initial snapshot request', () => desktop.snapshotRequests.length >= 1, 20_000);
  await waitForCanonicalGeometry(page, 'initial sync');

  let seq = 0;
  let snapshot = '';
  for (let index = 1; index <= 220; index += 1) {
    const chunk =
      `VISUAL-LINE-${String(index).padStart(3, '0')} ${'W'.repeat(160)}\r\n`;
    seq += 1;
    snapshot += chunk;
    desktop.sendPty(SID, seq, chunk, CANONICAL_GEOMETRY.epoch);
  }
  await waitFor(
    'terminal catches up to line feed',
    async () => {
      const state = await getSyncState(page);
      return state.phase === 'live' && state.lastSeq >= seq;
    },
    20_000,
  );

  // Portrait: 390x844.
  await waitFor('portrait app-height', async () => (await appHeightPx(page)) === 844, 10_000);
  await assertCoreLayout(page, 'portrait');
  await assertScrollbarGeometry(page, 'portrait');
  await assertGeometry(page, 'portrait geometry', CANONICAL_GEOMETRY);
  await assertTerminalOverflowGeometry(page, 'portrait');
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'portrait.png') });
  log('PASS portrait canonical width + controls');

  // Horizontal right-edge pan shows left-edge affordance.
  await assertPanToRightEdge(page, 'portrait');
  await assertGeometry(page, 'post-pan geometry', CANONICAL_GEOMETRY);
  log('PASS horizontal right-edge pan + affordance');

  // Scrollbar jump + thumb drag alter logical viewport.
  await assertScrollbarTrackJumpAndThumbDrag(page, 'pre-barrier scrollbar', {
    expectedGeometry: CANONICAL_GEOMETRY,
  });
  log('PASS scrollbar track jump + thumb drag');

  // Helper focus survives keyboard shrink + restore.
  const helperTextarea = page.locator('.xterm-helper-textarea');
  await helperTextarea.waitFor({ state: 'attached' });
  await helperTextarea.focus();
  const helperFocused = await activeElementDescriptor(page);
  assert.match(helperFocused, /xterm-helper-textarea/, 'helper focus should be set');

  await setVisualViewportOverride(page, {
    height: 520,
    width: 390,
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
  });
  await waitFor('keyboard app-height', async () => (await appHeightPx(page)) === 520, 10_000);
  await assertCoreLayout(page, 'keyboard');
  await assertScrollbarGeometry(page, 'keyboard');
  await assertGeometry(page, 'keyboard geometry', CANONICAL_GEOMETRY);
  assert.equal(await activeElementDescriptor(page), helperFocused, 'keyboard shrink must not steal helper focus');
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'keyboard-open.png') });
  log('PASS keyboard visual viewport shrink');

  await setVisualViewportOverride(page, null);
  await waitFor('restored portrait app-height', async () => (await appHeightPx(page)) === 844, 10_000);
  await assertCoreLayout(page, 'restored-portrait');
  await assertGeometry(page, 'restored portrait geometry', CANONICAL_GEOMETRY);
  assert.equal(
    await activeElementDescriptor(page),
    helperFocused,
    'restoring portrait viewport must not steal helper focus',
  );
  log('PASS restored portrait');

  // Composer focus survives landscape + zoom.
  await page.getByRole('textbox', { name: 'Message' }).click();
  const composerFocused = await activeElementDescriptor(page);
  assert.match(composerFocused, /textarea\.message-composer__input/, 'composer focus should be set');

  await page.setViewportSize({ width: 844, height: 390 });
  await waitFor('landscape app-height', async () => (await appHeightPx(page)) === 390, 10_000);
  await assertCoreLayout(page, 'landscape');
  await assertScrollbarGeometry(page, 'landscape');
  await assertGeometry(page, 'landscape geometry', CANONICAL_GEOMETRY);
  assert.equal(
    await activeElementDescriptor(page),
    composerFocused,
    'landscape rotation must not steal composer focus',
  );
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'landscape.png') });
  log('PASS landscape 844x390');

  await setVisualViewportOverride(page, {
    height: 390,
    width: 820,
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1.2,
  });
  await waitFor('zoom app-height remains bounded', async () => (await appHeightPx(page)) === 390, 10_000);
  await assertCoreLayout(page, 'zoom', { wideContainers: true });
  await assertScrollbarGeometry(page, 'zoom');
  await assertGeometry(page, 'zoom geometry', CANONICAL_GEOMETRY);
  assert.equal(
    await activeElementDescriptor(page),
    composerFocused,
    'zoom viewport changes must not steal composer focus',
  );
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'zoom.png') });
  log('PASS zoom viewport');

  await setVisualViewportOverride(page, null);
  await page.setViewportSize({ width: 390, height: 844 });
  await waitFor('post-zoom portrait app-height', async () => (await appHeightPx(page)) === 844, 10_000);
  await assertCoreLayout(page, 'post-zoom portrait');
  await assertScrollbarGeometry(page, 'post-zoom portrait');
  await assertGeometry(page, 'post-zoom portrait geometry', CANONICAL_GEOMETRY);
  await assertFocusPreserved(page, 'post-zoom portrait', composerFocused);

  assertNoSessionResizeMessages(desktop, 'pre-barrier');

  // Desktop-authoritative barrier: geometry changes only after snapshot barrier.
  const preBarrierState = await getSyncState(page);
  desktop.sendResizeBarrier(SID, seq, snapshot, BARRIER_GEOMETRY);
  await waitForBarrierGeometry(page, 'desktop barrier');
  const postBarrierState = await getSyncState(page);
  assert.equal(
    postBarrierState.installSnapshotCount,
    preBarrierState.installSnapshotCount + 1,
    'desktop barrier must install exactly one extra snapshot',
  );
  assert.equal(
    postBarrierState.terminalResetCount,
    preBarrierState.terminalResetCount + 1,
    'desktop barrier must trigger exactly one extra reset',
  );
  assert.deepEqual(postBarrierState.geometry, BARRIER_GEOMETRY, 'desktop barrier geometry must be exactly 160x36 epoch 1');

  const postBarrierViewport = page.viewportSize();
  assert.deepEqual(postBarrierViewport, { width: 390, height: 844 }, 'post-barrier: physical viewport must remain portrait 390x844');
  await waitFor('post-barrier portrait app-height', async () => (await appHeightPx(page)) === 844, 10_000);
  await assertCoreLayout(page, 'post-barrier');
  await assertScrollbarGeometry(page, 'post-barrier');
  await assertGeometry(page, 'post-barrier geometry', BARRIER_GEOMETRY);
  await assertFocusPreserved(page, 'post-barrier', composerFocused);
  await assertTerminalOverflowGeometry(page, 'post-barrier');
  await assertPanToRightEdge(page, 'post-barrier');
  await assertGeometry(page, 'post-barrier post-pan geometry', BARRIER_GEOMETRY);
  await assertFocusPreserved(page, 'post-barrier post-pan', composerFocused);
  await assertScrollbarTrackJumpAndThumbDrag(page, 'post-barrier scrollbar', {
    expectedGeometry: BARRIER_GEOMETRY,
    expectedFocus: composerFocused,
    provePointerCapture: true,
  });
  assertNoSessionResizeMessages(desktop, 'post-barrier interactions');

  seq += 1;
  const tailChunk = `POST-BARRIER-LINE ${'Z'.repeat(120)}\r\n`;
  snapshot += tailChunk;
  desktop.sendPty(SID, seq, tailChunk, BARRIER_GEOMETRY.epoch);
  await waitFor(
    'post-barrier live tail applied',
    async () => (await getSyncState(page)).lastSeq >= seq,
    10_000,
  );
  await assertGeometry(page, 'post-barrier geometry', BARRIER_GEOMETRY);
  assertNoSessionResizeMessages(desktop, 'post-barrier');

  await assertNoBrowserErrors(consoleErrors, pageErrors, 'final');
  console.log('[mobile-remote-visual] PASS geometry authority + visual controls');
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
