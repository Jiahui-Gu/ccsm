// Dogfood probe — capture actual UI + run end-to-end happy path.
//
// 1. Boot packaged dist via electron+playwright with isolated user-data.
// 2. Capture rootHTML / store snapshot / bridge keys / console events.
// 3. Click "New session" CTA, wait for ttyd iframe to mount.
// 4. Verify ttyd.exe is running on host.
// 5. Inside the iframe, type a prompt to claude, wait for reply.
// 6. Screenshot populated session.

import { _electron as electron } from 'playwright';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

const userData = path.resolve('.dogfood-userdata');
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });
const screenshotDir = path.resolve('docs/screenshots/dogfood-current-ui');
mkdirSync(screenshotDir, { recursive: true });

const consoleEvents = [];
const steps = [];
const log = (step, ok, detail) => {
  steps.push({ step, ok, detail });
  console.log(`[${ok ? 'OK' : 'FAIL'}] ${step}${detail ? ': ' + JSON.stringify(detail).slice(0, 200) : ''}`);
};

const electronApp = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`],
  env: {
    ...process.env,
    ELECTRON_DISABLE_GPU: '1',
    NODE_ENV: 'production',
    CCSM_PROD_BUNDLE: '1',
  },
  timeout: 60000,
});

const win = await electronApp.firstWindow();
win.on('console', (msg) => consoleEvents.push({ type: msg.type(), text: msg.text() }));
win.on('pageerror', (err) => consoleEvents.push({ type: 'pageerror', text: String(err) }));

await win.waitForLoadState('domcontentloaded');
await new Promise((r) => setTimeout(r, 4500));
log('boot', true, null);

// ---------- STEP A: capture initial state ----------
const initial = await win.evaluate(async () => {
  const root = document.getElementById('root');
  let claudeProbe = null;
  try {
    if (window.ccsmCliBridge?.checkClaudeAvailable) {
      claudeProbe = await window.ccsmCliBridge.checkClaudeAvailable();
    }
  } catch (e) { claudeProbe = { error: String(e) }; }
  const s = window.__ccsmStore?.getState?.();
  return {
    rootHTML: root?.outerHTML?.slice(0, 4000) ?? '<no #root>',
    bridgePresent: typeof window.ccsmCliBridge !== 'undefined',
    bridgeKeys: window.ccsmCliBridge ? Object.keys(window.ccsmCliBridge) : null,
    claudeProbe,
    storeSnapshot: s ? {
      sessionsCount: s.sessions?.length ?? null,
      activeId: s.activeId ?? null,
      hydrated: s.hydrated ?? null,
      claudeAvailable: s.claudeAvailable ?? null,
      tutorialSeen: s.tutorialSeen ?? null,
    } : null,
    bodyText: document.body.innerText.slice(0, 600),
    testIds: Array.from(document.querySelectorAll('[data-testid]'))
      .map((el) => el.getAttribute('data-testid')),
  };
});
log('initial-snapshot', true, { activeId: initial.storeSnapshot?.activeId, claudeAvailable: initial.storeSnapshot?.claudeAvailable, testIds: initial.testIds });
await win.screenshot({ path: path.join(screenshotDir, '01-initial.png') });

// ---------- STEP B: click "New session" ----------
let createOk = false;
try {
  // First-run-empty has the New session button. If user has dismissed
  // tutorial it may be the same; if not, the Tutorial component shows
  // its own CTA. Try both.
  const firstRun = await win.locator('[data-testid="first-run-empty"]').count();
  if (firstRun > 0) {
    await win.locator('[data-testid="first-run-empty"] button').first().click();
  } else {
    // Tutorial path — find a "New session" / "Start" / primary button.
    await win.locator('button:has-text("New session"), button:has-text("Start")').first().click();
  }
  createOk = true;
  log('click-new-session', true, null);
} catch (err) {
  log('click-new-session', false, String(err).slice(0, 200));
}

await new Promise((r) => setTimeout(r, 2500));

// ---------- STEP C: wait for webview ----------
// TtydPane now renders an Electron <webview> tag (not <iframe>) — see
// src/components/TtydPane.tsx for why. Webview hosts the page in an
// out-of-process Chromium frame and Playwright doesn't expose it via
// frameLocator the same way; we just verify the tag mounts + the src
// points at a 127.0.0.1 ttyd port. Inner-text validation moved to the
// process check + screenshot review.
let iframePort = null;
let iframeMounted = false;
try {
  const ifSelector = 'webview[title^="ttyd session"]';
  await win.waitForSelector(ifSelector, { timeout: 15000 });
  iframeMounted = true;
  iframePort = await win.evaluate((sel) => {
    const ifr = document.querySelector(sel);
    return ifr ? ifr.getAttribute('src') : null;
  }, ifSelector);
  log('webview-mounted', true, { src: iframePort });
} catch (err) {
  log('webview-mounted', false, String(err).slice(0, 200));
}

await win.screenshot({ path: path.join(screenshotDir, '02-after-create.png') });

// ---------- STEP D: ttyd.exe process check ----------
let ttydRunning = false;
try {
  const out = execSync('tasklist /FI "IMAGENAME eq ttyd.exe" /FO CSV', { encoding: 'utf8' });
  ttydRunning = /ttyd\.exe/i.test(out);
  log('ttyd-process-running', ttydRunning, out.split('\n').filter((l) => /ttyd\.exe/i.test(l)));
} catch (err) {
  log('ttyd-process-running', false, String(err).slice(0, 200));
}

// ---------- STEP E: type into webview ----------
// frameLocator() doesn't reach into Electron <webview> the same way as
// <iframe> — we'd need page.context().pages() to grab the webview's
// out-of-process page. For now keep this best-effort; the real validation
// is the screenshot + ttyd-process-running. Mark gracefully skipped if
// the locator API can't see the webview's xterm DOM.
let typedOk = false;
let iframeText = null;
let claudeReplied = false;
if (iframeMounted) {
  try {
    const frame = win.frameLocator('webview[title^="ttyd session"]').first();
    // ttyd uses xterm.js; the input target is .xterm-helper-textarea
    await frame.locator('.xterm-helper-textarea').waitFor({ timeout: 10000 });
    await frame.locator('.xterm-helper-textarea').click();
    // Wait for claude TUI to render its initial prompt area before typing
    await new Promise((r) => setTimeout(r, 3000));
    await frame.locator('.xterm-helper-textarea').type('say hello in 3 words', { delay: 30 });
    await new Promise((r) => setTimeout(r, 500));
    await frame.locator('.xterm-helper-textarea').press('Enter');
    typedOk = true;
    log('webview-type', true, null);

    // Wait up to 30s for "hello" to appear in screen text
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      iframeText = await frame.locator('.xterm-screen').textContent({ timeout: 2000 }).catch(() => null);
      if (iframeText && /hello/i.test(iframeText)) {
        claudeReplied = true;
        break;
      }
    }
    log('claude-replied', claudeReplied, iframeText ? iframeText.slice(0, 400) : null);
  } catch (err) {
    log('webview-type', false, String(err).slice(0, 300));
  }
}

await win.screenshot({ path: path.join(screenshotDir, '03-after-prompt.png'), fullPage: true });

// ---------- STEP F: dump final state ----------
const final = await win.evaluate(() => {
  const s = window.__ccsmStore?.getState?.();
  return {
    sessionsCount: s?.sessions?.length ?? null,
    activeId: s?.activeId ?? null,
    bodyText: document.body.innerText.slice(0, 400),
  };
});
log('final-state', true, final);

const summary = { initial, steps, final, consoleErrors: consoleEvents.filter((e) => e.type === 'error' || e.type === 'pageerror') };
writeFileSync(path.join(screenshotDir, 'probe-summary.json'), JSON.stringify(summary, null, 2));

console.log('\n===== SUMMARY =====');
console.log(JSON.stringify(summary, null, 2));

await electronApp.close();
