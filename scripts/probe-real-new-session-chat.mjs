// Real-claude E2E probe — UX scenario C:
//
//   "1是new session以后，右边打开了claude没有报错，可以聊天"
//   After creating a new session, the right pane opens claude with no
//   errors, and the user can chat.
//
// What this probe verifies, end-to-end, against the prod bundle and the
// real claude CLI:
//
//   1. Boot ccsm in production-bundle mode with an isolated ~/.claude
//      clone (auth/proxy/permission config copied; chat history NOT).
//   2. Seed a fresh session via `window.__ccsmStore.createSession`.
//      `createSession` already sets it as active — that selection is
//      what causes <TtydPane> to mount on the right.
//   3. Wait for the ttyd <webview> to mount AND xterm + window.term to
//      initialize inside the OOPIF.
//   4. Wait for claude TUI to render its first content (banner / trust
//      prompt / input box).
//   5. If a trust / first-run prompt is visible, accept it (Enter).
//   6. Send a deterministic chat prompt ("say hi in 3 words").
//   7. Wait for claude's reply to appear in the buffer (text after the
//      echoed prompt).
//   8. Assert no error toast and no `ttyd-exit` flipped TtydPane into
//      its error state.
//   9. Cleanup (helper handles tempdir / userData; we close electron).
//
// All Electron / xterm / claude-TUI gotchas are encapsulated in the
// helper at scripts/probe-utils-real-cli.mjs (see its header). This
// file deliberately contains no canvas / triggerDataEvent / OOPIF code.

import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
  seedSession,
  waitForWebviewMounted,
  waitForXtermBuffer,
  sendToClaudeTui,
  readXtermLines,
} from './probe-utils-real-cli.mjs';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';

const PROBE_NAME = 'probe-real-new-session-chat';
const SCREENSHOT_DIR = path.resolve('docs/screenshots', PROBE_NAME);
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const CHAT_PROMPT = 'say hi in 3 words';

let electronApp = null;
let win = null;
let wcId = null;

function log(step, ok, detail) {
  const tag = ok ? 'PASS' : 'FAIL';
  const tail = detail ? ' ' + JSON.stringify(detail).slice(0, 200) : '';
  console.log(`[STEP] ${step}: ${tag}${tail}`);
}

async function fail(reason) {
  console.log(`[FAIL] ${PROBE_NAME}: ${reason}`);
  // Last 30 xterm buffer lines, if reachable.
  if (electronApp && wcId != null) {
    try {
      const lines = await readXtermLines(electronApp, wcId, { lines: 30 });
      console.log('--- last 30 xterm lines ---');
      for (const l of lines) console.log(l);
      console.log('--- end ---');
    } catch (err) {
      console.log(`(could not read xterm buffer: ${String(err).slice(0, 200)})`);
    }
  }
  // Best-effort screenshot of the host window.
  let screenshotPath = null;
  if (win) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    screenshotPath = path.join(SCREENSHOT_DIR, `fail-${ts}.png`);
    try {
      await win.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[FAIL] screenshot: ${screenshotPath}`);
    } catch (_) { /* ignore */ }
  }
  if (electronApp) {
    try { await electronApp.close(); } catch (_) { /* ignore */ }
  }
  process.exit(1);
}

async function pass() {
  console.log(`[PASS] ${PROBE_NAME}`);
  if (electronApp) {
    try { await electronApp.close(); } catch (_) { /* ignore */ }
  }
  process.exit(0);
}

(async () => {
  // ---------- 1. Isolated claude config + ccsm boot ----------
  let tempDir;
  try {
    ({ tempDir } = await createIsolatedClaudeDir());
    log('isolated-claude-dir', true, { tempDir });
  } catch (err) {
    return fail(`createIsolatedClaudeDir: ${String(err).slice(0, 300)}`);
  }

  try {
    ({ electronApp, win } = await launchCcsmIsolated({ tempDir }));
    log('launch-ccsm', true, null);
  } catch (err) {
    return fail(`launchCcsmIsolated: ${String(err).slice(0, 300)}`);
  }

  // Capture renderer console errors / pageerrors for the post-mortem.
  const consoleEvents = [];
  win.on('console', (msg) => consoleEvents.push({ type: msg.type(), text: msg.text() }));
  win.on('pageerror', (err) => consoleEvents.push({ type: 'pageerror', text: String(err) }));

  // Also surface main-process logs (where ttyd / cliBridge spawn errors land).
  electronApp.on('console', (msg) => consoleEvents.push({ type: 'main-' + msg.type(), text: msg.text() }));

  // ---------- 2. Seed a new session (createSession also sets activeId) ----------
  // Wait for the renderer's claudeAvailable check to resolve BEFORE seeding,
  // otherwise the right pane is in the indeterminate "probing" branch and
  // <TtydPane> never mounts — the IPC call we need to drive a webview only
  // happens once <TtydPane> renders.
  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );
    log('claude-availability-resolved', true, null);
  } catch (err) {
    return fail(`claude availability probe never resolved: ${String(err).slice(0, 300)}`);
  }

  let sid;
  try {
    ({ sid } = await seedSession(win, { name: 'probe-new-session', cwd: tempDir }));
    if (!sid) throw new Error('seedSession returned empty sid');
    log('seed-session', true, { sid });
  } catch (err) {
    return fail(`seedSession: ${String(err).slice(0, 300)}`);
  }

  // ---------- 3. Wait for webview to mount ----------
  // Give TtydPane's mount-time IPC call (openTtydForSession) a moment to
  // dispatch before we let the helper poll for the webview tag.
  await new Promise((r) => setTimeout(r, 4000));
  try {
    wcId = await waitForWebviewMounted(win, electronApp, sid, { timeout: 60000 });
    log('webview-mounted', true, { wcId });
  } catch (err) {
    // Surface diagnostics so a webview-mount failure can be triaged
    // without re-running with manual instrumentation. This is the most
    // common failure mode of the probe so it's worth the noise.
    try {
      const paneState = await win.evaluate((wantedSid) => {
        const all = Array.from(document.getElementsByTagName('webview'));
        return {
          webviewCount: all.length,
          firstWebviewTitle: all[0]?.getAttribute('title') ?? null,
          firstWebviewSrc: all[0]?.getAttribute('src') ?? null,
          hasMissingGuide: !!document.querySelector('[data-testid="claude-missing-guide"]'),
          hasInstallerBanner: !!document.querySelector('[data-testid="installer-corrupt-banner"]'),
          activeId: window.__ccsmStore?.getState?.()?.activeId ?? null,
          sessionCount: window.__ccsmStore?.getState?.()?.sessions?.length ?? 0,
          wantedSid,
          rightPaneText: (document.querySelector('main')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200),
        };
      }, sid);
      console.log(`[DEBUG] right-pane state at webview-mount failure: ${JSON.stringify(paneState)}`);
      console.log(`[DEBUG] last 10 console events captured (${consoleEvents.length} total):`);
      for (const e of consoleEvents.slice(-10)) {
        console.log(`  - [${e.type}] ${e.text.slice(0, 200)}`);
      }
    } catch (_) { /* ignore */ }
    return fail(`waitForWebviewMounted: ${String(err).slice(0, 300)}`);
  }

  // ---------- 4. claude TUI rendered ----------
  try {
    await waitForXtermBuffer(electronApp, wcId, /trust|claude|welcome|│|╭|>/i, { timeout: 30000 });
    log('claude-tui-rendered', true, null);
  } catch (err) {
    return fail(`waitForXtermBuffer (initial): ${String(err).slice(0, 300)}`);
  }

  // ---------- 5. Dismiss trust / first-run / "Welcome back!" splashes ----------
  // claude can show several pre-prompt screens that intercept the first
  // keystrokes:
  //   - trust dialog: "Do you trust the files in this folder?" → "1\r"
  //   - "Welcome back!" cold-start splash → bare Enter dismisses
  //   - theme picker / security notice → bare Enter advances
  // Loop until we see the input box "│ >" or run out of attempts.
  let promptReady = false;
  for (let i = 0; i < 12; i++) {
    const lines = await readXtermLines(electronApp, wcId, { lines: 30 }).catch(() => []);
    const screen = lines.join('\n');
    if (/│\s*>/.test(screen) || /^\s*>\s/m.test(screen)) {
      promptReady = true;
      break;
    }
    if (/trust|do you trust/i.test(screen)) {
      await sendToClaudeTui(electronApp, wcId, '1\r').catch(() => {});
    } else {
      // Covers "Welcome back!", theme picker, security notice — all advance
      // on Enter.
      await sendToClaudeTui(electronApp, wcId, '\r').catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  log('prompt-ready', true, { inputBoxDetected: promptReady });

  // ---------- 6. Send chat prompt ----------
  try {
    await sendToClaudeTui(electronApp, wcId, CHAT_PROMPT);
    await new Promise((r) => setTimeout(r, 500));
    await sendToClaudeTui(electronApp, wcId, '\r');
    log('prompt-sent', true, { prompt: CHAT_PROMPT });
  } catch (err) {
    return fail(`sendToClaudeTui (chat): ${String(err).slice(0, 300)}`);
  }

  // ---------- 7. Wait for claude reply ----------
  // Strategy: poll the buffer; succeed when the buffer contains substantive
  // text AFTER the echoed prompt that isn't itself the prompt or empty
  // box-drawing chrome. We don't pin to a specific reply word because
  // "say hi in 3 words" is open-ended; instead we look for any line of
  // 2+ alphanumeric tokens appearing after the prompt echo.
  let replied = false;
  let lastLines = [];
  const start = Date.now();
  const TIMEOUT_MS = 90_000;
  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 2000));
    lastLines = await readXtermLines(electronApp, wcId, { lines: 60 }).catch(() => []);
    if (!lastLines.length) continue;
    const joined = lastLines.join('\n');
    // Find the LAST occurrence of the echoed prompt and look at content
    // that follows it, so the user-typed prompt itself isn't a false hit.
    const idx = joined.lastIndexOf(CHAT_PROMPT);
    const after = idx >= 0 ? joined.slice(idx + CHAT_PROMPT.length) : joined;
    // Skip pure box-drawing / prompt chrome lines; require >= 2 word chars
    // of content on a line that isn't another echo of the prompt.
    const replyLines = after
      .split('\n')
      .map((l) => l.replace(/[│╭╰─╯╮>•·\s]+/g, ' ').trim())
      .filter((l) => l.length >= 4 && /[A-Za-z]{2,}/.test(l) && !l.includes(CHAT_PROMPT));
    if (replyLines.length > 0) {
      replied = true;
      break;
    }
  }
  if (!replied) {
    return fail(
      `claude did not reply within ${TIMEOUT_MS}ms. Last buffer lines:\n${lastLines.slice(-20).join('\n')}`,
    );
  }
  log('claude-replied', true, { elapsedMs: Date.now() - start });

  // ---------- 8. No error toast, no ttyd-exit flip ----------
  let healthy;
  try {
    healthy = await win.evaluate(() => {
      const w = window;
      const out = { errorToast: null, ttydErrorVisible: false };
      // Error toasts render in the 'assertive' aria-live region.
      const errRegion = document.querySelector('[aria-live="assertive"]');
      if (errRegion) {
        const txt = (errRegion.textContent || '').trim();
        if (txt) out.errorToast = txt.slice(0, 240);
      }
      // TtydPane's error state shows literal "ttyd exited" text in red.
      // Detect the "Retry" button it renders; that button only exists in
      // the error branch.
      const buttons = Array.from(document.querySelectorAll('button'));
      out.ttydErrorVisible = buttons.some((b) => /^retry$/i.test((b.textContent || '').trim()));
      return out;
    });
  } catch (err) {
    return fail(`health-check evaluate: ${String(err).slice(0, 300)}`);
  }
  if (healthy.errorToast) {
    return fail(`error toast surfaced after chat: ${healthy.errorToast}`);
  }
  if (healthy.ttydErrorVisible) {
    return fail('TtydPane flipped to error state (Retry button visible)');
  }
  log('no-error-state', true, null);

  // Surface a small slice of console errors for visibility (informational).
  const consoleErrors = consoleEvents.filter(
    (e) => e.type === 'error' || e.type === 'pageerror',
  );
  if (consoleErrors.length > 0) {
    console.log(`[INFO] renderer logged ${consoleErrors.length} error events (non-fatal):`);
    for (const e of consoleErrors.slice(0, 5)) {
      console.log(`  - [${e.type}] ${e.text.slice(0, 200)}`);
    }
  }

  await pass();
})().catch(async (err) => {
  await fail(`unhandled: ${String(err).slice(0, 400)}`);
});
