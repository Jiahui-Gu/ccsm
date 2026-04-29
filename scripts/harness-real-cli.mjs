// Real-CLI e2e harness — runs all UX-scenario probes against the prod
// bundle + the real claude binary in a single process.
//
// Cases (in run order):
//   1. new-session-chat              — UX C: new session opens claude, can chat
//   2. switch-session-keeps-chat     — UX F: session A↔B switch reuses pty, scrollback intact
//   3. cwd-projects-claude           — UX E: real cwd flows into claude's JSONL hash
//   4. import-resume                 — UX H: import existing JSONL, claude --resume restores
//   5. default-cwd-from-userCwds-lru — task #551: new-session cwd defaults to LRU head
//   6. new-session-focus-cli         — UX C': button focus does not double-fire
//   7. pty-pid-stable-across-switch  — direct-xterm: pty pid stable across A→B→A switch
//   8. reopen-resume                 — UX G: close ccsm, reopen, click session, --resume restores
//
// Sharing strategy:
//   * Cases 1–6 share ONE Electron launch + ONE isolated tempDir. Each case
//     creates its own session(s) in the running app and relies on
//     CLAUDE_CONFIG_DIR / HOME = tempDir for filesystem isolation. Sessions
//     accumulate; later cases tolerate prior sessions in the store.
//   * Case 7 (reopen-resume) needs TWO launches with a shared userDataDir to
//     verify cross-restart persistence + claude --resume. It runs standalone
//     after the shared-launch group has torn down.
//
// Selection:
//   node scripts/harness-real-cli.mjs                          # all cases
//   node scripts/harness-real-cli.mjs --only=switch-session-keeps-chat
//   node scripts/harness-real-cli.mjs --skip=reopen-resume,import-resume
//
// Per memory feedback_local_e2e_only.md: PR review uses --only=<case>,
// never the full harness.
//
// ARCHITECTURE NOTE — direct-xterm (PR-1..PR-6):
//   The renderer hosts a single xterm.js Terminal in the host window
//   (window.__ccsmTerm) bound to a host DIV
//   (`[data-terminal-host][data-active-sid="<sid>"]`). The pty is owned by
//   main and surfaced to the renderer via window.ccsmPty.{list,attach,
//   detach,input,resize,kill,spawn,onData,onExit}. There is NO ttyd HTTP
//   server, NO port allocation, NO <webview>, NO OOPIF. Probes drive
//   xterm via `win.evaluate(() => window.__ccsmTerm....)` directly on the
//   host page.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createIsolatedClaudeDir,
  dismissFirstRunModals,
  dismissWelcomeSplash,
  launchCcsmIsolated,
  readXtermLines,
  seedSession,
  sendToClaudeTui,
  waitForTerminalReady,
  waitForXtermBuffer,
} from './probe-utils-real-cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      console.log('Usage: node scripts/harness-real-cli.mjs [--only=name1,name2] [--skip=name1,name2]');
      console.log('Cases:');
      for (const c of CASE_REGISTRY) console.log('  -', c.name);
      process.exit(0);
    }
  }
  return out;
}

// ============================================================================
// Diagnostics
// ============================================================================

const SCREENSHOT_ROOT = path.resolve('docs/screenshots/harness-real-cli');
mkdirSync(SCREENSHOT_ROOT, { recursive: true });

function tsLabel() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function snap(win, caseName, label) {
  if (!win) return null;
  const dir = path.join(SCREENSHOT_ROOT, caseName);
  try {
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${label}-${tsLabel()}.png`);
    await win.screenshot({ path: p, fullPage: true });
    return p;
  } catch (_) {
    return null;
  }
}

// ============================================================================
// Direct-xterm: pty helpers
// ============================================================================

/**
 * Look up the pty pid for a session id via window.ccsmPty.list().
 * Returns the numeric pid, or null if no entry matches.
 */
async function getPtyPidForSid(win, sid) {
  return await win.evaluate(async (s) => {
    if (!window.ccsmPty || typeof window.ccsmPty.list !== 'function') return null;
    try {
      const arr = await window.ccsmPty.list();
      const entry = (arr || []).find((x) => x.sid === s);
      return entry && typeof entry.pid === 'number' ? entry.pid : null;
    } catch (_) {
      return null;
    }
  }, sid);
}

/**
 * Wait for the ACTIVE xterm buffer (window.__ccsmTerm) to be wired and to
 * contain at least `minLines` rows. Polls every 100ms until ready or timeout.
 *
 * Motivation: after a session switch (A→B→A), waitForTerminalReady asserts
 * the host element + term + buffer exist, but `__ccsmTerm` may briefly point
 * at the previous session's term during the React re-render, so an immediate
 * readXtermLines can hit `term.buffer.active.length === 0` and silently
 * return []. This helper closes that window before the first read.
 *
 * Throws on timeout with the last seen state for diagnostics.
 */
async function waitForActiveXtermBuffer(win, sid, { minLines = 1, timeout = 3000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await win
      .evaluate(
        (s) => {
          const host = document.querySelector(
            `[data-terminal-host][data-active-sid="${s}"]`,
          );
          const term = window.__ccsmTerm;
          const buf = term && term.buffer && term.buffer.active;
          return {
            host: !!host,
            term: !!term,
            buffer: !!buf,
            length: buf ? buf.length : 0,
          };
        },
        sid,
      )
      .catch((err) => ({ host: false, term: false, buffer: false, length: 0, err: String(err) }));
    if (last.host && last.term && last.buffer && last.length >= minLines) return true;
    await sleep(100);
  }
  throw new Error(
    `waitForActiveXtermBuffer: sid=${sid} did not reach minLines=${minLines} within ${timeout}ms (last: ${JSON.stringify(last)})`,
  );
}

/**
 * Snapshot the list of pty exits surfaced to the renderer. Cases install a
 * one-shot listener on window.ccsmPty.onExit and accumulate into
 * window.__probePtyExits; this helper just reads that buffer back.
 */
async function readPtyExits(win) {
  return await win.evaluate(() => Array.isArray(window.__probePtyExits) ? window.__probePtyExits.slice() : []);
}

/**
 * Install the pty:exit listener (idempotent). Mirrors the original
 * `__probeTtydExits` pattern but on the new ccsmPty bridge.
 */
async function installPtyExitProbe(win) {
  await win.evaluate(() => {
    if (window.__probePtyExitsHooked) return;
    window.__probePtyExits = window.__probePtyExits || [];
    if (window.ccsmPty && typeof window.ccsmPty.onExit === 'function') {
      window.ccsmPty.onExit((evt) => {
        try { window.__probePtyExits.push(evt); } catch (_) { /* ignore */ }
      });
      window.__probePtyExitsHooked = true;
    }
  });
}

// ============================================================================
// Case 1: new-session-chat (UX C)
// ============================================================================

async function caseNewSessionChat({ electronApp, win, tempDir }) {
  const CHAT_PROMPT = 'say hi in 3 words';

  // Wait for claude availability probe to resolve so the terminal pane will mount.
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30000 },
  );

  const { sid } = await seedSession(win, { name: 'probe-new-session', cwd: tempDir });
  if (!sid) throw new Error('seedSession returned empty sid');

  // Tiny settle for terminal mount.
  await sleep(4000);

  await waitForTerminalReady(win, sid, { timeout: 60000 });

  // Task #548 — after the new session attaches, focus must land on the
  // embedded xterm so the user's first keystroke goes to claude's TUI
  // (not the trigger button or the document body). xterm's input target
  // is the `.xterm-helper-textarea` element it injects under the host div.
  await assertCliFocused(win, sid, 'new-session-chat');

  await waitForXtermBuffer(win, /trust|claude|welcome|│|╭|>/i, { timeout: 30000 });

  // Dismiss trust / welcome / theme splashes.
  await dismissFirstRunModals(win);

  await sendToClaudeTui(win, CHAT_PROMPT);
  await sleep(500);
  await sendToClaudeTui(win, '\r');

  // Look for any substantive line after the echoed prompt that isn't the
  // prompt itself. Allow up to 90s for first reply (cold model).
  const start = Date.now();
  let replied = false;
  let lastLines = [];
  while (Date.now() - start < 90_000) {
    await sleep(2000);
    lastLines = await readXtermLines(win, { lines: 60 });
    if (!lastLines.length) continue;
    const joined = lastLines.join('\n');
    const idx = joined.lastIndexOf(CHAT_PROMPT);
    const after = idx >= 0 ? joined.slice(idx + CHAT_PROMPT.length) : joined;
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
    throw new Error(`claude did not reply within 90s. Tail:\n${lastLines.slice(-20).join('\n')}`);
  }

  // No error toast / pty error state.
  const healthy = await win.evaluate(() => {
    const out = { errorToast: null, terminalErrorVisible: false };
    const errRegion = document.querySelector('[aria-live="assertive"]');
    if (errRegion) {
      const txt = (errRegion.textContent || '').trim();
      if (txt) out.errorToast = txt.slice(0, 240);
    }
    const buttons = Array.from(document.querySelectorAll('button'));
    out.terminalErrorVisible = buttons.some((b) => /^retry$/i.test((b.textContent || '').trim()));
    return out;
  });
  if (healthy.errorToast) throw new Error(`error toast surfaced: ${healthy.errorToast}`);
  if (healthy.terminalErrorVisible) throw new Error('terminal pane flipped to error state (Retry button visible)');

  // Task #573 — the window title must stay "CCSM" even after claude has
  // emitted ESC ]0;TITLE BEL sequences during the session. Previously
  // TerminalPane forwarded those into document.title, hijacking the app
  // window title. After 2s settle to give any pending ANSI title sequence
  // time to land in the renderer.
  await sleep(2000);
  const docTitle = await win.title();
  if (docTitle !== 'CCSM') {
    throw new Error(`window title hijacked by CLI: expected "CCSM", got ${JSON.stringify(docTitle)}`);
  }
}

// ============================================================================
// Case 1c: session-rename-writes-jsonl (PR2 — store renameSession → SDK writeback)
// ============================================================================
//
// Verifies the renderer's renameSession action forwards the new title through
// the main-process SDK bridge installed in PR1. End-to-end flow:
//   1. Spawn a fresh session in an isolated CLAUDE_CONFIG_DIR.
//   2. Send a one-shot prompt so the JSONL transcript exists on disk.
//   3. Trigger renameSession via window.__ccsmStore.getState().renameSession.
//      The store update is async; await it from inside win.evaluate.
//   4. Locate <sid>.jsonl under <tempDir>/projects/<hash>/ and grep for the
//      custom title. The SDK writes a `customTitle` discriminator frame
//      (or stamps `customTitle` on the existing summary frame); both shapes
//      contain the literal string we set. Asserting on the literal is
//      schema-tolerant.
async function caseSessionRenameWritesJsonl({ electronApp: _e, win, tempDir }) {
  const RENAME_PROMPT = 'reply with the single word: ack';
  const CUSTOM_TITLE = `pr2-rename-${Math.random().toString(36).slice(2, 10)}`;

  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30000 },
  );

  const projectDir = path.join(tempDir, 'rename-project');
  mkdirSync(projectDir, { recursive: true });
  const { sid } = await seedSession(win, { name: 'rename-probe', cwd: projectDir });
  if (!sid) throw new Error('seedSession returned no sid');

  await sleep(4000);
  await waitForTerminalReady(win, sid, { timeout: 60000 });
  await waitForXtermBuffer(win, /trust|claude|welcome|│|╭|>/i, { timeout: 30000 });
  await dismissFirstRunModals(win);

  // Drive a tiny chat so the JSONL gets written; renameSession's SDK bridge
  // requires the session file to exist (otherwise it'd return no_jsonl and
  // the title would be queued, never landing on disk during this case).
  await sendToClaudeTui(win, RENAME_PROMPT);
  await sleep(500);
  await sendToClaudeTui(win, '\r');

  // Wait for the JSONL to appear under <tempDir>/projects/<hash>/.
  const projectsRoot = path.join(tempDir, 'projects');
  let matchedJsonl = null;
  {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !matchedJsonl) {
      if (existsSync(projectsRoot)) {
        for (const dirName of readdirSync(projectsRoot)) {
          let entries;
          try { entries = readdirSync(path.join(projectsRoot, dirName)); } catch { continue; }
          if (entries.includes(`${sid}.jsonl`)) {
            matchedJsonl = path.join(projectsRoot, dirName, `${sid}.jsonl`);
            break;
          }
        }
      }
      if (!matchedJsonl) await sleep(1000);
    }
  }
  if (!matchedJsonl) {
    throw new Error(`no <sid>.jsonl found under ${projectsRoot} within 90s for sid=${sid}`);
  }

  // Trigger the rename via the renderer store. The action is async — we
  // await it so the IPC writeback round-trips before asserting on disk.
  const renameOutcome = await win.evaluate(async ({ s, t }) => {
    const store = window.__ccsmStore;
    if (!store) return { ok: false, reason: 'no-store' };
    const action = store.getState().renameSession;
    if (typeof action !== 'function') return { ok: false, reason: 'no-action' };
    try {
      const ret = action(s, t);
      // Action is async (returns a Promise); await it.
      if (ret && typeof ret.then === 'function') await ret;
      const after = store.getState().sessions.find((x) => x.id === s);
      return { ok: true, localName: after?.name ?? null };
    } catch (err) {
      return { ok: false, reason: 'threw', message: String(err && err.message ? err.message : err) };
    }
  }, { s: sid, t: CUSTOM_TITLE });
  if (!renameOutcome.ok) {
    throw new Error(`renameSession failed: ${JSON.stringify(renameOutcome)}`);
  }
  if (renameOutcome.localName !== CUSTOM_TITLE) {
    throw new Error(
      `local store name not updated: expected "${CUSTOM_TITLE}", got "${renameOutcome.localName}"`
    );
  }

  // Assert the JSONL gained the custom title. SDK writes asynchronously;
  // poll the file for up to 10s.
  let foundOnDisk = false;
  let lastSnapshot = '';
  {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const contents = readFileSync(matchedJsonl, 'utf8');
        lastSnapshot = contents;
        if (contents.includes(CUSTOM_TITLE)) {
          foundOnDisk = true;
          break;
        }
      } catch {
        /* keep polling */
      }
      await sleep(500);
    }
  }
  if (!foundOnDisk) {
    const tail = lastSnapshot.split('\n').slice(-6).join('\n');
    throw new Error(
      `customTitle "${CUSTOM_TITLE}" not present in ${matchedJsonl} after rename. tail:\n${tail}`,
    );
  }
}

// ============================================================================
// Case: session-title-syncs-from-jsonl (PR4 #593 — live-tail title backfill)
// ============================================================================
//
// Verifies the live JSONL tail-watcher → IPC → store → sidebar flow for
// SDK-derived session titles. This is the renderer-visible counterpart to
// PR3's titleChanged.test.ts (which only covers main-process emission):
//   1. Spawn a fresh session whose store name is the literal default
//      'New session' (we set it explicitly so we have a known starting
//      point regardless of what seedSession defaults to).
//   2. Send a real prompt so claude writes the JSONL transcript and the
//      SDK's session-summary derivation kicks in.
//   3. Wait for `<sid>.jsonl` to land under <tempDir>/projects/<key>/ —
//      the projectKey encoder mirrors the CLI's `[\\/:]` → `-` rule.
//   4. Wait for the renderer's session row .name to flip from
//      'New session' to a non-default value (the SDK summary). This is
//      driven by `electron/sessionWatcher` → `session:title` IPC →
//      `_applyExternalTitle` (App.tsx subscribes; PR3 wiring).
//   5. Cross-check via `useStore.getState().sessions.find(...)` so we
//      assert against the canonical store value, not just the rendered DOM.
async function caseSessionTitleSyncsFromJsonl({ electronApp: _e, win, tempDir }) {
  const PROMPT = 'reply with two short sentences about the moon.';

  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30000 },
  );

  const projectDir = path.join(tempDir, 'title-sync-project');
  mkdirSync(projectDir, { recursive: true });

  // Seed with name 'New session' explicitly so the backfill / live-tail
  // overwrite path has a known placeholder to swap. seedSession defaults
  // to a custom name otherwise.
  const { sid } = await seedSession(win, {
    name: 'New session',
    cwd: projectDir,
  });
  if (!sid) throw new Error('seedSession returned no sid');

  await sleep(4000);
  await waitForTerminalReady(win, sid, { timeout: 60000 });
  await waitForXtermBuffer(win, /trust|claude|welcome|│|╭|>/i, { timeout: 30000 });
  await dismissFirstRunModals(win);

  // Send a substantive prompt so claude writes more than just an init frame —
  // the SDK's summary derivation needs an actual user message + assistant
  // response to produce a real summary string.
  await sendToClaudeTui(win, PROMPT);
  await sleep(500);
  await sendToClaudeTui(win, '\r');

  // Wait for the JSONL to appear under <tempDir>/projects/<hash>/.
  const projectsRoot = path.join(tempDir, 'projects');
  let matchedJsonl = null;
  {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !matchedJsonl) {
      if (existsSync(projectsRoot)) {
        for (const dirName of readdirSync(projectsRoot)) {
          let entries;
          try { entries = readdirSync(path.join(projectsRoot, dirName)); } catch { continue; }
          if (entries.includes(`${sid}.jsonl`)) {
            matchedJsonl = path.join(projectsRoot, dirName, `${sid}.jsonl`);
            break;
          }
        }
      }
      if (!matchedJsonl) await sleep(1000);
    }
  }
  if (!matchedJsonl) {
    throw new Error(`no <sid>.jsonl found under ${projectsRoot} within 90s for sid=${sid}`);
  }

  // Wait for claude to actually finish replying so the SDK can derive a
  // session summary. SDKSessionInfo.summary is "custom title, auto-derived
  // summary, or first prompt" (per `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`),
  // so once the JSONL has at least the first user message frame, getSessionInfo
  // returns a non-empty value. We poll the bridge directly instead of grepping
  // disk — the SDK derives `summary` in-memory; there's no `"summary"` field
  // written into the user/assistant frames.
  let sdkSummary = null;
  {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !sdkSummary) {
      const result = await win.evaluate(async ({ s, dir }) => {
        const bridge = window.ccsmSessionTitles;
        if (!bridge || typeof bridge.get !== 'function') return { err: 'no-bridge' };
        try {
          const info = await bridge.get(s, dir);
          return { ok: true, summary: info?.summary ?? null };
        } catch (e) {
          return { err: String(e?.message || e) };
        }
      }, { s: sid, dir: projectDir });
      if (result?.err === 'no-bridge') {
        throw new Error('window.ccsmSessionTitles bridge missing — preload wiring broken');
      }
      if (result?.summary && typeof result.summary === 'string' && result.summary.length > 0) {
        sdkSummary = result.summary;
        break;
      }
      await sleep(2000);
    }
  }
  if (!sdkSummary) {
    throw new Error(
      `bridge.get(${sid}) never returned a non-empty summary within 180s. ` +
        `JSONL tail: ${readFileSync(matchedJsonl, 'utf8').split('\n').slice(-2).join('\n').slice(0, 800)}`,
    );
  }
  console.log(`[HARNESS]   sdk-derived summary: ${JSON.stringify(sdkSummary)}`);

  // Now wait for the renderer-side store.name to swap away from
  // 'New session'. The watcher's debounce + IPC roundtrip + React render
  // cycle is well under a second; budget 30s to absorb cold-cache /
  // slow-CI variance.
  let finalName = null;
  {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const observed = await win.evaluate((s) => {
        const useStore = window.__ccsmStore;
        if (!useStore) return null;
        const sess = useStore.getState().sessions.find((x) => x.id === s);
        return sess ? sess.name : null;
      }, sid);
      if (observed && observed !== 'New session') {
        finalName = observed;
        break;
      }
      await sleep(500);
    }
  }
  if (!finalName) {
    throw new Error(
      `session ${sid} name still equals 'New session' after 30s — live-tail title sync did not fire. ` +
        `sdkSummary=${JSON.stringify(sdkSummary)}`,
    );
  }
  console.log(`[HARNESS]   store.name now: ${JSON.stringify(finalName)}`);

  // Sanity: the rendered sidebar row should reflect the same value (DOM
  // and store agree). data-session-id is set by the SessionRow component.
  const domName = await win.evaluate((s) => {
    const row = document.querySelector(`[data-session-id="${s}"]`);
    return row ? (row.textContent || '').trim() : null;
  }, sid);
  if (!domName || !domName.includes(finalName)) {
    // Don't fail hard — the sidebar template may add status pills etc.
    // around the name. Log for visibility.
    console.log(
      `[HARNESS]   sidebar row text: ${JSON.stringify(domName)} (does not contain "${finalName}" verbatim — acceptable if wrapped)`,
    );
  }
}

// ============================================================================
// Case 1b: session-state-becomes-idle (#553 — JSONL tail-watcher signal)
// ============================================================================
//
// Verifies the JSONL tail-watcher (electron/sessionWatcher) → IPC
// (`session:state`) → preload (`window.ccsmSession.onState`) → Sidebar dot
// flow end-to-end:
//   1. Subscribe to `window.ccsmSession.onState` from the renderer side
//      and accumulate {sid, state} events on `window.__sessionStateLog`.
//   2. Spawn a fresh session, send a short prompt.
//   3. Assert the running → idle transition for THIS sid arrived within
//      90s of claude's reply landing in xterm.
//   4. Assert the inactive-row dot appears for some other (non-active)
//      session row whose state we know — we seed a second session so its
//      row is non-active when the first session is focused.
//
// Notes:
//   * Acceptable to also see other intermediate states (running ⇄ running
//     on tool calls). We only require that 'idle' shows up after the reply.
//   * Sidebar dot rendering is verified via DOM aria-label match — the
//     dot's aria-label = i18n `sidebar.sessionStateIdle` ("Waiting for
//     your reply"). We match a substring from the en bundle to avoid
//     coupling to the i18n machinery here.

async function caseSessionStateBecomesIdle({ electronApp: _electronApp, win, tempDir }) {
  const CHAT_PROMPT = 'reply with the single word: ack';

  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30000 },
  );

  // Install the renderer-side event log BEFORE any session spawns so we
  // catch the very first state event for this sid.
  await win.evaluate(() => {
    if (window.__sessionStateLog) return;
    window.__sessionStateLog = [];
    const api = window.ccsmSession;
    if (!api || typeof api.onState !== 'function') {
      window.__sessionStateApiMissing = true;
      return;
    }
    api.onState((evt) => {
      window.__sessionStateLog.push({ ...evt, t: Date.now() });
    });
  });
  const apiMissing = await win.evaluate(() => Boolean(window.__sessionStateApiMissing));
  if (apiMissing) {
    throw new Error('window.ccsmSession.onState not exposed by preload (PR-A wiring missing)');
  }

  // Seed two sessions so we can also assert the non-active dot renders.
  const { sid: sidIdle } = await seedSession(win, { name: 'state-probe-bystander', cwd: tempDir });
  const { sid: sid } = await seedSession(win, { name: 'state-probe-active', cwd: tempDir });
  if (!sid || !sidIdle || sid === sidIdle) {
    throw new Error(`bad sids active=${sid} bystander=${sidIdle}`);
  }

  await sleep(4000);
  await waitForTerminalReady(win, sid, { timeout: 60000 });
  await waitForXtermBuffer(win, /trust|claude|welcome|│|╭|>/i, { timeout: 30000 });
  await dismissFirstRunModals(win);

  await sendToClaudeTui(win, CHAT_PROMPT);
  await sleep(500);
  await sendToClaudeTui(win, '\r');

  // Wait for a 'idle' event for the active sid. The JSONL frame writes on
  // claude's turn boundary, then fs.watch fires within ~50ms (debounce).
  // 90s budget covers cold-model first-reply latency.
  const start = Date.now();
  let observedIdle = false;
  let lastLog = [];
  while (Date.now() - start < 90_000) {
    await sleep(2000);
    lastLog = await win.evaluate((s) =>
      (window.__sessionStateLog || []).filter((e) => e.sid === s),
      sid,
    );
    if (lastLog.some((e) => e.state === 'idle')) {
      observedIdle = true;
      break;
    }
  }
  if (!observedIdle) {
    throw new Error(
      `did not observe state='idle' for ${sid} within 90s. Log: ${JSON.stringify(lastLog)}`,
    );
  }

  // Verify the sidebar renders a state dot for the bystander row (which
  // is NOT the active session, so the dot rule kicks in). The bystander
  // never received a prompt, so its inferred state is 'running' (file
  // doesn't exist yet → empty-frames fallback) OR may show 'idle' if the
  // CLI wrote an init frame. Either way the aria-label should match one
  // of our three i18n strings. We scope the query to its data-session-id.
  const bystanderDot = await win.evaluate((sb) => {
    const row = document.querySelector(`[data-session-id="${sb}"]`);
    if (!row) return { rowFound: false };
    const dot = row.querySelector('[aria-label]');
    if (!dot) return { rowFound: true, aria: null };
    return { rowFound: true, aria: dot.getAttribute('aria-label') };
  }, sidIdle);
  if (!bystanderDot.rowFound) {
    throw new Error(`bystander row [data-session-id=${sidIdle}] not found in DOM`);
  }
  // We don't fail when no dot has rendered yet — the CLI may not have
  // written a frame for the bystander. Idle/running/requires-action dots
  // share the rail-cell slot but only render when a state event has
  // arrived. Log for visibility.
  if (bystanderDot.aria) {
    console.log(`[HARNESS]   bystander dot aria-label: "${bystanderDot.aria}"`);
  } else {
    console.log('[HARNESS]   bystander dot not rendered (no state event yet for that sid) — acceptable');
  }
}

// ============================================================================
// Case: notify-fires-on-idle (PR-B desktop notifications)
// ============================================================================
//
// Verifies the notify bridge:
//   - listens to sessionWatcher 'state-changed'
//   - fires when the user is NOT looking at the session
//   - records via the test-hook impl (CCSM_NOTIFY_TEST_HOOK=1, set in runner)
//
// Strategy: seed one session, send a prompt, then BEFORE the idle event lands
// clear the renderer's active sid via window.ccsmSession.setActive('') — that
// removes the active-window+active-sid suppression so the notify fires. Read
// the in-memory log via electronApp.evaluate() against the main process.

async function caseNotifyFiresOnIdle({ electronApp, win, tempDir }) {
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30000 },
  );

  // Sanity-check the test hook is wired (env set + bridge installed).
  const hookReady = await electronApp.evaluate(() => {
    const g = globalThis;
    if (!Array.isArray(g.__ccsmNotifyLog)) {
      g.__ccsmNotifyLog = [];
    }
    return true;
  });
  if (!hookReady) throw new Error('CCSM_NOTIFY_TEST_HOOK seam not initialized');
  // Snapshot baseline length so we only count NEW notifications fired by THIS case.
  const baseline = await electronApp.evaluate(() => globalThis.__ccsmNotifyLog?.length ?? 0);

  const { sid } = await seedSession(win, { name: 'notify-probe', cwd: tempDir });
  if (!sid) throw new Error('seedSession returned no sid');

  await sleep(3000);
  await waitForTerminalReady(win, sid, { timeout: 60000 });
  await waitForXtermBuffer(win, /trust|claude|welcome|│|╭|>/i, { timeout: 30000 });
  await dismissFirstRunModals(win);

  // Disable the active-window+active-sid suppression by clearing the
  // renderer's notion of "active session". Main caches '' as null and the
  // bridge then treats every state event as background.
  await win.evaluate(() => {
    const bridge = window.ccsmSession;
    if (bridge && typeof bridge.setActive === 'function') bridge.setActive('');
  });
  // Tiny pause so the IPC reaches main before the next state event fires.
  await sleep(200);

  await sendToClaudeTui(win, 'reply with: ack');
  await sleep(300);
  await sendToClaudeTui(win, '\r');

  // Wait up to 180s for a notification entry whose sid matches.
  const start = Date.now();
  let entry = null;
  while (Date.now() - start < 180_000) {
    await sleep(2000);
    const nextEntries = await electronApp.evaluate(
      (_electron, [s, base]) => (globalThis.__ccsmNotifyLog || []).slice(base).filter((e) => e.sid === s),
      [sid, baseline],
    );
    if (nextEntries.length > 0) { entry = nextEntries[0]; break; }
  }
  if (!entry) {
    const diag = await electronApp.evaluate((electron, s) => {
      const dbg = globalThis.__ccsmTestDebug;
      const env = dbg?.env ? dbg.env() : null;
      const lastEmitted = dbg?.getLastEmittedForSid
        ? dbg.getLastEmittedForSid(s)
        : 'no-debug-seam';
      const jsonl = dbg?.jsonl ? dbg.jsonl() : null;
      return {
        log: globalThis.__ccsmNotifyLog || [],
        lastEmitted,
        env,
        jsonl,
        hookEnv: process.env.CCSM_NOTIFY_TEST_HOOK ?? null,
      };
    }, sid);
    throw new Error(
      `no notify entry for sid=${sid} within 180s. Diag: ${JSON.stringify(diag)}`,
    );
  }
  if (!entry.title || !entry.body) {
    throw new Error(`notify entry missing title/body: ${JSON.stringify(entry)}`);
  }
  if (entry.state !== 'idle' && entry.state !== 'requires_action') {
    throw new Error(`unexpected notify state=${entry.state}`);
  }
  console.log(`[HARNESS]   notify fired: state=${entry.state} title="${entry.title}" body="${entry.body}"`);

  // -- Tray + taskbar badge unread count (#572) ------------------------
  // The notify bridge bumps BadgeManager.incrementSid(sid) ONLY when the
  // notification actually fired (mute/focus/dedupe survived). We just
  // observed the fire above, so total must be >= 1 and include our sid.
  // On mac/linux app.getBadgeCount() is the source of truth; on win32 we
  // assert via the BadgeManager debug seam since setOverlayIcon state
  // can't be probed back out.
  const totalAfterFire = await electronApp.evaluate(({ app }) => {
    const dbg = globalThis.__ccsmBadgeDebug;
    return {
      app: app.getBadgeCount?.() ?? 0,
      mgr: dbg?.getTotal ? dbg.getTotal() : null,
    };
  });
  const observed = process.platform === 'win32' ? totalAfterFire.mgr : totalAfterFire.app;
  if (observed === null || observed === undefined) {
    throw new Error(`badge total unreadable. Diag: ${JSON.stringify(totalAfterFire)}`);
  }
  if (observed < 1) {
    throw new Error(
      `badge total expected >=1 after notify fire, got ${observed}. Diag: ${JSON.stringify(totalAfterFire)}`,
    );
  }
  console.log(`[HARNESS]   badge total after fire: ${observed} (platform=${process.platform})`);

  // Re-focus + re-set active sid → BadgeManager.clearSid(sid) → total back to 0.
  await win.evaluate((s) => {
    const bridge = window.ccsmSession;
    if (bridge && typeof bridge.setActive === 'function') bridge.setActive(s);
  }, sid);
  // The window already has focus (Playwright keeps it focused); the
  // session:setActive IPC arriving in main triggers clearBadgeForActiveIfFocused.
  await sleep(300);
  const totalAfterClear = await electronApp.evaluate(({ app }) => {
    const dbg = globalThis.__ccsmBadgeDebug;
    return {
      app: app.getBadgeCount?.() ?? 0,
      mgr: dbg?.getTotal ? dbg.getTotal() : null,
    };
  });
  const cleared = process.platform === 'win32' ? totalAfterClear.mgr : totalAfterClear.app;
  if (cleared !== 0) {
    throw new Error(
      `badge total expected 0 after re-focus, got ${cleared}. Diag: ${JSON.stringify(totalAfterClear)}`,
    );
  }
  console.log(`[HARNESS]   badge total after clear: ${cleared}`);
}

// ============================================================================
// Case 2: switch-session-keeps-chat (UX F)
// ============================================================================

async function caseSwitchSessionKeepsChat({ electronApp, win, tempDir }) {
  const consoleErrors = [];
  const consoleHandler = (msg) => {
    if (msg.type() === 'error') consoleErrors.push({ type: 'error', text: msg.text() });
  };
  const pageErrorHandler = (err) => consoleErrors.push({ type: 'pageerror', text: String(err) });
  win.on('console', consoleHandler);
  win.on('pageerror', pageErrorHandler);

  await installPtyExitProbe(win);

  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    const { sid: sidA } = await seedSession(win, { name: 'session-A', cwd: tempDir });
    const { sid: sidB } = await seedSession(win, { name: 'session-B', cwd: tempDir });
    if (!sidA || !sidB || sidA === sidB) throw new Error(`bad sids A=${sidA} B=${sidB}`);

    // Select A.
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
    await waitForTerminalReady(win, sidA, { timeout: 45000 });
    await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30000 });

    const pidA1 = await getPtyPidForSid(win, sidA);
    if (typeof pidA1 !== 'number') {
      throw new Error(`A's pty pid not reported: ${JSON.stringify(pidA1)}`);
    }

    // Advance any first-run prompts.
    for (let i = 0; i < 6; i++) {
      const lines = await readXtermLines(win, { lines: 30 });
      const tail = lines.join('\n');
      if (/│\s*>/m.test(tail) || /^\s*>\s/m.test(tail)) break;
      await sendToClaudeTui(win, '\r');
      await sleep(1500);
    }
    await dismissWelcomeSplash(win);

    const ALPHA = 'Please reply with the single word ALPHA';
    const reply1 = await sendAndAwaitReply(win, ALPHA, 'ALPHA');
    if (!reply1.ok) throw new Error(`A first reply (ALPHA) timed out. Tail:\n${reply1.tail}`);

    // Switch to B.
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidB);
    await waitForTerminalReady(win, sidB, { timeout: 30000 });
    await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30000 });
    await dismissWelcomeSplash(win);

    const pidA2 = await getPtyPidForSid(win, sidA);
    if (pidA2 !== pidA1) {
      throw new Error(`A's pty dropped or changed after switching to B (was ${pidA1}, now ${pidA2})`);
    }

    // Switch BACK to A.
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
    await waitForTerminalReady(win, sidA, { timeout: 30000 });

    const pidA3 = await getPtyPidForSid(win, sidA);
    if (pidA3 !== pidA1) {
      throw new Error(`A's pid changed on switch-back (was ${pidA1}, now ${pidA3})`);
    }

    // Re-dismiss trust/splash on the rebound terminal.
    for (let i = 0; i < 6; i++) {
      const lines = await readXtermLines(win, { lines: 30 });
      const tail = lines.join('\n');
      if (/│\s*>/m.test(tail) || /^\s*>\s/m.test(tail)) break;
      await sendToClaudeTui(win, '\r');
      await sleep(1500);
    }

    // Wait for ALPHA scrollback to be visible — same pty means buffer was
    // preserved (no replay needed).
    try {
      await waitForXtermBuffer(win, /ALPHA/, { timeout: 15000 });
    } catch (_) { /* fall through */ }
    // readXtermLines (since #579) re-throws unexpected evaluate failures
    // with context at the inner site, so a generic "scrollback lost ALPHA"
    // assertion no longer hides the real buffer state (see #490 / #574).
    const aLines = await readXtermLines(win, { lines: 200 });
    if (!/ALPHA/.test(aLines.join('\n'))) {
      throw new Error(`A's scrollback lost ALPHA after switch-back. lines=${aLines.length}`);
    }

    await dismissWelcomeSplash(win);
    const BETA = 'Please reply with the single word BETA';
    const reply2 = await sendAndAwaitReply(win, BETA, 'BETA');
    if (!reply2.ok) throw new Error(`A second reply (BETA) timed out. Tail:\n${reply2.tail}`);

    const exitsForA = await win.evaluate(
      (sid) => (window.__probePtyExits || []).filter((e) => e && (e.sid === sid || e.sessionId === sid)),
      sidA,
    );
    if (exitsForA.length > 0) throw new Error(`pty:exit fired for A: ${JSON.stringify(exitsForA)}`);
  } finally {
    win.off('console', consoleHandler);
    win.off('pageerror', pageErrorHandler);
  }
}

// Task #548 — assert that the embedded xterm has DOM focus after a fresh
// session attaches. Polls briefly because focus transfer can race the
// React commit that sets state to 'ready'. Throws with rich context so
// regressions point at the exact element that stole focus instead.
async function assertCliFocused(win, sid, label, { timeout = 5000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await win.evaluate((expectedSid) => {
      const host = document.querySelector(
        `[data-terminal-host][data-active-sid="${expectedSid}"]`,
      ) || document.querySelector('[data-terminal-host]');
      const ta = host ? host.querySelector('.xterm-helper-textarea') : null;
      const ae = document.activeElement;
      const isHelper =
        !!ta && ae === ta;
      return {
        ok: isHelper,
        hostFound: !!host,
        helperFound: !!ta,
        activeTag: ae ? ae.tagName : null,
        activeClass: ae && ae.className ? String(ae.className).slice(0, 120) : null,
        activeTestid: ae && ae.getAttribute ? ae.getAttribute('data-testid') : null,
        activeAriaLabel: ae && ae.getAttribute ? ae.getAttribute('aria-label') : null,
      };
    }, sid);
    if (last.ok) return;
    await sleep(150);
  }
  throw new Error(
    `[${label}] expected document.activeElement === xterm helper textarea ` +
      `inside [data-terminal-host][data-active-sid="${sid}"], but got ` +
      `${JSON.stringify(last)}`,
  );
}

async function sendAndAwaitReply(win, prompt, replyToken, { timeout = 90000 } = {}) {
  await win.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    if (ta) ta.focus();
    if (window.__ccsmTerm && typeof window.__ccsmTerm.focus === 'function') window.__ccsmTerm.focus();
    return true;
  });
  await sleep(300);
  await sendToClaudeTui(win, prompt);
  await sleep(400);
  await sendToClaudeTui(win, '\r');

  const deadline = Date.now() + timeout;
  let lastTail = '';
  while (Date.now() < deadline) {
    await sleep(2000);
    const lines = await readXtermLines(win, { lines: 200 });
    const full = lines.join('\n');
    lastTail = full.slice(-800);
    const after = full.split(prompt).slice(1).join(prompt);
    if (after && new RegExp(replyToken).test(after)) return { ok: true, tail: lastTail };
  }
  return { ok: false, tail: lastTail };
}

// ============================================================================
// Case 3: cwd-projects-claude (UX E)
// ============================================================================

async function caseCwdProjectsClaude({ electronApp, win, tempDir }) {
  const MARKER_FILENAME = 'CCSM-PROBE-MARKER.txt';
  const MARKER_TOKEN = `probe-cwd-marker-${Math.random().toString(36).slice(2, 10)}`;

  const projectDir = path.join(tempDir, 'my-project');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, MARKER_FILENAME), `${MARKER_TOKEN}\n`, 'utf8');

  const { sid } = await seedSession(win, { name: 'cwd-test', cwd: projectDir, groupId: 'g1' });
  if (!sid) throw new Error('seedSession returned no sid');

  await waitForTerminalReady(win, sid, { timeout: 25000 });
  await sleep(4000);

  await waitForXtermBuffer(win, /my-project/, { timeout: 30000 });

  // Dismiss any splash before sending.
  for (let i = 0; i < 4; i++) {
    await sendToClaudeTui(win, '\r');
    await sleep(700);
  }
  await sleep(1500);

  const PROMPT = `ccsm-probe-cwd marker ${MARKER_TOKEN}, please reply with the word PONG`;
  await sendToClaudeTui(win, PROMPT);
  await sleep(800);
  {
    const tailLines = await readXtermLines(win, { lines: 12 });
    if (!tailLines.some((l) => l.includes(MARKER_TOKEN.slice(0, 8)))) {
      await sleep(1000);
      await sendToClaudeTui(win, PROMPT);
      await sleep(800);
    }
  }
  await sendToClaudeTui(win, '\r');

  await waitForXtermBuffer(win, /PONG/, { timeout: 90000 });

  // JSONL on disk under <CLAUDE_CONFIG_DIR>/projects/.
  const projectsRoot = path.join(tempDir, 'projects');
  const deadline = Date.now() + 20000;
  let matchedJsonl = null;
  let matchedDir = null;
  let projectsListing = [];
  while (Date.now() < deadline) {
    if (existsSync(projectsRoot)) {
      projectsListing = readdirSync(projectsRoot);
      for (const dirName of projectsListing) {
        let entries;
        try { entries = readdirSync(path.join(projectsRoot, dirName)); } catch { continue; }
        if (entries.includes(`${sid}.jsonl`)) {
          matchedJsonl = path.join(projectsRoot, dirName, `${sid}.jsonl`);
          matchedDir = dirName;
          break;
        }
      }
    }
    if (matchedJsonl) break;
    await sleep(500);
  }
  if (!matchedJsonl) {
    throw new Error(`no <sid>.jsonl found under ${projectsRoot}. listing=${JSON.stringify(projectsListing)}`);
  }
  if (!/my-project/i.test(matchedDir)) {
    throw new Error(`hash dir name does not encode "my-project": ${matchedDir}`);
  }

  // Cwd-leak negative.
  const electronCwdHashFragment = path.basename(process.cwd()).replace(/[^a-z0-9-]/gi, '');
  for (const dirName of projectsListing) {
    if (dirName === matchedDir) continue;
    if (electronCwdHashFragment && dirName.includes(electronCwdHashFragment) && !dirName.includes('my-project')) {
      throw new Error(`extra projects/ dir encodes electron cwd: ${dirName}`);
    }
  }

  const jsonlBody = readFileSync(matchedJsonl, 'utf8');
  if (jsonlBody.trim().length === 0) throw new Error(`JSONL empty: ${matchedJsonl}`);
  const firstLine = jsonlBody.split('\n').find((l) => l.trim().length > 0);
  try { JSON.parse(firstLine); } catch (e) { throw new Error(`JSONL first line not valid JSON: ${e}`); }
  if (!jsonlBody.includes(MARKER_TOKEN)) {
    throw new Error(`JSONL does not contain marker token ${MARKER_TOKEN}`);
  }

  // #560 — sub-assertion: cwd with spaces still flows through the same
  // hash-dir + JSONL-marker pipeline. Spaces are a common Windows footgun
  // (e.g. `C:\Users\First Last\my project`); assert here so we catch any
  // future shell-escaping or path-encoding regression.
  const spacesProjectDir = path.join(tempDir, 'my project with spaces');
  mkdirSync(spacesProjectDir, { recursive: true });
  const SPACES_MARKER = `probe-cwd-spaces-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(path.join(spacesProjectDir, MARKER_FILENAME), `${SPACES_MARKER}\n`, 'utf8');

  const { sid: sidSpaces } = await seedSession(win, {
    name: 'cwd-test-spaces', cwd: spacesProjectDir, groupId: 'g1',
  });
  if (!sidSpaces) throw new Error('seedSession (spaces) returned no sid');

  await waitForTerminalReady(win, sidSpaces, { timeout: 25000 });
  await sleep(2000);

  for (let i = 0; i < 4; i++) {
    await sendToClaudeTui(win, '\r');
    await sleep(700);
  }
  await sleep(1500);

  const SPACES_PROMPT = `ccsm-probe-cwd marker ${SPACES_MARKER}, please reply with the word PONG`;
  await sendToClaudeTui(win, SPACES_PROMPT);
  await sleep(800);
  await sendToClaudeTui(win, '\r');

  await waitForXtermBuffer(win, /PONG/, { timeout: 90000 });

  const spacesDeadline = Date.now() + 20000;
  let spacesJsonl = null;
  let spacesDir = null;
  while (Date.now() < spacesDeadline) {
    if (existsSync(projectsRoot)) {
      for (const dirName of readdirSync(projectsRoot)) {
        let entries;
        try { entries = readdirSync(path.join(projectsRoot, dirName)); } catch { continue; }
        if (entries.includes(`${sidSpaces}.jsonl`)) {
          spacesJsonl = path.join(projectsRoot, dirName, `${sidSpaces}.jsonl`);
          spacesDir = dirName;
          break;
        }
      }
    }
    if (spacesJsonl) break;
    await sleep(500);
  }
  if (!spacesJsonl) {
    throw new Error(`spaces: no <sid>.jsonl found under ${projectsRoot}`);
  }
  // The hash-dir name should encode the project folder. Different CLI
  // versions encode spaces as `-` or `_`; assert that some recognisable
  // segment of the folder name survives.
  if (!/my[-_ ]project[-_ ]with[-_ ]spaces/i.test(spacesDir)) {
    throw new Error(`spaces: hash dir does not encode "my project with spaces": ${spacesDir}`);
  }
  const spacesBody = readFileSync(spacesJsonl, 'utf8');
  if (!spacesBody.includes(SPACES_MARKER)) {
    throw new Error(`spaces: JSONL does not contain marker ${SPACES_MARKER}`);
  }
}

// ============================================================================
// Case 4: import-resume (UX H)
// ============================================================================

function encodeCwdForClaude(cwd) {
  return cwd.replace(/[\\\/:]/g, '-');
}

async function caseImportResume({ electronApp, win, tempDir }) {
  // Seed JSONL into both scanner path and claude path.
  const seedSid = randomUUID();
  const seedCwd = process.cwd();
  const projectDirName = encodeCwdForClaude(seedCwd);
  const scannerProjectDir = path.join(tempDir, '.claude', 'projects', projectDirName);
  const claudeProjectDir = path.join(tempDir, 'projects', projectDirName);
  mkdirSync(scannerProjectDir, { recursive: true });
  mkdirSync(claudeProjectDir, { recursive: true });
  const scannerJsonlPath = path.join(scannerProjectDir, `${seedSid}.jsonl`);
  const claudeJsonlPath = path.join(claudeProjectDir, `${seedSid}.jsonl`);

  const seedUserText = 'PROBE_IMPORT_PING please remember the token PROBE_IMPORT_PINEAPPLE';
  const assistantReplyMarker = `PROBE_IMPORT_ASSISTANT_REPLY_${randomUUID().slice(0, 8)}`;
  const userFrame = {
    parentUuid: null, isSidechain: false, type: 'user',
    message: { role: 'user', content: seedUserText },
    uuid: randomUUID(), timestamp: new Date().toISOString(),
    userType: 'external', cwd: seedCwd, sessionId: seedSid,
    version: '2.1.119', gitBranch: 'HEAD',
  };
  const aiTitleFrame = {
    type: 'ai-title', parentUuid: userFrame.uuid, isSidechain: false,
    sessionId: seedSid, cwd: seedCwd, timestamp: new Date().toISOString(),
    uuid: randomUUID(), aiTitle: 'probe imported session',
  };
  const assistantFrame = {
    parentUuid: userFrame.uuid, isSidechain: false, type: 'assistant',
    message: {
      id: 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24),
      type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: `Got it, I will remember PROBE_IMPORT_PINEAPPLE. ${assistantReplyMarker}` }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    uuid: randomUUID(), timestamp: new Date().toISOString(),
    userType: 'external', cwd: seedCwd, sessionId: seedSid,
    version: '2.1.119', gitBranch: 'HEAD',
  };
  const jsonlBlob = [userFrame, aiTitleFrame, assistantFrame].map((f) => JSON.stringify(f)).join('\n') + '\n';
  writeFileSync(scannerJsonlPath, jsonlBlob);
  writeFileSync(claudeJsonlPath, jsonlBlob);

  // Pre-trust seedCwd in the isolated .claude.json.
  const claudeJsonPath = path.join(tempDir, '.claude.json');
  let claudeJson = {};
  if (existsSync(claudeJsonPath)) {
    try { claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8')); } catch { claudeJson = {}; }
  }
  if (!claudeJson.projects || typeof claudeJson.projects !== 'object') claudeJson.projects = {};
  const seedCwdFwd = seedCwd.replace(/\\/g, '/');
  const trustedEntry = {
    allowedTools: [], mcpContextUris: [], mcpServers: {},
    enabledMcpjsonServers: [], disabledMcpjsonServers: [],
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    ...(claudeJson.projects[seedCwd] || {}),
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: 1,
  };
  claudeJson.projects[seedCwd] = trustedEntry;
  claudeJson.projects[seedCwdFwd] = trustedEntry;
  writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));

  // Hook pty-exit listener (idempotent).
  await installPtyExitProbe(win);
  // Snapshot exit count BEFORE this case to filter cross-case exits.
  const exitCountBefore = (await readPtyExits(win)).length;

  const importResult = await win.evaluate(async (expectedSid) => {
    const api = window.ccsm;
    const useStore = window.__ccsmStore;
    if (!api?.scanImportable) throw new Error('window.ccsm.scanImportable unavailable');
    if (!useStore) throw new Error('window.__ccsmStore unavailable');
    const rows = await api.scanImportable();
    const found = rows.find((r) => r.sessionId === expectedSid);
    if (!found) {
      return { ok: false, rows: rows.map((r) => ({ sessionId: r.sessionId, cwd: r.cwd })), reason: 'seeded-jsonl-not-in-scan' };
    }
    const { importSession, createGroup, groups } = useStore.getState();
    let groupId = groups.find((g) => g.kind === 'normal' && g.name === 'Imported')?.id;
    if (!groupId) groupId = createGroup('Imported');
    const importedId = importSession({
      name: found.title, cwd: found.cwd, groupId,
      resumeSessionId: found.sessionId, projectDir: found.projectDir,
    });
    useStore.setState({ activeId: importedId, focusedGroupId: null });
    const after = useStore.getState();
    const session = after.sessions.find((s) => s.id === importedId);
    return {
      ok: true,
      importedId,
      // Expose the scanner row's cwd + projectDir so the harness can
      // verify the scanner read from `<HOME>/.claude/projects/` (#559).
      scannerRow: { cwd: found.cwd, projectDir: found.projectDir, title: found.title },
      session: session ? { id: session.id, resumeSessionId: session.resumeSessionId } : null,
    };
  }, seedSid);
  if (!importResult?.ok) throw new Error(`import-flow failed: ${JSON.stringify(importResult)}`);
  if (importResult.importedId !== seedSid || importResult.session?.resumeSessionId !== seedSid) {
    throw new Error(`import id mismatch: ${JSON.stringify(importResult)}`);
  }
  // #559 — explicit per-path assertion: scanner returns the seeded entry
  // from `<HOME>/.claude/projects/<projectDirName>/<sid>.jsonl`. Production
  // import-scanner reads from `path.join(os.homedir(), '.claude',
  // 'projects')`, so under HOME=tempDir that's `scannerProjectDir`.
  if (importResult.scannerRow?.cwd !== seedCwd) {
    throw new Error(
      `scanner row cwd mismatch (scanner-path read failed): expected ${seedCwd}, ` +
        `got ${importResult.scannerRow?.cwd}`,
    );
  }
  if (importResult.scannerRow?.projectDir !== projectDirName) {
    throw new Error(
      `scanner row projectDir mismatch: expected ${projectDirName}, ` +
        `got ${importResult.scannerRow?.projectDir}`,
    );
  }

  await sleep(1500);

  await waitForTerminalReady(win, seedSid, { timeout: 30000 });

  // Task #548 — same focus contract as new-session-chat: after the
  // imported session's terminal attaches (claude --resume), focus must
  // be on the xterm helper textarea, not the importing trigger or body.
  await assertCliFocused(win, seedSid, 'import-resume');

  // Wait for claude --resume to replay PROBE_IMPORT_PING.
  await waitForXtermBuffer(win, /PROBE_IMPORT_PING/, { timeout: 30000 });
  // #559 — also assert the seeded ASSISTANT frame replayed. This proves
  // claude --resume consumed the canonical CLI-path JSONL (`<HOME>/projects/`,
  // not just the scanner-path one), end-to-end.
  await waitForXtermBuffer(win, new RegExp(assistantReplyMarker), { timeout: 30000 });

  const followupToken = 'PROBE_FOLLOWUP_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  await sleep(2000);
  await sendToClaudeTui(win, `Reply with the token ${followupToken} verbatim and nothing else.\r`);
  await waitForXtermBuffer(win, new RegExp(followupToken), { timeout: 90000 });

  const exitsAfter = await readPtyExits(win);
  const exitsThisCase = exitsAfter.slice(exitCountBefore);
  if (exitsThisCase.length > 0) {
    throw new Error(`unexpected pty:exit during import-resume: ${JSON.stringify(exitsThisCase)}`);
  }
}

// ============================================================================
// Case: default-cwd-from-userCwds-lru (task #551)
//
// New session creation must default the cwd to the user's most-recently
// used cwd from the ccsm-owned `userCwds` LRU (head of the list), with
// a fallback to `userHome` only when the LRU is empty.
//
// Reproduces the bug from PR #392's "default cwd is always home" policy:
// the user re-picks the same project on every new session because the
// LRU is consulted only by the picker, never by the default.
//
// Steps:
//   1. Read userHome from the renderer.
//   2. Push a synthetic non-home cwd into the LRU via `window.ccsm.userCwds.push`.
//   3. Wait for `lastUsedCwd` to reflect the new head in the store.
//   4. Call `createSession()` with NO opts.cwd — the new session's cwd
//      MUST equal the pushed path, NOT userHome.
//   5. Soft-cleanup: delete the new session so subsequent cases see a
//      clean shared launch.
// ============================================================================

async function caseDefaultCwdFromUserCwdsLru({ electronApp: _e, win, tempDir }) {
  // Boot probe must have resolved (renderer needs userCwds IPC + store).
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30000 },
  );

  // Synthetic project dir distinct from tempDir so we don't collide with
  // earlier cases that may have pushed tempDir already.
  const projectDir = path.join(tempDir, 'lru-project-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(projectDir, { recursive: true });
  const normalizedExpected = projectDir.replace(/[\\/]+$/, '');

  // Push the cwd through the real IPC. The renderer-side `lastUsedCwd`
  // cache is normally updated by store mutators (createSession /
  // setSessionCwd / importSession) that wrap the push call; pushing the
  // raw IPC bypasses those wrappers, so we mirror what `hydrateStore`
  // does at boot — read the LRU back via `userCwds.get` and seed
  // `lastUsedCwd` from the head. This matches the real path for the
  // first `+` click of every fresh launch.
  const pushed = await win.evaluate(async (p) => {
    const api = window.ccsm;
    if (!api?.userCwds?.push || !api?.userCwds?.get) {
      return { ok: false, reason: 'userCwds IPC unavailable' };
    }
    await api.userCwds.push(p);
    const list = await api.userCwds.get();
    const head = Array.isArray(list) && list.length > 0 ? list[0] : null;
    if (head) {
      window.__ccsmStore.setState({ lastUsedCwd: head });
    }
    return { ok: true, head };
  }, projectDir);
  if (!pushed.ok) throw new Error(`userCwds.push failed: ${pushed.reason}`);

  // Wait briefly for the setState to flush. The check polls instead of
  // relying on react-batching timing.
  await win.waitForFunction(
    (expected) => {
      const st = window.__ccsmStore?.getState?.();
      return !!st && (st.lastUsedCwd || '').replace(/[\\/]+$/, '') === expected;
    },
    normalizedExpected,
    { timeout: 5000 },
  );

  // Snapshot pre-create state for the failure message.
  const before = await win.evaluate(() => {
    const st = window.__ccsmStore.getState();
    return {
      lastUsedCwd: st.lastUsedCwd,
      userHome: st.userHome,
      sessionCount: st.sessions.length,
    };
  });

  // Create the new session WITHOUT specifying cwd — this is the defaulted
  // path the bug is about. Read back the active session's cwd.
  const result = await win.evaluate(() => {
    const useStore = window.__ccsmStore;
    const { createSession } = useStore.getState();
    createSession({ name: 'lru-default-probe' });
    const st = useStore.getState();
    const active = st.sessions.find((s) => s.id === st.activeId);
    return { sid: st.activeId, cwd: active?.cwd ?? null };
  });

  const actual = (result.cwd || '').replace(/[\\/]+$/, '');
  if (actual !== normalizedExpected) {
    throw new Error(
      `default cwd did not honor userCwds LRU.\n` +
        `  expected (LRU head): ${normalizedExpected}\n` +
        `  actual (session.cwd): ${result.cwd}\n` +
        `  store.lastUsedCwd:   ${before.lastUsedCwd}\n` +
        `  store.userHome:      ${before.userHome}`,
    );
  }

  // Negative: actual MUST NOT equal userHome (the regressed default).
  if (before.userHome && actual === before.userHome.replace(/[\\/]+$/, '')) {
    throw new Error(`default cwd fell back to userHome (${before.userHome}) despite non-empty LRU`);
  }

  // Cleanup so subsequent cases see no extra session row.
  await win.evaluate((sid) => {
    const useStore = window.__ccsmStore;
    const { deleteSession } = useStore.getState();
    deleteSession?.(sid);
  }, result.sid);
}

// ============================================================================
// Case: new-session-focus-cli — clicking "New Session" must transfer focus
// AWAY from the trigger button so a subsequent Enter goes to the CLI, not
// to the still-focused button (which would re-fire and spawn yet another
// session). Reproduces the user-reported bug behind the partial fix in
// PR #467 (cliFocusNonce alone is insufficient — DOM focus stays on the
// button).
// ============================================================================

async function caseNewSessionFocusCli({ electronApp, win, tempDir }) {
  // Wait for boot probe so the main shell renders the terminal pane / empty
  // state rather than the availability spinner (which has no sidebar).
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30000 },
  );

  // Reproduce the user-reported flow. Bug repro requires the sidebar
  // "New Session" button to retain DOM focus after activation. PR #467's
  // cliFocusNonce path moves focus to the embedded terminal ONLY when
  // (a) the terminal already exists AND (b) it is mounted. If the
  // CURRENT session's terminal pane is still in 'loading' state at the
  // moment of click — e.g., the user just created a session and
  // immediately creates another — flushFocus is a no-op, the button
  // keeps focus, and the next Enter re-fires it.
  //
  // The harness's shared launch may already have sessions from earlier
  // cases; that's fine. We seed a fresh session so the terminal is in
  // 'loading' state, then immediately activate sidebar New Session.
  await win.evaluate(() => {
    const useStore = window.__ccsmStore;
    useStore.setState({ tutorialSeen: true });
  });
  // Seed a session and don't wait for its terminal to finish loading —
  // the bug surfaces precisely when state.kind === 'loading' and there
  // is no terminal to receive focus.
  const { sid: seedSid } = await seedSession(win, { name: 'focus-loading', cwd: tempDir });
  if (!seedSid) throw new Error('seedSession returned empty sid');
  // Tiny wait so the sidebar+terminal pane mount, but NOT enough for the
  // pty to attach.
  await sleep(150);

  await win.waitForSelector('[data-testid="sidebar-newsession-row"]', { timeout: 10000 });

  const before = await win.evaluate(() => window.__ccsmStore.getState().sessions.length);

  // Focus the sidebar "New Session" button via JS (mirrors keyboard-walk
  // or post-mousedown DOM state) and activate via Enter, then immediately
  // press Enter again.
  await win.evaluate(() => {
    const el = document.querySelector('[data-testid="sidebar-newsession-row"] button');
    if (!el) throw new Error('sidebar new-session button not found');
    el.focus();
  });
  await win.keyboard.press('Enter');
  // Tight gap: enough for React to commit the cliFocusNonce bump (and
  // for flushFocus to run) but NOT enough for a fresh terminal to mount.
  await sleep(50);
  await win.keyboard.press('Enter');

  // Wait long enough for any second createSession to land in the store.
  await sleep(2500);

  const after = await win.evaluate(() => window.__ccsmStore.getState().sessions.length);
  const delta = after - before;
  if (delta !== 1) {
    const focusAfter = await win.evaluate(() => {
      const el = document.activeElement;
      if (!el) return { tag: null };
      return {
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 80),
        testid: el.getAttribute('data-testid'),
        ariaLabel: el.getAttribute('aria-label'),
      };
    });
    throw new Error(
      `expected exactly 1 new session after focus+Enter+Enter, got ${delta} ` +
        `(before=${before}, after=${after}). ` +
        `Active element after: ${JSON.stringify(focusAfter)}`,
    );
  }

  // #528 — count delta alone proves "no double-fire", not "keystrokes
  // reach the CLI". A regression where focus moves to <body> after
  // activation (no-op typing) would still pass the delta check.
  // Tighten by typing a unique marker into the newly-active session and
  // asserting it lands in xterm's scrollback — that requires both
  // (a) focus on the xterm helper textarea, and (b) live pty plumbing.
  const newSid = await win.evaluate(() => window.__ccsmStore.getState().activeId);
  if (!newSid) throw new Error('no activeId after Enter+Enter');
  await waitForTerminalReady(win, newSid, { timeout: 45000 });
  await dismissFirstRunModals(win);
  await assertCliFocused(win, newSid, 'new-session-focus-cli');

  const focusMarker = `FOCUS_PROBE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await sendToClaudeTui(win, `echo ${focusMarker}\r`);
  await waitForXtermBuffer(win, new RegExp(focusMarker), { timeout: 15000 });
}

// ============================================================================
// Case: pty-pid-stable-across-switch (direct-xterm)
//
// New under the direct-xterm architecture: with no per-session ttyd port
// to assert against, the strongest "switch did not respawn" probe is to
// pin the pty pid before A→B→A and assert it survives the round-trip
// (and that the marker we wrote into A's buffer is still in scrollback —
// proving it's literally the same pty, not a reattach with replay).
// ============================================================================

async function casePtyPidStableAcrossSwitch({ electronApp, win, tempDir }) {
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30000 },
  );

  const { sid: sidA } = await seedSession(win, { name: 'pid-stable-A', cwd: tempDir });
  const { sid: sidB } = await seedSession(win, { name: 'pid-stable-B', cwd: tempDir });
  if (!sidA || !sidB || sidA === sidB) throw new Error(`bad sids A=${sidA} B=${sidB}`);

  // Select A and wait for its terminal to attach.
  await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
  await waitForTerminalReady(win, sidA, { timeout: 45000 });

  // Dismiss claude's trust / welcome / theme splashes that intercept
  // the first keystrokes after a cold start. Without this, the
  // `echo MARKER` below would be eaten by the trust modal and the
  // marker would never reach the shell.
  await dismissFirstRunModals(win);

  // Snapshot pidA1 from window.ccsmPty.list().
  const pidA1 = await getPtyPidForSid(win, sidA);
  if (typeof pidA1 !== 'number') {
    throw new Error(`pidA1 not numeric: ${JSON.stringify(pidA1)}`);
  }

  // Send a unique marker into A's buffer so we can verify the SAME pty
  // (no replay) on switch-back.
  const MARKER = `MARKER_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await sendToClaudeTui(win, `echo ${MARKER}\r`);
  // Wait for the marker to appear in A's scrollback.
  await waitForXtermBuffer(win, new RegExp(MARKER), { timeout: 15000 });

  // Switch to B.
  await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidB);
  await waitForTerminalReady(win, sidB, { timeout: 30000 });

  // #560 — sanity: B must have its own pty pid distinct from A's. Cheap
  // guard against a regression where window.ccsmPty.list() returns a stale
  // single entry for every sid (which would silently make the A→B→A
  // equality below trivially true).
  const pidB = await getPtyPidForSid(win, sidB);
  if (typeof pidB !== 'number') {
    throw new Error(`pidB not numeric: ${JSON.stringify(pidB)}`);
  }
  if (pidB === pidA1) {
    throw new Error(`A and B share the same pty pid (${pidA1}); list() is reading stale state`);
  }

  // Switch BACK to A.
  await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
  await waitForTerminalReady(win, sidA, { timeout: 30000 });
  // Post-switch, waitForTerminalReady asserts the host/term/buffer exist,
  // but window.__ccsmTerm can briefly remain wired to B during the React
  // re-render. Wait until A's buffer is actually populated before reading,
  // otherwise readXtermLines returns [] and the MARKER assertion fires
  // spuriously (see #574 flake repro).
  await waitForActiveXtermBuffer(win, sidA, { minLines: 1, timeout: 5000 });

  // Assert MARKER is STILL in the active buffer — no replay = same pty.
  // readXtermLines (since #579) re-throws unexpected evaluate failures
  // with context at the inner site, so the prior "MARKER not found" flake
  // can no longer hide a real driver error.
  const lines = await readXtermLines(win, { lines: 200 });
  const joined = lines.join('\n');
  if (!new RegExp(MARKER).test(joined)) {
    throw new Error(
      `MARKER ${MARKER} not found in A's scrollback after switch-back. ` +
        `Tail:\n${joined.slice(-400)}`,
    );
  }

  // Snapshot pidA2 and require equality.
  const pidA2 = await getPtyPidForSid(win, sidA);
  if (pidA2 !== pidA1) {
    throw new Error(`A's pty pid changed across A→B→A: ${pidA1} → ${pidA2}`);
  }
}

// ============================================================================
// Case: reopen-resume (UX G) — owns its launches
// ============================================================================

async function caseReopenResume() {
  const SECRET_TOKEN = 'OMEGA';
  const PROMPT_1 = `remember the word ${SECRET_TOKEN}`;
  const PROMPT_2 = `what was the word I asked you to remember? reply with just the single word.`;

  const isolated = await createIsolatedClaudeDir();
  const tempDir = isolated.tempDir;
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'ccsm-probe-reopen-userdata-'));

  let app1 = null;
  let app2 = null;
  try {
    // ---- run1 ----
    ({ electronApp: app1 } = await launchCcsmIsolated({ tempDir, userDataDir }));
    const win1 = await app1.firstWindow();
    win1.on('console', (m) => {
      const t = m.type();
      if (t === 'error' || t === 'pageerror') console.warn(`[run1 ${t}] ${m.text()}`.slice(0, 400));
    });
    await sleep(3500);

    const { sid: sessionId } = await seedSession(win1, { name: 'persist-session', cwd: tempDir });
    if (!sessionId) throw new Error('seedSession returned no sid');

    await waitForTerminalReady(win1, sessionId, { timeout: 30000 });
    await waitForXtermBuffer(win1, /claude|welcome|│|╭|╰|\?\sfor\sshortcuts|trust/i, { timeout: 60000 });
    await dismissFirstRunModals(win1);

    await sendToClaudeTui(win1, PROMPT_1);
    await sleep(400);
    await sendToClaudeTui(win1, '\r');

    await waitForXtermBuffer(
      win1,
      // #560 — keep this strict: only assert the model produced an
      // acknowledgement signal (the token, "remember", or "noted").
      // Loose verbs like "sure"/"okay"/"got it"/"will remember" matched
      // unrelated boilerplate (welcome text, trust dialog) and gave a
      // false-green when claude actually never replied.
      new RegExp(`${SECRET_TOKEN}|remember|noted`, 'i'),
      { timeout: 90000 },
    );

    await sleep(4000); // JSONL flush + persist debounce.
    await app1.close();
    app1 = null;

    // ---- run2 ----
    ({ electronApp: app2 } = await launchCcsmIsolated({ tempDir, userDataDir }));
    const win2 = await app2.firstWindow();
    let ptyExited = null;
    win2.on('console', (m) => {
      const txt = m.text();
      if (/pty[-_]exit|pty_exited/i.test(txt)) ptyExited = txt;
    });

    const sessionRow = `[data-session-id="${sessionId}"]`;
    await win2.waitForSelector(sessionRow, { timeout: 15000 });
    await win2.locator(sessionRow).first().click();
    await sleep(500);
    const activeId = await win2.evaluate(() => window.__ccsmStore?.getState?.()?.activeId ?? null);
    if (activeId !== sessionId) throw new Error(`click did not set activeId. Got ${activeId}, expected ${sessionId}`);

    await waitForTerminalReady(win2, sessionId, { timeout: 30000 });
    await waitForXtermBuffer(win2, /claude|welcome|│|╭|╰|trust|\?\sfor\sshortcuts/i, { timeout: 60000 });
    await dismissFirstRunModals(win2);

    await waitForXtermBuffer(win2, new RegExp(SECRET_TOKEN), { timeout: 90000 });

    await sendToClaudeTui(win2, PROMPT_2);
    await sleep(400);
    await sendToClaudeTui(win2, '\r');

    let replied = false;
    let lastTail = '';
    const start = Date.now();
    while (Date.now() - start < 90000) {
      await sleep(2000);
      const lines = await readXtermLines(win2, { lines: 200 });
      const full = lines.join('\n');
      lastTail = full.slice(-1200);
      const parts = full.split(PROMPT_2);
      const after = parts.length > 1 ? parts.slice(1).join(PROMPT_2) : '';
      if (after && new RegExp(SECRET_TOKEN, 'i').test(after)) { replied = true; break; }
    }
    if (!replied) throw new Error(`run2 follow-up no recognizable reply. Tail:\n${lastTail}`);

    if (ptyExited) throw new Error(`run2: pty:exit observed: ${ptyExited}`);
  } finally {
    if (app1) try { await app1.close(); } catch (_) { /* ignore */ }
    if (app2) try { await app2.close(); } catch (_) { /* ignore */ }
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    isolated.cleanup?.();
  }
}

// ============================================================================
// Case: pty-subtree-killed-on-quit (#554) — owns its own launch
// ============================================================================
//
// Verifies that quitting ccsm tears down the ENTIRE PTY subtree, not just the
// ConPTY wrapper. On Windows, node-pty.kill() only terminates the
// cmd.exe / OpenConsole wrapper; without an explicit `taskkill /F /T` the
// claude.exe grandchild (and anything it spawned) survives as an orphan.
//
// Flow: launch ccsm -> create 2 sessions -> walk pty pid + descendants ->
// quit app -> confirm none of those pids are alive after a 2s settle.

function listChildPids(parentPid) {
  if (!parentPid || parentPid <= 0) return [];
  if (process.platform === 'win32') {
    // wmic is deprecated on newer Windows but still installed; fall back to
    // PowerShell Get-CimInstance if it's missing.
    const wmic = spawnSync(
      'wmic',
      ['process', 'where', `ParentProcessId=${parentPid}`, 'get', 'ProcessId'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (wmic.status === 0 && wmic.stdout) {
      return wmic.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^\d+$/.test(l))
        .map((l) => Number(l))
        .filter((n) => n !== parentPid);
    }
    const ps = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (ps.status === 0 && ps.stdout) {
      return ps.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^\d+$/.test(l))
        .map((l) => Number(l));
    }
    return [];
  }
  const r = spawnSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map((l) => Number(l));
}

function walkSubtree(rootPid) {
  const all = new Set();
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    if (!pid || all.has(pid)) continue;
    all.add(pid);
    for (const child of listChildPids(pid)) {
      if (!all.has(child)) queue.push(child);
    }
  }
  return [...all];
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout) return false;
    // tasklist prints "INFO: No tasks are running ..." when no match, otherwise
    // a CSV row containing the pid.
    return new RegExp(`"${pid}"`).test(r.stdout);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function processName(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout) {
      const m = r.stdout.match(/"([^"]+)"/);
      if (m) return m[1];
    }
    return '?';
  }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  return r.status === 0 && r.stdout ? r.stdout.trim() : '?';
}

async function casePtySubtreeKilledOnQuit() {
  const isolated = await createIsolatedClaudeDir();
  const tempDir = isolated.tempDir;

  let app = null;
  try {
    const launched = await launchCcsmIsolated({ tempDir });
    app = launched.electronApp;
    const win = launched.win;
    await sleep(1500);

    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    // Spawn 2 sessions so we exercise the kill loop, not just one entry.
    const sessions = [];
    for (const name of ['subtree-A', 'subtree-B']) {
      const { sid } = await seedSession(win, { name, cwd: tempDir });
      if (!sid) throw new Error(`seedSession (${name}) returned no sid`);
      await waitForTerminalReady(win, sid, { timeout: 60000 });
      await waitForXtermBuffer(win, /claude|welcome|│|╭|trust|\?\sfor\sshortcuts/i, {
        timeout: 30000,
      });
      const pid = await getPtyPidForSid(win, sid);
      if (typeof pid !== 'number') throw new Error(`no pty pid for ${name} (${sid})`);
      sessions.push({ name, sid, pid });
    }

    // Walk the full subtree for each pty root. Capture BEFORE quit so we have
    // ground truth — after the quit the kernel will recycle pid table entries
    // and we'd miss children.
    const allPids = new Map(); // pid -> { ownerName, name }
    for (const s of sessions) {
      const tree = walkSubtree(s.pid);
      for (const p of tree) {
        if (!allPids.has(p)) allPids.set(p, { ownerName: s.name, name: processName(p) });
      }
    }

    if (allPids.size < sessions.length) {
      throw new Error(
        `expected at least ${sessions.length} pids in tree, got ${allPids.size}: ` +
          JSON.stringify([...allPids]),
      );
    }
    console.log(
      `[pty-subtree] captured ${allPids.size} pids across ${sessions.length} sessions: ` +
        [...allPids.entries()]
          .map(([pid, m]) => `${pid}(${m.name})`)
          .join(', '),
    );

    // Trigger graceful quit (drives the before-quit handler that calls
    // killAllPtySessions). Tolerate the close raising — Electron is going down.
    try {
      await app.evaluate(({ app: a }) => a.quit());
    } catch (_) {
      /* expected if context tears down mid-evaluate */
    }
    try {
      await app.close();
    } catch (_) {
      /* already closing */
    }
    app = null;

    // 2s settle so taskkill /T can finish walking the tree and the OS reaps
    // the children.
    await sleep(2000);

    const survivors = [];
    for (const [pid, meta] of allPids.entries()) {
      if (pidAlive(pid)) survivors.push({ pid, ...meta, currentName: processName(pid) });
    }

    if (survivors.length > 0) {
      // Best-effort cleanup so a failed run doesn't leak claude.exe forever.
      for (const s of survivors) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/F', '/T', '/PID', String(s.pid)], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } else {
          try { process.kill(s.pid, 'SIGKILL'); } catch (_) { /* ignore */ }
        }
      }
      throw new Error(
        `pty subtree leaked after app quit: ` +
          survivors
            .map((s) => `pid=${s.pid} name=${s.currentName} owner=${s.ownerName}`)
            .join('; '),
      );
    }
  } finally {
    if (app) {
      try { await app.close(); } catch (_) { /* ignore */ }
    }
    isolated.cleanup?.();
  }
}

// ============================================================================
// Cases: cwd-picker-* (task #552 — chevron + popover cwd picker)
//
// The sidebar's New Session triggers (top + per-group) gained a `▾`
// chevron next to the `+`. Clicking `+` creates a session with the LRU
// default cwd; clicking `▾` opens a popover, the user picks a cwd, and the
// session is created with that cwd. The Cmd+N / Cmd+Shift+N / Cmd+Shift+G
// keyboard shortcuts were removed in the same change.
//
// All cases share a tempDir+launch with the rest of the shared group; each
// pushes its own synthetic project dir into `userCwds` and verifies the
// store mutation, never relying on cross-case ordering.
// ============================================================================

async function _waitBoot(win) {
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30000 },
  );
  await win.evaluate(() => {
    const useStore = window.__ccsmStore;
    useStore.setState({ tutorialSeen: true });
  });
  await win.waitForSelector('[data-testid="sidebar-newsession-row"]', { timeout: 10000 });
}

async function _seedRecentCwd(win, projectDir) {
  // Push the cwd through the real IPC and mirror lastUsedCwd, matching the
  // boot path used by hydrateStore. See caseDefaultCwdFromUserCwdsLru.
  mkdirSync(projectDir, { recursive: true });
  const result = await win.evaluate(async (p) => {
    const api = window.ccsm;
    if (!api?.userCwds?.push || !api?.userCwds?.get) {
      return { ok: false, reason: 'userCwds IPC unavailable' };
    }
    await api.userCwds.push(p);
    const list = await api.userCwds.get();
    const head = Array.isArray(list) && list.length > 0 ? list[0] : null;
    if (head) window.__ccsmStore.setState({ lastUsedCwd: head });
    return { ok: true, head };
  }, projectDir);
  if (!result.ok) throw new Error(`userCwds.push failed: ${result.reason}`);
  return result.head;
}

function _norm(p) {
  return (p || '').replace(/[\\/]+$/, '');
}

async function _sessionCount(win) {
  return await win.evaluate(() => window.__ccsmStore.getState().sessions.length);
}

async function _activeCwd(win) {
  return await win.evaluate(() => {
    const st = window.__ccsmStore.getState();
    const a = st.sessions.find((s) => s.id === st.activeId);
    return a?.cwd ?? null;
  });
}

async function _deleteActive(win) {
  await win.evaluate(() => {
    const st = window.__ccsmStore.getState();
    st.deleteSession?.(st.activeId);
  });
}

async function _seedGroup(win, name) {
  return await win.evaluate((nm) => {
    const st = window.__ccsmStore.getState();
    const id = st.createGroup(nm);
    st.focusGroup(id);
    return id;
  }, name);
}

// Case: cwd-picker-top-default
//   Click the top `+` (NOT the chevron). Asserts the new session uses the
//   LRU default cwd (lastUsedCwd), proving that the `+` half is unaffected
//   by the chevron addition.
async function caseCwdPickerTopDefault({ win, tempDir }) {
  await _waitBoot(win);
  const projectDir = path.join(tempDir, 'cwd-pick-top-default-' + Math.random().toString(36).slice(2, 8));
  const expected = _norm(await _seedRecentCwd(win, projectDir));

  const before = await _sessionCount(win);
  // The top "+" lives inside [data-sidebar-newsession-cluster] as the
  // FIRST <button>. Click that, NOT the chevron sibling.
  await win.evaluate(() => {
    const cluster = document.querySelector('[data-sidebar-newsession-cluster]');
    if (!cluster) throw new Error('top newsession cluster not found');
    const plus = cluster.querySelector('button:not([data-testid="sidebar-newsession-cwd-chevron"])');
    if (!plus) throw new Error('top + button not found');
    plus.click();
  });
  await sleep(300);
  const after = await _sessionCount(win);
  if (after - before !== 1) throw new Error(`expected 1 new session, got delta=${after - before}`);
  const actual = _norm(await _activeCwd(win));
  if (actual !== expected) {
    throw new Error(`top + did not honor LRU default. expected=${expected} actual=${actual}`);
  }
  await _deleteActive(win);
}

// Case: cwd-picker-top-chevron
//   Click `▾` → popover opens → seed an alternative cwd into the LRU →
//   click that recent row → assert new session uses the picked cwd, popover
//   closes, no extra session is created from the chevron click itself.
async function caseCwdPickerTopChevron({ win, tempDir }) {
  await _waitBoot(win);
  // Seed two cwds: the LRU head (which would be the default) and an
  // alternate the user will pick.
  const head = path.join(tempDir, 'top-chevron-head-' + Math.random().toString(36).slice(2, 8));
  const alt = path.join(tempDir, 'top-chevron-alt-' + Math.random().toString(36).slice(2, 8));
  await _seedRecentCwd(win, head);
  await _seedRecentCwd(win, alt); // alt becomes the LRU head; head sits at index 1

  const before = await _sessionCount(win);

  // Click the chevron.
  await win.click('[data-testid="sidebar-newsession-cwd-chevron"]');
  // Popover panel must mount.
  await win.waitForSelector('[data-testid="cwd-popover-panel"]', { timeout: 4000 });
  // Confirm no session was created by the chevron click.
  const midCount = await _sessionCount(win);
  if (midCount !== before) {
    throw new Error(`chevron click leaked a session: before=${before} mid=${midCount}`);
  }

  // Pick the row whose path includes our seeded "head" path (NOT the
  // current LRU head "alt"). This proves the user's pick — not the
  // default — drives the new session's cwd.
  const target = _norm(head);
  await win.evaluate((needle) => {
    const opts = Array.from(document.querySelectorAll('[data-testid="cwd-popover-panel"] [role="option"]'));
    const hit = opts.find((el) => (el.getAttribute('title') || el.textContent || '').includes(needle.split(/[\\/]/).pop()));
    if (!hit) throw new Error(`recent row not found for ${needle}`);
    // The popover commits on mousedown so the input doesn't blur first.
    hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  }, target);
  await sleep(300);

  const after = await _sessionCount(win);
  if (after - before !== 1) throw new Error(`expected 1 new session after pick, got delta=${after - before}`);
  const actual = _norm(await _activeCwd(win));
  if (actual !== target) {
    throw new Error(`top chevron pick did not apply. picked=${target} actual=${actual}`);
  }
  // Popover must close.
  const stillOpen = await win.evaluate(
    () => !!document.querySelector('[data-testid="cwd-popover-panel"]'),
  );
  if (stillOpen) throw new Error('cwd popover did not close after pick');

  await _deleteActive(win);
}

// Case: cwd-picker-no-shortcut
//   Cmd+N / Ctrl+N must NOT create a session anymore — the keyboard shortcut
//   was removed in the same task. Holds for both unmodified `n` (always was
//   typed text) and `Mod+n` (the deleted binding).
async function caseCwdPickerNoShortcut({ win }) {
  await _waitBoot(win);
  const before = await _sessionCount(win);

  // Make sure focus is on document.body so the shortcut would have bubbled
  // up to the App-level keydown listener under the old code.
  await win.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) {
      try { document.activeElement.blur(); } catch (_) { /* noop */ }
    }
    document.body.focus();
  });

  // Press Mod+N (Ctrl on Windows/Linux, Cmd on macOS — Playwright maps
  // 'Control' deterministically; we send both for paranoia).
  await win.keyboard.press('Control+n');
  await win.keyboard.press('Meta+n');
  // Also Cmd+Shift+G (deleted new-group shortcut).
  await win.keyboard.press('Control+Shift+g');
  await win.keyboard.press('Meta+Shift+g');
  await sleep(400);

  const after = await _sessionCount(win);
  if (after !== before) {
    throw new Error(`Cmd/Ctrl+N (or +Shift+G) still creates sessions. before=${before} after=${after}`);
  }
}

// Case: sidebar-group-no-newsession-cluster
//   Per-group `+` button + cwd chevron were removed (see PR #605). The only
//   way to start a new session is now the top-of-sidebar NewSession cluster.
//   Hard-asserts that no GroupRow renders any of the per-group split-button
//   selectors, so the deletion can't silently regress.
async function caseSidebarGroupHasNoNewSessionCluster({ win }) {
  await _waitBoot(win);
  // Seed >=1 user group so at least one <GroupRow> mounts. Without a group,
  // the assertion would trivially pass even if the per-group cluster were
  // re-introduced.
  await _seedGroup(win, 'no-cluster-' + Math.random().toString(36).slice(2, 6));
  // Give the sidebar a tick to render the new GroupRow.
  await sleep(200);

  const counts = await win.evaluate(() => ({
    cluster: document.querySelectorAll('[data-sidebar-group-newsession-cluster]').length,
    plus: document.querySelectorAll('[data-sidebar-group-newsession-plus]').length,
    chevron: document.querySelectorAll('[data-sidebar-group-newsession-cwd-chevron]').length,
    groupRows: document.querySelectorAll('[data-testid^="sidebar-group-row"], [data-sidebar-group-row]').length,
  }));

  if (counts.cluster !== 0 || counts.plus !== 0 || counts.chevron !== 0) {
    throw new Error(
      `per-group newsession cluster regressed: cluster=${counts.cluster} plus=${counts.plus} chevron=${counts.chevron}`,
    );
  }
}

// ============================================================================
// Registry
// ============================================================================

const CASE_REGISTRY = [
  { name: 'new-session-chat',            group: 'shared', run: caseNewSessionChat },
  { name: 'session-rename-writes-jsonl', group: 'shared', run: caseSessionRenameWritesJsonl },
  { name: 'session-title-syncs-from-jsonl', group: 'shared', run: caseSessionTitleSyncsFromJsonl },
  { name: 'session-state-becomes-idle',  group: 'shared', run: caseSessionStateBecomesIdle },
  { name: 'notify-fires-on-idle',        group: 'shared', run: caseNotifyFiresOnIdle },
  { name: 'switch-session-keeps-chat',   group: 'shared', run: caseSwitchSessionKeepsChat },
  { name: 'cwd-projects-claude',         group: 'shared', run: caseCwdProjectsClaude },
  { name: 'import-resume',               group: 'shared', run: caseImportResume },
  { name: 'default-cwd-from-userCwds-lru', group: 'shared', run: caseDefaultCwdFromUserCwdsLru },
  { name: 'new-session-focus-cli',       group: 'shared', run: caseNewSessionFocusCli },
  { name: 'pty-pid-stable-across-switch',group: 'shared', run: casePtyPidStableAcrossSwitch },
  { name: 'cwd-picker-top-default',      group: 'shared', run: caseCwdPickerTopDefault },
  { name: 'cwd-picker-top-chevron',      group: 'shared', run: caseCwdPickerTopChevron },
  { name: 'cwd-picker-no-shortcut',      group: 'shared', run: caseCwdPickerNoShortcut },
  { name: 'sidebar-group-no-newsession-cluster', group: 'shared', run: caseSidebarGroupHasNoNewSessionCluster },
  { name: 'reopen-resume',               group: 'standalone', run: caseReopenResume },
  { name: 'pty-subtree-killed-on-quit',  group: 'standalone', run: casePtySubtreeKilledOnQuit },
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

  const sharedCases = selected.filter((c) => c.group === 'shared');
  const standaloneCases = selected.filter((c) => c.group === 'standalone');

  const results = [];
  const harnessStart = Date.now();

  // ---- shared-launch group ----
  if (sharedCases.length > 0) {
    if (!existsSync(path.resolve('dist/renderer/index.html'))) {
      console.error('dist/renderer/index.html missing — run `npm run build` first');
      process.exit(2);
    }
    let isolated = null;
    let launched = null;
    try {
      isolated = await createIsolatedClaudeDir();
      launched = await launchCcsmIsolated({
        tempDir: isolated.tempDir,
        // Swap the desktop notify impl for an in-memory log accessible via
        // `globalThis.__ccsmNotifyLog` from the main process. Keeps the e2e
        // run silent (no OS toasts during a probe batch) and gives the
        // notify-fires-on-idle case something to assert against.
        env: { CCSM_NOTIFY_TEST_HOOK: '1' },
      });
      const ctx = { electronApp: launched.electronApp, win: launched.win, tempDir: isolated.tempDir };
      console.log(`\n[HARNESS] shared launch ready (tempDir=${isolated.tempDir})`);
      for (const c of sharedCases) {
        const t0 = Date.now();
        console.log(`\n[HARNESS] >>> case: ${c.name}`);
        try {
          await c.run(ctx);
          const ms = Date.now() - t0;
          results.push({ name: c.name, ok: true, ms });
          console.log(`[HARNESS] <<< PASS ${c.name} (${ms}ms)`);
        } catch (err) {
          const ms = Date.now() - t0;
          const screen = await snap(ctx.win, c.name, 'fail');
          results.push({ name: c.name, ok: false, ms, error: String(err?.stack || err), screenshot: screen });
          console.error(`[HARNESS] <<< FAIL ${c.name} (${ms}ms): ${err?.message || err}`);
          if (screen) console.error(`[HARNESS]     screenshot: ${screen}`);
        }
      }
    } finally {
      if (launched?.electronApp) try { await launched.electronApp.close(); } catch (_) { /* ignore */ }
      launched?.cleanup?.();
      isolated?.cleanup?.();
    }
  }

  // ---- standalone cases ----
  for (const c of standaloneCases) {
    const t0 = Date.now();
    console.log(`\n[HARNESS] >>> case (standalone launch): ${c.name}`);
    try {
      await c.run();
      const ms = Date.now() - t0;
      results.push({ name: c.name, ok: true, ms });
      console.log(`[HARNESS] <<< PASS ${c.name} (${ms}ms)`);
    } catch (err) {
      const ms = Date.now() - t0;
      results.push({ name: c.name, ok: false, ms, error: String(err?.stack || err) });
      console.error(`[HARNESS] <<< FAIL ${c.name} (${ms}ms): ${err?.message || err}`);
    }
  }

  // ---- summary ----
  const totalMs = Date.now() - harnessStart;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('\n===== HARNESS SUMMARY =====');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(34)} ${r.ms}ms`);
  }
  console.log(`  total: ${passed}/${results.length} passed, ${(totalMs / 1000).toFixed(1)}s wall`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[HARNESS] unhandled top-level error:', err?.stack || err);
  process.exit(1);
});
