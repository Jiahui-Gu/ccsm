// Shared helpers for real-claude e2e probes.
//
// Goal: factor the working real-CLI driving patterns (in-renderer xterm.js
// buffer reads, raw `triggerDataEvent` keystroke injection, prod-bundle
// launch with isolated config) into a single reusable module so the
// downstream probes share one canonical implementation.
//
// This module is helpers ONLY. No assertions, no test logic, no top-level
// `console.log` chatter beyond what callers explicitly opt into.
//
// Critical correctness points (do not regress):
//
//   1. xterm renders to canvas — `document.body.innerText` is empty. The only
//      reliable buffer read is `term.buffer.active.getLine(N).translateToString()`
//      via the xterm Terminal instance the renderer exposes as
//      `window.__ccsmTerm`.
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
//      AND process.on('SIGINT') / SIGTERM / uncaughtException /
//      unhandledRejection. Cleanups run LIFO so process force-kill
//      (electron + claude subtree, registered in launchCcsmIsolated)
//      runs BEFORE tempdir rmSync — Windows can't remove a directory whose
//      files are still locked by live processes.
//
//   7. Direct-xterm architecture (post-PR-1..PR-6): the renderer hosts a
//      single xterm.js Terminal in the host window (NOT inside an OOPIF
//      <webview>). It is exposed as `window.__ccsmTerm`, bound to the host
//      DIV with `[data-terminal-host][data-active-sid="<sid>"]`. The pty
//      is owned by the main process; renderer drives it via
//      `window.ccsmPty.{list, attach, detach, input, resize, kill, spawn,
//      onData, onExit}` and clipboard via `window.ccsmPty.clipboard.{readText,
//      writeText}`. There is no ttyd HTTP server, no port allocation, no
//      OOPIF, no webview <tag>. All probe driving happens via
//      `win.evaluate(() => window.__ccsmTerm....)`.

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
import { spawnSync } from 'node:child_process';

// ============================================================================
// Direct-xterm helpers
// ============================================================================

/**
 * Wait for the in-renderer xterm Terminal to be mounted and active for the
 * given session id. Polls for both:
 *   1. host DIV `[data-terminal-host][data-active-sid="<sid>"]` exists
 *   2. `window.__ccsmTerm` is non-null (Terminal singleton constructed)
 *
 * Throws on timeout.
 */
export async function waitForTerminalReady(win, sid, { timeout = 10000 } = {}) {
  if (!sid) throw new Error('waitForTerminalReady: sid is required');
  const deadline = Date.now() + timeout;
  let lastSeen = null;
  while (Date.now() < deadline) {
    const ready = await win
      .evaluate(
        (s) => {
          const host = document.querySelector(
            `[data-terminal-host][data-active-sid="${s}"]`,
          );
          const term = window.__ccsmTerm;
          return {
            host: !!host,
            term: !!term,
            buffer: !!(term && term.buffer && term.buffer.active),
          };
        },
        sid,
      )
      .catch((err) => ({ host: false, term: false, buffer: false, err: String(err) }));
    lastSeen = ready;
    if (ready.host && ready.term && ready.buffer) return true;
    await sleep(200);
  }
  throw new Error(
    `waitForTerminalReady: terminal not ready for sid=${sid} within ${timeout}ms (last: ${JSON.stringify(lastSeen)})`,
  );
}

/**
 * Read the last N lines from the active xterm buffer, anchored at the
 * cursor row. Returns an array of strings (one per row, top-to-bottom).
 * Empty rows are preserved so callers can see the cursor row context.
 *
 * If `window.__ccsmTerm` is unavailable, the inner evaluate resolves to []
 * (safe for polling loops).
 *
 * Error semantics (single source of truth — see #579):
 * - Transient evaluate failures (page closed / context destroyed / target
 *   closed mid-navigation) are absorbed and resolve to []. Polling loops
 *   can keep polling.
 * - Anything else (real driver / bridge / unexpected exception) is
 *   re-thrown with a wrapped message + original stack so callers see the
 *   actual root cause instead of a generic "buffer empty" assertion.
 *   This was the #569 / #574 flake's actual root cause: the inner site
 *   silently returned [] and the assertion blamed the wrong layer.
 */
export async function readXtermLines(win, { lines = 30 } = {}) {
  const out = await win
    .evaluate(
      ({ n }) => {
        const term = window.__ccsmTerm;
        if (!term || !term.buffer || !term.buffer.active) return [];
        const buf = term.buffer.active;
        const cursorRow = buf.baseY + buf.cursorY;
        const start = Math.max(0, cursorRow - n);
        const out = [];
        for (let i = start; i <= cursorRow; i++) {
          const line = buf.getLine(i);
          out.push(line ? line.translateToString(true) : '');
        }
        return out;
      },
      { n: lines },
    )
    .catch((err) => {
      // Page closed / context destroyed / evaluate timeout = transient,
      // polling-friendly. Match Playwright/Electron driver phrasings.
      if (/Target closed|Execution context|page has been closed|context.*was destroyed/i.test(String(err))) return [];
      // Anything else is unexpected — surface real error with context.
      throw new Error(`readXtermLines.evaluate failed: ${err?.stack || err?.message || err}`);
    });
  return out;
}

/**
 * Send raw bytes to claude TUI via xterm's internal data path, bypassing
 * bracketed-paste wrapping. Caller appends '\r' for Enter / newline.
 *
 * Throws if `window.__ccsmTerm` / triggerDataEvent unavailable.
 */
export async function sendToClaudeTui(win, text) {
  const ok = await win
    .evaluate(
      (t) => {
        const term = window.__ccsmTerm;
        if (!term || !term._core) return false;
        const cs = term._core._coreService || term._core.coreService;
        if (!cs || typeof cs.triggerDataEvent !== 'function') return false;
        // Focus first so claude's Ink TUI registers the input.
        try {
          const ta = document.querySelector('.xterm-helper-textarea');
          if (ta) ta.focus();
          if (typeof term.focus === 'function') term.focus();
        } catch (_) { /* ignore */ }
        cs.triggerDataEvent(t, true);
        return true;
      },
      text,
    )
    .catch(() => false);
  if (!ok) {
    throw new Error('sendToClaudeTui: window.__ccsmTerm / triggerDataEvent unavailable');
  }
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
export async function waitForXtermBuffer(win, pattern, { timeout = 15000 } = {}) {
  if (!(pattern instanceof RegExp)) {
    throw new TypeError('waitForXtermBuffer: pattern must be a RegExp');
  }
  const deadline = Date.now() + timeout;
  let lastBuf = null;
  while (Date.now() < deadline) {
    lastBuf = await readXtermBuffer(win).catch(() => null);
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

// Internal: full + screen buffer dump.
async function readXtermBuffer(win) {
  return await win.evaluate(() => {
    const term = window.__ccsmTerm;
    if (!term || !term.buffer || !term.buffer.active) {
      return { full: '', screen: '' };
    }
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
    return { full: fullLines.join('\n'), screen: screenLines.join('\n') };
  });
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
    // Iterate in reverse insertion order (LIFO) so process-kill cleanups
    // registered after tempdir cleanups run FIRST. Order matters on
    // Windows: rmSync on a tempdir fails if electron / claude still
    // hold file locks inside it.
    const fns = Array.from(cleanupRegistry).reverse();
    for (const fn of fns) {
      try { fn(); } catch (_) { /* ignore */ }
    }
    cleanupRegistry.clear();
  };
  process.on('exit', runAll);
  process.on('SIGINT', () => { runAll(); process.exit(130); });
  process.on('SIGTERM', () => { runAll(); process.exit(143); });
  process.on('uncaughtException', (err) => {
    // #560 — if cleanup itself throws, preserve the ORIGINAL error.
    // Without try/catch the cleanup throw would replace `err` and we'd
    // lose the actual crash signal that the user needs to debug.
    try { runAll(); } catch (cleanupErr) {
      try { console.error('[probe-utils] cleanup threw during uncaughtException:', cleanupErr); } catch (_) { /* ignore */ }
    }
    // Re-throw so the original error still surfaces.
    throw err;
  });
  process.on('unhandledRejection', (err) => {
    // Async electron crashes surface here; without this the tempdir leaks.
    try { runAll(); } catch (cleanupErr) {
      try { console.error('[probe-utils] cleanup threw during unhandledRejection:', cleanupErr); } catch (_) { /* ignore */ }
    }
    // Surface the rejection — let Node's default handler exit non-zero.
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
 * Returns { electronApp, win, userDataDir } from playwright.
 *
 * `userDataDir` behaviour:
 *   - If caller passes `userDataDir`: helper uses it verbatim and does NOT
 *     register it for cleanup (caller owns it). This is the cross-restart
 *     pattern used by reopen/import probes that need ccsm.db to persist
 *     between two `launchCcsmIsolated` calls on the same dir.
 *   - If omitted: helper mints a fresh tempdir and registers it for cleanup.
 *
 * Throws a clear error if `dist/renderer/index.html` doesn't exist (caller
 * forgot to run `npm run build`).
 */
export async function launchCcsmIsolated({ tempDir, userDataDir, env = {} } = {}) {
  if (!tempDir) throw new Error('launchCcsmIsolated: tempDir is required');
  const cwd = process.cwd();
  const distIndex = path.join(cwd, 'dist', 'renderer', 'index.html');
  if (!existsSync(distIndex)) {
    throw new Error(
      `launchCcsmIsolated: prod bundle missing at ${distIndex}. Run \`npm run build\` first.`,
    );
  }

  // Per-launch electron user-data-dir, isolated from the user's real one.
  // If caller supplied one, they own its lifecycle (cross-restart pattern).
  const callerOwnsUserData = typeof userDataDir === 'string' && userDataDir.length > 0;
  const effectiveUserDataDir = callerOwnsUserData
    ? userDataDir
    : mkdtempSync(path.join(tmpdir(), 'ccsm-probe-userdata-'));

  let cleaned = false;
  const cleanupUd = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupRegistry.delete(cleanupUd);
    try { rmSync(effectiveUserDataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  };
  if (!callerOwnsUserData) {
    installCleanupHooks();
    cleanupRegistry.add(cleanupUd);
  }

  const electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${effectiveUserDataDir}`],
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

  // Force-kill cleanup. Registered AFTER tempdir/userdata cleanups so that
  // LIFO iteration in `runAll` runs this FIRST — electron + claude die
  // before rmSync touches the dirs (Windows fails to remove locked files
  // otherwise). User reported leaked processes after probe runs because
  // the previous cleanup only rm-ed tempdirs and never killed the process tree.
  const electronPid = electronApp.process()?.pid ?? null;
  const killCleanup = () => {
    cleanupRegistry.delete(killCleanup);
    // Best-effort async close so playwright tears down its IPC pipes.
    // Fire-and-forget — the synchronous taskkill below is what guarantees
    // death even from inside a sync `exit` handler.
    try { electronApp.close(); } catch (_) { /* ignore */ }
    if (electronPid) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/T', '/F', '/PID', String(electronPid)]);
        } else {
          // SIGKILL the whole process group; falls back to plain pid kill
          // if the process wasn't started as group leader.
          try { process.kill(-electronPid, 'SIGKILL'); } catch (_) {
            try { process.kill(electronPid, 'SIGKILL'); } catch (_) { /* ignore */ }
          }
        }
      } catch (_) { /* ignore */ }
    }
  };
  installCleanupHooks();
  cleanupRegistry.add(killCleanup);

  const win = await electronApp.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // Renderer needs a beat to mount App + populate window.__ccsmStore.
  await sleep(2500);
  return {
    electronApp,
    win,
    userDataDir: effectiveUserDataDir,
    cleanup: callerOwnsUserData ? () => {} : cleanupUd,
  };
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
 * Dismiss claude's "Welcome back!" / "Try /help" splash card that intercepts
 * the first keystrokes after a cold start. Sends Enter (via triggerDataEvent,
 * NOT bracketed-paste) up to `maxAttempts` times until either:
 *   - the splash text disappears from the visible buffer, OR
 *   - the input prompt indicator (`│ >`) becomes visible (indicates input
 *     box is interactive)
 *
 * Returns { dismissed: boolean, attempts: number, finalScreen: string }.
 * Never throws — splash absence is the happy path. Callers can inspect the
 * result if they want to assert the splash was actually present.
 *
 * Probes #505 (new-session-chat) and #506 (switch-session-keeps-chat)
 * regressed because their first prompt keystrokes hit the splash card,
 * not the input field — claude never received the user message.
 */
export async function dismissWelcomeSplash(
  win,
  { maxAttempts = 3, settleMs = 500 } = {},
) {
  // Heuristics for "splash is present":
  //   - "Welcome back" greeting line
  //   - "Try /" or "/help" hint card
  //   - "press Enter" / "Press Enter" prompt to dismiss
  // Heuristics for "input ready" (definitely past splash):
  //   - "│ >" or "> " followed by cursor (claude TUI input row)
  const splashRe = /Welcome back|Try \/|press Enter|Press Enter/;
  const readyRe = /│\s*>|^\s*>\s*$/m;

  let attempts = 0;
  let finalScreen = '';
  for (let i = 0; i < maxAttempts; i++) {
    const buf = await readXtermBufferSafe(win);
    finalScreen = buf.screen;
    const hasSplash = splashRe.test(buf.screen);
    const hasReady = readyRe.test(buf.screen);
    if (!hasSplash && hasReady) {
      return { dismissed: i > 0, attempts, finalScreen };
    }
    if (!hasSplash && i > 0) {
      // Splash gone, no explicit ready marker — accept.
      return { dismissed: true, attempts, finalScreen };
    }
    // Send a bare Enter via triggerDataEvent (no bracketed-paste).
    try {
      await sendToClaudeTui(win, '\r');
      attempts++;
    } catch (_) {
      // term not reachable — bail without throwing.
      return { dismissed: false, attempts, finalScreen };
    }
    await sleep(settleMs);
  }
  // Final read so caller sees the post-attempt state.
  const buf = await readXtermBufferSafe(win);
  finalScreen = buf.screen;
  const stillSplash = splashRe.test(buf.screen);
  return { dismissed: !stillSplash, attempts, finalScreen };
}

/**
 * Dismiss claude's first-run modals (trust dialog + welcome / theme splashes)
 * that intercept keystrokes after a cold start. Without this, the probe's
 * first `\r` / prompt would be eaten by the trust modal and never reach
 * the shell.
 *
 * Behavior is the union of the patterns the harness probes evolved
 * independently:
 *   - Phase 1 (trust loop): up to `maxIters` iterations. Read the buffer;
 *     if the input prompt (`│ >` or leading `> `) is visible, we're done.
 *     If a trust prompt is visible, send `1\r` to accept. Otherwise send
 *     a bare `\r` to advance any other intermediate splash.
 *   - Phase 2 (welcome splash): delegate to `dismissWelcomeSplash` for
 *     the "Welcome back" / "Try /" hint card that some claude versions
 *     show after trust.
 *   - Phase 3 (final settle): a few more bare-Enter retries in case a
 *     theme picker or version hint is still visible after the welcome
 *     card was dismissed.
 *
 * Returns once the input prompt regex matches, or after the iteration
 * budget is exhausted. Never throws — caller can verify ready state via
 * the next `readXtermLines` / `waitForXtermBuffer` call.
 */
export async function dismissFirstRunModals(win, opts = {}) {
  const {
    maxIters = 12,
    intervalMs = 250,
  } = opts;

  const trustRe = /trust the files|trust this folder|Do you trust|trust|do you trust|1\.\s*Yes|Yes, proceed/i;
  const promptRe = /│\s*>|^\s*>\s/m;

  // Phase 1: trust + generic splash advance.
  for (let i = 0; i < maxIters; i++) {
    const lines = await readXtermLines(win, { lines: 30 }).catch(() => []);
    const screen = lines.join('\n');
    if (promptRe.test(screen)) return;
    if (trustRe.test(screen)) {
      await sendToClaudeTui(win, '1\r').catch(() => {});
    } else {
      await sendToClaudeTui(win, '\r').catch(() => {});
    }
    await sleep(Math.max(intervalMs, 600));
  }

  // Phase 2: welcome / hint card.
  await dismissWelcomeSplash(win, { maxAttempts: 5, settleMs: 600 }).catch(() => {});

  // Phase 3: final settle.
  for (let i = 0; i < 4; i++) {
    const lines = await readXtermLines(win, { lines: 12 }).catch(() => []);
    const screen = lines.join('\n');
    if (promptRe.test(screen)) return;
    await sendToClaudeTui(win, '\r').catch(() => {});
    await sleep(Math.max(intervalMs, 600));
  }
}

async function readXtermBufferSafe(win) {
  try {
    return await readXtermBuffer(win);
  } catch (_) {
    return { full: '', screen: '' };
  }
}

// ============================================================================
// Internal
// ============================================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
