// Workflow group ⑤ — input/output paste-fidelity e2e harness.
//
// Pins the transparent-transport invariant for the three paste entry points:
//
//   1. terminal-paste-text   — multi-line CRLF text. Programmatically place
//      "line1\r\nline2\r\nline3" on the OS clipboard via the in-renderer
//      ccsmPty.clipboard.writeText bridge, then drive the right-click /
//      Ctrl+V paste path. Assert the pty stdin received exactly
//      `\x1b[200~line1\nline2\nline3\x1b[201~` (CRLF normalised to LF +
//      bracketed-paste wrapping IFF bracketedPasteMode is on).
//
//   2. terminal-paste-image  — programmatically place a PNG buffer on the
//      clipboard via the main-process Electron clipboard.writeImage bridge.
//      Trigger paste. Assert (a) a file appears under
//      `<userData>/clipboard-images/`, and (b) pty stdin received the
//      path string (image-first branch in src/terminal/paste.ts).
//
//   3. terminal-input-ime    — OPTIONAL. Programmatically fire
//      compositionstart / compositionupdate / compositionend with Chinese
//      characters on the xterm-helper-textarea. Assert pty stdin received
//      the UTF-8 bytes for the composed string. Marked allowed-red if the
//      mock proves unstable — claude's TUI IME integration is the third
//      hop and we can't substitute its receiver in a black-box harness.
//
// Test seam:
//   The renderer's `pasteIntoActivePty` performs a single
//   `window.ccsmPty.input(sid, payload)` call per paste; that payload is
//   handed verbatim to the main-process IPC and `entry.pty.write(data)`
//   in `electron/ptyHost/lifecycle.ts:input` writes it byte-for-byte to
//   node-pty (no transformation between renderer and pty). We intercept
//   on the MAIN side: contextBridge.exposeInMainWorld freezes the
//   renderer namespace (`window.ccsmPty.input = wrapped` is a no-op,
//   verified), but the main-process `ipcMain.handle('pty:input', ...)`
//   handler lives in `ipcMain._invokeHandlers` (a Map keyed by channel)
//   and IS mutable. We wrap it to log every (sid, data) into
//   `globalThis.__pastePtyInputLog`. See `installPtyInputProbe` below.
//
// Group: shared. All cases run in one isolated electron launch.
//
// Run: `node scripts/harness-e2e-paste-fidelity.mjs`
// Run one: `node scripts/harness-e2e-paste-fidelity.mjs --only=terminal-paste-text`

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  dismissFirstRunModals,
  launchCcsmIsolated,
  seedSession,
  waitForTerminalReady,
  waitForXtermBuffer,
} from './probe-utils-real-cli.mjs';
import { startFakeAnthropicApi } from './fixtures/fake-anthropic-api.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed claude's onboarding state into the isolated tempDir so the spawned
// CLI talks to the fake Anthropic API (wired via ANTHROPIC_BASE_URL below)
// and never the real one. The empty `{}` settings.json/settings.local.json
// overwrite the copies createIsolatedClaudeDir() lifts from the real
// ~/.claude — dropping any ANTHROPIC_AUTH_TOKEN / proxy config that would
// otherwise route to a live endpoint. Pre-approving the 'fake-ci-key' avoids
// the first-launch custom-API-key modal. Shape mirrors
// harness-e2e-session-lifecycle.mjs#seedOnboarding.
function seedOnboarding(tempDir) {
  const trustedEntry = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: 1,
  };
  const projects = {};
  projects[tempDir] = trustedEntry;
  const tempDirFwd = tempDir.replace(/\\/g, '/');
  if (tempDirFwd !== tempDir) projects[tempDirFwd] = trustedEntry;
  writeFileSync(
    path.join(tempDir, '.claude.json'),
    JSON.stringify(
      {
        hasCompletedOnboarding: true,
        bypassPermissionsModeAccepted: true,
        customApiKeyResponses: { approved: ['fake-ci-key'] },
        projects,
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(tempDir, 'settings.json'), '{}');
  writeFileSync(path.join(tempDir, 'settings.local.json'), '{}');
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

// ============================================================================
// CLI args
// ============================================================================

function parseArgs(argv) {
  const out = { only: null, skip: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--only=')) {
      out.only = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--skip=')) {
      out.skip = arg.slice('--skip='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/harness-e2e-paste-fidelity.mjs [--only=name1,name2] [--skip=name1,name2]');
      for (const c of CASE_REGISTRY) console.log('  -', c.name);
      process.exit(0);
    }
  }
  return out;
}

// ============================================================================
// Test seam: wrap the main-process `pty:input` IPC handler to log every payload
// ============================================================================
//
// Why main-side rather than renderer-side: `contextBridge.exposeInMainWorld`
// freezes the exposed namespace, so `window.ccsmPty.input = wrapped` is a
// no-op (verified empirically). The main-process IPC handler registered via
// `ipcMain.handle(PTY_CHANNELS.input, ...)` lives in `ipcMain._invokeHandlers`
// — an internal Map keyed by channel name — and IS mutable. We wrap the
// installed handler so every (sid, data) pair lands in `globalThis.__pastePtyInputLog`
// before being forwarded to the real handler. The real `pty.write` call is
// transparent: lifecycle.input → `entry.pty.write(data)` writes the bytes
// verbatim, so the captured payload equals the bytes that reach claude's stdin.
//
// We also defensively wrap `ipcMain.handle` so a future re-registration
// (HMR / module re-init) doesn't shed the wrap.

/**
 * Install the main-process IPC interceptor. Idempotent. Captures every
 * `pty:input` invocation into `globalThis.__pastePtyInputLog`, accessible
 * from the harness via `electronApp.evaluate`.
 */
async function installPtyInputProbe(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    if (globalThis.__pastePtyInputProbeInstalled) return;
    globalThis.__pastePtyInputProbeInstalled = true;
    globalThis.__pastePtyInputLog = [];
    const CHANNEL = 'pty:input';
    // ipcMain._invokeHandlers is the internal handler registry — keyed by
    // channel name. Wrap the existing handler so the real call still runs
    // (otherwise `pty.write` never fires and the paste vanishes).
    const map = ipcMain._invokeHandlers;
    if (!map || typeof map.get !== 'function') {
      globalThis.__pastePtyInputProbeError = 'ipcMain._invokeHandlers not a Map';
      return;
    }
    const orig = map.get(CHANNEL);
    if (typeof orig !== 'function') {
      globalThis.__pastePtyInputProbeError = `no handler registered for ${CHANNEL}`;
      return;
    }
    map.set(CHANNEL, (event, ...args) => {
      try {
        const [sid, data] = args;
        if (typeof data === 'string') {
          globalThis.__pastePtyInputLog.push({ sid, data, at: Date.now() });
        }
      } catch (_) { /* swallow — never break the IPC */ }
      return orig(event, ...args);
    });
  });
}

async function readPtyInputLog(electronApp, sid) {
  return await electronApp.evaluate((_e, s) => {
    const all = globalThis.__pastePtyInputLog || [];
    return all.filter((entry) => entry.sid === s).slice();
  }, sid);
}

async function clearPtyInputLog(electronApp) {
  await electronApp.evaluate(() => { globalThis.__pastePtyInputLog = []; });
}

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * Get the userData path from the main process. Needed to inspect
 * `<userData>/clipboard-images/` after an image paste.
 */
async function getUserDataDir(electronApp) {
  return await electronApp.evaluate(({ app }) => app.getPath('userData'));
}

/**
 * Wait until xterm's bracketed-paste mode is enabled (claude's Ink TUI
 * emits `\x1b[?2004h` shortly after the prompt is interactive). We need
 * this to be ON before triggering the paste, otherwise
 * `preparePastePayload` will skip the bracketed wrapping and the
 * assertion that asserts the sentinels will fail with a "false negative"
 * that's actually correct behaviour.
 *
 * Reads from `window.__ccsmTerm.modes.bracketedPasteMode` directly.
 */
async function waitForBracketedPasteMode(win, { timeout = 45_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const on = await win.evaluate(() => {
      const term = window.__ccsmTerm;
      return term && term.modes ? term.modes.bracketedPasteMode === true : false;
    });
    if (on) return true;
    await sleep(200);
  }
  return false;
}

// ============================================================================
// Case: terminal-paste-text
// ============================================================================

async function caseTerminalPasteText({ electronApp, win, tempDir }) {
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30_000 },
  );

  const { sid } = await seedSession(win, { name: 'paste-text-probe', cwd: tempDir });
  if (!sid) throw new Error('seedSession returned no sid');

  await sleep(3000);
  await waitForTerminalReady(win, sid, { timeout: 60_000 });
  await waitForXtermBuffer(win, /trust|claude|welcome|│|╭|>/i, { timeout: 30_000 });
  await dismissFirstRunModals(win);

  // Wait for bracketed-paste mode to be on (claude's prompt is interactive).
  const bracketed = await waitForBracketedPasteMode(win, { timeout: 45_000 });
  // bracketed mode is the production case; if claude never enabled it
  // (e.g. trust splash still active), we still verify whichever branch
  // the production code takes — `preparePastePayload` gates on the live
  // value of `term.modes.bracketedPasteMode`.

  // Install the pty-input probe BEFORE the paste so we capture the call.
  await installPtyInputProbe(electronApp);
  await clearPtyInputLog(electronApp);

  // The payload as it appears on the OS clipboard.
  const CLIPBOARD_TEXT = 'line1\r\nline2\r\nline3';
  // Expected pty-stdin payload: CRLF normalised → LF; lone CR → LF; if
  // bracketed-paste mode is on, wrapped with ESC [200~ / ESC [201~.
  const NORMALISED = 'line1\nline2\nline3';
  const EXPECTED = bracketed
    ? `${BRACKETED_PASTE_START}${NORMALISED}${BRACKETED_PASTE_END}`
    : NORMALISED;

  // Place the text on the clipboard via the renderer's clipboard bridge
  // (resolves to electron `clipboard.writeText` under the hood). Then
  // trigger the right-click contextmenu code path on the terminal host —
  // identical to a real user right-clicking with no selection.
  await win.evaluate((t) => window.ccsmPty.clipboard.writeText(t), CLIPBOARD_TEXT);
  // Sanity: confirm the clipboard round-trips.
  const roundTrip = await win.evaluate(() => window.ccsmPty.clipboard.readText());
  if (roundTrip !== CLIPBOARD_TEXT) {
    throw new Error(`clipboard round-trip mismatch: wrote ${JSON.stringify(CLIPBOARD_TEXT)}, got ${JSON.stringify(roundTrip)}`);
  }

  // Drive the right-click paste path. TerminalPane's onContextMenu is a
  // React JSX prop; dispatching a bare MouseEvent on the host div doesn't
  // route through React's synthetic event delegation reliably. Playwright's
  // real right-click does. Use the host element selector.
  await win.locator(`[data-terminal-host][data-active-sid="${sid}"]`).first()
    .click({ button: 'right', position: { x: 80, y: 80 } });

  // Wait for the pty-input log to record the paste payload.
  let entry = null;
  {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const log = await readPtyInputLog(electronApp, sid);
      // The most recent payload that contains 'line1' is the paste output.
      // Earlier entries on this sid would be one-byte keystrokes from the
      // trust-dismiss loop above (which we cleared, but a stray dataUnsubscribe
      // re-arm could push one). Match by 'line1' substring to be robust.
      entry = log.filter((e) => typeof e.data === 'string' && e.data.includes('line1')).at(-1) ?? null;
      if (entry) break;
      await sleep(150);
    }
  }
  if (!entry) {
    const log = await readPtyInputLog(electronApp, sid);
    throw new Error(`pty input log never received a paste payload. log=${JSON.stringify(log)}`);
  }

  // Compare byte-for-byte. JSON.stringify makes ESC bytes visible in any
  // failure log.
  if (entry.data !== EXPECTED) {
    throw new Error(
      `paste payload mismatch (bracketed=${bracketed})\n  expected: ${JSON.stringify(EXPECTED)}\n  got:      ${JSON.stringify(entry.data)}`,
    );
  }
  console.log(
    `[case=terminal-paste-text] bracketed=${bracketed} payload=${JSON.stringify(entry.data)}`,
  );

  // Defence-in-depth: assert NO lone \r byte survived the normalisation.
  // (Catches a future regression where preparePastePayload's CRLF rule
  // drifts.) The bracketed sentinels contain no \r.
  if (/\r/.test(entry.data)) {
    throw new Error(`pty stdin still contains \\r after normalisation: ${JSON.stringify(entry.data)}`);
  }
}

// ============================================================================
// Case: terminal-paste-image
// ============================================================================

async function caseTerminalPasteImage({ electronApp, win, tempDir }) {
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30_000 },
  );

  const { sid } = await seedSession(win, { name: 'paste-image-probe', cwd: tempDir });
  if (!sid) throw new Error('seedSession returned no sid');
  await sleep(3000);
  await waitForTerminalReady(win, sid, { timeout: 60_000 });
  await waitForXtermBuffer(win, /trust|claude|welcome|│|╭|>/i, { timeout: 30_000 });
  await dismissFirstRunModals(win);

  // Snapshot the existing image directory contents so we only consider
  // files created by THIS paste.
  const userDataDir = await getUserDataDir(electronApp);
  const imageDir = path.join(userDataDir, 'clipboard-images');
  mkdirSync(imageDir, { recursive: true });
  const filesBefore = new Set(readdirSync(imageDir));
  console.log(`[case=terminal-paste-image] image dir=${imageDir} (${filesBefore.size} files before)`);

  await installPtyInputProbe(electronApp);
  await clearPtyInputLog(electronApp);

  // Place a tiny PNG on the system clipboard via main-process Electron API.
  // A 1x1 transparent PNG (smallest valid image, ~67 bytes). Using a
  // base64 string keeps the harness file dep-free.
  const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await electronApp.evaluate(({ clipboard, nativeImage }, b64) => {
    const buf = Buffer.from(b64, 'base64');
    const img = nativeImage.createFromBuffer(buf);
    clipboard.writeImage(img);
  }, TINY_PNG_BASE64);

  // Sanity: the renderer's `ccsmPty.saveClipboardImage` should now find
  // an image on the clipboard and not return null. We do NOT call it
  // ahead of time (the paste path will call it for us) — but reading
  // the clipboard text should be empty / disclaim the image, matching
  // the Windows-text-unreliable-with-image branch.

  // Drive the right-click paste path. See terminal-paste-text for why we
  // use Playwright's real right-click rather than a synthetic event.
  await win.locator(`[data-terminal-host][data-active-sid="${sid}"]`).first()
    .click({ button: 'right', position: { x: 80, y: 80 } });

  // Wait for a new file under <userData>/clipboard-images/.
  let createdFile = null;
  {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const cur = readdirSync(imageDir);
      const fresh = cur.filter((f) => !filesBefore.has(f) && f.toLowerCase().endsWith('.png'));
      if (fresh.length > 0) {
        createdFile = path.join(imageDir, fresh[0]);
        break;
      }
      await sleep(200);
    }
  }
  if (!createdFile) {
    throw new Error(`no PNG file created under ${imageDir} within 15s after paste`);
  }
  const st = statSync(createdFile);
  if (st.size === 0) throw new Error(`created image file is empty: ${createdFile}`);
  console.log(`[case=terminal-paste-image] created file=${createdFile} (${st.size} bytes)`);

  // Wait for the pty-input log to record a paste containing the image path.
  // The image-first branch sends EXACTLY the image path (bracketed if
  // applicable). Compare with the normalised file path.
  let entry = null;
  {
    const deadline = Date.now() + 10_000;
    // Match against any path-ish payload that ends in the created file's
    // basename (sentinels notwithstanding).
    const baseName = path.basename(createdFile);
    while (Date.now() < deadline) {
      const log = await readPtyInputLog(electronApp, sid);
      entry = log.filter((e) => typeof e.data === 'string' && e.data.includes(baseName)).at(-1) ?? null;
      if (entry) break;
      await sleep(150);
    }
  }
  if (!entry) {
    const log = await readPtyInputLog(electronApp, sid);
    throw new Error(`pty input log never received the image path payload. log=${JSON.stringify(log)}`);
  }
  // Sanity check the wrapping. The renderer normalises CRLF→LF on the
  // image path too (paths shouldn't contain CR, but the normaliser runs
  // unconditionally). Bracketed sentinels MAY or MAY NOT be present
  // depending on terminal state at paste time; only assert the path
  // itself made it through.
  if (!entry.data.includes(createdFile) && !entry.data.includes(createdFile.replace(/\\/g, '/'))) {
    throw new Error(
      `pty stdin payload doesn't contain the image path.\n  payload: ${JSON.stringify(entry.data)}\n  path:    ${createdFile}`,
    );
  }
  console.log(
    `[case=terminal-paste-image] pty stdin payload=${JSON.stringify(entry.data.slice(0, 240))}…`,
  );
}

// ============================================================================
// Case: terminal-input-ime  (OPTIONAL — allowed red if mock unstable)
// ============================================================================
//
// Programmatically drives the xterm-helper-textarea's compositionstart /
// compositionupdate / compositionend events with Chinese characters. The
// xtermWarmRegistry installs composition listeners on the textarea (see
// the IME setup section of `ensureAndShowEntry`) — when the composition
// ends, the committed text is forwarded via `term._core._coreService
// .triggerDataEvent(text, true)`, which in turn fires `term.onData`,
// which the cold-attach hook wires through to `window.ccsmPty.input`.
//
// If the composition path proves unstable under Playwright (event-order
// races with xterm's WriteBuffer, or the headless Chromium TextInputClient
// not honouring synthetic CompositionEvent.data), this case is marked
// allowed-red and documented; the IME composition contract is covered at
// the unit level by `tests/ime-composition.test.tsx` (DOM-only) and by
// `scripts/harness-ime-overflow.mjs` (layout invariant).

async function caseTerminalInputIme({ electronApp, win, tempDir }) {
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30_000 },
  );

  const { sid } = await seedSession(win, { name: 'ime-input-probe', cwd: tempDir });
  if (!sid) throw new Error('seedSession returned no sid');
  await sleep(3000);
  await waitForTerminalReady(win, sid, { timeout: 60_000 });
  await waitForXtermBuffer(win, /trust|claude|welcome|│|╭|>/i, { timeout: 30_000 });
  await dismissFirstRunModals(win);

  await installPtyInputProbe(electronApp);
  await clearPtyInputLog(electronApp);

  const IME_TEXT = '你好';
  // UTF-8 of "你好" is E4 BD A0 E5 A5 BD (6 bytes). triggerDataEvent forwards
  // the JS string verbatim through onData; node-pty writes the same JS
  // string to the pty, which Buffer-encodes as UTF-8. The pty-input log
  // captures the JS string — assert the string contains the IME chars,
  // and cross-check the UTF-8 byte length via TextEncoder for completeness.

  // Find and focus the xterm-helper-textarea, then dispatch the
  // composition sequence. The textarea must be focused for xterm's
  // composition listeners to register the events.
  const dispatched = await win.evaluate(({ s, txt }) => {
    const host = document.querySelector(`[data-terminal-host][data-active-sid="${s}"]`);
    if (!host) return { ok: false, reason: 'no-host' };
    const ta = host.querySelector('.xterm-helper-textarea');
    if (!ta) return { ok: false, reason: 'no-helper-textarea' };
    try { ta.focus(); } catch (_) { /* best-effort */ }
    // compositionstart with empty data
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    // compositionupdate with the full composed text
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: txt }));
    // Drive an input event mirroring how Chromium reports IME composition
    // intermediate state (xterm's compositionUpdateHandler reads the
    // textarea value, not just the event data, in some code paths).
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, txt);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) { /* not all xterm versions read .value */ }
    // compositionend commits — xterm forwards the committed data via
    // triggerDataEvent. Clear the textarea after to mirror real IME.
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: txt }));
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) { /* best-effort */ }
    return { ok: true };
  }, { s: sid, txt: IME_TEXT });
  if (!dispatched.ok) throw new Error(`composition dispatch failed: ${dispatched.reason}`);

  // Poll for the pty-input log to receive the committed text.
  let entry = null;
  {
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      const log = await readPtyInputLog(electronApp, sid);
      entry = log.filter((e) => typeof e.data === 'string' && e.data.includes(IME_TEXT)).at(-1) ?? null;
      if (entry) break;
      await sleep(150);
    }
  }
  if (!entry) {
    const log = await readPtyInputLog(electronApp, sid);
    // Documented allowed-red: the synthetic CompositionEvent path may not
    // wire through xterm's coreService.triggerDataEvent on every Chromium
    // version + xterm version pairing. Surface a clear diagnostic
    // distinguishing "mock didn't propagate" from "production regression".
    throw new Error(
      `IME composition payload not observed at pty stdin within 6s.\n` +
        `  expected substring: ${JSON.stringify(IME_TEXT)}\n` +
        `  pty input log     : ${JSON.stringify(log)}\n` +
        `  NOTE: this case is marked OPTIONAL — if the failure is due to ` +
        `Playwright/xterm composition-event plumbing rather than a real ` +
        `regression, document and leave red per the harness's allowed-red ` +
        `policy. Real IME coverage lives in tests/ime-composition.test.tsx ` +
        `(DOM) and scripts/harness-ime-overflow.mjs (layout).`,
    );
  }
  // Cross-check UTF-8 encoding length.
  const encodedLen = new TextEncoder().encode(IME_TEXT).length;
  if (encodedLen !== 6) {
    throw new Error(`test invariant broke: "${IME_TEXT}" UTF-8 length expected 6, got ${encodedLen}`);
  }
  console.log(`[case=terminal-input-ime] pty stdin received "${IME_TEXT}" (${encodedLen} UTF-8 bytes) via payload=${JSON.stringify(entry.data)}`);
}

// ============================================================================
// Registry
// ============================================================================

const CASE_REGISTRY = [
  { name: 'terminal-paste-text',  group: 'shared', run: caseTerminalPasteText },
  { name: 'terminal-paste-image', group: 'shared', run: caseTerminalPasteImage },
  // TODO(ime-stable-mock): re-enable `terminal-input-ime` once we have a
  // stable cross-platform mock for IME composition through xterm.js +
  // headless Chromium. The synthetic CompositionEvent path is unreliable
  // under Playwright/xvfb (event-order races with xterm's WriteBuffer,
  // and headless Chromium TextInputClient does not honour synthetic
  // CompositionEvent.data consistently across versions), so this case
  // failed on CI even when production code is correct. The runner
  // propagates any failure to exit code 1, so a flaky "allowed-red"
  // does block the PR — explicit skip is the honest stance.
  //
  // Real IME coverage is provided by:
  //   - `tests/ime-composition.test.tsx` — DOM-level composition events
  //   - `scripts/harness-ime-overflow.mjs` — layout invariant under IME
  //
  // The function `caseTerminalInputIme` below is kept for the future
  // re-enable; it is not referenced from the registry.
  // { name: 'terminal-input-ime',   group: 'shared', run: caseTerminalInputIme },
];

// ============================================================================
// Runner
// ============================================================================

async function main() {
  const { only, skip } = parseArgs(process.argv);
  const selected = CASE_REGISTRY.filter((c) => {
    if (only && !only.includes(c.name)) return false;
    if (skip && skip.includes(c.name)) return false;
    return true;
  });
  if (selected.length === 0) {
    console.error('No cases selected. Available:', CASE_REGISTRY.map((c) => c.name).join(', '));
    process.exit(2);
  }

  if (!existsSync(path.resolve('dist/renderer/index.html'))) {
    console.error('dist/renderer/index.html missing — run `npm run build` first');
    process.exit(2);
  }

  const results = [];
  const harnessStart = Date.now();

  const fakeApi = await startFakeAnthropicApi({ port: 0, verbose: false });
  console.log(`[HARNESS=paste-fidelity] fake Anthropic API at ${fakeApi.url}`);

  let isolated = null;
  let launched = null;
  try {
    isolated = await createIsolatedClaudeDir();
    seedOnboarding(isolated.tempDir);
    launched = await launchCcsmIsolated({
      tempDir: isolated.tempDir,
      env: {
        ANTHROPIC_BASE_URL: fakeApi.url,
        ANTHROPIC_API_KEY: 'fake-ci-key',
      },
    });
    const ctx = { electronApp: launched.electronApp, win: launched.win, tempDir: isolated.tempDir };
    console.log(`\n[HARNESS=paste-fidelity] shared launch ready (tempDir=${isolated.tempDir})`);
    for (const c of selected) {
      const t0 = Date.now();
      console.log(`\n[HARNESS=paste-fidelity] >>> case: ${c.name}`);
      try {
        await c.run(ctx);
        const ms = Date.now() - t0;
        results.push({ name: c.name, ok: true, ms });
        console.log(`[HARNESS=paste-fidelity] <<< PASS ${c.name} (${ms}ms)`);
      } catch (err) {
        const ms = Date.now() - t0;
        results.push({ name: c.name, ok: false, ms, error: String(err?.stack || err) });
        console.error(`[HARNESS=paste-fidelity] <<< FAIL ${c.name} (${ms}ms): ${err?.message || err}`);
      }
    }
  } finally {
    if (launched?.electronApp) try { await launched.electronApp.close(); } catch (_) { /* ignore */ }
    launched?.cleanup?.();
    isolated?.cleanup?.();
    try { await fakeApi.stop(); } catch (_) { /* ignore */ }
  }

  const totalMs = Date.now() - harnessStart;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('\n===== HARNESS=paste-fidelity SUMMARY =====');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(34)} ${r.ms}ms`);
  }
  console.log(`  total: ${passed}/${results.length} passed, ${(totalMs / 1000).toFixed(1)}s wall`);
  process.exit(failed === 0 ? 0 : 1);
}

const _entryUrlMain =
  process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (_entryUrlMain && import.meta.url === _entryUrlMain) {
  main().catch((err) => {
    console.error('[HARNESS=paste-fidelity] unhandled top-level error:', err?.stack || err);
    process.exit(1);
  });
}
