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
import {
  createIsolatedClaudeDir,
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
  for (let i = 0; i < 12; i++) {
    const lines = await readXtermLines(win, { lines: 30 }).catch(() => []);
    const screen = lines.join('\n');
    if (/│\s*>/.test(screen) || /^\s*>\s/m.test(screen)) break;
    if (/trust|do you trust/i.test(screen)) {
      await sendToClaudeTui(win, '1\r').catch(() => {});
    } else {
      await sendToClaudeTui(win, '\r').catch(() => {});
    }
    await sleep(1500);
  }

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
    lastLines = await readXtermLines(win, { lines: 60 }).catch(() => []);
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
      const lines = await readXtermLines(win, { lines: 30 }).catch(() => []);
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
      const lines = await readXtermLines(win, { lines: 30 }).catch(() => []);
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
    const aLines = await readXtermLines(win, { lines: 200 }).catch(() => []);
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
    const lines = await readXtermLines(win, { lines: 200 }).catch(() => []);
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
    const tailLines = await readXtermLines(win, { lines: 12 }).catch(() => []);
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
      content: [{ type: 'text', text: 'Got it, I will remember PROBE_IMPORT_PINEAPPLE.' }],
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
    return { ok: true, importedId, session: session ? { id: session.id, resumeSessionId: session.resumeSessionId } : null };
  }, seedSid);
  if (!importResult?.ok) throw new Error(`import-flow failed: ${JSON.stringify(importResult)}`);
  if (importResult.importedId !== seedSid || importResult.session?.resumeSessionId !== seedSid) {
    throw new Error(`import id mismatch: ${JSON.stringify(importResult)}`);
  }

  await sleep(1500);

  await waitForTerminalReady(win, seedSid, { timeout: 30000 });

  // Task #548 — same focus contract as new-session-chat: after the
  // imported session's terminal attaches (claude --resume), focus must
  // be on the xterm helper textarea, not the importing trigger or body.
  await assertCliFocused(win, seedSid, 'import-resume');

  // Wait for claude --resume to replay PROBE_IMPORT_PING.
  await waitForXtermBuffer(win, /PROBE_IMPORT_PING/, { timeout: 30000 });

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
  for (let i = 0; i < 12; i++) {
    const lines = await readXtermLines(win, { lines: 30 }).catch(() => []);
    const screen = lines.join('\n');
    if (/│\s*>/.test(screen) || /^\s*>\s/m.test(screen)) break;
    if (/trust|do you trust/i.test(screen)) {
      await sendToClaudeTui(win, '1\r').catch(() => {});
    } else {
      await sendToClaudeTui(win, '\r').catch(() => {});
    }
    await sleep(1500);
  }

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

  // Switch BACK to A.
  await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
  await waitForTerminalReady(win, sidA, { timeout: 30000 });

  // Assert MARKER is STILL in the active buffer — no replay = same pty.
  const lines = await readXtermLines(win, { lines: 200 }).catch(() => []);
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
      new RegExp(`${SECRET_TOKEN}|remember|noted|got it|will remember|sure|okay`, 'i'),
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
      const lines = await readXtermLines(win2, { lines: 200 }).catch(() => []);
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

async function dismissFirstRunModals(win) {
  const trustRe = /trust the files|trust this folder|Do you trust|1\.\s*Yes|Yes, proceed/i;
  const promptRe = /│\s*>|^\s*>\s/m;

  for (let i = 0; i < 8; i++) {
    const lines = await readXtermLines(win, { lines: 20 }).catch(() => []);
    const screen = lines.join('\n');
    if (promptRe.test(screen)) break;
    if (trustRe.test(screen)) {
      await sendToClaudeTui(win, '1\r').catch(() => {});
      await sleep(800);
      continue;
    }
    await sleep(600);
  }
  await dismissWelcomeSplash(win, { maxAttempts: 5, settleMs: 600 });
  for (let i = 0; i < 4; i++) {
    const lines = await readXtermLines(win, { lines: 12 }).catch(() => []);
    const screen = lines.join('\n');
    if (/│\s*>|^\s*>\s/m.test(screen)) return;
    await sendToClaudeTui(win, '\r').catch(() => {});
    await sleep(900);
  }
}

// ============================================================================
// Registry
// ============================================================================

const CASE_REGISTRY = [
  { name: 'new-session-chat',            group: 'shared', run: caseNewSessionChat },
  { name: 'switch-session-keeps-chat',   group: 'shared', run: caseSwitchSessionKeepsChat },
  { name: 'cwd-projects-claude',         group: 'shared', run: caseCwdProjectsClaude },
  { name: 'import-resume',               group: 'shared', run: caseImportResume },
  { name: 'default-cwd-from-userCwds-lru', group: 'shared', run: caseDefaultCwdFromUserCwdsLru },
  { name: 'new-session-focus-cli',       group: 'shared', run: caseNewSessionFocusCli },
  { name: 'pty-pid-stable-across-switch',group: 'shared', run: casePtyPidStableAcrossSwitch },
  { name: 'reopen-resume',               group: 'standalone', run: caseReopenResume },
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
      launched = await launchCcsmIsolated({ tempDir: isolated.tempDir });
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
