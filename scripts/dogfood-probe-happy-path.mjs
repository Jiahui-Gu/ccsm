// Dogfood probe — happy-path session (start session → send prompt → await claude reply).
//
// Verifies the end-to-end happy path:
//   1. Boot ccsm in production bundle mode with isolated electron user-data-dir.
//   2. Reuse the host's REAL ~/.claude/ config so the claude CLI inside the
//      ttyd session is already logged in (otherwise the prompt step cannot
//      possibly succeed).
//   3. Click "New session" CTA.
//   4. Wait for the ttyd iframe to mount.
//   5. Enter the iframe (xterm.js terminal), wait for claude's banner / prompt.
//   6. Type a deterministic prompt: "Hello, please reply with the word PING".
//   7. Poll the terminal text for the literal token "PING" (timeout 90s).
//   8. Capture screenshots at every milestone + a JSON report.
//
// Pre-requisites for a green run:
//   - The host user has `claude` installed and is logged in
//     (i.e. `claude` works from a terminal without prompting for auth).
//   - OR the env var `ANTHROPIC_API_KEY` is set in the calling shell —
//     it will be forwarded to the electron process and inherited by the
//     ttyd → claude child.
//   - PR #494 (cliBridge ttyd lifecycle / cwd fix) is merged, so that
//     claude inside the ttyd session loads the correct CLAUDE_CONFIG_DIR.
//     Without #494 the probe will reach iframe-mount but claude will
//     start in the wrong cwd / config dir and never reply with PING.
//
// Output:
//   docs/screenshots/dogfood-happy-path/00-boot.png
//   docs/screenshots/dogfood-happy-path/01-iframe-mount.png
//   docs/screenshots/dogfood-happy-path/02-after-prompt-sent.png
//   docs/screenshots/dogfood-happy-path/03-claude-replied.png
//   docs/screenshots/dogfood-happy-path/probe.json

import { _electron as electron } from 'playwright';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

const userData = path.resolve('.dogfood-userdata-happy');
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });

const screenshotDir = path.resolve('docs/screenshots/dogfood-happy-path');
mkdirSync(screenshotDir, { recursive: true });

const realClaudeConfigDir = path.join(homedir(), '.claude');

const consoleEvents = [];
const steps = [];
const log = (step, ok, detail) => {
  const entry = { step, ok, detail: detail ?? null };
  steps.push(entry);
  const tag = ok ? 'OK' : 'FAIL';
  const tail = detail ? ': ' + JSON.stringify(detail).slice(0, 240) : '';
  console.log(`[${tag}] ${step}${tail}`);
};

const finish = async (electronApp, exitCode) => {
  const report = {
    generatedAt: new Date().toISOString(),
    claudeConfigDir: realClaudeConfigDir,
    steps,
    consoleErrors: consoleEvents.filter((e) => e.type === 'error' || e.type === 'pageerror').slice(0, 50),
  };
  writeFileSync(path.join(screenshotDir, 'probe.json'), JSON.stringify(report, null, 2));
  console.log('\n===== HAPPY-PATH PROBE REPORT =====');
  console.log(JSON.stringify(report, null, 2));
  if (electronApp) {
    try { await electronApp.close(); } catch { /* ignore */ }
  }
  process.exit(exitCode);
};

// ---------- BOOT ----------
let electronApp;
try {
  electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      ELECTRON_DISABLE_GPU: '1',
      NODE_ENV: 'production',
      CCSM_PROD_BUNDLE: '1',
      // Both env vars matter — main reads CCSM_CLAUDE_CONFIG_DIR, but the
      // renderer's commands-loader reads bare CLAUDE_CONFIG_DIR. Set both.
      CCSM_CLAUDE_CONFIG_DIR: realClaudeConfigDir,
      CLAUDE_CONFIG_DIR: realClaudeConfigDir,
    },
    timeout: 60000,
  });
} catch (err) {
  log('boot', false, String(err).slice(0, 300));
  await finish(null, 1);
}

const win = await electronApp.firstWindow();
win.on('console', (msg) => consoleEvents.push({ type: msg.type(), text: msg.text() }));
win.on('pageerror', (err) => consoleEvents.push({ type: 'pageerror', text: String(err) }));

await win.waitForLoadState('domcontentloaded');
await new Promise((r) => setTimeout(r, 4500));
log('boot', true, { userData, claudeConfigDir: realClaudeConfigDir });
await win.screenshot({ path: path.join(screenshotDir, '00-boot.png') });

// ---------- CREATE SESSION ----------
try {
  const firstRun = await win.locator('[data-testid="first-run-empty"]').count();
  if (firstRun > 0) {
    await win.locator('[data-testid="first-run-empty"] button').first().click();
  } else {
    await win.locator('button:has-text("New session"), button:has-text("Start")').first().click();
  }
  log('click-new-session', true, null);
} catch (err) {
  log('click-new-session', false, String(err).slice(0, 240));
  await finish(electronApp, 1);
}

// ---------- WAIT FOR IFRAME ----------
const ifSelector = 'iframe[title^="ttyd session"]';
let iframeMounted = false;
try {
  await win.waitForSelector(ifSelector, { timeout: 20000 });
  iframeMounted = true;
  const src = await win.evaluate((sel) => document.querySelector(sel)?.getAttribute('src') ?? null, ifSelector);
  log('iframe-mount', true, { src });
} catch (err) {
  log('iframe-mount', false, String(err).slice(0, 240));
}

await new Promise((r) => setTimeout(r, 1500));
await win.screenshot({ path: path.join(screenshotDir, '01-iframe-mount.png') });

if (!iframeMounted) {
  await finish(electronApp, 1);
}

// ---------- WAIT FOR CLAUDE TUI / xterm READY ----------
const frame = win.frameLocator(ifSelector).first();
let xtermReady = false;
try {
  await frame.locator('.xterm-helper-textarea').waitFor({ timeout: 15000 });
  xtermReady = true;
  log('xterm-ready', true, null);
} catch (err) {
  log('xterm-ready', false, String(err).slice(0, 240));
  await finish(electronApp, 1);
}

// Give claude TUI time to render its banner / prompt area before typing.
// claude can take a few seconds on cold start to display the prompt `>`.
let bannerSeen = false;
let bannerText = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  bannerText = await frame.locator('.xterm-screen').textContent({ timeout: 2000 }).catch(() => null);
  if (bannerText && (/claude/i.test(bannerText) || />/.test(bannerText))) {
    bannerSeen = true;
    break;
  }
}
log('claude-banner', bannerSeen, bannerText ? bannerText.slice(0, 400) : null);

// ---------- TYPE PROMPT ----------
const PROMPT = 'Hello, please reply with the word PING';
try {
  await frame.locator('.xterm-helper-textarea').click();
  await new Promise((r) => setTimeout(r, 500));
  await frame.locator('.xterm-helper-textarea').type(PROMPT, { delay: 30 });
  await new Promise((r) => setTimeout(r, 500));
  await frame.locator('.xterm-helper-textarea').press('Enter');
  log('prompt-sent', true, { prompt: PROMPT });
} catch (err) {
  log('prompt-sent', false, String(err).slice(0, 240));
  await win.screenshot({ path: path.join(screenshotDir, '02-after-prompt-sent.png'), fullPage: true });
  await finish(electronApp, 1);
}

await new Promise((r) => setTimeout(r, 1000));
await win.screenshot({ path: path.join(screenshotDir, '02-after-prompt-sent.png'), fullPage: true });

// ---------- POLL FOR REPLY ----------
let replied = false;
let lastText = null;
const start = Date.now();
const TIMEOUT_MS = 90_000;
while (Date.now() - start < TIMEOUT_MS) {
  await new Promise((r) => setTimeout(r, 2000));
  lastText = await frame.locator('.xterm-screen').textContent({ timeout: 2000 }).catch(() => null);
  if (!lastText) continue;
  // Strip the echoed prompt itself before searching, so "PING" in the
  // user's own input line doesn't trigger a false positive.
  const after = lastText.split(PROMPT).slice(1).join(PROMPT);
  if (after && /PING/.test(after)) {
    replied = true;
    break;
  }
}
log('claude-replied', replied, {
  elapsedMs: Date.now() - start,
  tailText: lastText ? lastText.slice(-600) : null,
});

await win.screenshot({ path: path.join(screenshotDir, '03-claude-replied.png'), fullPage: true });

await finish(electronApp, replied ? 0 : 1);
