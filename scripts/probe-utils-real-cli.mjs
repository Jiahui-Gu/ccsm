// Shared helpers for real-claude e2e probes.
//
// Goal: factor the working `dogfood-probe-happy-path.mjs` patterns (Electron
// OOPIF webview drive, xterm canvas-buffer reads, raw `triggerDataEvent`
// keystroke injection, prod-bundle launch with isolated config) into a single
// reusable module so the 5 downstream probes share one canonical implementation.
//
// This module is helpers ONLY. No assertions, no test logic, no top-level
// `console.log` chatter beyond what callers explicitly opt into.
//
// Critical correctness points (do not regress):
//
//   1. xterm renders to canvas — `document.body.innerText` is empty. The only
//      reliable buffer read is `term.buffer.active.getLine(N).translateToString()`
//      via the xterm Terminal instance ttyd exposes as `window.term`.
//
//   2. claude's Ink TUI silently swallows bracketed-paste sequences. Use
//      `term._core._coreService.triggerDataEvent(text, true)` — NOT
//      `term.paste()` — to inject keystrokes. Append `'\r'` for Enter in the
//      caller; this helper sends bytes verbatim.
//
//   3. xterm bg merges with host bg (#0B0B0C). If you screenshot and see
//      "nothing", the buffer may still have content — read the buffer first.
//
//   4. Auth on Windows lives in `~/.claude/settings.json` (Agent Maestro
//      proxy + ANTHROPIC_AUTH_TOKEN), NOT in a `.credentials.json`. We must
//      copy `settings.json`, `settings.local.json`, `config.json`, and
//      `.claude.json` into the isolated tempdir so claude can authenticate,
//      but we deliberately omit `projects/`, `sessions/`, `history.jsonl`,
//      `tasks/`, `plans/` etc. so probes don't see the user's chat history
//      and write fresh JSONLs into the tempdir.
//
//   5. Node + Electron read `USERPROFILE` (not `HOME`) on Windows. The
//      isolated launch sets HOME, USERPROFILE, CLAUDE_CONFIG_DIR, and
//      CCSM_CLAUDE_CONFIG_DIR all together — main reads
//      CCSM_CLAUDE_CONFIG_DIR but the renderer's commands-loader reads bare
//      CLAUDE_CONFIG_DIR.
//
//   6. Cleanup must run on Ctrl+C too — registered via process.on('exit')
//      AND process.on('SIGINT') / SIGTERM.

import { _electron as electron } from 'playwright';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ============================================================================
// OOPIF helpers
// ============================================================================

/**
 * Find the Electron WebContents id of the ttyd <webview>. Returns a number.
 *
 * The ttyd webview is identified by getType() === 'webview' AND a URL that
 * starts with `http://127.0.0.1:` (the ttyd HTTP server).
 *
 * Throws if no matching webview is found within `timeout` ms.
 */
export async function getTtydWebContentsId(electronApp, { timeout = 5000 } = {}) {
  const deadline = Date.now() + timeout;
  let lastSeen = null;
  while (Date.now() < deadline) {
    const found = await electronApp.evaluate(({ webContents }) => {
      const all = webContents.getAllWebContents();
      const matches = [];
      for (const wc of all) {
        const type = wc.getType();
        const url = wc.getURL();
        if (type === 'webview' && /^http:\/\/127\.0\.0\.1:\d+/.test(url)) {
          matches.push({ id: wc.id, url });
        }
      }
      return matches;
    });
    if (found && found.length > 0) {
      // Prefer the most recently created (highest id) — matches the
      // "current session's ttyd" intent when multiple have been opened.
      found.sort((a, b) => b.id - a.id);
      return found[0].id;
    }
    lastSeen = found;
    await sleep(200);
  }
  throw new Error(
    `getTtydWebContentsId: no <webview> with http://127.0.0.1:* URL found within ${timeout}ms (last seen: ${JSON.stringify(lastSeen)})`,
  );
}

/**
 * Run JS inside the webview's WebContents (OOPIF). Returns whatever the JS
 * expression evaluates to. The script must be a string (Electron's
 * `executeJavaScript` API requirement).
 */
export async function executeJavaScriptOnWebview(electronApp, wcId, scriptString) {
  if (typeof scriptString !== 'string') {
    throw new TypeError('executeJavaScriptOnWebview: scriptString must be a string');
  }
  return await electronApp.evaluate(
    async ({ webContents }, { id, expr }) => {
      const wc = webContents.fromId(id);
      if (!wc) throw new Error(`no webContents with id ${id}`);
      return await wc.executeJavaScript(expr, true);
    },
    { id: wcId, expr: scriptString },
  );
}

/**
 * Wait for xterm buffer to contain text matching `pattern` (RegExp). Polls
 * every 200ms until match or timeout. Reads via
 * `term.buffer.active.getLine(N).translateToString()` — DOM textContent is
 * always empty on canvas-rendered xterm.
 *
 * Returns { matched, full, screen } on success.
 * Throws on timeout, including the last buffer tail in the error message.
 */
export async function waitForXtermBuffer(electronApp, wcId, pattern, { timeout = 15000 } = {}) {
  if (!(pattern instanceof RegExp)) {
    throw new TypeError('waitForXtermBuffer: pattern must be a RegExp');
  }
  const deadline = Date.now() + timeout;
  let lastBuf = null;
  while (Date.now() < deadline) {
    lastBuf = await readXtermBuffer(electronApp, wcId).catch(() => null);
    if (lastBuf && (pattern.test(lastBuf.full) || pattern.test(lastBuf.screen))) {
      return { matched: true, full: lastBuf.full, screen: lastBuf.screen };
    }
    await sleep(200);
  }
  const tail = lastBuf?.screen ? lastBuf.screen.slice(-400) : '<no buffer>';
  throw new Error(
    `waitForXtermBuffer: pattern ${pattern} not found within ${timeout}ms. Last screen tail:\n${tail}`,
  );
}

/**
 * Send raw bytes to claude TUI via xterm's internal data path, bypassing
 * bracketed-paste wrapping. Caller appends '\r' for Enter / newline.
 */
export async function sendToClaudeTui(electronApp, wcId, text) {
  const ok = await executeJavaScriptOnWebview(
    electronApp,
    wcId,
    `(function(text){
      const t = window.term;
      if (!t || !t._core) return false;
      const cs = t._core._coreService || t._core.coreService;
      if (!cs || typeof cs.triggerDataEvent !== 'function') return false;
      // Focus first so claude's Ink TUI registers the input.
      try {
        const ta = document.querySelector('.xterm-helper-textarea');
        if (ta) ta.focus();
        if (typeof t.focus === 'function') t.focus();
      } catch (_) {}
      cs.triggerDataEvent(text, true);
      return true;
    })(${JSON.stringify(text)})`,
  );
  if (!ok) {
    throw new Error('sendToClaudeTui: window.term / triggerDataEvent unavailable in webview');
  }
}

/**
 * Read the last N non-empty lines from the xterm buffer. Useful for
 * assertions / debug dumps.
 */
export async function readXtermLines(electronApp, wcId, { lines = 30 } = {}) {
  const buf = await readXtermBuffer(electronApp, wcId);
  const all = buf.full.split('\n').map((l) => l.trimEnd());
  const nonEmpty = all.filter((l) => l.length > 0);
  return nonEmpty.slice(-lines);
}

// Internal: full + screen buffer dump. Not exported — prefer
// `waitForXtermBuffer` / `readXtermLines` for assertion ergonomics.
async function readXtermBuffer(electronApp, wcId) {
  return await executeJavaScriptOnWebview(
    electronApp,
    wcId,
    `(function(){
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
    })()`,
  );
}

// ============================================================================
// Tempdir isolation
// ============================================================================

// Files we copy from ~/.claude/ into the isolated tempdir. These hold the
// auth/proxy/permission config the claude binary needs to authenticate.
// We INTENTIONALLY skip:
//   projects/, sessions/, history.jsonl, file-history/, tasks/, plans/,
//   teams/, ide/, paste-cache/, shell-snapshots/, session-env/, backups/,
//   cache/, plugins/, scheduled_tasks.lock
// — these are the user's chat history / local state. Probes write fresh
// JSONLs into the isolated dir.
const AUTH_FILES_TO_COPY = [
  'settings.json',
  'settings.local.json',
  'config.json',
  '.claude.json', // some claude builds put account state here
];

const cleanupRegistry = new Set();
let cleanupHooksInstalled = false;

function installCleanupHooks() {
  if (cleanupHooksInstalled) return;
  cleanupHooksInstalled = true;
  const runAll = () => {
    for (const fn of cleanupRegistry) {
      try { fn(); } catch (_) { /* ignore */ }
    }
    cleanupRegistry.clear();
  };
  process.on('exit', runAll);
  process.on('SIGINT', () => { runAll(); process.exit(130); });
  process.on('SIGTERM', () => { runAll(); process.exit(143); });
  process.on('uncaughtException', (err) => {
    runAll();
    // Re-throw so the original error still surfaces.
    throw err;
  });
}

/**
 * Create an isolated ~/.claude clone for this probe run. Copies ONLY
 * auth/proxy/permission config (settings.json + friends) — NOT projects/
 * or sessions/. Returns { tempDir, cleanup }.
 *
 * Cleanup is registered to fire on process exit (incl. SIGINT/SIGTERM)
 * unless `keep: true`.
 */
export async function createIsolatedClaudeDir({ keep = false } = {}) {
  const realClaudeDir = path.join(homedir(), '.claude');
  const tempBase = mkdtempSync(path.join(tmpdir(), 'ccsm-probe-claude-'));
  // The directory itself IS the new CLAUDE_CONFIG_DIR; no nested .claude.
  // (Caller passes tempBase as both CLAUDE_CONFIG_DIR and CCSM_CLAUDE_CONFIG_DIR.)
  for (const name of AUTH_FILES_TO_COPY) {
    const src = path.join(realClaudeDir, name);
    if (!existsSync(src)) continue;
    try {
      const st = statSync(src);
      if (!st.isFile()) continue;
      cpSync(src, path.join(tempBase, name));
    } catch (_) {
      // Best-effort. A missing settings.json is OK if user has no proxy
      // config and uses raw ANTHROPIC_API_KEY env var instead.
    }
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupRegistry.delete(cleanup);
    if (keep) return;
    try { rmSync(tempBase, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  };

  installCleanupHooks();
  cleanupRegistry.add(cleanup);

  return { tempDir: tempBase, cleanup };
}

// ============================================================================
// Electron launch
// ============================================================================

/**
 * Launch ccsm with the prod bundle pointed at an isolated claude config dir.
 * Sets CCSM_PROD_BUNDLE=1 + the full quartet of config-dir env vars (HOME,
 * USERPROFILE, CLAUDE_CONFIG_DIR, CCSM_CLAUDE_CONFIG_DIR).
 *
 * Returns { electronApp, win, userDataDir } from playwright. `userDataDir`
 * is registered for cleanup alongside the tempDir.
 *
 * Throws a clear error if `dist/renderer/index.html` doesn't exist (caller
 * forgot to run `npm run build`).
 */
export async function launchCcsmIsolated({ tempDir, env = {} } = {}) {
  if (!tempDir) throw new Error('launchCcsmIsolated: tempDir is required');
  const cwd = process.cwd();
  const distIndex = path.join(cwd, 'dist', 'renderer', 'index.html');
  if (!existsSync(distIndex)) {
    throw new Error(
      `launchCcsmIsolated: prod bundle missing at ${distIndex}. Run \`npm run build\` first.`,
    );
  }

  // Per-launch electron user-data-dir, isolated from the user's real one.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'ccsm-probe-userdata-'));
  let cleaned = false;
  const cleanupUd = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupRegistry.delete(cleanupUd);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  };
  installCleanupHooks();
  cleanupRegistry.add(cleanupUd);

  const electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd,
    env: {
      ...process.env,
      ELECTRON_DISABLE_GPU: '1',
      NODE_ENV: 'production',
      CCSM_PROD_BUNDLE: '1',
      // Main reads CCSM_CLAUDE_CONFIG_DIR; renderer's commands-loader reads
      // bare CLAUDE_CONFIG_DIR; claude binary reads CLAUDE_CONFIG_DIR;
      // ccsm.userHome is derived from HOME / USERPROFILE. Set them all.
      CCSM_CLAUDE_CONFIG_DIR: tempDir,
      CLAUDE_CONFIG_DIR: tempDir,
      HOME: tempDir,
      USERPROFILE: tempDir,
      ...env,
    },
    timeout: 60000,
  });
  const win = await electronApp.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // Renderer needs a beat to mount App + populate window.__ccsmStore.
  await sleep(2500);
  return { electronApp, win, userDataDir, cleanup: cleanupUd };
}

// ============================================================================
// Renderer state seeding
// ============================================================================

/**
 * Seed a session into the renderer's zustand store via window.__ccsmStore.
 *
 * Calls `createSession({ name, cwd, groupId })` which generates a fresh UUID
 * and sets it as activeId. Returns { sid }.
 *
 * If `sid` is provided, the existing store-generated id is replaced with the
 * caller's id by patching the session record post-create. (Useful when the
 * probe needs a deterministic session id, e.g. to assert against on-disk
 * JSONL filenames.)
 */
export async function seedSession(win, { sid, name = 'probe-session', cwd, groupId = 'g1' } = {}) {
  if (!cwd) throw new Error('seedSession: cwd is required');
  const result = await win.evaluate(
    ({ name, cwd, groupId, sid }) => {
      const w = window;
      const useStore = w.__ccsmStore;
      if (!useStore) throw new Error('window.__ccsmStore not ready');
      const { createSession } = useStore.getState();
      createSession({ name, cwd, groupId });
      let activeId = useStore.getState().activeId;
      if (sid && activeId && activeId !== sid) {
        // Rename the just-created session's id to the caller-provided sid.
        useStore.setState((s) => ({
          sessions: s.sessions.map((x) => (x.id === activeId ? { ...x, id: sid } : x)),
          activeId: sid,
        }));
        activeId = sid;
      }
      return { sid: activeId };
    },
    { name, cwd, groupId, sid },
  );
  return result;
}

/**
 * Wait for TtydPane <webview> to mount for the given session. Returns the
 * webview WebContents id (caller can immediately drive the buffer).
 *
 * Polls for both:
 *   1. host-page <webview title="ttyd session <sid>"> element present
 *   2. webContents.fromId for that webview is reachable AND xterm + window.term
 *      have initialized inside the OOPIF.
 */
export async function waitForWebviewMounted(win, electronApp, sessionId, { timeout = 10000 } = {}) {
  // Step 1: wait for the host-page <webview> tag for THIS session.
  const selector = `webview[title="ttyd session ${sessionId}"]`;
  await win.waitForSelector(selector, { timeout });

  // Step 2: poll for the matching WebContents in main process.
  const deadline = Date.now() + timeout;
  let wcId = null;
  while (Date.now() < deadline) {
    try {
      wcId = await getTtydWebContentsId(electronApp, { timeout: 1000 });
      if (wcId != null) break;
    } catch (_) {
      // Keep polling.
    }
    await sleep(200);
  }
  if (wcId == null) {
    throw new Error(`waitForWebviewMounted: no ttyd webContents found for session ${sessionId} within ${timeout}ms`);
  }

  // Step 3: wait for xterm + window.term inside the OOPIF.
  const xtermDeadline = Date.now() + timeout;
  while (Date.now() < xtermDeadline) {
    const ready = await executeJavaScriptOnWebview(
      electronApp,
      wcId,
      `(function(){
        return !!document.querySelector('.xterm') &&
               !!document.querySelector('.xterm-helper-textarea') &&
               typeof window.term !== 'undefined' &&
               !!window.term && !!window.term.buffer;
      })()`,
    ).catch(() => false);
    if (ready) return wcId;
    await sleep(300);
  }
  throw new Error(
    `waitForWebviewMounted: webview mounted (wcId=${wcId}) but xterm/window.term not ready within ${timeout}ms`,
  );
}

// ============================================================================
// Internal
// ============================================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
