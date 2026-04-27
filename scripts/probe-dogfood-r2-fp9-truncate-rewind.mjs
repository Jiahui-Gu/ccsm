// Dogfood r2 fp9 — Truncate from here + Edit (rewind/edit-and-resend) probe.
//
// Drives the installed CCSM.exe (production bundle) against the Agent Maestro
// proxy on localhost:23333 to exercise the user-message hover-menu actions:
//
//   - Truncate (Scissors): drops the in-memory transcript at the user message,
//     persists a `{ blockId, truncatedAt }` marker, drops `resumeSessionId`
//     so the next send respawns the CLI fresh.
//   - Edit (Pencil): non-destructive — loads original text into composer; the
//     user tweaks and hits send → that send becomes a NEW turn appended to
//     the existing history (NOT a replace).
//
// IMPORTANT: the spec for fp9 talks about "right-click context menu" and
// "Edit and resend replaces original turn AND everything after with new turn".
// That is NOT what ccsm currently implements — ccsm uses inline hover icons
// (Edit / Retry / Copy / Truncate), Edit is non-destructive, and Truncate is
// only available on user blocks. This probe verifies the ACTUAL behavior and
// reports the divergence.
//
// Output:
//   - docs/screenshots/dogfood-r2/fp9-truncate-rewind/check-{a..f}.png
//   - dogfood-logs/r2-fp9/probe.log (textual trace)
//   - per-step JSON snapshots of the store schema fields.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'docs/screenshots/dogfood-r2/fp9-truncate-rewind');
const LOG_DIR = path.join(REPO_ROOT, 'dogfood-logs/r2-fp9');
fs.mkdirSync(SHOTS_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const CCSM_EXE = 'C:\\Users\\jiahuigu\\AppData\\Local\\Programs\\CCSM\\CCSM.exe';
const USER_DATA = 'C:\\temp\\ccsm-dogfood-r2-fp9';
if (fs.existsSync(USER_DATA)) {
  fs.rmSync(USER_DATA, { recursive: true, force: true });
}
fs.mkdirSync(USER_DATA, { recursive: true });

const PROBE_CWD = path.join(os.tmpdir(), `ccsm-fp9-cwd-${Date.now()}`);
fs.mkdirSync(PROBE_CWD, { recursive: true });
fs.writeFileSync(path.join(PROBE_CWD, 'README.md'), 'fp9 probe sandbox\n', 'utf8');

const logPath = path.join(LOG_DIR, 'probe.log');
const logLines = [];
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ');
  console.log(line);
  logLines.push(`[${new Date().toISOString()}] ${line}`);
  fs.writeFileSync(logPath, logLines.join('\n'), 'utf8');
}

const findings = {};
function record(key, status, detail) {
  findings[key] = { status, detail };
  log(`==> ${key}: ${status}`, detail ?? '');
}

// Sanitize HOME-leaking skill env. We keep CLAUDE_CONFIG_DIR=~/.claude so the
// installed CCSM picks up real credentials/proxy config (per CLAUDE.md project
// rule "ccsm 通过 CLAUDE_CONFIG_DIR=~/.claude/ 让 binary 自己加载所有用户 CLI 配置").
const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: 'http://localhost:23333/api/anthropic',
  CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude'),
  CCSM_USER_DATA_DIR: USER_DATA
};

log('launching CCSM', { CCSM_EXE, USER_DATA, PROBE_CWD });

const app = await electron.launch({
  executablePath: CCSM_EXE,
  args: [`--user-data-dir=${USER_DATA}`],
  env,
  timeout: 60_000
});

let win;
try {
  win = await appWindow(app, { timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 30_000 });
  await win.waitForTimeout(500);

  async function shoot(name) {
    const file = path.join(SHOTS_DIR, `${name}.png`);
    await win.screenshot({ path: file });
    log(`captured ${file}`);
  }

  async function snapshotStore(label) {
    const snap = await win.evaluate(() => {
      const s = window.__ccsmStore.getState();
      const sid = s.activeId;
      const msgs = (s.messagesBySession?.[sid] || []).map((b) => ({
        kind: b.kind,
        id: b.id,
        text: typeof b.text === 'string' ? b.text.slice(0, 200) : undefined
      }));
      return {
        activeId: sid,
        sessionCount: (s.sessions || []).length,
        running: !!s.runningSessions?.[sid],
        messageCount: msgs.length,
        messageBlocks: msgs,
        statsCostUsd: s.statsBySession?.[sid]?.costUsd ?? null,
        contextUsage: s.contextUsageBySession?.[sid] ?? null,
        resumeSessionId: s.sessions?.find((x) => x.id === sid)?.resumeSessionId ?? null
      };
    });
    fs.writeFileSync(path.join(LOG_DIR, `snap-${label}.json`), JSON.stringify(snap, null, 2));
    log(`snap[${label}]`, snap);
    return snap;
  }

  // Wait for an active session; create one if onboarding gave us empty state.
  async function ensureSession() {
    const sid = await win.evaluate(async (cwd) => {
      const st = window.__ccsmStore.getState();
      let id = st.activeId;
      if (!id) {
        if (typeof st.createSession === 'function') {
          id = st.createSession(cwd);
        }
      }
      // Force cwd so agent can spawn correctly.
      if (id) {
        const s2 = window.__ccsmStore.getState();
        const sess = (s2.sessions || []).find((x) => x.id === id);
        if (sess && !sess.cwd) {
          window.__ccsmStore.setState((cur) => ({
            sessions: cur.sessions.map((x) => (x.id === id ? { ...x, cwd } : x))
          }));
        }
      }
      return id;
    }, PROBE_CWD);
    log('ensured session', { sid });
    return sid;
  }

  async function dismissOnboardingIfPresent() {
    // If onboarding tour or welcome dialog is up, escape past it.
    for (let i = 0; i < 3; i++) {
      const onb = await win.locator('[data-onboarding], [data-tutorial], [role="dialog"]').first();
      if (await onb.isVisible().catch(() => false)) {
        await win.keyboard.press('Escape');
        await win.waitForTimeout(300);
      } else {
        break;
      }
    }
  }

  await dismissOnboardingIfPresent();
  await shoot('00-app-launched');

  let sid = await ensureSession();
  if (!sid) {
    // Try clicking "New session" or similar via store action only.
    sid = await win.evaluate((cwd) => {
      const st = window.__ccsmStore.getState();
      if (typeof st.createSession === 'function') return st.createSession(cwd);
      return null;
    }, PROBE_CWD);
    log('fallback createSession', { sid });
  }
  await win.waitForTimeout(500);
  await shoot('01-session-ready');

  // ----- Send 3 prompts to build history -----
  async function sendPrompt(text, { waitForRunning = true } = {}) {
    log(`sending prompt: ${text}`);
    // Focus textarea and type
    const ta = win.locator('textarea[data-input-bar]').first();
    await ta.waitFor({ state: 'visible', timeout: 15_000 });
    await ta.click();
    await ta.fill(text);
    await win.waitForTimeout(150);
    await win.keyboard.press('Enter');
    if (waitForRunning) {
      // Wait for either the assistant block to appear (turn finished) or the
      // agent to settle. Cap at 90s per prompt.
      const start = Date.now();
      while (Date.now() - start < 90_000) {
        const stillRunning = await win.evaluate(() => {
          const s = window.__ccsmStore.getState();
          return !!s.runningSessions?.[s.activeId];
        });
        if (!stillRunning) {
          const hasAssistant = await win.evaluate(() => {
            const s = window.__ccsmStore.getState();
            const ms = s.messagesBySession?.[s.activeId] || [];
            return ms.some((b) => b.kind === 'assistant' || b.kind === 'error');
          });
          if (hasAssistant) break;
        }
        await win.waitForTimeout(500);
      }
      const finalSnap = await win.evaluate(() => {
        const s = window.__ccsmStore.getState();
        return { running: !!s.runningSessions?.[s.activeId], n: (s.messagesBySession?.[s.activeId] || []).length };
      });
      log(`prompt settled`, finalSnap);
    }
  }

  // Three short prompts to build user1/asst1 / user2/asst2 / user3/asst3.
  await sendPrompt('Reply with the single word: ALPHA').catch((e) => log('p1 err', String(e)));
  await win.waitForTimeout(800);
  await sendPrompt('Reply with the single word: BETA').catch((e) => log('p2 err', String(e)));
  await win.waitForTimeout(800);
  await sendPrompt('Reply with the single word: GAMMA').catch((e) => log('p3 err', String(e)));
  await win.waitForTimeout(800);

  const baseline = await snapshotStore('baseline-after-3-prompts');
  await shoot('02-baseline-3-turns');

  if (baseline.messageCount < 2) {
    record('PROBE_PRECONDITION', 'FAIL', `only ${baseline.messageCount} blocks — agent did not respond. Cannot run truncate/rewind checks.`);
    throw new Error('No agent responses captured — proxy or login failure?');
  }

  // ----- Check A: assistant block right-click for "Truncate from here" -----
  // Per the codebase, truncate ONLY exists on USER blocks via hover icons,
  // NOT a right-click on assistant blocks. We probe both interpretations.
  log('CHECK A: assistant right-click context menu');
  // Find an assistant block. Look for the assistant body via store.
  const assistantBlock = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    const ms = s.messagesBySession?.[s.activeId] || [];
    return ms.find((b) => b.kind === 'assistant') ?? null;
  });
  log('first assistant block', assistantBlock);
  let assistantHasTruncateMenu = false;
  if (assistantBlock) {
    // Try right-click on the assistant text region. Selector: assistant blocks
    // don't have a stable testid; we locate by markdown wrapper near the bubble.
    const aLoc = win.locator('[data-message-kind="assistant"], [class*="assistant"]').first();
    try {
      // Right-click anywhere in the chat surface; check if any context menu appears.
      const chatRegion = win.locator('main, [data-chat-stream]').first();
      if (await chatRegion.isVisible().catch(() => false)) {
        await chatRegion.click({ button: 'right', position: { x: 200, y: 200 } });
        await win.waitForTimeout(400);
        const menuVisible = await win.evaluate(() => {
          const ctx = document.querySelector('[role="menu"], [data-radix-popper-content-wrapper]');
          if (!ctx) return null;
          return { text: ctx.textContent?.slice(0, 500), html: ctx.outerHTML?.slice(0, 800) };
        });
        log('right-click context menu', menuVisible);
        if (menuVisible && /truncate|rewind/i.test(menuVisible.text || '')) {
          assistantHasTruncateMenu = true;
        }
      }
    } catch (e) {
      log('assistant right-click error', String(e));
    }
  }
  await shoot('check-a-assistant-rightclick');
  if (assistantHasTruncateMenu) {
    record('A', 'PASS', 'right-click on assistant shows Truncate menu');
  } else {
    record(
      'A',
      'FAIL',
      'no right-click context menu with Truncate on assistant blocks. ccsm implements Truncate only on USER blocks via hover-icon (Scissors), not right-click on assistant. Spec divergence.'
    );
  }

  // ----- Check B: send a new prompt after truncate, verify it continues from truncated point -----
  // Strategy: programmatically click the user-block Truncate button on USER #2
  // (so user1 + asst1 remain, user2/asst2/user3/asst3 dropped). Then send a new
  // prompt and verify the agent gets only the truncated context.
  log('CHECK B+F: truncate via user-block hover Scissors button');
  const userBlocks = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    const ms = s.messagesBySession?.[s.activeId] || [];
    return ms.filter((b) => b.kind === 'user').map((b) => ({ id: b.id, text: b.text?.slice(0, 80) }));
  });
  log('user blocks', userBlocks);

  // Find user2 — the second user block.
  const targetUserId = userBlocks[1]?.id;
  if (!targetUserId) {
    record('B', 'FAIL', 'fewer than 2 user blocks — cannot truncate at user2');
  } else {
    // Hover the user block to reveal action icons, then click the Scissors icon.
    // We selected via [data-user-block-id] which UserBlock.tsx sets.
    const target = win.locator(`[data-user-block-id="${targetUserId}"]`).first();
    await target.scrollIntoViewIfNeeded();
    await target.hover();
    await win.waitForTimeout(300);
    // The Truncate button has aria-label that matches t('chat.userMsgRewind') = "Truncate from here".
    const truncateBtn = target.locator('button[aria-label*="Truncate"], button[aria-label*="截断"]').first();
    const visible = await truncateBtn.isVisible().catch(() => false);
    log('truncate button visible?', visible);
    await shoot('check-b-pre-truncate-hover');
    if (visible) {
      await truncateBtn.click();
      await win.waitForTimeout(800);
      const afterTrunc = await snapshotStore('after-truncate-user2');
      await shoot('check-b-post-truncate');
      // Expect: messageCount dropped, last block is user2 (idx+1 slice).
      if (afterTrunc.messageCount < baseline.messageCount && afterTrunc.messageBlocks.at(-1)?.id === targetUserId) {
        record('B-truncate', 'PASS', `messages cut from ${baseline.messageCount} -> ${afterTrunc.messageCount}, last block is the truncated-at user message (kept per Bug #309).`);
      } else {
        record('B-truncate', 'PARTIAL', `truncate happened (${baseline.messageCount}->${afterTrunc.messageCount}) but last-block check unexpected: ${JSON.stringify(afterTrunc.messageBlocks.at(-1))}`);
      }
      // Now send a follow-up prompt — agent should respawn fresh with no --resume.
      await sendPrompt('Reply with the single word: DELTA').catch((e) => log('post-truncate send err', String(e)));
      await win.waitForTimeout(800);
      const afterResume = await snapshotStore('after-truncate-resume');
      await shoot('check-b-post-truncate-resume');
      if (afterResume.messageCount > afterTrunc.messageCount) {
        record('B', 'PASS', `new prompt continued after truncate. Final block count ${afterResume.messageCount}.`);
      } else {
        record('B', 'FAIL', 'no new blocks after sending post-truncate prompt — agent did not resume.');
      }
    } else {
      record('B-truncate', 'FAIL', 'Scissors/Truncate button not visible on hover');
    }
  }

  // ----- Check C: right-click user message → "Edit and resend" -----
  // ccsm has Edit as a Pencil hover-icon. Right-click user is NOT used.
  log('CHECK C: right-click user message');
  let userRightClickMenu = false;
  if (userBlocks[0]) {
    const u0 = win.locator(`[data-user-block-id="${userBlocks[0].id}"]`).first();
    try {
      await u0.click({ button: 'right' });
      await win.waitForTimeout(400);
      const menu = await win.evaluate(() => {
        const ctx = document.querySelector('[role="menu"], [data-radix-popper-content-wrapper]');
        if (!ctx) return null;
        return { text: ctx.textContent?.slice(0, 500) };
      });
      log('user right-click menu', menu);
      if (menu && /edit|resend|rewind/i.test(menu.text || '')) {
        userRightClickMenu = true;
      }
    } catch (e) {
      log('user right-click err', String(e));
    }
  }
  await shoot('check-c-user-rightclick');
  if (userRightClickMenu) {
    record('C-rightclick', 'PASS', 'right-click on user shows edit/resend menu');
  } else {
    record(
      'C-rightclick',
      'FAIL',
      'no right-click context menu on user. ccsm uses inline hover icons (Pencil=Edit, RotateCw=Retry, Copy, Scissors=Truncate). Spec divergence.'
    );
  }

  // Now exercise the actual Edit (Pencil) flow: click Edit on remaining user1,
  // verify text loads into composer, modify, send → verify it appended a NEW
  // turn (NOT replaced the original).
  log('CHECK C/D: Edit (Pencil) flow — verify replace-vs-append semantics');
  // Re-snapshot to get current state (user1 should still exist; we already
  // resumed with DELTA so layout is: user1, asst1, user2 (truncate point), user-DELTA, asst-DELTA).
  const preEditSnap = await snapshotStore('pre-edit');
  const remainingUsers = preEditSnap.messageBlocks.filter((b) => b.kind === 'user');
  const editTargetId = remainingUsers[0]?.id;
  if (!editTargetId) {
    record('C-edit', 'FAIL', 'no user blocks to edit');
  } else {
    const target = win.locator(`[data-user-block-id="${editTargetId}"]`).first();
    await target.scrollIntoViewIfNeeded();
    await target.hover();
    await win.waitForTimeout(300);
    const editBtn = target.locator('button[aria-label*="Edit"], button[aria-label*="编辑"]').first();
    const editVisible = await editBtn.isVisible().catch(() => false);
    log('edit button visible?', editVisible);
    await shoot('check-c-pre-edit-hover');
    if (!editVisible) {
      record('C-edit', 'FAIL', 'Edit button not visible on user block hover');
    } else {
      await editBtn.click();
      await win.waitForTimeout(400);
      // Composer should now contain the original text.
      const composerVal = await win.evaluate(() => {
        const ta = document.querySelector('textarea[data-input-bar]');
        return ta ? ta.value : null;
      });
      log('composer value after Edit click', composerVal);
      await shoot('check-c-composer-loaded');
      // Modify and resend.
      const modified = (composerVal ?? '') + ' (edited)';
      const ta = win.locator('textarea[data-input-bar]').first();
      await ta.fill(modified);
      await win.waitForTimeout(200);
      await win.keyboard.press('Enter');
      // Wait for settle.
      const start = Date.now();
      while (Date.now() - start < 60_000) {
        const r = await win.evaluate(() => !!window.__ccsmStore.getState().runningSessions?.[window.__ccsmStore.getState().activeId]);
        if (!r) break;
        await win.waitForTimeout(400);
      }
      await win.waitForTimeout(800);
      const postEditSnap = await snapshotStore('post-edit');
      await shoot('check-d-post-edit');
      // Replace semantics would mean: messageCount stays roughly same, original
      // user block is gone, a new user block with edited text replaces it.
      // Append semantics (ccsm actual): messageCount grows, original user
      // block is preserved, a new user block appended.
      const stillHasOrig = postEditSnap.messageBlocks.some((b) => b.id === editTargetId);
      const hasEditedText = postEditSnap.messageBlocks.some(
        (b) => b.kind === 'user' && typeof b.text === 'string' && b.text.includes('(edited)')
      );
      log('replace semantics?', { stillHasOrig, hasEditedText, count: postEditSnap.messageCount });
      if (stillHasOrig && hasEditedText) {
        record(
          'C',
          'PASS',
          'Edit loaded original text into composer; modified+send appended a NEW user turn (non-destructive — does NOT replace). This matches ccsm intentional design but DIVERGES from fp9 spec ("replace original turn AND everything after").'
        );
        record('D', 'FAIL', 'Edit-and-resend in ccsm APPENDS a new turn. The agent sees BOTH the original AND the edited prompt in history. Spec said it should REPLACE.');
      } else if (!stillHasOrig && hasEditedText) {
        record('C', 'PASS', 'Edit replaced original turn with edited text');
        record('D', 'PASS', 'replace semantics confirmed');
      } else {
        record('C', 'PARTIAL', `unexpected post-edit state: stillHasOrig=${stillHasOrig} hasEditedText=${hasEditedText}`);
        record('D', 'PARTIAL', 'unable to confirm replace semantics');
      }
    }
  }

  // ----- Check E: Edit on FIRST user message (edge case) -----
  // We already triggered Edit on remainingUsers[0] which IS the first remaining
  // user block. Record as covered by Check C above.
  record('E', findings['C']?.status === 'PASS' ? 'PASS' : findings['C']?.status === 'PARTIAL' ? 'PARTIAL' : 'FAIL', 'Edit on first user message exercised in Check C — same code path. Result inherited.');

  // ----- Check F: Cross-restart persistence of truncate marker -----
  log('CHECK F: cross-restart truncate persistence');
  const preRestartSnap = await snapshotStore('pre-restart');
  await shoot('check-f-pre-restart');

  // We need to truncate to a known point first so the marker is meaningful.
  // Truncate at the second user block again (whatever is second in current list).
  const usersBeforeRestart = preRestartSnap.messageBlocks.filter((b) => b.kind === 'user');
  const restartTruncId = usersBeforeRestart[1]?.id ?? usersBeforeRestart[0]?.id;
  if (restartTruncId) {
    const target = win.locator(`[data-user-block-id="${restartTruncId}"]`).first();
    await target.scrollIntoViewIfNeeded();
    await target.hover();
    await win.waitForTimeout(300);
    const truncateBtn = target.locator('button[aria-label*="Truncate"], button[aria-label*="截断"]').first();
    if (await truncateBtn.isVisible().catch(() => false)) {
      await truncateBtn.click();
      await win.waitForTimeout(800);
    }
  }
  const afterTruncRestart = await snapshotStore('after-truncate-before-restart');
  // Capture truncation marker via IPC.
  const markerBefore = await win.evaluate(async () => {
    if (!window.ccsm?.truncationGet) return null;
    const sid = window.__ccsmStore.getState().activeId;
    return await window.ccsm.truncationGet(sid);
  });
  log('truncation marker before restart', markerBefore);

  await app.close();
  log('app closed; relaunching');

  const app2 = await electron.launch({
    executablePath: CCSM_EXE,
    args: [`--user-data-dir=${USER_DATA}`],
    env,
    timeout: 60_000
  });
  const win2 = await appWindow(app2, { timeout: 30_000 });
  await win2.waitForLoadState('domcontentloaded');
  await win2.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 30_000 });
  await win2.waitForTimeout(2500); // hydration + JSONL load + truncation re-apply

  const postRestartSnap = await win2.evaluate(() => {
    const s = window.__ccsmStore.getState();
    const sid = s.activeId;
    const msgs = (s.messagesBySession?.[sid] || []).map((b) => ({ kind: b.kind, id: b.id }));
    return {
      activeId: sid,
      messageCount: msgs.length,
      blocks: msgs
    };
  });
  log('post-restart store', postRestartSnap);
  fs.writeFileSync(path.join(LOG_DIR, 'snap-post-restart.json'), JSON.stringify(postRestartSnap, null, 2));
  await win2.screenshot({ path: path.join(SHOTS_DIR, 'check-f-post-restart.png') });

  const markerAfter = await win2.evaluate(async () => {
    if (!window.ccsm?.truncationGet) return null;
    const sid = window.__ccsmStore.getState().activeId;
    return await window.ccsm.truncationGet(sid);
  });
  log('truncation marker after restart', markerAfter);

  if (markerBefore && markerAfter && markerBefore.blockId === markerAfter.blockId) {
    if (postRestartSnap.messageCount <= afterTruncRestart.messageCount + 2) {
      // +2 fuzz for any new resumed turns. The key signal is the marker survived.
      record('F', 'PASS', `truncation marker persisted across restart (blockId=${markerAfter.blockId}). Post-restart message count=${postRestartSnap.messageCount}.`);
    } else {
      record('F', 'PARTIAL', `marker persisted but post-restart message count grew unexpectedly: ${afterTruncRestart.messageCount} -> ${postRestartSnap.messageCount}. May indicate JSONL re-hydration didn't apply marker correctly.`);
    }
  } else {
    record(
      'F',
      'FAIL',
      `truncation marker lost or mismatched. before=${JSON.stringify(markerBefore)} after=${JSON.stringify(markerAfter)}`
    );
  }

  await app2.close();
} catch (e) {
  log('FATAL', String(e?.stack ?? e));
  try {
    if (win) await win.screenshot({ path: path.join(SHOTS_DIR, 'fatal-error.png') });
  } catch {}
} finally {
  fs.writeFileSync(path.join(LOG_DIR, 'findings.json'), JSON.stringify(findings, null, 2));
  log('=== FINDINGS ===');
  for (const [k, v] of Object.entries(findings)) log(`${k}: ${v.status} — ${v.detail}`);
  try {
    await app.close();
  } catch {}
}
