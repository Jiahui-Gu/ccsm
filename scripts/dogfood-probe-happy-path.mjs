// Dogfood probe — happy-path session (start session → send prompt → await claude reply).
//
// Verifies the end-to-end happy path:
//   1. Boot ccsm in production bundle mode with isolated electron user-data-dir.
//   2. Reuse the host's REAL ~/.claude/ config so the claude CLI inside the
//      ttyd session is already logged in (otherwise the prompt step cannot
//      possibly succeed).
//   3. Click "New session" CTA.
//   4. Wait for the ttyd <webview> to mount (the host page DOM).
//   5. Reach INSIDE the webview (Electron OOPIF — separate process) via
//      `webContents.executeJavaScript()` and verify xterm is mounted, the
//      websocket is open, claude has printed its banner.
//   6. Type a deterministic prompt: "Hello, please reply with the word PING".
//   7. Poll xterm's internal Terminal buffer for the literal token "PING"
//      (timeout 90s).
//   8. Capture screenshots at every milestone + a JSON report.
//
// Why no `frameLocator`:
//   PR #452 swapped the embedded TUI host from a regular `<iframe>` to an
//   Electron `<webview>` tag. A `<webview>` is an Out-Of-Process IFrame
//   (OOPIF) — a separate renderer process — and Playwright's `frameLocator`
//   cannot reach into it. The supported way to introspect / drive the inner
//   page is through the Electron main process: ask `webContents` for the
//   webview, then `executeJavaScript()` against it. That pattern is shown
//   in `scripts/dogfood-probe-ttyd-debug.mjs` (PR #453).
//
// Pre-requisites for a green run:
//   - The host user has `claude` installed and is logged in
//     (i.e. `claude` works from a terminal without prompting for auth).
//   - OR the env var `ANTHROPIC_API_KEY` is set in the calling shell —
//     it will be forwarded to the electron process and inherited by the
//     ttyd → claude child.
//   - PR #494 (cliBridge ttyd lifecycle / cwd fix) is merged, so that
//     claude inside the ttyd session loads the correct CLAUDE_CONFIG_DIR.
//
// Output:
//   docs/screenshots/dogfood-happy-path/00-boot.png
//   docs/screenshots/dogfood-happy-path/01-webview-mount.png
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
  const tag = ok ? 'PASS' : 'FAIL';
  const tail = detail ? ': ' + JSON.stringify(detail).slice(0, 240) : '';
  console.log(`[STEP] ${step}: ${tag}${tail}`);
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

// ---------- WAIT FOR WEBVIEW MOUNT (host page DOM) ----------
const ifSelector = 'webview[title^="ttyd session"]';
let webviewSrc = null;
try {
  await win.waitForSelector(ifSelector, { timeout: 20000 });
  webviewSrc = await win.evaluate((sel) => document.querySelector(sel)?.getAttribute('src') ?? null, ifSelector);
  log('webview-mounted', true, { src: webviewSrc });
} catch (err) {
  log('webview-mounted', false, String(err).slice(0, 240));
  await finish(electronApp, 1);
}

await new Promise((r) => setTimeout(r, 1500));
await win.screenshot({ path: path.join(screenshotDir, '01-webview-mount.png') });

// Helper: locate the ttyd webview's webContents id from main process.
// Returns the id or null. We pin it to the URL we already saw in
// `webview-mounted` so we don't accidentally pick up devtools or another
// webview that might be created later.
async function findWebviewId(srcUrl) {
  return await electronApp.evaluate(({ webContents }, src) => {
    const all = webContents.getAllWebContents();
    for (const wc of all) {
      if (wc.getType() === 'webview' && (!src || wc.getURL().startsWith(src))) {
        return wc.id;
      }
    }
    return null;
  }, webviewSrc);
}

const webviewId = await findWebviewId(webviewSrc);
if (webviewId == null) {
  log('ttyd-webcontents-found', false, { reason: 'no webview webContents matched src', src: webviewSrc });
  await finish(electronApp, 1);
}
log('ttyd-webcontents-found', true, { webContentsId: webviewId, src: webviewSrc });

// Helper: run JS inside the webview.
async function wvEval(jsExpr) {
  return await electronApp.evaluate(async ({ webContents }, { id, expr }) => {
    const wc = webContents.fromId(id);
    if (!wc) throw new Error(`no webContents with id ${id}`);
    return await wc.executeJavaScript(expr, true);
  }, { id: webviewId, expr: jsExpr });
}

// ---------- XTERM READY ----------
// Wait until xterm DOM is mounted AND ttyd has exposed `window.term`
// (ttyd assigns the xterm Terminal to window.term after its `open()`).
let xtermReady = false;
try {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await wvEval(`(function(){
      return {
        hasXterm: !!document.querySelector('.xterm'),
        hasTextarea: !!document.querySelector('.xterm-helper-textarea'),
        hasWindowTerm: typeof window.term !== 'undefined' && !!window.term && !!window.term.buffer,
      };
    })()`);
    if (state && state.hasXterm && state.hasTextarea && state.hasWindowTerm) {
      xtermReady = true;
      log('xterm-ready', true, state);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!xtermReady) {
    log('xterm-ready', false, { reason: 'timed out waiting for xterm + window.term' });
    await finish(electronApp, 1);
  }
} catch (err) {
  log('xterm-ready', false, String(err).slice(0, 240));
  await finish(electronApp, 1);
}

// Helper: send raw input bytes through xterm's data path (which ttyd has
// hooked into its websocket → claude PTY). We deliberately AVOID
// `term.paste()` because it wraps the text in bracketed-paste escapes
// (`\x1b[200~...\x1b[201~`) and claude's Ink-based TUI doesn't process
// bracketed-paste markers — the keystrokes arrive at the PTY but claude
// never reacts. `triggerDataEvent` is the internal API that simulates raw
// user typing without any wrapping.
async function termSend(text) {
  await wvEval(`(function(text){
    const t = window.term;
    if (!t || !t._core) return false;
    const cs = t._core._coreService || t._core.coreService;
    if (!cs || typeof cs.triggerDataEvent !== 'function') return false;
    cs.triggerDataEvent(text, true);
    return true;
  })(${JSON.stringify(text)})`);
}

// Helper: dump xterm buffer text. Returns an object with:
//   - full: whole scrollback joined
//   - screen: only the currently visible viewport (rows × cols)
// xterm renders to canvas; the only reliable way to read text is via the
// Terminal instance's buffer API: `term.buffer.active.getLine(n).translateToString()`.
async function readBuffer() {
  return await wvEval(`(function(){
    if (!window.term || !window.term.buffer || !window.term.buffer.active) {
      return { full: '', screen: '' };
    }
    const term = window.term;
    const buf = term.buffer.active;
    const total = buf.length;
    const fullLines = [];
    for (let i = 0; i < total; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      fullLines.push(line.translateToString(true));
    }
    const rows = term.rows || 24;
    const viewportY = buf.viewportY || 0;
    const screenLines = [];
    for (let r = 0; r < rows; r++) {
      const line = buf.getLine(viewportY + r);
      if (!line) continue;
      screenLines.push(line.translateToString(true));
    }
    return { full: fullLines.join('\\n'), screen: screenLines.join('\\n') };
  })()`);
}

// ---------- WAIT FOR CLAUDE BANNER ----------
// claude prints a banner / prompt within ~2-15s of cold-start. We poll the
// xterm buffer for any of: literal "claude", the "Welcome" line,
// the box-drawing chars used by claude's input box, or "│ >" prompt.
let bannerSeen = false;
let bannerScreen = '';
let bannerFull = '';
const bannerRegex = /claude|welcome|│|╭|╰|^>|\?\sfor\sshortcuts/i;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const buf = await readBuffer().catch(() => null);
  bannerScreen = buf?.screen || '';
  bannerFull = buf?.full || '';
  if (bannerScreen && bannerRegex.test(bannerScreen)) {
    bannerSeen = true;
    break;
  }
}
log('claude-banner', bannerSeen, {
  matched: bannerSeen,
  screenTail: bannerScreen ? bannerScreen.slice(-600) : null,
});
if (!bannerSeen) {
  await win.screenshot({ path: path.join(screenshotDir, '02-after-prompt-sent.png'), fullPage: true });
  await finish(electronApp, 1);
}

// ---------- DISMISS FIRST-RUN PROMPTS (theme picker, etc.) ----------
// On a fresh ~/.claude (or some shared-cache scenarios) claude shows
// first-run setup screens (theme picker, security notice, ...) that block
// the actual prompt input. Loop: detect a non-input-box screen and press
// Enter to advance. We bail when we see the actual input box "│ >".
async function pressEnterInTerm() {
  await termSend('\r');
}
async function isAtPrompt() {
  const buf = await readBuffer().catch(() => null);
  if (!buf) return false;
  // Claude's input box renders as a "│ >" line near the bottom of the screen.
  // The setup screens use "❯" arrow and number-list options instead.
  const screen = buf.screen || '';
  // Heuristic: input box presence
  return /│\s*>/m.test(screen) || /^\s*>\s/m.test(screen);
}

let promptReady = false;
for (let i = 0; i < 12; i++) {
  if (await isAtPrompt()) { promptReady = true; break; }
  // Not at prompt — try to advance any first-run modal (theme picker, etc.).
  await pressEnterInTerm();
  await new Promise((r) => setTimeout(r, 1500));
}
// Informational only: if we don't see the input box via heuristic, it
// might be because claude's first-run sequence is still settling. The
// `claude-replied` poll below is what actually decides the run, so we
// always log this step as PASS and put the heuristic outcome in detail.
log('prompt-ready', true, { inputBoxDetected: promptReady });

// ---------- TYPE PROMPT ----------
// Send keystrokes by calling xterm's `paste()` on the Terminal instance.
// `paste` triggers the same `onData` path as user typing, which ttyd has
// hooked to ship bytes to its websocket. This avoids needing to forge
// keyboard events and works regardless of focus.
const PROMPT = 'Hello, please reply with the word PING';
try {
  // Focus the xterm helper textarea first so claude's TUI sees focus events
  // (claude won't accept input until its input box has focus).
  await wvEval(`(function(){
    const ta = document.querySelector('.xterm-helper-textarea');
    if (ta) ta.focus();
    if (window.term && typeof window.term.focus === 'function') window.term.focus();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  // Send the prompt text via the raw data path (no bracketed paste).
  await termSend(PROMPT);
  await new Promise((r) => setTimeout(r, 600));

  // Submit with Enter — claude expects CR.
  await termSend('\r');
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
let lastBuffer = null;
const start = Date.now();
const TIMEOUT_MS = 90_000;
while (Date.now() - start < TIMEOUT_MS) {
  await new Promise((r) => setTimeout(r, 2000));
  lastBuffer = (await readBuffer().catch(() => null)) || null;
  if (!lastBuffer) continue;
  const full = lastBuffer.full || '';
  // Strip the echoed prompt (which appears in claude's input box) before
  // searching, so the user-typed "PING" isn't a false positive.
  const after = full.split(PROMPT).slice(1).join(PROMPT);
  if (after && /PING/.test(after)) {
    replied = true;
    break;
  }
}
log('claude-replied', replied, {
  elapsedMs: Date.now() - start,
  screenTail: lastBuffer?.screen ? lastBuffer.screen.slice(-800) : null,
  fullTail: lastBuffer?.full ? lastBuffer.full.slice(-800) : null,
});

await win.screenshot({ path: path.join(screenshotDir, '03-claude-replied.png'), fullPage: true });

await finish(electronApp, replied ? 0 : 1);
