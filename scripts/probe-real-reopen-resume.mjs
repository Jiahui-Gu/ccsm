// Real-claude e2e probe — reopen ccsm and resume an existing session.
//
// UX scenario (Task #507, UX G — verbatim user words):
//   "3是关闭ccsm以后再打开，点击session可以聊天（暗含了resume在里面）"
//   Close ccsm, reopen it, click on a session, the chat must work — implicit:
//   `claude --resume` must restore the prior conversation across an app
//   restart (not just an in-memory session-switch).
//
// Probe flow:
//   1. Build an isolated ~/.claude tempDir (auth files only — see helper).
//   2. Launch ccsm run #1 with that tempDir + a caller-owned userDataDir
//      (helper API in #463: launchCcsmIsolated({ tempDir, userDataDir })
//      reuses the dir verbatim and skips auto-cleanup, so ccsm.db survives
//      across run1 → run2).
//   3. Seed a session, drive its ttyd webview, dismiss first-run modals
//      (trust folder, welcome splash), send a deterministic prompt
//      ("remember the word OMEGA") and wait for claude's reply.
//   4. Wait for the persist debounce (250 ms) + a cushion so ccsm.db
//      definitely contains the session row, then close run #1 cleanly.
//   5. Launch ccsm run #2 with SAME tempDir AND SAME userDataDir.
//   6. Verify the persisted session re-appears in the sidebar
//      ([data-session-id="<sid>"]). Click it.
//   7. The TtydPane will call openTtydForSession with the same ccsm sid →
//      processManager picks `--resume <sid>` because the JSONL exists on
//      disk (fix #464). claude rehydrates the prior transcript.
//   8. Dismiss the trust-folder modal AGAIN — claude re-prompts for trust
//      on every fresh launch in a folder, even though userDataDir reuse
//      preserves the Electron profile (the trust state lives in claude's
//      own state, not in the Electron user-data dir).
//   9. Grep the xterm buffer for the OMEGA token from run #1 — proof the
//      transcript was actually rehydrated, not a fresh empty session.
//  10. Send a follow-up message and confirm claude replies again.
//
// Output:
//   exit 0 + "[PASS]"   — all assertions held
//   exit 1 + "[FAIL]"   — failure + buffer dump + screenshot under
//                          docs/screenshots/probe-real-reopen-resume/

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  dismissWelcomeSplash,
  launchCcsmIsolated,
  readXtermLines,
  seedSession,
  sendToClaudeTui,
  waitForWebviewMounted,
  waitForXtermBuffer,
} from './probe-utils-real-cli.mjs';

const PROBE_NAME = 'probe-real-reopen-resume';
const SCREEN_DIR = path.resolve(`docs/screenshots/${PROBE_NAME}`);
mkdirSync(SCREEN_DIR, { recursive: true });

const SECRET_TOKEN = 'OMEGA';
const PROMPT_1 = `remember the word ${SECRET_TOKEN}`;
const PROMPT_2 = `what was the word I asked you to remember? reply with just the single word.`;

// --- utility ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
let lastWin = null;
async function snapFail(label) {
  if (!lastWin) return;
  try {
    await lastWin.screenshot({
      path: path.join(SCREEN_DIR, `fail-${ts()}-${label}.png`),
      fullPage: true,
    });
  } catch (_) {
    /* ignore */
  }
}

function fail(msg, extra) {
  console.error(`[FAIL] ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

// Dismiss claude's first-run modals that block the input box.
//
// Two stacked modals appear on a fresh launch in a folder claude hasn't
// seen before:
//
//   1. Trust-folder modal: "Do you trust the files in this folder?"
//      with numbered options "1. Yes, proceed", "2. No, exit". Claude
//      requires a digit response — a bare Enter is ignored. We send
//      '1\r' to accept trust.
//   2. Welcome / theme splash: "Welcome back!" / "Try /help" card that
//      eats the FIRST keystroke even after trust is granted. Helper
//      `dismissWelcomeSplash` handles this with bare Enter presses.
//
// Critically, the trust modal re-appears in run2 (post-restart) even
// though we reuse the Electron userDataDir — claude's trust state lives
// in claude's own config, and our isolated tempDir is the same across
// runs but the trust list inside it isn't reliably populated from a
// single in-app interaction. Both runs MUST handle the trust modal.
async function dismissFirstRunModals(electronApp, wcId, label) {
  const trustRe = /trust the files|trust this folder|Do you trust|1\.\s*Yes|Yes, proceed/i;
  const promptRe = /│\s*>|^\s*>\s/m;

  // Phase 1: trust modal. Up to 8 attempts of '1\r'. We keep checking
  // because the modal can take several hundred ms to react.
  let trusted = false;
  for (let i = 0; i < 8; i++) {
    const lines = await readXtermLines(electronApp, wcId, { lines: 20 }).catch(() => []);
    const screen = lines.join('\n');
    if (promptRe.test(screen)) {
      trusted = true;
      break;
    }
    if (trustRe.test(screen)) {
      await sendToClaudeTui(electronApp, wcId, '1\r').catch(() => {});
      await sleep(800);
      continue;
    }
    // No trust modal detected yet — could be still booting, or we're past
    // it. Wait a beat and re-check. If we see the prompt next iteration we
    // bail.
    await sleep(600);
  }
  console.log(`[INFO] ${label}: trust modal phase complete (trusted=${trusted})`);

  // Phase 2: welcome / theme splash via shared helper.
  const splashResult = await dismissWelcomeSplash(electronApp, wcId, {
    maxAttempts: 5,
    settleMs: 600,
  });
  console.log(
    `[INFO] ${label}: splash phase dismissed=${splashResult.dismissed} attempts=${splashResult.attempts}`,
  );

  // Phase 3: final fallback — if still no input prompt, press Enter a
  // couple more times. Some claude builds chain a third "tip" card.
  for (let i = 0; i < 4; i++) {
    const lines = await readXtermLines(electronApp, wcId, { lines: 12 }).catch(() => []);
    const screen = lines.join('\n');
    if (promptRe.test(screen)) return;
    await sendToClaudeTui(electronApp, wcId, '\r').catch(() => {});
    await sleep(900);
  }
}

// --- probe ---
let isolated;
let userDataDir;
let app1 = null;
let app2 = null;

try {
  isolated = await createIsolatedClaudeDir();
  const { tempDir } = isolated;
  // Pre-create our own userData dir; we'll reuse it across run 1 + run 2 so
  // the persisted ccsm.db (sessions table / app_state row) survives the
  // restart. Helper now accepts an external userDataDir (PR #463) and
  // skips auto-cleanup when caller owns it; we rmSync in `finally`.
  userDataDir = mkdtempSync(path.join(tmpdir(), 'ccsm-probe-reopen-userdata-'));
  console.log(`[INFO] tempDir=${tempDir}`);
  console.log(`[INFO] userDataDir=${userDataDir}`);

  // ============================================================
  // RUN 1: seed + drive + close
  // ============================================================
  console.log('[STEP] run1: launching ccsm');
  ({ electronApp: app1 } = await launchCcsmIsolated({ tempDir, userDataDir }));
  const win1 = await app1.firstWindow();
  lastWin = win1;
  win1.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'pageerror') {
      console.warn(`[run1 console.${t}] ${m.text()}`.slice(0, 400));
    }
  });

  // App.tsx gates TtydPane on `claudeAvailable === true` (resolved async via
  // bridge.checkClaudeAvailable). Wait for that boot probe to finish — without
  // it, the TtydPane never mounts and waitForWebviewMounted times out.
  await sleep(3500);

  // Seed a session pointing at the tempDir (so claude's JSONL lands inside
  // tempDir → preserved across runs).
  console.log('[STEP] run1: seeding session');
  const { sid: sessionId } = await seedSession(win1, {
    name: 'persist-session',
    cwd: tempDir,
  });
  if (!sessionId) fail('seedSession returned no sid');
  console.log(`[INFO] sessionId=${sessionId}`);

  // Wait for ttyd webview + xterm.
  console.log('[STEP] run1: waiting for ttyd webview');
  let wcId1;
  try {
    wcId1 = await waitForWebviewMounted(win1, app1, sessionId, { timeout: 30000 });
  } catch (err) {
    const dump = await win1.evaluate(() => {
      const w = window;
      const s = w.__ccsmStore?.getState?.();
      const webviewTags = Array.from(document.querySelectorAll('webview')).map((el) => ({
        title: el.getAttribute('title'),
        src: el.getAttribute('src'),
      }));
      const guideVisible = !!document.querySelector('[data-testid="claude-missing-guide"]') ||
        document.body.innerText?.includes('Claude is not installed');
      return {
        hydrated: s?.hydrated,
        sessionCount: s?.sessions?.length,
        activeId: s?.activeId,
        webviewTags,
        guideVisible,
        bodyText: (document.body.innerText || '').slice(0, 500),
      };
    });
    await snapFail('run1-no-webview');
    fail('run1: webview never mounted', JSON.stringify(dump, null, 2) + '\n' + String(err).slice(0, 400));
  }

  // Wait for claude banner / box-drawing chars / prompt — mirrors happy-path probe.
  console.log('[STEP] run1: waiting for claude banner');
  await waitForXtermBuffer(app1, wcId1, /claude|welcome|│|╭|╰|\?\sfor\sshortcuts|trust/i, {
    timeout: 60000,
  });

  // Dismiss trust modal + welcome splash.
  await dismissFirstRunModals(app1, wcId1, 'run1');

  // Send the deterministic remember prompt.
  console.log(`[STEP] run1: sending prompt "${PROMPT_1}"`);
  await sendToClaudeTui(app1, wcId1, PROMPT_1);
  await sleep(400);
  await sendToClaudeTui(app1, wcId1, '\r');

  // Wait for claude to actually reply (anything indicating it processed
  // the message — the literal token, "remember", "noted", "got it"). We
  // need confirmation the JSONL actually contains the assistant turn,
  // otherwise --resume won't have anything to restore.
  console.log('[STEP] run1: waiting for claude reply');
  try {
    await waitForXtermBuffer(
      app1,
      wcId1,
      new RegExp(`${SECRET_TOKEN}|remember|noted|got it|will remember|sure|okay`, 'i'),
      { timeout: 90000 },
    );
  } catch (err) {
    await snapFail('run1-no-reply');
    const tail = await readXtermLines(app1, wcId1, { lines: 40 }).catch(() => []);
    fail('run1: claude never acknowledged remember-prompt', tail.join('\n'));
  }

  // Give claude another beat to finish writing the JSONL turn to disk
  // (claude flushes after each completed message; 2s is generous).
  await sleep(2500);

  // Persist debounce (250ms) + cushion → ccsm.db has the session row.
  await sleep(1500);

  console.log('[STEP] run1: closing app');
  await app1.close();
  app1 = null;

  // ============================================================
  // RUN 2: relaunch + click persisted session + assert resume
  // ============================================================
  console.log('[STEP] run2: launching ccsm with SAME userDataDir + tempDir');
  ({ electronApp: app2 } = await launchCcsmIsolated({ tempDir, userDataDir }));
  const win2 = await app2.firstWindow();
  lastWin = win2;
  win2.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'pageerror') {
      console.warn(`[run2 console.${t}] ${m.text()}`.slice(0, 400));
    }
  });

  // Listen for ttyd-exit broadcasts during run2 — any unexpected death
  // is a probe failure.
  let ttydExited = null;
  win2.on('console', (m) => {
    const txt = m.text();
    if (/ttyd-exit|ttyd_exited/i.test(txt)) {
      ttydExited = txt;
    }
  });

  // Verify hydration completed and the persisted session is in the sidebar.
  console.log('[STEP] run2: verifying persisted session re-appeared');
  const sessionRow = `[data-session-id="${sessionId}"]`;
  try {
    await win2.waitForSelector(sessionRow, { timeout: 15000 });
  } catch (err) {
    await snapFail('run2-session-not-in-sidebar');
    // Dump store for diagnosis.
    const dump = await win2.evaluate(() => {
      const w = window;
      const s = w.__ccsmStore?.getState?.();
      if (!s) return { error: 'no __ccsmStore' };
      return {
        hydrated: s.hydrated,
        sessionCount: s.sessions?.length ?? -1,
        sessionIds: (s.sessions ?? []).map((x) => x.id),
        activeId: s.activeId,
      };
    });
    fail(
      `run2: persisted session ${sessionId} did not appear in sidebar (persistence broken)`,
      JSON.stringify(dump, null, 2),
    );
  }

  // Click it (covers the literal user words "点击session"). Some sidebar
  // implementations rely on a nested clickable child; click the row itself.
  console.log('[STEP] run2: clicking persisted session');
  await win2.locator(sessionRow).first().click();

  // Assert the activeId in the store became this sessionId — guards against
  // a click handler that's wired but no-ops.
  await sleep(500);
  const activeId = await win2.evaluate(
    () => window.__ccsmStore?.getState?.()?.activeId ?? null,
  );
  if (activeId !== sessionId) {
    await snapFail('run2-activeid-mismatch');
    fail(`run2: click did not set activeId. Got ${activeId}, expected ${sessionId}`);
  }

  // Wait for ttyd webview to mount (TtydPane will call openTtydForSession,
  // which spawns `claude --resume <sid>` because JSONL exists on disk
  // — fix #464. claude replays the prior transcript on attach).
  console.log('[STEP] run2: waiting for ttyd webview');
  const wcId2 = await waitForWebviewMounted(win2, app2, sessionId, { timeout: 30000 });

  // Wait for claude to produce SOMETHING (banner / trust prompt / replay).
  await waitForXtermBuffer(app2, wcId2, /claude|welcome|│|╭|╰|trust|\?\sfor\sshortcuts/i, {
    timeout: 60000,
  });

  // Dismiss trust modal + splash AGAIN. The trust modal re-appears even
  // with userDataDir reuse because claude's per-folder trust state isn't
  // reliably persisted in the isolated tempDir we hand it. Without this,
  // the trust modal eats the first follow-up keystroke and the probe
  // hangs waiting for a reply that was never delivered.
  await dismissFirstRunModals(app2, wcId2, 'run2');

  console.log('[STEP] run2: waiting for claude to print resumed transcript');
  // claude's --resume path replays the prior conversation into the screen
  // on attach. The OMEGA token from run #1 should appear somewhere in the
  // buffer once claude finishes re-rendering. Allow up to 90s — the cold
  // start dominates.
  try {
    await waitForXtermBuffer(app2, wcId2, new RegExp(SECRET_TOKEN), {
      timeout: 90000,
    });
  } catch (err) {
    await snapFail('run2-no-resumed-token');
    const tail = await readXtermLines(app2, wcId2, { lines: 60 }).catch(() => []);
    fail(
      `run2: token "${SECRET_TOKEN}" from run1 not found in resumed buffer (resume broken).\n` +
        `This UX scenario (close ccsm → reopen → click session → resume) does NOT work.\n` +
        `Expected: openTtydForSession detects existing JSONL and spawns \`claude --resume <sid>\` (fix #464).\n` +
        `If this fires after #464 merged, check whether the JSONL was actually written to ` +
        `\`\${tempDir}/projects/<cwd-hash>/<sid>.jsonl\` or to a different root.`,
      tail.join('\n'),
    );
  }
  console.log(`[OK] run2: token "${SECRET_TOKEN}" found in resumed buffer`);

  // Follow-up message: confirm chat is interactive after resume.
  console.log(`[STEP] run2: sending follow-up "${PROMPT_2}"`);
  await sendToClaudeTui(app2, wcId2, PROMPT_2);
  await sleep(400);
  await sendToClaudeTui(app2, wcId2, '\r');

  // Look for the token reappearing in claude's NEW reply. Strip the echoed
  // prompt to avoid matching the user's just-typed text. We pull a fresh
  // buffer over time and scan only what comes after the second occurrence
  // of PROMPT_2 (the echoed input box render).
  console.log('[STEP] run2: waiting for follow-up reply');
  let replied = false;
  let lastTail = '';
  const start = Date.now();
  const TIMEOUT = 90000;
  while (Date.now() - start < TIMEOUT) {
    await sleep(2000);
    const lines = await readXtermLines(app2, wcId2, { lines: 200 }).catch(() => []);
    const full = lines.join('\n');
    lastTail = full.slice(-1200);
    // Strip everything up through the echoed prompt to avoid matching the
    // user's typed-in OMEGA echo. The first occurrence is the run1 transcript
    // replay; the second-or-later is the new reply.
    const parts = full.split(PROMPT_2);
    const after = parts.length > 1 ? parts.slice(1).join(PROMPT_2) : '';
    if (after && new RegExp(SECRET_TOKEN, 'i').test(after)) {
      replied = true;
      break;
    }
  }
  if (!replied) {
    await snapFail('run2-followup-no-reply');
    fail('run2: follow-up message got no recognizable reply', lastTail);
  }

  if (ttydExited) {
    await snapFail('run2-ttyd-exited');
    fail(`run2: ttyd-exit observed during run: ${ttydExited}`);
  }

  console.log('[PASS] reopen + resume preserved transcript and chat is interactive');
  await app2.close();
  app2 = null;
  process.exit(0);
} catch (err) {
  console.error('[FAIL] unhandled probe error:', err?.stack || String(err));
  await snapFail('uncaught');
  process.exit(1);
} finally {
  if (app1) {
    try { await app1.close(); } catch (_) { /* ignore */ }
  }
  if (app2) {
    try { await app2.close(); } catch (_) { /* ignore */ }
  }
  if (userDataDir) {
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
  // isolated.cleanup auto-fires on process exit.
}
