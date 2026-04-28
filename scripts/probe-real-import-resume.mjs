// Real-CLI e2e probe — UX H: import existing claude JSONL transcript and resume.
//
// Scenario:
//   1. User has prior raw `claude` CLI history (JSONL files under
//      ~/.claude/projects/<cwd-encoded>/<sid>.jsonl).
//   2. They open ccsm and run the Import flow.
//   3. ccsm scans those JSONLs, presents them in a picker, and on import
//      creates a session row whose id == JSONL UUID, and `resumeSessionId`
//      pointing at the same UUID.
//   4. User clicks the imported session → ttyd spawns claude with `--resume`,
//      restoring the prior conversation context inside the TUI.
//   5. User can send a follow-up prompt and claude replies as a continuation.
//
// What this probe covers (UX H end-to-end):
//   - Pre-seeds a synthetic JSONL transcript on disk in the isolated
//     CLAUDE_CONFIG_DIR so the scanner has something to find.
//   - Boots ccsm against that isolated dir.
//   - Drives the Import flow via window.ccsm.scanImportable + the store's
//     importSession action (the Import dialog's exact code path — same
//     reducer, same payload shape).
//   - Verifies the imported session lands in the sidebar with the right
//     id (== JSONL UUID).
//   - Selects the imported session and waits for the ttyd webview.
//   - Asserts claude restores the prior message history on the TUI by
//     scanning xterm buffer for the seeded user message ("PROBE_IMPORT_PING").
//   - Sends a follow-up prompt and asserts claude emits something back.
//   - Asserts no ttyd-exit event fired during the run.
//
// Known gap (#496) — RESOLVED by #464:
//   Previously, openTtydForSession unconditionally spawned
//   `claude --session-id <sid>`, which claude rejected with
//   "Session ID is already in use" whenever a JSONL for that sid was
//   already on disk (e.g. imported sessions). #464 made the backend
//   probe disk and pick `--resume <sid>` automatically when a transcript
//   exists, so this probe now PASSes end-to-end on `working` ≥ fadcd04.

import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
  waitForWebviewMounted,
  waitForXtermBuffer,
  readXtermLines,
  sendToClaudeTui,
} from './probe-utils-real-cli.mjs';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const screenshotDir = path.resolve('docs/screenshots/probe-real-import-resume');
mkdirSync(screenshotDir, { recursive: true });

const steps = [];
const log = (step, ok, detail) => {
  const entry = { step, ok, detail: detail ?? null };
  steps.push(entry);
  const tag = ok ? 'PASS' : 'FAIL';
  const tail = detail ? ' :: ' + JSON.stringify(detail).slice(0, 320) : '';
  console.log(`[STEP] ${step}: ${tag}${tail}`);
};

// claude encodes the absolute cwd into its on-disk project-dir name by
// replacing every `\`, `/`, and `:` character with a single `-`. e.g.
//   C:\Users\jiahuigu\proj  ->  C--Users-jiahuigu-proj
// (verified empirically — see ~/.claude/projects/ on the host machine.)
function encodeCwdForClaude(cwd) {
  return cwd.replace(/[\\\/:]/g, '-');
}

function nowTs() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

let electronApp = null;
let win = null;
let cleanupClaude = null;
let cleanupUd = null;
let ttydExitEvents = [];

const finish = async (exitCode, summary) => {
  // Try to capture a fail screenshot for diagnostics.
  if (exitCode !== 0 && win) {
    try {
      const failPath = path.join(screenshotDir, `fail-${nowTs()}.png`);
      await win.screenshot({ path: failPath, fullPage: true });
      console.log(`[fail-screenshot] ${failPath}`);
    } catch (e) {
      console.log('[fail-screenshot] failed:', e?.message || e);
    }
  }
  console.log('\n===== PROBE-REAL-IMPORT-RESUME REPORT =====');
  console.log(JSON.stringify({ steps, ttydExitEvents, summary }, null, 2));
  if (electronApp) {
    try { await electronApp.close(); } catch { /* ignore */ }
  }
  try { cleanupUd?.(); } catch { /* ignore */ }
  try { cleanupClaude?.(); } catch { /* ignore */ }
  console.log(exitCode === 0 ? '\n[PASS] probe-real-import-resume' : '\n[FAIL] probe-real-import-resume');
  process.exit(exitCode);
};

// Top-level error guard — propagate failures with context.
process.on('unhandledRejection', (err) => {
  log('unhandledRejection', false, String(err?.stack || err));
  void finish(1, { error: String(err?.message || err) });
});

(async () => {
  // --- 1. Isolated CLAUDE_CONFIG_DIR ---
  let tempDir;
  try {
    const iso = await createIsolatedClaudeDir();
    tempDir = iso.tempDir;
    cleanupClaude = iso.cleanup;
    log('isolate-claude-dir', true, { tempDir });
  } catch (err) {
    log('isolate-claude-dir', false, String(err?.message || err));
    return finish(1, { error: 'isolate-claude-dir' });
  }

  // --- 2. Pre-seed a JSONL transcript ---
  // Two distinct codepaths read the on-disk JSONL during this scenario,
  // and they look in DIFFERENT places when CLAUDE_CONFIG_DIR is set:
  //
  //   a) The Import scanner (electron/import-scanner.ts) hard-codes
  //      `os.homedir() + '/.claude/projects/'`. With HOME=tempDir, that
  //      resolves to `${tempDir}/.claude/projects/<encoded-cwd>/<sid>.jsonl`.
  //
  //   b) The claude binary itself, when invoked with `--resume <sid>`,
  //      scans `${CLAUDE_CONFIG_DIR}/projects/` (NO `.claude/` segment).
  //      Verified empirically: a fresh `claude` launched with
  //      CLAUDE_CONFIG_DIR=/tmp/x writes its JSONL to
  //      `/tmp/x/projects/<encoded-cwd>/<sid>.jsonl`, and `--resume` only
  //      finds conversations under that exact path.
  //
  // In production these collapse to the same dir (`~/.claude/projects/`),
  // but the probe sets HOME=CLAUDE_CONFIG_DIR=tempDir which exposes the
  // divergence. Seed BOTH locations so:
  //   - the Import scanner finds the row to import (path a), AND
  //   - claude `--resume <sid>` actually restores the transcript (path b).
  //
  // jsonlExistsForSid in electron/cliBridge/processManager.ts also scans
  // both roots (added in #464), so the ccsm spawn-decision picks --resume
  // whichever location the seed lives in — but only path (b) lets claude
  // itself reattach to the conversation, which is what makes the
  // history-restored assertion pass.
  const seedSid = randomUUID();
  // The session must record a cwd field that a) doesn't look like a ccsm
  // temp spawn (or the scanner's isCCSMTempCwd filter drops it) and
  // b) actually exists on disk so claude can chdir into it on resume.
  // Use the worktree root — definitely real, definitely not a ccsm temp.
  const seedCwd = process.cwd();
  const projectDirName = encodeCwdForClaude(seedCwd);
  // Path (a) — for the Import scanner.
  const scannerProjectDir = path.join(tempDir, '.claude', 'projects', projectDirName);
  // Path (b) — for `claude --resume`.
  const claudeProjectDir = path.join(tempDir, 'projects', projectDirName);
  mkdirSync(scannerProjectDir, { recursive: true });
  mkdirSync(claudeProjectDir, { recursive: true });
  const scannerJsonlPath = path.join(scannerProjectDir, `${seedSid}.jsonl`);
  const claudeJsonlPath = path.join(claudeProjectDir, `${seedSid}.jsonl`);

  // Synthesize a minimal but valid claude transcript head. Field shapes
  // chosen to match what real claude writes (verified by inspecting a
  // freshly-written JSONL on disk):
  //   - user.message.content is a STRING (not an API-style array of parts)
  //   - assistant.message.content IS an array of parts (mirrors API)
  //   - parentUuid:null + isSidechain:false on the head frame ensure it's
  //     treated as a top-level resumable session, not a sub-agent slice
  //   - version matches the running claude major (used by upgrade probes;
  //     a wildly-wrong version may make claude reject the file)
  const seedUserText = 'PROBE_IMPORT_PING please remember the token PROBE_IMPORT_PINEAPPLE';
  const userFrame = {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: seedUserText,
    },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    userType: 'external',
    cwd: seedCwd,
    sessionId: seedSid,
    version: '2.1.119',
    gitBranch: 'HEAD',
  };
  const aiTitleFrame = {
    type: 'ai-title',
    parentUuid: userFrame.uuid,
    isSidechain: false,
    sessionId: seedSid,
    cwd: seedCwd,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    aiTitle: 'probe imported session'
  };
  const assistantFrame = {
    parentUuid: userFrame.uuid,
    isSidechain: false,
    type: 'assistant',
    message: {
      id: 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24),
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'Got it, I will remember PROBE_IMPORT_PINEAPPLE.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    userType: 'external',
    cwd: seedCwd,
    sessionId: seedSid,
    version: '2.1.119',
    gitBranch: 'HEAD',
  };
  const jsonlBlob =
    [userFrame, aiTitleFrame, assistantFrame].map((f) => JSON.stringify(f)).join('\n') + '\n';
  writeFileSync(scannerJsonlPath, jsonlBlob);
  writeFileSync(claudeJsonlPath, jsonlBlob);
  log('seed-jsonl', existsSync(scannerJsonlPath) && existsSync(claudeJsonlPath), {
    scannerJsonlPath,
    claudeJsonlPath,
    seedSid,
    seedCwd,
    projectDirName,
  });

  // --- 2b. Pre-accept the trust dialog for seedCwd ---
  // claude shows "Quick safety check: Is this a project you trust?" the
  // first time it's launched in any cwd. That prompt blocks the TUI from
  // loading the resumed transcript (history-restored fails with the trust
  // prompt visible in the buffer). The trust state lives in
  // `${HOME}/.claude.json` under `projects[<absCwd>].hasTrustDialogAccepted`.
  // createIsolatedClaudeDir copies the user's `.claude.json` into tempDir,
  // but it almost certainly has no entry for the worktree path used as
  // seedCwd here — so we patch one in.
  try {
    const claudeJsonPath = path.join(tempDir, '.claude.json');
    let claudeJson = {};
    if (existsSync(claudeJsonPath)) {
      try { claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8')); }
      catch { claudeJson = {}; }
    }
    if (!claudeJson.projects || typeof claudeJson.projects !== 'object') {
      claudeJson.projects = {};
    }
    const existing = claudeJson.projects[seedCwd] || {};
    // claude stores project keys with forward slashes even on Windows
    // (verified: real ~/.claude.json on this host uses "C:/Users/..." keys).
    // Use BOTH the raw cwd and the forward-slashed variant to cover any
    // claude version that normalizes differently.
    const seedCwdFwd = seedCwd.replace(/\\/g, '/');
    const trustedEntry = {
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false,
      ...existing,
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: 1,
    };
    claudeJson.projects[seedCwd] = trustedEntry;
    claudeJson.projects[seedCwdFwd] = trustedEntry;
    writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
    log('pre-trust-cwd', true, { claudeJsonPath, seedCwd, seedCwdFwd });
  } catch (err) {
    log('pre-trust-cwd', false, String(err?.message || err));
    return finish(1, { error: 'pre-trust-cwd' });
  }

  // --- 3. Launch ccsm pointed at the isolated dir ---
  try {
    const launched = await launchCcsmIsolated({ tempDir });
    electronApp = launched.electronApp;
    win = launched.win;
    cleanupUd = launched.cleanup;
    log('launch-ccsm', true, { userDataDir: launched.userDataDir });
  } catch (err) {
    log('launch-ccsm', false, String(err?.message || err));
    return finish(1, { error: 'launch-ccsm' });
  }

  // Subscribe to ttyd-exit broadcasts in the renderer so an unexpected
  // backend death is visible in the report.
  try {
    await win.evaluate(() => {
      window.__ccsmTtydExits = [];
      const bridge = window.ccsmCliBridge;
      if (bridge?.onTtydExit) {
        bridge.onTtydExit((evt) => {
          try { window.__ccsmTtydExits.push(evt); } catch { /* ignore */ }
        });
      }
    });
  } catch (err) {
    log('hook-ttyd-exit', false, String(err?.message || err));
  }

  // --- 4. Drive the Import flow ---
  // The Import dialog calls window.ccsm.scanImportable() then runs the
  // store's importSession action for each picked row. Reproduce that
  // pipeline directly — fewer DOM interactions, same end state.
  let importResult;
  try {
    importResult = await win.evaluate(async (expectedSid) => {
      const api = window.ccsm;
      const useStore = window.__ccsmStore;
      if (!api || !api.scanImportable) {
        throw new Error('window.ccsm.scanImportable unavailable');
      }
      if (!useStore) throw new Error('window.__ccsmStore unavailable');
      const rows = await api.scanImportable();
      const found = rows.find((r) => r.sessionId === expectedSid);
      if (!found) {
        return {
          ok: false,
          rows: rows.map((r) => ({ sessionId: r.sessionId, cwd: r.cwd, title: r.title })),
          reason: 'seeded-jsonl-not-in-scan'
        };
      }
      const { importSession, createGroup, groups } = useStore.getState();
      let groupId = groups.find((g) => g.kind === 'normal' && g.name === 'Imported')?.id;
      if (!groupId) groupId = createGroup('Imported');
      const importedId = importSession({
        name: found.title,
        cwd: found.cwd,
        groupId,
        resumeSessionId: found.sessionId,
        projectDir: found.projectDir
      });
      // Make sure the imported session is the active one so TtydPane mounts.
      useStore.setState({ activeId: importedId, focusedGroupId: null });
      const after = useStore.getState();
      const session = after.sessions.find((s) => s.id === importedId);
      return {
        ok: true,
        importedId,
        scannedCount: rows.length,
        session: session
          ? {
              id: session.id,
              name: session.name,
              cwd: session.cwd,
              resumeSessionId: session.resumeSessionId,
              groupId: session.groupId
            }
          : null,
        activeId: after.activeId
      };
    }, seedSid);
  } catch (err) {
    log('import-flow', false, String(err?.message || err));
    return finish(1, { error: 'import-flow-eval' });
  }
  if (!importResult?.ok) {
    log('import-flow', false, importResult);
    return finish(1, { error: 'import-flow-not-found', importResult });
  }
  const importMatchesSid =
    importResult.importedId === seedSid &&
    importResult.session?.id === seedSid &&
    importResult.session?.resumeSessionId === seedSid;
  log('import-flow', importMatchesSid, importResult);
  if (!importMatchesSid) {
    return finish(1, { error: 'import-id-mismatch', importResult });
  }

  // Tiny settle so the renderer mounts TtydPane after activeId flip.
  await new Promise((r) => setTimeout(r, 1500));

  // Diagnostic: dump renderer-side render conditions for TtydPane. App.tsx
  // gates TtydPane on (active && claudeAvailable === true). If either is
  // off the webview never mounts and the next step fails opaquely.
  let renderState;
  try {
    renderState = await win.evaluate(() => {
      const useStore = window.__ccsmStore;
      const s = useStore?.getState?.();
      const active = s?.sessions?.find((x) => x.id === s.activeId);
      const probing = !!document.querySelector('[data-testid="claude-availability-probing"]');
      const firstRun = !!document.querySelector('[data-testid="first-run-empty"]');
      const skel = !!document.querySelector('[data-testid="sidebar-skeleton"]');
      const webview = document.querySelector('webview');
      return {
        activeId: s?.activeId ?? null,
        sessionsLen: s?.sessions?.length ?? 0,
        activeName: active?.name ?? null,
        activeResume: active?.resumeSessionId ?? null,
        probing,
        firstRun,
        skel,
        webviewTitle: webview?.getAttribute?.('title') ?? null,
        webviewSrc: webview?.getAttribute?.('src') ?? null
      };
    });
    log('render-state', true, renderState);
  } catch (err) {
    log('render-state', false, String(err?.message || err));
  }

  // --- 5. Wait for ttyd webview + xterm ---
  let wcId;
  try {
    wcId = await waitForWebviewMounted(win, electronApp, seedSid, { timeout: 30000 });
    log('webview-mounted', true, { wcId });
  } catch (err) {
    log('webview-mounted', false, String(err?.message || err));
    // Capture any ttyd-exit events to clarify whether ttyd died (the #496
    // failure mode: claude refuses --session-id <sid> when the JSONL
    // already exists, ttyd exits, webview never reaches xterm-ready).
    try {
      ttydExitEvents = await win.evaluate(() => window.__ccsmTtydExits || []);
    } catch { /* ignore */ }
    let postState;
    try {
      postState = await win.evaluate(() => {
        const probing = !!document.querySelector('[data-testid="claude-availability-probing"]');
        const firstRun = !!document.querySelector('[data-testid="first-run-empty"]');
        const missingGuide = !!document.querySelector('[data-testid="claude-missing-guide"]');
        const webview = document.querySelector('webview');
        // Walk every <main> and collect inner text per element separately
        // so we can tell sidebar text from right-pane text.
        const mains = Array.from(document.querySelectorAll('main')).map((m, i) => ({
          i,
          className: m.className?.slice?.(0, 120) ?? null,
          text: m.innerText?.slice(0, 600) ?? null
        }));
        // Webviews vs iframes anywhere in the tree.
        const allWebviews = Array.from(document.querySelectorAll('webview')).map((w) => ({
          title: w.getAttribute?.('title') ?? null,
          src: w.getAttribute?.('src') ?? null
        }));
        const allIframes = Array.from(document.querySelectorAll('iframe')).map((f) => ({
          title: f.getAttribute?.('title') ?? null,
          src: f.getAttribute?.('src') ?? null
        }));
        return {
          probing,
          firstRun,
          missingGuide,
          webviewTitle: webview?.getAttribute?.('title') ?? null,
          webviewSrc: webview?.getAttribute?.('src') ?? null,
          mains,
          allWebviews,
          allIframes,
          bodyTextHead: document.body.innerText?.slice(0, 800) ?? null
        };
      });
    } catch { /* ignore */ }
    return finish(1, {
      error: 'webview-mount',
      hint: 'pre-condition: TtydPane gated by claudeAvailable; OR import did not trigger ttyd spawn',
      ttydExitEvents,
      preMountRenderState: renderState,
      postMountRenderState: postState
    });
  }

  // --- 6. Wait for claude --resume to restore prior history in the TUI ---
  // On a working resume, claude prints the prior user message back into the
  // viewport before the prompt. We seeded "PROBE_IMPORT_PING" in user text,
  // so look for that token. Generous timeout — claude can take a few
  // seconds to read+replay the JSONL on cold start.
  let restoredOk = false;
  try {
    const matched = await waitForXtermBuffer(electronApp, wcId, /PROBE_IMPORT_PING/, {
      timeout: 30000
    });
    restoredOk = !!matched?.matched;
    log('history-restored', restoredOk, {
      tail: (matched?.full || '').slice(-300)
    });
  } catch (err) {
    log('history-restored', false, String(err?.message || err));
  }

  // Snapshot any ttyd-exit events seen so far — useful diagnostic.
  try {
    ttydExitEvents = await win.evaluate(() => window.__ccsmTtydExits || []);
  } catch { /* ignore */ }

  if (!restoredOk) {
    // Capture what's in the buffer for diagnostics.
    let lines = [];
    try { lines = await readXtermLines(electronApp, wcId, { lines: 40 }); } catch { /* ignore */ }
    return finish(1, {
      error: 'history-not-restored',
      // Classic regression of #464: backend spawned `--session-id` instead
      // of `--resume`. claude rejects with "Session ID is already in use"
      // (visible in the buffer tail) and ttyd exits before history paints.
      hint: 'regression of #464: jsonlExistsForSid did not detect the on-disk transcript, so backend spawned --session-id and claude rejected the duplicate id',
      ttydExitEvents,
      bufferTail: lines.slice(-20)
    });
  }

  // --- 7. Send a follow-up prompt and assert claude responds ---
  // Use a unique token in the prompt so we don't false-match against the
  // seeded history echo above.
  const followupToken = 'PROBE_FOLLOWUP_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  try {
    // Slight delay so claude is past the resume reflow and in input-ready state.
    await new Promise((r) => setTimeout(r, 2000));
    await sendToClaudeTui(
      electronApp,
      wcId,
      `Reply with the token ${followupToken} verbatim and nothing else.\r`
    );
    log('send-followup', true, { followupToken });
  } catch (err) {
    log('send-followup', false, String(err?.message || err));
    return finish(1, { error: 'send-followup' });
  }

  let followupOk = false;
  try {
    // Wait long enough for a real model round-trip on resume.
    const matched = await waitForXtermBuffer(electronApp, wcId, new RegExp(followupToken), {
      timeout: 90000
    });
    followupOk = !!matched?.matched;
    log('followup-replied', followupOk, {
      tail: (matched?.full || '').slice(-300)
    });
  } catch (err) {
    log('followup-replied', false, String(err?.message || err));
  }
  if (!followupOk) {
    let lines = [];
    try { lines = await readXtermLines(electronApp, wcId, { lines: 40 }); } catch { /* ignore */ }
    return finish(1, { error: 'followup-not-replied', bufferTail: lines.slice(-20) });
  }

  // --- 8. Confirm no ttyd-exit fired during the run ---
  try {
    ttydExitEvents = await win.evaluate(() => window.__ccsmTtydExits || []);
  } catch { /* ignore */ }
  const noExit = ttydExitEvents.length === 0;
  log('no-ttyd-exit', noExit, { ttydExitEvents });
  if (!noExit) {
    return finish(1, { error: 'unexpected-ttyd-exit', ttydExitEvents });
  }

  return finish(0, {
    seedSid,
    seedCwd,
    importedSession: importResult.session,
    followupToken
  });
})().catch((err) => {
  log('top-level', false, String(err?.stack || err));
  void finish(1, { error: 'top-level' });
});
