// Real-CLI e2e harness — runs all 5 UX-scenario probes against the prod
// bundle + the real claude binary in a single process.
//
// Cases (in run order):
//   1. new-session-chat              — UX C: new session opens claude, can chat
//   2. switch-session-keeps-chat     — UX F: session A↔B switch reuses ttyd, scrollback intact
//   3. cwd-projects-claude           — UX E: real cwd flows into claude's JSONL hash
//   4. import-resume                 — UX H: import existing JSONL, claude --resume restores
//   5. reopen-resume                 — UX G: close ccsm, reopen, click session, --resume restores
//
// Sharing strategy:
//   * Cases 1–4 share ONE Electron launch + ONE isolated tempDir. Each case
//     creates its own session(s) in the running app and relies on
//     CLAUDE_CONFIG_DIR / HOME = tempDir for filesystem isolation. Sessions
//     accumulate; later cases tolerate prior sessions in the store.
//   * Case 5 (reopen-resume) needs TWO launches with a shared userDataDir to
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
  executeJavaScriptOnWebview,
  launchCcsmIsolated,
  readXtermLines,
  seedSession,
  sendToClaudeTui,
  waitForWebviewMounted,
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
// Case 1: new-session-chat (UX C)
// ============================================================================

async function caseNewSessionChat({ electronApp, win, tempDir }) {
  const CHAT_PROMPT = 'say hi in 3 words';

  // Wait for claude availability probe to resolve so TtydPane will mount.
  await win.waitForFunction(
    () => !document.querySelector('[data-testid="claude-availability-probing"]'),
    null,
    { timeout: 30000 },
  );

  const { sid } = await seedSession(win, { name: 'probe-new-session', cwd: tempDir });
  if (!sid) throw new Error('seedSession returned empty sid');

  // Tiny settle for TtydPane mount.
  await sleep(4000);

  const wcId = await waitForWebviewMounted(win, electronApp, sid, { timeout: 60000 });

  await waitForXtermBuffer(electronApp, wcId, /trust|claude|welcome|│|╭|>/i, { timeout: 30000 });

  // Dismiss trust / welcome / theme splashes.
  for (let i = 0; i < 12; i++) {
    const lines = await readXtermLines(electronApp, wcId, { lines: 30 }).catch(() => []);
    const screen = lines.join('\n');
    if (/│\s*>/.test(screen) || /^\s*>\s/m.test(screen)) break;
    if (/trust|do you trust/i.test(screen)) {
      await sendToClaudeTui(electronApp, wcId, '1\r').catch(() => {});
    } else {
      await sendToClaudeTui(electronApp, wcId, '\r').catch(() => {});
    }
    await sleep(1500);
  }

  await sendToClaudeTui(electronApp, wcId, CHAT_PROMPT);
  await sleep(500);
  await sendToClaudeTui(electronApp, wcId, '\r');

  // Look for any substantive line after the echoed prompt that isn't the
  // prompt itself. Allow up to 90s for first reply (cold model).
  const start = Date.now();
  let replied = false;
  let lastLines = [];
  while (Date.now() - start < 90_000) {
    await sleep(2000);
    lastLines = await readXtermLines(electronApp, wcId, { lines: 60 }).catch(() => []);
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

  // No error toast / ttyd error state.
  const healthy = await win.evaluate(() => {
    const out = { errorToast: null, ttydErrorVisible: false };
    const errRegion = document.querySelector('[aria-live="assertive"]');
    if (errRegion) {
      const txt = (errRegion.textContent || '').trim();
      if (txt) out.errorToast = txt.slice(0, 240);
    }
    const buttons = Array.from(document.querySelectorAll('button'));
    out.ttydErrorVisible = buttons.some((b) => /^retry$/i.test((b.textContent || '').trim()));
    return out;
  });
  if (healthy.errorToast) throw new Error(`error toast surfaced: ${healthy.errorToast}`);
  if (healthy.ttydErrorVisible) throw new Error('TtydPane flipped to error state (Retry button visible)');
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

  await win.evaluate(() => {
    window.__probeTtydExits = window.__probeTtydExits || [];
    const bridge = window.ccsmCliBridge;
    if (bridge?.onTtydExit && !window.__probeTtydExitsHooked) {
      bridge.onTtydExit((evt) => window.__probeTtydExits.push(evt));
      window.__probeTtydExitsHooked = true;
    }
  });

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
    const wcA = await waitForWebviewMounted(win, electronApp, sidA, { timeout: 45000 });
    await waitForXtermBuffer(electronApp, wcA, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30000 });

    const portA1 = await getTtydPortForSid(win, sidA);
    if (!portA1 || portA1.__error || typeof portA1.port !== 'number') {
      throw new Error(`A's ttyd port not reported: ${JSON.stringify(portA1)}`);
    }

    // Advance any first-run prompts.
    for (let i = 0; i < 6; i++) {
      const lines = await readXtermLines(electronApp, wcA, { lines: 30 }).catch(() => []);
      const tail = lines.join('\n');
      if (/│\s*>/m.test(tail) || /^\s*>\s/m.test(tail)) break;
      await sendToClaudeTui(electronApp, wcA, '\r');
      await sleep(1500);
    }
    await dismissWelcomeSplash(electronApp, wcA);

    const ALPHA = 'Please reply with the single word ALPHA';
    const reply1 = await sendAndAwaitReply(electronApp, wcA, ALPHA, 'ALPHA');
    if (!reply1.ok) throw new Error(`A first reply (ALPHA) timed out. Tail:\n${reply1.tail}`);

    // Switch to B.
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidB);
    const wcB = await waitForWebviewMounted(win, electronApp, sidB, { timeout: 30000 });
    if (wcB === wcA) throw new Error(`switch to B: helper returned A's wcId (${wcA})`);
    await waitForXtermBuffer(electronApp, wcB, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30000 });
    await dismissWelcomeSplash(electronApp, wcB);

    const portA2 = await getTtydPortForSid(win, sidA);
    if (!portA2 || portA2.__error || portA2.port !== portA1.port) {
      throw new Error(`A's ttyd dropped after switching to B`);
    }

    // Switch BACK to A.
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
    await win.waitForSelector(`webview[title="ttyd session ${sidA}"]`, { timeout: 15000 });

    const portA3 = await getTtydPortForSid(win, sidA);
    if (!portA3 || portA3.__error || portA3.port !== portA1.port) {
      throw new Error(`A's port changed on switch-back (was ${portA1.port}, now ${JSON.stringify(portA3)})`);
    }

    const wcA2 = await waitForWebviewMounted(win, electronApp, sidA, { timeout: 30000 });
    const liveAfter = await listTtydWebviewIds(electronApp);
    const wcA2Entry = liveAfter.find((x) => x.id === wcA2);
    if (!wcA2Entry || !wcA2Entry.url.includes(`:${portA1.port}`)) {
      throw new Error(`A's new webview not on original port ${portA1.port}: ${wcA2Entry?.url}`);
    }

    // Re-dismiss trust/splash on the respawned claude.
    for (let i = 0; i < 6; i++) {
      const lines = await readXtermLines(electronApp, wcA2, { lines: 30 }).catch(() => []);
      const tail = lines.join('\n');
      if (/│\s*>/m.test(tail) || /^\s*>\s/m.test(tail)) break;
      await sendToClaudeTui(electronApp, wcA2, '\r');
      await sleep(1500);
    }

    // Wait for ALPHA scrollback to replay over the new client.
    try {
      await waitForXtermBuffer(electronApp, wcA2, /ALPHA/, { timeout: 15000 });
    } catch (_) { /* fall through */ }
    const aLines = await readXtermLines(electronApp, wcA2, { lines: 200 }).catch(() => []);
    if (!/ALPHA/.test(aLines.join('\n'))) {
      throw new Error(`A's scrollback lost ALPHA after switch-back. lines=${aLines.length}`);
    }

    await dismissWelcomeSplash(electronApp, wcA2);
    const BETA = 'Please reply with the single word BETA';
    const reply2 = await sendAndAwaitReply(electronApp, wcA2, BETA, 'BETA');
    if (!reply2.ok) throw new Error(`A second reply (BETA) timed out. Tail:\n${reply2.tail}`);

    const exitsForA = await win.evaluate(
      (sid) => (window.__probeTtydExits || []).filter((e) => e.sessionId === sid),
      sidA,
    );
    if (exitsForA.length > 0) throw new Error(`ttyd-exit fired for A: ${JSON.stringify(exitsForA)}`);

    const inUse = consoleErrors.find((e) => /already in use|session is already/i.test(e.text || ''));
    if (inUse) throw new Error(`renderer console "already in use" error: ${inUse.text}`);
  } finally {
    win.off('console', consoleHandler);
    win.off('pageerror', pageErrorHandler);
  }
}

async function sendAndAwaitReply(electronApp, wcId, prompt, replyToken, { timeout = 90000 } = {}) {
  await executeJavaScriptOnWebview(electronApp, wcId, `(function(){
    const ta = document.querySelector('.xterm-helper-textarea');
    if (ta) ta.focus();
    if (window.term && typeof window.term.focus === 'function') window.term.focus();
    return true;
  })()`);
  await sleep(300);
  await sendToClaudeTui(electronApp, wcId, prompt);
  await sleep(400);
  await sendToClaudeTui(electronApp, wcId, '\r');

  const deadline = Date.now() + timeout;
  let lastTail = '';
  while (Date.now() < deadline) {
    await sleep(2000);
    const lines = await readXtermLines(electronApp, wcId, { lines: 200 }).catch(() => []);
    const full = lines.join('\n');
    lastTail = full.slice(-800);
    const after = full.split(prompt).slice(1).join(prompt);
    if (after && new RegExp(replyToken).test(after)) return { ok: true, tail: lastTail };
  }
  return { ok: false, tail: lastTail };
}

async function listTtydWebviewIds(electronApp) {
  return await electronApp.evaluate(({ webContents }) => {
    const out = [];
    for (const wc of webContents.getAllWebContents()) {
      try {
        if (wc.getType() === 'webview' && /^http:\/\/127\.0\.0\.1:\d+/.test(wc.getURL())) {
          out.push({ id: wc.id, url: wc.getURL() });
        }
      } catch { /* ignore */ }
    }
    return out;
  });
}

async function getTtydPortForSid(win, sid) {
  return await win.evaluate(async (sessionId) => {
    const bridge = window.ccsmCliBridge;
    if (!bridge?.getTtydForSession) return null;
    try { return await bridge.getTtydForSession(sessionId); }
    catch (err) { return { __error: String(err) }; }
  }, sid);
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

  const wcId = await waitForWebviewMounted(win, electronApp, sid, { timeout: 25000 });
  await sleep(4000);

  await waitForXtermBuffer(electronApp, wcId, /my-project/, { timeout: 30000 });

  // Dismiss any splash before sending.
  for (let i = 0; i < 4; i++) {
    await sendToClaudeTui(electronApp, wcId, '\r');
    await sleep(700);
  }
  await sleep(1500);

  const PROMPT = `ccsm-probe-cwd marker ${MARKER_TOKEN}, please reply with the word PONG`;
  await sendToClaudeTui(electronApp, wcId, PROMPT);
  await sleep(800);
  {
    const tailLines = await readXtermLines(electronApp, wcId, { lines: 12 }).catch(() => []);
    if (!tailLines.some((l) => l.includes(MARKER_TOKEN.slice(0, 8)))) {
      await sleep(1000);
      await sendToClaudeTui(electronApp, wcId, PROMPT);
      await sleep(800);
    }
  }
  await sendToClaudeTui(electronApp, wcId, '\r');

  await waitForXtermBuffer(electronApp, wcId, /PONG/, { timeout: 90000 });

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

  // Hook ttyd-exit listener (additive — multiple cases may install).
  await win.evaluate(() => {
    window.__ccsmTtydExits = window.__ccsmTtydExits || [];
    const bridge = window.ccsmCliBridge;
    if (bridge?.onTtydExit && !window.__ccsmTtydExitsHooked) {
      bridge.onTtydExit((evt) => window.__ccsmTtydExits.push(evt));
      window.__ccsmTtydExitsHooked = true;
    }
  });
  // Snapshot exit count BEFORE this case to filter cross-case exits.
  const exitCountBefore = await win.evaluate(() => (window.__ccsmTtydExits || []).length);

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

  const wcId = await waitForWebviewMounted(win, electronApp, seedSid, { timeout: 30000 });

  // Wait for claude --resume to replay PROBE_IMPORT_PING.
  await waitForXtermBuffer(electronApp, wcId, /PROBE_IMPORT_PING/, { timeout: 30000 });

  const followupToken = 'PROBE_FOLLOWUP_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  await sleep(2000);
  await sendToClaudeTui(electronApp, wcId, `Reply with the token ${followupToken} verbatim and nothing else.\r`);
  await waitForXtermBuffer(electronApp, wcId, new RegExp(followupToken), { timeout: 90000 });

  const exitsAfter = await win.evaluate(() => window.__ccsmTtydExits || []);
  const exitsThisCase = exitsAfter.slice(exitCountBefore);
  if (exitsThisCase.length > 0) {
    throw new Error(`unexpected ttyd-exit during import-resume: ${JSON.stringify(exitsThisCase)}`);
  }
}

// ============================================================================
// Case 5: reopen-resume (UX G) — owns its launches
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

    const wcId1 = await waitForWebviewMounted(win1, app1, sessionId, { timeout: 30000 });
    await waitForXtermBuffer(app1, wcId1, /claude|welcome|│|╭|╰|\?\sfor\sshortcuts|trust/i, { timeout: 60000 });
    await dismissFirstRunModals(app1, wcId1);

    await sendToClaudeTui(app1, wcId1, PROMPT_1);
    await sleep(400);
    await sendToClaudeTui(app1, wcId1, '\r');

    await waitForXtermBuffer(
      app1, wcId1,
      new RegExp(`${SECRET_TOKEN}|remember|noted|got it|will remember|sure|okay`, 'i'),
      { timeout: 90000 },
    );

    await sleep(4000); // JSONL flush + persist debounce.
    await app1.close();
    app1 = null;

    // ---- run2 ----
    ({ electronApp: app2 } = await launchCcsmIsolated({ tempDir, userDataDir }));
    const win2 = await app2.firstWindow();
    let ttydExited = null;
    win2.on('console', (m) => {
      const txt = m.text();
      if (/ttyd-exit|ttyd_exited/i.test(txt)) ttydExited = txt;
    });

    const sessionRow = `[data-session-id="${sessionId}"]`;
    await win2.waitForSelector(sessionRow, { timeout: 15000 });
    await win2.locator(sessionRow).first().click();
    await sleep(500);
    const activeId = await win2.evaluate(() => window.__ccsmStore?.getState?.()?.activeId ?? null);
    if (activeId !== sessionId) throw new Error(`click did not set activeId. Got ${activeId}, expected ${sessionId}`);

    const wcId2 = await waitForWebviewMounted(win2, app2, sessionId, { timeout: 30000 });
    await waitForXtermBuffer(app2, wcId2, /claude|welcome|│|╭|╰|trust|\?\sfor\sshortcuts/i, { timeout: 60000 });
    await dismissFirstRunModals(app2, wcId2);

    await waitForXtermBuffer(app2, wcId2, new RegExp(SECRET_TOKEN), { timeout: 90000 });

    await sendToClaudeTui(app2, wcId2, PROMPT_2);
    await sleep(400);
    await sendToClaudeTui(app2, wcId2, '\r');

    let replied = false;
    let lastTail = '';
    const start = Date.now();
    while (Date.now() - start < 90000) {
      await sleep(2000);
      const lines = await readXtermLines(app2, wcId2, { lines: 200 }).catch(() => []);
      const full = lines.join('\n');
      lastTail = full.slice(-1200);
      const parts = full.split(PROMPT_2);
      const after = parts.length > 1 ? parts.slice(1).join(PROMPT_2) : '';
      if (after && new RegExp(SECRET_TOKEN, 'i').test(after)) { replied = true; break; }
    }
    if (!replied) throw new Error(`run2 follow-up no recognizable reply. Tail:\n${lastTail}`);

    if (ttydExited) throw new Error(`run2: ttyd-exit observed: ${ttydExited}`);
  } finally {
    if (app1) try { await app1.close(); } catch (_) { /* ignore */ }
    if (app2) try { await app2.close(); } catch (_) { /* ignore */ }
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    isolated.cleanup?.();
  }
}

async function dismissFirstRunModals(electronApp, wcId) {
  const trustRe = /trust the files|trust this folder|Do you trust|1\.\s*Yes|Yes, proceed/i;
  const promptRe = /│\s*>|^\s*>\s/m;

  for (let i = 0; i < 8; i++) {
    const lines = await readXtermLines(electronApp, wcId, { lines: 20 }).catch(() => []);
    const screen = lines.join('\n');
    if (promptRe.test(screen)) break;
    if (trustRe.test(screen)) {
      await sendToClaudeTui(electronApp, wcId, '1\r').catch(() => {});
      await sleep(800);
      continue;
    }
    await sleep(600);
  }
  await dismissWelcomeSplash(electronApp, wcId, { maxAttempts: 5, settleMs: 600 });
  for (let i = 0; i < 4; i++) {
    const lines = await readXtermLines(electronApp, wcId, { lines: 12 }).catch(() => []);
    const screen = lines.join('\n');
    if (/│\s*>|^\s*>\s/m.test(screen)) return;
    await sendToClaudeTui(electronApp, wcId, '\r').catch(() => {});
    await sleep(900);
  }
}

// ============================================================================
// Registry
// ============================================================================

const CASE_REGISTRY = [
  { name: 'new-session-chat',          group: 'shared', run: caseNewSessionChat },
  { name: 'switch-session-keeps-chat', group: 'shared', run: caseSwitchSessionKeepsChat },
  { name: 'cwd-projects-claude',       group: 'shared', run: caseCwdProjectsClaude },
  { name: 'import-resume',             group: 'shared', run: caseImportResume },
  { name: 'reopen-resume',             group: 'standalone', run: caseReopenResume },
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
