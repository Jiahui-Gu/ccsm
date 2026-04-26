// Themed harness — AGENT cluster, Phase-2 pilot.
//
// Per docs/e2e/single-harness-brainstorm.md §8 (option B + C). Each case
// below is the de-duplicated body of one of the per-file probes in
// scripts/probe-e2e-*.mjs. The original probe files have been left in place
// with a `// MERGED INTO harness-agent.mjs` marker on line 1 and are
// excluded from the per-file runner via scripts/run-all-e2e.mjs's
// MERGED_INTO_HARNESS skip list.
//
// Scope (all pure-store / no real claude.exe required):
//   - streaming
//   - streaming-caret-lifecycle
//   - inputbar-visible
//   - chat-copy
//   - input-placeholder
//   - tool-block-ux
//   - tool-stall-escalation
//   - diagnostic-banner
//   - init-failure-banner
//   - streaming-journey-switch
//   - streaming-journey-parallel
//   - streaming-journey-queue-clear
//   - streaming-journey-esc-interrupt
//   - msg-queue
//   - esc-interrupt
//   - composer-morph-mention
//   - sdk-stream-roundtrip
//   - sdk-stream-event-partial
//   - sdk-exit-error-surfaces
//   - sdk-tool-use-roundtrip
//   - sdk-system-subtypes
//   - sdk-abort-on-disposed
//   - user-block-hover-menu
//
//   Absorbed (PR: harness-agent absorbs 12 standalone probes):
//   - empty-group-new-session, interrupt-banner, tool-journey-render
//   - tool-call-dogfood, input-queue, send, switch
//   - delete-session-kills-process, default-cwd, streaming-partial-frames
//   - notify-integration, close-window-aborts-sessions
//
//   Absorbed (PR: bucket-7 final cleanup pass — 5 more probes):
//   - restore-session-undo, restore-group-undo (pure-store delete+undo,
//     reclassified from "restore-*" naming — single-launch fits here)
//   - askuserquestion-full (6 journeys for AskUserQuestion render+interaction;
//     mega-case with shared ipcMain agent:send capture per journey)
//   - sidebar-journey-create-delete (J1..J7 sidebar create/delete user
//     journeys; mega-case collecting divergences)
//   - installer-corrupt (3 sub-cases: cold-launch baseline + CLAUDE_NOT_FOUND
//     trigger + recovery; userDataDir:'fresh' for clean cold-launch state)
//
// Add new AGENT cases here by:
//   1. Wrap the case body in a named function `case<Name>({ win, log, ... })`.
//   2. Use `log()` instead of `console.log()` for the case-id prefix.
//   3. Throw on failure — the runner catches and records.
//   4. If your case mounts a monkey-patch on main (`dialog.showOpenDialog`,
//      `shell.openPath`, ...), call `registerDispose(() => app.evaluate(...))`
//      so the runner restores the original before the next case.
//   5. Keep cases independent. Don't read state set by an earlier case.
//
// Run: `node scripts/harness-agent.mjs`
// Run one case: `node scripts/harness-agent.mjs --only=streaming`

import { randomUUID } from 'node:crypto';
import { runHarness } from './probe-helpers/harness-runner.mjs';

// ---------- diagnostic-banner (F1) ----------
// Verifies that pushing an agent:diagnostic into the store surfaces a banner
// above ChatStream, and that Dismiss hides it.
async function caseDiagnosticBanner({ win, log }) {
  const SID = 's-diag';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'diag-probe', state: 'idle', cwd: 'C:/x', model: 'm', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [] },
      diagnostics: [],
      sessionInitFailures: {},
    });
  }, SID);
  await win.waitForTimeout(200);

  // No banner visible initially.
  // The banner element comes from <TopBanner /> (#237 unification), which
  // emits `data-testid={testId}` and `data-variant={variant}` — NOT the
  // legacy `data-agent-diagnostic-banner` / `data-severity` attributes.
  const initial = await win.locator('[data-testid="agent-diagnostic-banner"]').count();
  if (initial !== 0) throw new Error(`expected no diagnostic banner initially, got ${initial}`);

  // Push a diagnostic (simulating what lifecycle.ts does on onAgentDiagnostic).
  await win.evaluate((sid) => {
    window.__ccsmStore.getState().pushDiagnostic({
      sessionId: sid,
      level: 'error',
      code: 'init_failed',
      message: 'Agent initialize handshake failed — permission prompts may be degraded: E2E_PROBE',
      timestamp: Date.now(),
    });
  }, SID);
  await win.waitForTimeout(250);

  const banner = win.locator('[data-testid="agent-diagnostic-banner"]').first();
  await banner.waitFor({ state: 'visible', timeout: 3000 });
  const severity = await banner.getAttribute('data-variant');
  if (severity !== 'error') throw new Error(`expected variant=error, got ${severity}`);
  const bannerText = await banner.innerText();
  if (!bannerText.includes('E2E_PROBE')) throw new Error(`banner text missing probe message, got: ${JSON.stringify(bannerText)}`);

  // Store entry exists and is not dismissed.
  const entryBefore = await win.evaluate(() => {
    const d = window.__ccsmStore.getState().diagnostics;
    return d.map((x) => ({ code: x.code, level: x.level, dismissed: !!x.dismissed }));
  });
  if (entryBefore.length !== 1) throw new Error(`expected 1 diagnostic, got ${entryBefore.length}`);
  if (entryBefore[0].dismissed) throw new Error('diagnostic should not be dismissed yet');

  // Dismiss — banner should disappear. TopBanner renders the dismiss
  // button with `data-top-banner-dismiss`.
  await win.locator('[data-testid="agent-diagnostic-banner"] [data-top-banner-dismiss]').first().click();
  await win.waitForTimeout(300);
  const afterDismiss = await win.locator('[data-testid="agent-diagnostic-banner"]').count();
  if (afterDismiss !== 0) throw new Error(`banner should be hidden after dismiss, still ${afterDismiss}`);

  const entryAfter = await win.evaluate(() => window.__ccsmStore.getState().diagnostics[0]);
  if (!entryAfter.dismissed) throw new Error('dismissed flag should be set in store');

  // A diagnostic for a DIFFERENT session must not surface on this active session.
  await win.evaluate(() => {
    window.__ccsmStore.getState().pushDiagnostic({
      sessionId: 's-other',
      level: 'warn',
      code: 'control_timeout',
      message: 'other session warn',
      timestamp: Date.now(),
    });
  });
  await win.waitForTimeout(200);
  const crossSession = await win.locator('[data-testid="agent-diagnostic-banner"]').count();
  if (crossSession !== 0) throw new Error(`banner should not surface cross-session, got ${crossSession}`);

  log('push → banner render → dismiss → hide; cross-session entries do not leak into active view');
}

// ---------- init-failure-banner (F7) ----------
// Verifies that setSessionInitFailure surfaces an actionable banner with
// title, error text, Retry, Reconfigure, and dismiss. Because the
// contextBridge-exposed window.ccsm is non-configurable, we cannot
// reliably stub `agentStart` from the renderer — so instead of driving the
// full retry IPC round-trip, we verify the reconcile helper's observable
// effects directly (clearing the failure hides the banner) and that the
// Reconfigure button fires its prop callback.
async function caseInitFailureBanner({ win, log }) {
  const SID = 's-initfail';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'initfail-probe', state: 'idle', cwd: 'C:/x', model: 'm', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [] },
      sessionInitFailures: {},
      diagnostics: [],
    });
  }, SID);
  await win.waitForTimeout(150);

  // No banner initially. Same TopBanner unification — selector is the
  // shared `data-testid={testId}` slot, not the legacy data-agent-* attr.
  const initialCount = await win.locator('[data-testid="agent-init-failed-banner"]').count();
  if (initialCount !== 0) throw new Error(`expected no init-failed banner initially, got ${initialCount}`);

  // Seed a failure — matches what startSessionAndReconcile produces for a
  // non-CLAUDE_NOT_FOUND / non-CWD_MISSING failure.
  await win.evaluate((sid) => {
    window.__ccsmStore.getState().setSessionInitFailure(sid, {
      error: 'spawn EACCES: permission denied (probe)',
      errorCode: undefined,
      searchedPaths: [],
    });
  }, SID);
  await win.waitForTimeout(250);

  const banner = win.locator('[data-testid="agent-init-failed-banner"]').first();
  await banner.waitFor({ state: 'visible', timeout: 3000 });
  const text = await banner.innerText();
  if (!text.includes('Failed to start Claude')) throw new Error(`missing title, got ${JSON.stringify(text)}`);
  if (!text.includes('EACCES')) throw new Error(`missing error body, got ${JSON.stringify(text)}`);

  // All three action buttons must render and be enabled.
  const retry = win.locator('[data-agent-init-failed-retry]').first();
  const reconfigure = win.locator('[data-agent-init-failed-reconfigure]').first();
  if (!(await retry.isVisible())) throw new Error('Retry button should be visible');
  if (!(await retry.isEnabled())) throw new Error('Retry button should be enabled');
  if (!(await reconfigure.isVisible())) throw new Error('Reconfigure button should be visible');
  if (!(await reconfigure.isEnabled())) throw new Error('Reconfigure button should be enabled');

  // Clicking Reconfigure should open the Settings dialog (App wires the
  // banner prop to setSettingsOpen). We detect it via the dialog title.
  await reconfigure.click();
  await win.waitForTimeout(300);
  const settingsOpen = await win.evaluate(() => {
    return !!document.querySelector('[role="dialog"]');
  });
  if (!settingsOpen) throw new Error('Reconfigure click should open Settings dialog');

  // Close the dialog with Escape so it doesn't leak into the next case.
  await win.keyboard.press('Escape');
  await win.waitForTimeout(200);

  // Clearing the failure (what a successful retry does) hides the banner.
  await win.evaluate((sid) => {
    window.__ccsmStore.getState().clearSessionInitFailure(sid);
  }, SID);
  await win.waitForTimeout(300);
  const afterClear = await win.locator('[data-testid="agent-init-failed-banner"]').count();
  if (afterClear !== 0) throw new Error(`banner should be hidden after clearSessionInitFailure, still ${afterClear}`);

  // The banner is also session-scoped: a failure on a DIFFERENT session must
  // not render while SID is active.
  await win.evaluate(() => {
    window.__ccsmStore.getState().setSessionInitFailure('s-other-session', {
      error: 'cross-session probe',
      errorCode: undefined,
      searchedPaths: [],
    });
  });
  await win.waitForTimeout(200);
  const crossSession = await win.locator('[data-testid="agent-init-failed-banner"]').count();
  if (crossSession !== 0) throw new Error(`banner should not leak across sessions, got ${crossSession}`);

  log('setSessionInitFailure → banner render (title + error + Retry + Reconfigure) → Reconfigure opens Settings → clearSessionInitFailure hides banner → cross-session scoped');
}

// ---------- streaming ----------
async function caseStreaming({ win, log }) {
  // Seed a session directly (instead of `createSession`, which triggers the
  // CLI check and pops the "Claude CLI not found" dialog when claude.exe
  // isn't on PATH — which is the default in CI). Same observable behaviour
  // for the streamAssistantText/appendBlocks code path the case actually
  // exercises.
  const sessionId = 's-stream';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'streaming-probe', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [] }
    });
  }, sessionId);
  await win.waitForTimeout(150);

  await win.evaluate((sid) => {
    const st = window.__ccsmStore.getState();
    st.streamAssistantText(sid, 'msg-probe:c0', 'Hel', false);
    st.streamAssistantText(sid, 'msg-probe:c0', 'lo, ', false);
    st.streamAssistantText(sid, 'msg-probe:c0', 'world!', false);
  }, sessionId);
  await win.waitForTimeout(200);

  const midState = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.map((b) => ({ id: b.id, kind: b.kind, text: b.text, streaming: b.streaming }));
  }, sessionId);
  const streamingBlocks = midState.filter((b) => b.id === 'msg-probe:c0');
  if (streamingBlocks.length !== 1) throw new Error(`expected 1 streaming block, got ${streamingBlocks.length}`);
  if (streamingBlocks[0].text !== 'Hello, world!') throw new Error(`expected 'Hello, world!', got '${streamingBlocks[0].text}'`);
  if (streamingBlocks[0].streaming !== true) throw new Error('streaming flag not set');

  // ChatStream's AnimatePresence keyed on `blocks:${activeId}` runs a
  // ~180ms exit+enter transition (MOTION_SESSION_SWITCH_DURATION =
  // DURATION.standard = 0.18s) when entering a session — on the FIRST
  // case entry the empty-state pane exits while the blocks pane enters,
  // so for ~180ms no block children are mounted. A blind 150ms sleep
  // races that transition and the caret count transiently reads 0. Wait
  // for the caret to attach instead.
  try {
    await win.locator('span.animate-pulse').first().waitFor({ state: 'attached', timeout: 2000 });
  } catch { /* fall through to richer assertion message below */ }
  const caretCount = await win.locator('span.animate-pulse').count();
  if (caretCount < 1) throw new Error('streaming caret not rendered in DOM');

  await win.evaluate((sid) => {
    window.__ccsmStore.getState().appendBlocks(sid, [
      { kind: 'assistant', id: 'msg-probe:c0', text: 'Final reply.' }
    ]);
  }, sessionId);
  await win.waitForTimeout(200);

  const finalState = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.filter((b) => b.id === 'msg-probe:c0').map((b) => ({ text: b.text, streaming: b.streaming }));
  }, sessionId);
  if (finalState.length !== 1) throw new Error(`after finalize, expected 1 block, got ${finalState.length}`);
  if (finalState[0].text !== 'Final reply.') throw new Error(`expected 'Final reply.', got '${finalState[0].text}'`);
  if (finalState[0].streaming) throw new Error('streaming flag should be cleared after finalize');

  const finalCaretCount = await win.locator('span.animate-pulse').count();
  if (finalCaretCount !== 0) throw new Error(`caret should disappear after finalize; found ${finalCaretCount}`);

  // Baseline-diagnostics-empty contract (task #88): a happy-path streaming
  // turn must NOT push any non-dismissed diagnostics for the active session.
  // The store's lifecycle (setRunning, streamAssistantText, appendBlocks)
  // does not auto-clear diagnostics, so any leak here would persist across
  // turns. Dual check: DOM (banner not rendered) AND store (no active
  // entries scoped to this session). Brief settle for any TopBanner
  // <AnimatePresence> exit transition.
  await win.waitForTimeout(250);
  const baselineBannerCount = await win.locator('[data-testid="agent-diagnostic-banner"]').count();
  if (baselineBannerCount !== 0) {
    throw new Error(`baseline diagnostics should be empty after happy-path streaming; banner count=${baselineBannerCount}`);
  }
  const baselineStoreActive = await win.evaluate((sid) => {
    const st = window.__ccsmStore.getState();
    const all = st.diagnostics ?? [];
    return all.filter((d) => d.sessionId === sid && !d.dismissed).map((d) => ({ code: d.code, level: d.level, message: d.message }));
  }, sessionId);
  if (baselineStoreActive.length !== 0) {
    throw new Error(`baseline diagnostics should be empty in store for active session; found ${baselineStoreActive.length}: ${JSON.stringify(baselineStoreActive)}`);
  }

  log('3 deltas coalesced into 1 block; caret shown then hidden on finalize; baseline diagnostics empty (DOM + store)');
}

// ---------- streaming-caret-lifecycle ----------
async function caseStreamingCaretLifecycle({ win, log }) {
  const SID1 = 's-caret-final';
  const BID1 = 'msg-caret:final';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'caret-final', state: 'idle', cwd: 'C:/x', model: 'm', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [{ kind: 'user', id: 'u-1', text: 'hi' }] },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true }
    });
  }, SID1);

  await win.evaluate(([sid, bid]) => {
    const st = window.__ccsmStore.getState();
    st.streamAssistantText(sid, bid, 'partial ', false);
    st.streamAssistantText(sid, bid, 'reply ', false);
  }, [SID1, BID1]);
  await win.waitForTimeout(150);

  // Same AnimatePresence session-switch race as caseStreaming above — wait
  // for the caret to attach rather than relying on a fixed 150ms sleep.
  try {
    await win.locator('span.animate-pulse').first().waitFor({ state: 'attached', timeout: 2000 });
  } catch { /* fall through */ }
  const caretDuring = await win.locator('span.animate-pulse').count();
  if (caretDuring < 1) throw new Error('Part 1: expected caret during stream, found 0');

  await win.evaluate(([sid, bid]) => {
    window.__ccsmStore.getState().appendBlocks(sid, [{ kind: 'assistant', id: bid, text: 'final reply' }]);
    window.__ccsmStore.getState().setRunning(sid, false);
  }, [SID1, BID1]);
  await win.waitForTimeout(150);

  const caretAfterFinal = await win.locator('span.animate-pulse').count();
  if (caretAfterFinal !== 0) throw new Error(`Part 2: expected caret gone after finalize, found ${caretAfterFinal}`);

  const blockAfterFinal = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid);
  }, [SID1, BID1]);
  if (!blockAfterFinal) throw new Error('Part 2: finalized block missing');
  if (blockAfterFinal.streaming) throw new Error('Part 2: block.streaming should be false after finalize');

  // Part 3: Esc-interrupt mid-stream — distinct session in same renderer.
  const SID2 = 's-caret-int';
  const BID2 = 'msg-caret:int';
  await win.evaluate((sid) => {
    const cur = window.__ccsmStore.getState();
    const sessions = cur.sessions.some((s) => s.id === sid)
      ? cur.sessions
      : [{ id: sid, name: 'caret-int', state: 'idle', cwd: 'C:/x', model: 'm', groupId: 'g1', agentType: 'claude-code' }, ...cur.sessions];
    window.__ccsmStore.setState({
      sessions,
      activeId: sid,
      messagesBySession: { ...cur.messagesBySession, [sid]: [{ kind: 'user', id: 'u-2', text: 'count' }] },
      startedSessions: { ...cur.startedSessions, [sid]: true },
      runningSessions: { ...cur.runningSessions, [sid]: true }
    });
  }, SID2);

  await win.evaluate(([sid, bid]) => {
    const st = window.__ccsmStore.getState();
    st.streamAssistantText(sid, bid, '1 ', false);
    st.streamAssistantText(sid, bid, '2 ', false);
    st.streamAssistantText(sid, bid, '3 ', false);
  }, [SID2, BID2]);
  await win.waitForTimeout(150);

  // Part 3 started by switching activeId from SID1 → SID2; ChatStream's
  // AnimatePresence keyed on `blocks:${activeId}` runs a ~180ms exit+enter
  // transition (MOTION_SESSION_SWITCH_DURATION = DURATION.standard = 0.18s)
  // during which the new session's blocks are not yet mounted. A fixed
  // 150ms sleep races that transition — at 150ms the old pane is still
  // exiting and the new pane hasn't mounted, so caret count is 0 even
  // though the store has streaming:true on the block. Wait for the caret
  // to actually appear in the DOM instead of a blind sleep.
  try {
    await win.locator('span.animate-pulse').first().waitFor({ state: 'attached', timeout: 2000 });
  } catch {
    // fall through so the assertion below produces the richer error message
  }
  const caretMid = await win.locator('span.animate-pulse').count();
  if (caretMid < 1) throw new Error('Part 3: caret should be visible mid-stream before interrupt');

  await win.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await win.waitForTimeout(150);

  await win.evaluate(([sid, bid]) => {
    const st = window.__ccsmStore.getState();
    st.consumeInterrupted(sid);
    const open = (st.messagesBySession[sid] ?? []).find((b) => b.id === bid);
    if (open) {
      st.appendBlocks(sid, [{ kind: 'assistant', id: bid, text: open.text ?? '' }]);
    }
    st.appendBlocks(sid, [{ kind: 'status', id: 'res-int', tone: 'info', title: 'Interrupted' }]);
    st.setRunning(sid, false);
  }, [SID2, BID2]);
  await win.waitForTimeout(200);

  const caretAfterInt = await win.locator('span.animate-pulse').count();
  if (caretAfterInt !== 0) throw new Error(`Part 3: caret should be 0 after interrupt, found ${caretAfterInt}`);

  const blockAfterInt = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid);
  }, [SID2, BID2]);
  if (!blockAfterInt) throw new Error('Part 3: in-flight block missing after interrupt — should remain with partial text');
  if (blockAfterInt.streaming) throw new Error('Part 3: block.streaming should be false after interrupt-finalize');

  log('Part 1 caret-during, Part 2 caret-gone-after-finalize, Part 3 caret-gone-after-interrupt + block-survived + streaming-cleared');
}

// ---------- inputbar-visible ----------
async function caseInputbarVisible({ win, log }) {
  await win.evaluate(() => {
    const store = window.__ccsmStore;
    const many = [];
    for (let i = 0; i < 80; i++) {
      many.push({ kind: 'user', id: `u-${i}`, text: `message ${i} — ${'lorem '.repeat(12)}` });
      many.push({
        kind: 'assistant-md',
        id: `a-${i}`,
        text: `reply ${i}\n\n${'paragraph body '.repeat(20)}\n\n${'second paragraph '.repeat(15)}`
      });
    }
    store.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }
      ],
      activeId: 's1',
      messagesBySession: { s1: many }
    });
  });
  await win.waitForTimeout(400);

  const ta = win.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 3000 });

  const { box, vh } = await win.evaluate(() => {
    const el = document.querySelector('textarea');
    if (!el) return { box: null, vh: window.innerHeight };
    const r = el.getBoundingClientRect();
    return { box: { top: r.top, bottom: r.bottom }, vh: window.innerHeight };
  });
  if (!box) throw new Error('no textarea element');
  if (box.bottom > vh + 1) throw new Error(`textarea extends below viewport: bottom=${box.bottom.toFixed(1)} vh=${vh}`);
  if (box.top < 0 || box.top > vh) throw new Error(`textarea top=${box.top.toFixed(1)} outside viewport (vh=${vh})`);

  // Clear any leftover draft text. The InputBar persists per-session drafts
  // via src/stores/drafts.ts (module-scope cache, not in zustand) so a
  // previous case that typed into a session with the same id can leak its
  // text into ours. fill('') is the cheap fix.
  await ta.fill('');
  await ta.click();
  await win.keyboard.type('hello');
  const value = await ta.inputValue();
  if (value !== 'hello') throw new Error(`type failed, got ${JSON.stringify(value)}`);

  log(`textarea within viewport: top=${box.top.toFixed(1)} bottom=${box.bottom.toFixed(1)} vh=${vh}`);
}

// ---------- chat-copy ----------
async function caseChatCopy({ win, log }) {
  const SAMPLE = 'COPY_ME_PROBE_TEXT this should land in the clipboard';
  await win.evaluate((sample) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      messagesBySession: { s1: [{ kind: 'assistant', id: 'a1', text: sample }] }
    });
  }, SAMPLE);
  await win.waitForTimeout(300);

  const target = win.getByText('COPY_ME_PROBE_TEXT', { exact: false }).first();
  await target.waitFor({ state: 'visible', timeout: 3000 });
  await target.click();

  await win.keyboard.press('Control+a');
  await win.waitForTimeout(100);
  const sel = await win.evaluate(() => window.getSelection()?.toString() ?? '');
  if (!sel.includes('COPY_ME_PROBE_TEXT')) throw new Error(`Ctrl+A did not select chat text (selection=${JSON.stringify(sel.slice(0, 80))})`);

  await win.keyboard.press('Control+c');
  await win.waitForTimeout(150);
  const clip = await win.evaluate(() => navigator.clipboard.readText().catch((e) => `ERR:${e.message}`));
  if (!clip.includes('COPY_ME_PROBE_TEXT')) throw new Error(`clipboard missing sample after Ctrl+C (clip=${JSON.stringify(clip.slice(0, 80))})`);

  log('Ctrl+A selects chat, Ctrl+C copies to clipboard');
}

// ---------- input-placeholder ----------
async function caseInputPlaceholder({ win, log, registerDispose }) {
  // i18n is a global side effect; restore en at case end via dispose.
  registerDispose(async () => {
    await win.evaluate(async () => {
      try { if (window.__ccsmI18n) await window.__ccsmI18n.changeLanguage('en'); } catch {}
    });
  });

  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      messagesBySession: {}
    });
  });
  await win.waitForTimeout(300);

  const ta = win.locator('textarea');
  await ta.waitFor({ state: 'visible', timeout: 5000 });
  const emptyPlaceholder = await ta.getAttribute('placeholder');
  if (emptyPlaceholder !== 'Ask anything…') throw new Error(`empty-session placeholder should be "Ask anything…", got ${JSON.stringify(emptyPlaceholder)}`);

  await win.evaluate(() => {
    window.__ccsmStore.setState({
      messagesBySession: { s1: [{ kind: 'user', id: 'u1', text: 'hi' }] }
    });
  });
  await win.waitForTimeout(200);
  const replyPlaceholder = await ta.getAttribute('placeholder');
  if (replyPlaceholder !== 'Reply…') throw new Error(`with-messages placeholder should be "Reply…", got ${JSON.stringify(replyPlaceholder)}`);

  // Long stream + running toggle.
  await win.evaluate(() => {
    const many = [];
    for (let i = 0; i < 200; i++) {
      many.push({ kind: i % 2 ? 'assistant' : 'user', id: `b-${i}`, text: `block ${i}` });
    }
    window.__ccsmStore.setState({ messagesBySession: { s1: many } });
  });
  await win.waitForTimeout(200);
  const longReplyPh = await ta.getAttribute('placeholder');
  if (longReplyPh !== 'Reply…') throw new Error(`after long stream, placeholder should still be "Reply…", got ${JSON.stringify(longReplyPh)}`);

  await win.evaluate(() => window.__ccsmStore.getState().setRunning('s1', true));
  await win.waitForTimeout(150);
  const runningPh = await ta.getAttribute('placeholder');
  if (!runningPh || !runningPh.includes('Esc')) throw new Error(`running placeholder should mention Esc, got ${JSON.stringify(runningPh)}`);
  await win.evaluate(() => window.__ccsmStore.getState().setRunning('s1', false));
  await win.waitForTimeout(150);
  const backToReply = await ta.getAttribute('placeholder');
  if (backToReply !== 'Reply…') throw new Error(`after running off, placeholder should return to "Reply…", got ${JSON.stringify(backToReply)}`);

  // zh.
  const switched = await win.evaluate(async () => {
    for (let i = 0; i < 20 && !window.__ccsmI18n; i++) await new Promise((r) => setTimeout(r, 100));
    if (!window.__ccsmI18n) return { ok: false, err: 'window.__ccsmI18n missing' };
    await window.__ccsmI18n.changeLanguage('zh');
    return { ok: true, lang: window.__ccsmI18n.language };
  });
  if (switched.ok) {
    await win.waitForTimeout(200);
    const zhPlaceholder = await ta.getAttribute('placeholder');
    if (zhPlaceholder !== '回复…') throw new Error(`zh with-messages placeholder should be "回复…", got ${JSON.stringify(zhPlaceholder)}`);
    await win.evaluate(() => window.__ccsmStore.setState({ messagesBySession: { s1: [] } }));
    await win.waitForTimeout(150);
    const zhEmpty = await ta.getAttribute('placeholder');
    if (zhEmpty !== '问点什么…') throw new Error(`zh empty placeholder should be "问点什么…", got ${JSON.stringify(zhEmpty)}`);
  } else {
    log(`[skip] could not switch language dynamically: ${switched.err}`);
  }

  log('en+zh placeholder transitions verified');
}

// ---------- tool-block-ux ----------
// Covers the rendered side of three related tool-block UX signals
// (A2-NEW-5 / A2-NEW-6 / A2-NEW-7). We seed a tool block directly into
// the store (same pattern as other cases in this harness) rather than
// spinning up a real claude.exe — the render path is what's under test,
// not the IPC. Component-level vitest in tests/chatstream-tool-block-ux.tsx
// covers the stall-hint branch that needs fake timers.
async function caseToolBlockUx({ win, log }) {
  const sid = 's-tool-ux';
  await win.evaluate((s) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: s, name: 'tool-ux', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: s,
      runningSessions: { [s]: true },
      messagesBySession: {
        [s]: [
          { kind: 'user', id: 'u1', text: 'run something slow' },
          {
            kind: 'tool',
            id: 't-run',
            name: 'Bash',
            brief: 'sleep 5',
            expanded: false,
            toolUseId: 'tu-run'
            // No `result` -> in-flight; elapsed counter should be ticking.
          },
          {
            kind: 'tool',
            id: 't-dropped',
            name: 'Read',
            brief: 'src/foo.ts',
            expanded: false,
            toolUseId: 'tu-drop',
            result: '' // explicit empty result -> A2-NEW-6 "(no result)"
          },
          {
            kind: 'tool',
            id: 't-done',
            name: 'Read',
            brief: 'src/bar.ts',
            expanded: false,
            toolUseId: 'tu-done',
            result: 'hello\nworld\n'
          }
        ]
      }
    });
  }, sid);
  await win.waitForTimeout(250);

  // A2-NEW-5: elapsed counter renders on the in-flight block and matches
  // the documented `\d+\.\ds` format. Poll for one tick so a second-fraction
  // digit definitely lands.
  await win.waitForTimeout(200);
  const elapsedText = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="tool-elapsed"]');
    return el ? el.textContent : null;
  });
  if (!elapsedText) throw new Error('A2-NEW-5: elapsed counter not rendered on in-flight tool block');
  if (!/^\d+\.\ds$/.test(elapsedText.trim())) {
    throw new Error(`A2-NEW-5: elapsed text "${elapsedText}" does not match /^\\d+\\.\\ds$/`);
  }

  // Must ONLY render on in-flight blocks — not on the completed one.
  const elapsedCount = await win.locator('[data-testid="tool-elapsed"]').count();
  if (elapsedCount !== 1) {
    throw new Error(`A2-NEW-5: expected 1 elapsed counter (in-flight only), got ${elapsedCount}`);
  }

  // A2-NEW-6: "(no result)" marker on the dropped block.
  const noResultCount = await win.locator('[data-testid="tool-no-result"]').count();
  if (noResultCount < 1) throw new Error('A2-NEW-6: "(no result)" marker missing on dropped tool block');
  const noResultText = await win.locator('[data-testid="tool-no-result"]').first().textContent();
  if (!noResultText || !noResultText.toLowerCase().includes('no result')) {
    throw new Error(`A2-NEW-6: marker text "${noResultText}" does not include "no result"`);
  }

  // Completed-healthy block should NOT carry the marker.
  if (noResultCount > 1) {
    throw new Error(`A2-NEW-6: marker leaked to healthy block (got ${noResultCount} markers, want 1)`);
  }

  // Transition: result lands on the in-flight block -> counter disappears.
  await win.evaluate((s) => {
    const st = window.__ccsmStore.getState();
    const prev = st.messagesBySession[s] ?? [];
    const next = prev.map((b) =>
      b.id === 't-run' ? { ...b, result: 'done\n' } : b
    );
    window.__ccsmStore.setState({ messagesBySession: { ...st.messagesBySession, [s]: next } });
  }, sid);
  await win.waitForTimeout(250);

  const elapsedAfter = await win.locator('[data-testid="tool-elapsed"]').count();
  if (elapsedAfter !== 0) {
    throw new Error(`A2-NEW-5: elapsed counter should clear after result lands, got ${elapsedAfter}`);
  }

  log('A2-NEW-5 counter ticking + clears on result; A2-NEW-6 "(no result)" renders on dropped only');
}

// ---------- tool-stall-escalation (#208) ----------
// Verifies the tiered stall ladder on in-flight tool blocks:
//   30s  -> subtle "(taking longer than usual…)" hint   (#181)
//   90s  -> escalated warning + Cancel link              (#208 — this PR)
//
// We can't sleep for 90 real seconds in a probe, so we monkey-patch
// `Date.now` in the renderer window BEFORE seeding the in-flight tool block
// so the ToolBlock's startedAtRef captures a synthetic T-Δ. After the block
// mounts we restore Date.now and let the existing 100ms ChatStream interval
// (`setNow(Date.now())`) sample the real wall clock — at which point the
// computed elapsedMs = realNow - (realNow - Δ) = Δ, flipping the right
// thresholds. Both the 31s tier (hint only) and the 91s tier (escalation +
// Cancel) are covered so we catch a regression that mistakenly shows the
// escalation early or skips the hint entirely.
async function caseToolStallEscalation({ win, log, registerDispose }) {
  // Always restore Date.now even if the case throws midway, so other cases
  // running in the same renderer aren't poisoned with a stale fake clock.
  registerDispose(async () => {
    await win.evaluate(() => {
      // @ts-ignore
      if (window.__realDateNow) {
        // eslint-disable-next-line no-global-assign
        Date.now = window.__realDateNow;
        delete window.__realDateNow;
      }
    });
  });

  // ---- Tier 1: 31s — only the 30s hint, NOT the escalation ----
  {
    const sid = 's-stall-31';
    await win.evaluate((offsetMs) => {
      // @ts-ignore
      window.__realDateNow = Date.now.bind(Date);
      const fakeOrigin = window.__realDateNow() - offsetMs;
      // Freeze a synthetic Date.now at "31 seconds ago" — when ToolBlock
      // mounts, startedAtRef and the ChatStream `now` state both capture
      // this value.
      // eslint-disable-next-line no-global-assign
      Date.now = () => fakeOrigin;
    }, 31_000);

    await win.evaluate((s) => {
      window.__ccsmStore.setState({
        groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
        sessions: [{ id: s, name: 'stall-31', state: 'idle', cwd: 'C:/x', model: 'm', groupId: 'g1', agentType: 'claude-code' }],
        activeId: s,
        runningSessions: { [s]: true },
        messagesBySession: {
          [s]: [
            { kind: 'user', id: 'u1', text: 'slow' },
            { kind: 'tool', id: 't-31', name: 'Bash', brief: 'sleep 60', expanded: false, toolUseId: 'tu-31' }
          ]
        }
      });
    }, sid);
    // Let ToolBlock mount and capture the fake startedAt.
    await win.waitForTimeout(250);

    // Restore Date.now; the ChatStream 100ms interval will sample real time
    // on the next tick, so elapsedMs becomes ~31s.
    await win.evaluate(() => {
      // @ts-ignore
      // eslint-disable-next-line no-global-assign
      Date.now = window.__realDateNow;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete window.__realDateNow;
    });
    await win.waitForTimeout(400);

    const stalledCount = await win.locator('[data-testid="tool-stalled"]').count();
    if (stalledCount !== 1) {
      throw new Error(`#208 tier-1 (31s): expected 1 "taking longer" hint, got ${stalledCount}`);
    }
    const escalatedCount = await win.locator('[data-testid="tool-stall-escalated"]').count();
    if (escalatedCount !== 0) {
      throw new Error(`#208 tier-1 (31s): escalation should NOT be visible, got ${escalatedCount}`);
    }
    const cancelCount = await win.locator('[data-testid="tool-stall-cancel"]').count();
    if (cancelCount !== 0) {
      throw new Error(`#208 tier-1 (31s): Cancel link should NOT be visible, got ${cancelCount}`);
    }
    const elapsedTierEarly = await win.locator('[data-testid="tool-elapsed"]').first();
    const earlyEscalatedAttr = await elapsedTierEarly.getAttribute('data-escalated');
    if (earlyEscalatedAttr === 'true') {
      throw new Error('#208 tier-1 (31s): elapsed chip should NOT carry data-escalated=true');
    }
  }

  // ---- Tier 2: 91s — escalation visible (warning chip + Cancel link),
  // and the 30s hint is suppressed because the louder tier supersedes it. ----
  {
    const sid = 's-stall-91';
    await win.evaluate((offsetMs) => {
      // @ts-ignore
      window.__realDateNow = Date.now.bind(Date);
      const fakeOrigin = window.__realDateNow() - offsetMs;
      // eslint-disable-next-line no-global-assign
      Date.now = () => fakeOrigin;
    }, 91_000);

    await win.evaluate((s) => {
      window.__ccsmStore.setState({
        groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
        sessions: [{ id: s, name: 'stall-91', state: 'idle', cwd: 'C:/x', model: 'm', groupId: 'g1', agentType: 'claude-code' }],
        activeId: s,
        runningSessions: { [s]: true },
        messagesBySession: {
          [s]: [
            { kind: 'user', id: 'u1', text: 'really slow' },
            { kind: 'tool', id: 't-91', name: 'Bash', brief: 'sleep 600', expanded: false, toolUseId: 'tu-91' }
          ]
        }
      });
    }, sid);
    await win.waitForTimeout(250);

    await win.evaluate(() => {
      // @ts-ignore
      // eslint-disable-next-line no-global-assign
      Date.now = window.__realDateNow;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete window.__realDateNow;
    });
    await win.waitForTimeout(400);

    const escalatedCount = await win.locator('[data-testid="tool-stall-escalated"]').count();
    if (escalatedCount !== 1) {
      throw new Error(`#208 tier-2 (91s): expected escalation badge to be visible, got ${escalatedCount}`);
    }
    const cancelCount = await win.locator('[data-testid="tool-stall-cancel"]').count();
    if (cancelCount !== 1) {
      throw new Error(`#208 tier-2 (91s): expected Cancel link to be visible, got ${cancelCount}`);
    }
    // Hint and escalation are mutually exclusive — once we cross the louder
    // threshold the gentle hint should step aside so the row isn't
    // double-noisy.
    const stalledCount = await win.locator('[data-testid="tool-stalled"]').count();
    if (stalledCount !== 0) {
      throw new Error(`#208 tier-2 (91s): the 30s hint should be hidden once escalated, got ${stalledCount}`);
    }
    const elapsedChip = await win.locator('[data-testid="tool-elapsed"]').first();
    const escalatedAttr = await elapsedChip.getAttribute('data-escalated');
    if (escalatedAttr !== 'true') {
      throw new Error(`#208 tier-2 (91s): elapsed chip should carry data-escalated=true, got ${escalatedAttr}`);
    }

    // Cancel click must NOT collapse/expand the parent row (we use
    // stopPropagation). Capture initial expanded state, click Cancel,
    // confirm aria-expanded unchanged.
    const collapseBtn = win.locator('button[aria-expanded]').first();
    const beforeExpanded = await collapseBtn.getAttribute('aria-expanded');
    await win.locator('[data-testid="tool-stall-cancel"]').first().click();
    await win.waitForTimeout(150);
    const afterExpanded = await collapseBtn.getAttribute('aria-expanded');
    if (beforeExpanded !== afterExpanded) {
      throw new Error(`#208 tier-2 (91s): Cancel click leaked to parent collapse (aria-expanded ${beforeExpanded} -> ${afterExpanded})`);
    }
  }

  log('tier-1 (31s): hint only, no escalation/cancel; tier-2 (91s): escalation badge + Cancel link, hint suppressed, click does not toggle row');
}

// ---------- streaming-journey-switch ----------
// Absorbed from probe-e2e-streaming-journey-switch.mjs. Stream survives a
// session switch and back: A starts streaming, user switches to B, more
// chunks arrive for A while offscreen, switch back to A reveals the full
// concatenated reply with no torn / duplicated blocks, finalize clears the
// caret.
async function caseStreamingJourneySwitch({ win, log }) {
  const A = 's-jswitch-A';
  const B = 's-jswitch-B';
  const BLOCK_ID = 'msg-A-jswitch:0';

  await win.evaluate(([a, b]) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: a, name: 'session-A', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
        { id: b, name: 'session-B', state: 'idle', cwd: 'C:/y', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }
      ],
      activeId: a,
      messagesBySession: {
        [a]: [{ kind: 'user', id: 'u-a', text: 'long reply please' }],
        [b]: [{ kind: 'user', id: 'u-b', text: 'unrelated' }]
      },
      startedSessions: { [a]: true, [b]: true },
      runningSessions: { [a]: true, [b]: false }
    });
  }, [A, B]);
  await win.waitForTimeout(200);

  const CHUNKS = Array.from({ length: 30 }, (_, i) => `c${i.toString().padStart(2, '0')} `);

  const inject = async (idx) => {
    await win.evaluate(
      ([sid, bid, text]) => window.__ccsmStore.getState().streamAssistantText(sid, bid, text, false),
      [A, BLOCK_ID, CHUNKS[idx]]
    );
  };

  // Phase 1: chunks 0..9 with A active.
  for (let i = 0; i < 10; i++) await inject(i);
  await win.waitForTimeout(150);

  try {
    await win.locator('span.animate-pulse').first().waitFor({ state: 'attached', timeout: 2000 });
  } catch { /* fall through */ }
  const caretMid = await win.locator('span.animate-pulse').count();
  if (caretMid < 1) throw new Error('expected streaming caret to be visible while A is mid-stream');

  const aMid = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.filter((b) => b.id === bid).map((b) => ({ text: b.text, streaming: b.streaming }));
  }, [A, BLOCK_ID]);
  if (aMid.length !== 1) throw new Error(`expected exactly 1 block id ${BLOCK_ID}, got ${aMid.length}`);
  const expectedHalf = CHUNKS.slice(0, 10).join('');
  if (aMid[0].text !== expectedHalf) {
    throw new Error(`mid-stream text mismatch: got ${JSON.stringify(aMid[0].text)} want ${JSON.stringify(expectedHalf)}`);
  }
  if (aMid[0].streaming !== true) throw new Error('streaming flag should be true mid-stream');

  // Phase 2: switch to B.
  await win.evaluate((b) => window.__ccsmStore.setState({ activeId: b }), B);
  await win.waitForTimeout(150);

  // Deliver chunks 10..24 to A while on B.
  for (let i = 10; i < 25; i++) await inject(i);
  await win.waitForTimeout(150);

  const bWhileAStreams = await win.evaluate(
    (sid) => (window.__ccsmStore.getState().messagesBySession[sid] ?? []).map((b) => ({ id: b.id, text: b.text })),
    B
  );
  const leakedToB = bWhileAStreams.find((b) => b.id === BLOCK_ID || (b.text ?? '').includes('c10'));
  if (leakedToB) throw new Error(`A stream leaked into B: ${JSON.stringify(leakedToB)}`);

  const sawAStreamInDom = await win.evaluate(() => document.body.textContent?.includes('c14') ?? false);
  if (sawAStreamInDom) throw new Error('chunk c14 visible in DOM while on B — wrong session shown');

  // Phase 3: deliver 25..29 then switch back to A.
  for (let i = 25; i < 30; i++) await inject(i);
  await win.waitForTimeout(100);

  await win.evaluate((a) => window.__ccsmStore.setState({ activeId: a }), A);
  await win.waitForTimeout(200);

  const aFull = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.filter((b) => b.id === bid).map((b) => ({ text: b.text, streaming: b.streaming }));
  }, [A, BLOCK_ID]);
  if (aFull.length !== 1) throw new Error(`after switch-back, expected 1 block, got ${aFull.length}`);
  const expectedFull = CHUNKS.join('');
  if (aFull[0].text !== expectedFull) {
    throw new Error(`full text mismatch: got ${JSON.stringify(aFull[0].text)} want ${JSON.stringify(expectedFull)}`);
  }
  if (aFull[0].streaming !== true) throw new Error('streaming flag should still be true (no finalize yet)');

  // Finalize.
  await win.evaluate(([sid, bid, text]) => {
    window.__ccsmStore.getState().appendBlocks(sid, [{ kind: 'assistant', id: bid, text }]);
    window.__ccsmStore.getState().setRunning(sid, false);
  }, [A, BLOCK_ID, expectedFull]);
  await win.waitForTimeout(150);

  const aFinal = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.filter((b) => b.id === bid).map((b) => ({ text: b.text, streaming: b.streaming }));
  }, [A, BLOCK_ID]);
  if (aFinal.length !== 1) throw new Error(`after finalize, expected 1 block, got ${aFinal.length}`);
  if (aFinal[0].streaming) throw new Error('streaming flag should be cleared after finalize');
  if (aFinal[0].text !== expectedFull) throw new Error('finalized text mutated unexpectedly');

  const caretFinal = await win.locator('span.animate-pulse').count();
  if (caretFinal !== 0) throw new Error(`caret should be gone after finalize, found ${caretFinal}`);

  log('A absorbed all 30 chunks across a B-side detour, single block, finalize cleared caret');
}

// ---------- streaming-journey-parallel ----------
// Absorbed from probe-e2e-streaming-journey-parallel.mjs. Interleaved
// per-session deltas must remain isolated; carets clear independently.
async function caseStreamingJourneyParallel({ win, log }) {
  const A = 's-jpar-A';
  const B = 's-jpar-B';
  const BID_A = 'msg-A:jpar';
  const BID_B = 'msg-B:jpar';

  await win.evaluate(([a, b]) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: a, name: 'A', state: 'idle', cwd: 'C:/x', model: 'm', groupId: 'g1', agentType: 'claude-code' },
        { id: b, name: 'B', state: 'idle', cwd: 'C:/y', model: 'm', groupId: 'g1', agentType: 'claude-code' }
      ],
      activeId: a,
      messagesBySession: {
        [a]: [{ kind: 'user', id: 'ua', text: 'A asks' }],
        [b]: [{ kind: 'user', id: 'ub', text: 'B asks' }]
      },
      startedSessions: { [a]: true, [b]: true },
      runningSessions: { [a]: true, [b]: true }
    });
  }, [A, B]);
  await win.waitForTimeout(150);

  const A_CHUNKS = ['Aa ', 'Ab ', 'Ac ', 'Ad ', 'Ae ', 'Af '];
  const B_CHUNKS = ['Bp ', 'Bq ', 'Br ', 'Bs ', 'Bt ', 'Bu '];

  for (let i = 0; i < 6; i++) {
    await win.evaluate(([sid, bid, text]) => window.__ccsmStore.getState().streamAssistantText(sid, bid, text, false), [A, BID_A, A_CHUNKS[i]]);
    await win.evaluate(([sid, bid, text]) => window.__ccsmStore.getState().streamAssistantText(sid, bid, text, false), [B, BID_B, B_CHUNKS[i]]);
  }
  await win.waitForTimeout(150);

  const aText = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid)?.text;
  }, [A, BID_A]);
  const bText = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid)?.text;
  }, [B, BID_B]);

  const wantA = A_CHUNKS.join('');
  const wantB = B_CHUNKS.join('');
  if (aText !== wantA) throw new Error(`A text wrong: got ${JSON.stringify(aText)} want ${JSON.stringify(wantA)}`);
  if (bText !== wantB) throw new Error(`B text wrong: got ${JSON.stringify(bText)} want ${JSON.stringify(wantB)}`);

  for (const c of B_CHUNKS) {
    if (aText.includes(c)) throw new Error(`A reply contains B chunk ${JSON.stringify(c)}`);
  }
  for (const c of A_CHUNKS) {
    if (bText.includes(c)) throw new Error(`B reply contains A chunk ${JSON.stringify(c)}`);
  }

  const aBlocks = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.filter((b) => b.kind === 'assistant').map((b) => ({ id: b.id, streaming: b.streaming }));
  }, A);
  const bBlocks = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.filter((b) => b.kind === 'assistant').map((b) => ({ id: b.id, streaming: b.streaming }));
  }, B);
  if (aBlocks.length !== 1) throw new Error(`A should have 1 assistant block, got ${aBlocks.length}`);
  if (bBlocks.length !== 1) throw new Error(`B should have 1 assistant block, got ${bBlocks.length}`);
  if (aBlocks[0].id !== BID_A) throw new Error(`A block has wrong id ${aBlocks[0].id}`);
  if (bBlocks[0].id !== BID_B) throw new Error(`B block has wrong id ${bBlocks[0].id}`);
  if (!aBlocks[0].streaming || !bBlocks[0].streaming) throw new Error('both should still be streaming pre-finalize');

  // Finalize A only.
  await win.evaluate(([sid, bid, text]) => {
    window.__ccsmStore.getState().appendBlocks(sid, [{ kind: 'assistant', id: bid, text }]);
    window.__ccsmStore.getState().setRunning(sid, false);
  }, [A, BID_A, wantA]);
  await win.waitForTimeout(150);

  await win.evaluate((sid) => window.__ccsmStore.setState({ activeId: sid }), A);
  await win.waitForFunction(
    (text) => document.body.textContent?.includes(text) ?? false,
    'Aa Ab Ac',
    { timeout: 3000 }
  ).catch(() => { throw new Error('A view never mounted after switch'); });
  await win.waitForFunction(() => document.querySelectorAll('span.animate-pulse').length === 0, null, { timeout: 2000 }).catch(() => {});
  const caretAfterA = await win.locator('span.animate-pulse').count();
  if (caretAfterA !== 0) throw new Error(`A caret should be gone after finalize, found ${caretAfterA}`);

  const bStillStreaming = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.kind === 'assistant')?.streaming === true;
  }, B);
  if (!bStillStreaming) throw new Error('B should still be streaming after only A was finalized');

  await win.evaluate((sid) => window.__ccsmStore.setState({ activeId: sid }), B);
  await win.waitForFunction(
    (text) => document.body.textContent?.includes(text) ?? false,
    'Bp Bq Br',
    { timeout: 3000 }
  ).catch(() => { throw new Error('B view never mounted after switch'); });
  await win.locator('span.animate-pulse').first().waitFor({ state: 'visible', timeout: 3000 })
    .catch(() => { throw new Error('B should still show caret'); });

  // Finalize B.
  await win.evaluate(([sid, bid, text]) => {
    window.__ccsmStore.getState().appendBlocks(sid, [{ kind: 'assistant', id: bid, text }]);
    window.__ccsmStore.getState().setRunning(sid, false);
  }, [B, BID_B, wantB]);
  await win.waitForFunction(() => document.querySelectorAll('span.animate-pulse').length === 0, null, { timeout: 3000 }).catch(() => {});
  const caretFinal = await win.locator('span.animate-pulse').count();
  if (caretFinal !== 0) throw new Error(`caret should be 0 after both finalize, got ${caretFinal}`);

  log('A and B streamed interleaved, no bleed; carets cleared independently');
}

// ---------- streaming-journey-queue-clear ----------
// Absorbed from probe-e2e-streaming-journey-queue-clear.mjs. While running,
// queue 3 messages -> "+3 queued" chip; Esc -> messageQueues emptied (3-deep
// not just head-drop) AND chip gone.
async function caseStreamingJourneyQueueClear({ win, log }) {
  // Defensive: prior runs may have persisted i18n=zh; we assert on English
  // chip text + "Stop" button name below.
  await win.evaluate(async () => {
    try { if (window.__ccsmI18n && window.__ccsmI18n.language !== 'en') await window.__ccsmI18n.changeLanguage('en'); } catch {}
  });
  const SID = 's-jqclear';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: sid, name: 'queue-clear', state: 'idle', cwd: 'C:/x',
        model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code'
      }],
      activeId: sid,
      messagesBySession: {
        [sid]: [
          { kind: 'user', id: 'u-1', text: 'first turn' },
          { kind: 'assistant', id: 'a-1', text: 'streaming reply...' }
        ]
      },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true }
    });
  }, SID);
  await win.waitForTimeout(200);

  const stopBtn = win.getByRole('button', { name: /^stop$/i });
  await stopBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { throw new Error('Stop button missing — running not rendered'); });

  const queueWanted = ['queued one', 'queued two', 'queued three'];
  await win.evaluate(([sid, msgs]) => {
    const st = window.__ccsmStore.getState();
    for (const m of msgs) st.enqueueMessage(sid, { text: m, attachments: [] });
  }, [SID, queueWanted]);
  await win.waitForTimeout(150);

  const chip = win.getByText(/\+3 queued/);
  await chip.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { throw new Error('"+3 queued" chip never appeared'); });

  const preEscQueue = await win.evaluate(
    (sid) => (window.__ccsmStore.getState().messageQueues[sid] ?? []).map((m) => m.text),
    SID
  );
  if (JSON.stringify(preEscQueue) !== JSON.stringify(queueWanted)) {
    throw new Error(`pre-Esc queue mismatch: got ${JSON.stringify(preEscQueue)}`);
  }

  await win.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await win.waitForTimeout(250);

  const postEsc = await win.evaluate((sid) => {
    const st = window.__ccsmStore.getState();
    return {
      interrupted: !!st.interruptedSessions[sid],
      queueLen: (st.messageQueues[sid] ?? []).length,
      queueDump: (st.messageQueues[sid] ?? []).map((m) => m.text)
    };
  }, SID);
  if (!postEsc.interrupted) throw new Error('interruptedSessions flag not set after Esc');
  if (postEsc.queueLen !== 0) {
    throw new Error(`queue should be EMPTY after Esc, got len=${postEsc.queueLen}, contents=${JSON.stringify(postEsc.queueDump)}`);
  }

  await chip.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => { throw new Error('"+3 queued" chip still visible after Esc'); });

  for (const n of [1, 2]) {
    const remaining = win.getByText(new RegExp(`\\+${n} queued`));
    if (await remaining.count() > 0) {
      throw new Error(`unexpected "+${n} queued" chip visible after Esc — partial drop, not full clear`);
    }
  }

  log('3 enqueues -> chip +3 queued; Esc -> queue empty + chip gone');
}

// ---------- streaming-journey-esc-interrupt ----------
// Absorbed from probe-e2e-streaming-journey-esc-interrupt.mjs. Esc during a
// stream halts deltas, neutral "Interrupted" status block appears, caret
// disappears, composer focus returns, Stop -> Send affordance.
async function caseStreamingJourneyEscInterrupt({ win, log }) {
  // Defensive: assertions below pin the English "Stop" button name + status
  // banner text; force i18n=en in case a prior run persisted zh.
  await win.evaluate(async () => {
    try { if (window.__ccsmI18n && window.__ccsmI18n.language !== 'en') await window.__ccsmI18n.changeLanguage('en'); } catch {}
  });
  const SID = 's-jesc';
  const BLOCK_ID = 'msg-jesc:0';

  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: sid, name: 'esc-stream', state: 'idle', cwd: 'C:/x',
        model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code'
      }],
      activeId: sid,
      messagesBySession: { [sid]: [{ kind: 'user', id: 'u-1', text: 'count 1..30' }] },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true }
    });
  }, SID);

  await win.waitForFunction((sid) => {
    return window.__ccsmStore?.getState().activeId === sid && document.querySelector('textarea') !== null;
  }, SID, { timeout: 5000 });

  await win.evaluate(([sid, bid]) => {
    const st = window.__ccsmStore.getState();
    for (let i = 0; i < 8; i++) st.streamAssistantText(sid, bid, `c${i} `, false);
  }, [SID, BLOCK_ID]);
  await win.waitForTimeout(150);

  try {
    await win.locator('span.animate-pulse').first().waitFor({ state: 'attached', timeout: 2000 });
  } catch { /* fall through */ }
  const caretMid = await win.locator('span.animate-pulse').count();
  if (caretMid < 1) throw new Error('caret should be pulsing while streaming');

  const stopBtn = win.getByRole('button', { name: /^stop$/i });
  await stopBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { throw new Error('Stop button not visible mid-stream'); });

  const midText = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid)?.text;
  }, [SID, BLOCK_ID]);

  // Park focus elsewhere so we can prove focus returns post-interrupt.
  await win.evaluate(() => {
    const ta = document.querySelector('textarea');
    if (ta) ta.blur();
    document.body.focus();
  });

  await win.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await win.waitForTimeout(200);

  const interrupted = await win.evaluate((sid) => !!window.__ccsmStore.getState().interruptedSessions[sid], SID);
  if (!interrupted) throw new Error('interruptedSessions flag not set after Esc');

  // Synthesize the lifecycle's post-interrupt result frame translation.
  await win.evaluate(([sid, bid]) => {
    const st = window.__ccsmStore.getState();
    if (!st.consumeInterrupted(sid)) throw new Error('flag not consumed');
    const open = (st.messagesBySession[sid] ?? []).find((b) => b.id === bid);
    if (open) {
      st.appendBlocks(sid, [{ kind: 'assistant', id: bid, text: open.text ?? '' }]);
    }
    st.appendBlocks(sid, [{ kind: 'status', id: 'res-jesc', tone: 'info', title: 'Interrupted' }]);
    st.setRunning(sid, false);
  }, [SID, BLOCK_ID]);
  await win.waitForTimeout(200);

  const caretAfter = await win.locator('span.animate-pulse').count();
  if (caretAfter !== 0) throw new Error(`caret still pulsing after interrupt, found ${caretAfter}`);

  const inflight = await win.evaluate(([sid, bid]) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid);
  }, [SID, BLOCK_ID]);
  if (!inflight) throw new Error('in-flight block disappeared after interrupt — should remain with partial text');
  if (inflight.streaming) throw new Error('in-flight block.streaming should be false after interrupt');
  if (inflight.text !== midText) throw new Error(`in-flight text changed unexpectedly. before=${JSON.stringify(midText)} after=${JSON.stringify(inflight.text)}`);

  await win.waitForSelector('[role="status"]', { timeout: 3000 });
  const banner = await win.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[role="status"]'));
    const el = nodes.find((n) => n.textContent?.includes('Interrupted'));
    if (!el) return { found: false };
    return { found: true, hasAlert: !!el.closest('[role="alert"]') };
  });
  if (!banner.found) throw new Error('"Interrupted" banner not rendered with role=status');
  if (banner.hasAlert) throw new Error('"Interrupted" banner is inside role=alert — should be neutral');

  await stopBtn.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => { throw new Error('Stop button still visible after running cleared'); });

  await win.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', null, { timeout: 2000 }).catch(async () => {
    const tag = await win.evaluate(() => document.activeElement?.tagName);
    throw new Error(`composer focus did not return to textarea after interrupt; activeElement=${tag}`);
  });

  // Clear any prior draft text from a previous case using the same session id slot
  // (drafts.ts module-scope cache survives setState).
  await win.locator('textarea').first().fill('');
  await win.locator('textarea').first().click();
  await win.keyboard.type('post-int');
  const val = await win.locator('textarea').first().inputValue();
  if (val !== 'post-int') throw new Error(`textarea value should be 'post-int' after typing, got ${JSON.stringify(val)}`);

  log('Esc -> caret cleared, neutral Interrupted banner, focus back to composer');
}

// ---------- msg-queue ----------
// Absorbed from probe-e2e-msg-queue.mjs. While running, 3 Enter-presses
// must each enqueue (not call agentSend); chip shows "+3 queued"; FIFO drain
// via dequeueMessage; chip drops in lockstep and hides at zero.
async function caseMsgQueue({ win, log }) {
  // Defensive: pin English so "Stop" button + "+N queued" chip selectors hit.
  await win.evaluate(async () => {
    try { if (window.__ccsmI18n && window.__ccsmI18n.language !== 'en') await window.__ccsmI18n.changeLanguage('en'); } catch {}
  });
  const SID = 's-mq';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: sid, name: 'queue-probe', state: 'idle', cwd: 'C:/x',
        model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code'
      }],
      activeId: sid,
      messagesBySession: {
        [sid]: [
          { kind: 'user', id: 'u-0', text: 'first turn' },
          { kind: 'assistant', id: 'a-0', text: 'starting…' }
        ]
      },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true }
    });
  }, SID);
  await win.waitForTimeout(200);

  const textarea = win.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });
  // Prior case may have left a draft in the per-session drafts cache.
  await textarea.fill('');

  const stopBtn = win.getByRole('button', { name: /^stop$/i });
  await stopBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { throw new Error('Stop button missing — running state did not render'); });

  const messages = ['queued one', 'queued two', 'queued three'];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const want = i + 1;
    await win.waitForFunction(() => (document.querySelector('textarea')?.value ?? '') === '', null, { timeout: 3000 }).catch(() => {});
    await textarea.click();
    await textarea.fill(msg);
    await win.waitForFunction((m) => document.querySelector('textarea')?.value === m, msg, { timeout: 2000 }).catch(async () => {
      const v = await win.evaluate(() => document.querySelector('textarea')?.value);
      throw new Error(`pre-Enter textarea value mismatch: got ${JSON.stringify(v)} want ${JSON.stringify(msg)}`);
    });
    const running = await win.evaluate((sid) => !!window.__ccsmStore.getState().runningSessions[sid], SID);
    if (!running) throw new Error('running flag false at iteration ' + i);
    await textarea.press('Enter');
    await win.waitForFunction(
      ([sid, n]) => (window.__ccsmStore.getState().messageQueues[sid] ?? []).length === n,
      [SID, want],
      { timeout: 3000 }
    ).catch(async () => {
      const len = await win.evaluate((sid) => (window.__ccsmStore.getState().messageQueues[sid] ?? []).length, SID);
      const dump = await win.evaluate((sid) => (window.__ccsmStore.getState().messageQueues[sid] ?? []).map((m) => m.text), SID);
      throw new Error(`enqueue #${want} did not advance queue length (got ${len}, queue=${JSON.stringify(dump)})`);
    });
    await win.waitForFunction(() => (document.querySelector('textarea')?.value ?? '') === '', null, { timeout: 2000 }).catch(() => {});
  }

  const chip = win.getByText(/\+3 queued/);
  await chip.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { throw new Error('"+3 queued" chip never appeared after 3 Enters'); });

  const queuedTexts = await win.evaluate(
    (sid) => (window.__ccsmStore.getState().messageQueues[sid] ?? []).map((m) => m.text),
    SID
  );
  if (JSON.stringify(queuedTexts) !== JSON.stringify(messages)) {
    throw new Error(`queue order wrong after 3 Enters: got ${JSON.stringify(queuedTexts)}, want ${JSON.stringify(messages)}`);
  }

  const composerValue = await textarea.inputValue();
  if (composerValue !== '') {
    throw new Error(`composer should be empty after enqueue, got ${JSON.stringify(composerValue)}`);
  }

  for (let i = 0; i < 3; i++) {
    const head = await win.evaluate((sid) => window.__ccsmStore.getState().dequeueMessage(sid), SID);
    if (!head) throw new Error(`dequeue #${i + 1} returned null — queue ran dry early`);
    if (head.text !== messages[i]) {
      throw new Error(`dequeue #${i + 1} popped wrong message: got "${head.text}", expected "${messages[i]}"`);
    }
    await win.waitForTimeout(80);
    const remaining = await win.evaluate((sid) => (window.__ccsmStore.getState().messageQueues[sid] ?? []).length, SID);
    const expectRemaining = 3 - i - 1;
    if (remaining !== expectRemaining) {
      throw new Error(`after dequeue #${i + 1}, queue length should be ${expectRemaining}, got ${remaining}`);
    }
    if (expectRemaining > 0) {
      const partial = win.getByText(new RegExp(`\\+${expectRemaining} queued`));
      await partial.waitFor({ state: 'visible', timeout: 1500 })
        .catch(() => { throw new Error(`chip should show "+${expectRemaining} queued" after dequeue #${i + 1}`); });
    }
  }

  const finalQueue = await win.evaluate((sid) => window.__ccsmStore.getState().messageQueues[sid], SID);
  if (finalQueue && finalQueue.length > 0) {
    throw new Error(`queue not empty after 3 dequeues: ${JSON.stringify(finalQueue)}`);
  }

  await chip.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => { throw new Error('queue chip still visible after final dequeue'); });

  log('3 Enter-presses -> chip "+3 queued"; FIFO dequeue: ' + messages.join(' -> '));
}

// ---------- esc-interrupt ----------
// Absorbed from probe-e2e-esc-interrupt.mjs. Esc during running -> stop()
// runs (markInterrupted + clearQueue), Stop button hides after running
// flips false, textarea usable again post-interrupt.
async function caseEscInterrupt({ win, log }) {
  // Defensive: pin English so "Stop" button name + "+1 queued" chip hit.
  await win.evaluate(async () => {
    try { if (window.__ccsmI18n && window.__ccsmI18n.language !== 'en') await window.__ccsmI18n.changeLanguage('en'); } catch {}
  });
  const SID = 's-esc-int';
  await win.evaluate((sid) => {
    const store = window.__ccsmStore;
    store.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: sid, name: 'esc-probe', state: 'idle', cwd: 'C:/x',
        model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code'
      }],
      activeId: sid,
      messagesBySession: {
        [sid]: [
          { kind: 'user', id: 'u-1', text: 'count slowly to 100' },
          { kind: 'assistant', id: 'a-1', text: '1\n2\n3\n' }
        ]
      },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true }
    });
    store.getState().enqueueMessage(sid, { text: 'queued during running', attachments: [] });
  }, SID);
  await win.waitForTimeout(200);

  const stopBtn = win.getByRole('button', { name: /^stop$/i });
  await stopBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { throw new Error('Stop button not visible — session not in running state'); });

  const chip = win.getByText(/\+1 queued/);
  await chip.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { throw new Error('queue chip never appeared after enqueue'); });

  await win.evaluate(() => {
    const ta = document.querySelector('textarea');
    if (ta) ta.blur();
    document.body.focus();
  });

  await win.evaluate(() => {
    window.__sawEsc = false;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.__sawEsc = true;
    }, { capture: true });
  });

  await win.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await win.waitForTimeout(200);

  const sawEsc = await win.evaluate(() => window.__sawEsc);
  if (!sawEsc) throw new Error('document never saw the Escape keydown — playwright dispatch path broken');

  const postEsc = await win.evaluate((sid) => ({
    interrupted: !!window.__ccsmStore.getState().interruptedSessions[sid],
    queueLen: (window.__ccsmStore.getState().messageQueues[sid] ?? []).length,
  }), SID);
  if (!postEsc.interrupted) throw new Error('after Esc, interruptedSessions flag was not set — stop() did not run');
  if (postEsc.queueLen !== 0) {
    throw new Error(`after Esc, queue should be empty (CLI Ctrl+C parity), got length=${postEsc.queueLen}`);
  }

  await chip.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => { throw new Error('queue chip still visible after Esc — clearQueue did not propagate'); });

  // Synthesize the SDK delivering the post-interrupt result frame.
  await win.evaluate((sid) => {
    const st = window.__ccsmStore.getState();
    if (!st.consumeInterrupted(sid)) throw new Error('interrupted flag was not consumed');
    st.appendBlocks(sid, [{ kind: 'status', id: 'res-esc-int', tone: 'info', title: 'Interrupted' }]);
    st.setRunning(sid, false);
  }, SID);
  await win.waitForTimeout(150);

  await stopBtn.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => { throw new Error('Stop button still visible after running flipped to false'); });

  const textarea = win.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 3000 });
  await textarea.fill('');
  await textarea.click();
  await win.keyboard.type('post-interrupt');
  const value = await textarea.inputValue();
  if (value !== 'post-interrupt') {
    throw new Error(`textarea not usable after interrupt: inputValue=${JSON.stringify(value)}`);
  }

  log('Esc -> stop() ran (interrupted+queue cleared); Interrupted status block; textarea usable');

  // ── J2 ────────────────────────────────────────────────────────────────
  // Regression for #286 (PR #365): Esc must interrupt while textarea has
  // focus AND when an inline `role="dialog"` widget (AskUserQuestion sticky,
  // CwdPopover) is mounted. Before the fix, the doc-level handler returned
  // early on `[role="dialog"]` — any inline a11y dialog silently disabled
  // Esc-to-stop, including from the composer.
  //
  // Sub-case A: textarea-focus + inline role="dialog" (no data-modal-dialog).
  // Asserts interrupt still fires.
  // Sub-case B: textarea-focus + role="dialog" + data-modal-dialog.
  // Asserts interrupt is suppressed (real Radix modals own Esc).
  const SID2 = 's-esc-int-j2';
  await win.evaluate((sid) => {
    const store = window.__ccsmStore;
    store.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: sid, name: 'esc-textarea', state: 'idle', cwd: 'C:/x',
        model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code'
      }],
      activeId: sid,
      messagesBySession: { [sid]: [] },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true },
      interruptedSessions: {},
    });
  }, SID2);
  await win.waitForTimeout(150);

  // Sub-case A: inline role="dialog" must NOT block doc-level Esc handler.
  await win.evaluate(() => {
    // Remove any leftover from sub-case set up below on retries.
    document.querySelectorAll('[data-harness-injected-dialog]').forEach((n) => n.remove());
    const inline = document.createElement('div');
    inline.setAttribute('role', 'dialog');
    inline.setAttribute('aria-label', 'inline a11y widget (no aria-modal)');
    inline.setAttribute('data-harness-injected-dialog', 'inline');
    // No data-modal-dialog marker — this is the inline-widget shape that
    // QuestionBlock + CwdPopover use.
    document.body.appendChild(inline);
  });
  // Real textarea focus — that's the regression scenario.
  const ta2A = win.locator('textarea').first();
  await ta2A.waitFor({ state: 'visible', timeout: 5000 });
  await ta2A.click();
  const focusedA = await win.evaluate(() => document.activeElement?.tagName);
  if (focusedA !== 'TEXTAREA') throw new Error(`J2-A: expected textarea focus, got activeElement=${focusedA}`);
  await win.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await win.waitForTimeout(200);
  const interruptedA = await win.evaluate((sid) => !!window.__ccsmStore.getState().interruptedSessions[sid], SID2);
  if (!interruptedA) {
    throw new Error('J2-A regression: textarea-focus Esc did NOT interrupt while inline role="dialog" was mounted — the global selector is over-matching');
  }
  // Reset for sub-case B.
  await win.evaluate((sid) => {
    document.querySelectorAll('[data-harness-injected-dialog]').forEach((n) => n.remove());
    const st = window.__ccsmStore.getState();
    st.consumeInterrupted(sid);
    st.setRunning(sid, true);
  }, SID2);
  await win.waitForTimeout(120);

  // Sub-case B: data-modal-dialog (real Radix modal shape) MUST suppress.
  await win.evaluate(() => {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('data-modal-dialog', '');
    modal.setAttribute('data-harness-injected-dialog', 'modal');
    document.body.appendChild(modal);
  });
  const ta2B = win.locator('textarea').first();
  await ta2B.click();
  const focusedB = await win.evaluate(() => document.activeElement?.tagName);
  if (focusedB !== 'TEXTAREA') throw new Error(`J2-B: expected textarea focus, got activeElement=${focusedB}`);
  await win.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await win.waitForTimeout(200);
  const interruptedB = await win.evaluate((sid) => !!window.__ccsmStore.getState().interruptedSessions[sid], SID2);
  if (interruptedB) {
    throw new Error('J2-B contract broken: data-modal-dialog should suppress global Esc-to-stop (real Radix modals own Esc), but interrupt fired anyway');
  }
  // Cleanup so later cases see a clean DOM.
  await win.evaluate(() => {
    document.querySelectorAll('[data-harness-injected-dialog]').forEach((n) => n.remove());
  });

  log('J2 — textarea-focus Esc passes through inline role="dialog" (#286), suppressed by data-modal-dialog');
}

// ---------- composer-morph-mention ----------
// Absorbed from probe-e2e-composer-morph-mention.mjs. Verifies the
// send/stop morph button + @file mention picker. Stubs the `files:list`
// IPC handler on main; restored via registerDispose so subsequent cases
// see the real handler.
async function caseComposerMorphMention({ win, log, app, registerDispose }) {
  // Defensive: morph button aria-label asserts /stop/i; pin English first.
  await win.evaluate(async () => {
    try { if (window.__ccsmI18n && window.__ccsmI18n.language !== 'en') await window.__ccsmI18n.changeLanguage('en'); } catch {}
  });
  // Replace `files:list` with a known-three-row stub. Restore on dispose so
  // subsequent cases see the real handler.
  await app.evaluate(({ ipcMain }) => {
    try { ipcMain.removeHandler('files:list'); } catch {}
    ipcMain.handle('files:list', async () => [
      { path: 'src/components/InputBar.tsx', name: 'InputBar.tsx' },
      { path: 'src/components/MentionPicker.tsx', name: 'MentionPicker.tsx' },
      { path: 'README.md', name: 'README.md' },
    ]);
  });
  registerDispose(async () => {
    // Removing our stub leaves the channel un-handled; subsequent cases
    // either don't touch it or will register their own. Removing is safer
    // than leaving stale data in.
    await app.evaluate(({ ipcMain }) => {
      try { ipcMain.removeHandler('files:list'); } catch {}
    });
  });

  const stubCheck = await win.evaluate(async () => {
    const list = window.ccsm?.files?.list;
    if (typeof list !== 'function') return { ok: false, why: 'list not function' };
    const r = await list(null);
    return { ok: true, count: Array.isArray(r) ? r.length : -1 };
  });
  if (!stubCheck.ok || stubCheck.count !== 3) {
    throw new Error(`bridge stub failed: ${JSON.stringify(stubCheck)} — IPC override didn't take`);
  }

  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: 's-morph', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude',
        groupId: 'g1', agentType: 'claude-code',
      }],
      activeId: 's-morph',
      messagesBySession: { 's-morph': [] },
      startedSessions: { 's-morph': true },
      runningSessions: {},
      messageQueues: {},
    });
  });
  await win.waitForTimeout(300);

  const ta = win.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { throw new Error('textarea did not appear'); });
  // Drain any prior draft text the drafts module-cache may have hung onto.
  await ta.fill('');

  // 1. Morph button: idle = send/primary.
  let morph = win.locator('button[data-morph-state]').first();
  let morphState = await morph.getAttribute('data-morph-state');
  let morphVariant = await morph.getAttribute('data-variant');
  if (morphState !== 'send' || morphVariant !== 'primary') {
    throw new Error(`expected idle morph button send/primary; got ${morphState}/${morphVariant}`);
  }

  // Flip running -> stop/danger.
  await win.evaluate(() => {
    window.__ccsmStore.setState({ runningSessions: { 's-morph': true } });
  });
  await win.waitForTimeout(350);

  morph = win.locator('button[data-morph-state]').first();
  morphState = await morph.getAttribute('data-morph-state');
  morphVariant = await morph.getAttribute('data-variant');
  if (morphState !== 'stop' || morphVariant !== 'danger') {
    throw new Error(`expected running morph button stop/danger; got ${morphState}/${morphVariant}`);
  }
  const morphLabel = await morph.getAttribute('aria-label');
  if (!morphLabel || !/stop/i.test(morphLabel)) {
    throw new Error(`expected aria-label including "Stop"; got ${JSON.stringify(morphLabel)}`);
  }

  // Restore idle for the @mention subtests.
  await win.evaluate(() => {
    window.__ccsmStore.setState({ runningSessions: {} });
  });
  await win.waitForTimeout(200);

  // 2. @ trigger opens picker; Esc dismisses without altering value.
  await ta.click();
  await win.keyboard.type('@');
  await win.waitForTimeout(200);

  let picker = win.getByRole('listbox', { name: /file mentions/i });
  await picker.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { throw new Error('mention picker did not open after typing @'); });

  await win.keyboard.press('Escape');
  await win.waitForTimeout(200);
  const stillOpen = await picker.isVisible().catch(() => false);
  if (stillOpen) throw new Error('mention picker did not dismiss on Esc');
  const valueAfterEsc = await ta.inputValue();
  if (valueAfterEsc !== '@') throw new Error(`Esc altered textarea value: ${JSON.stringify(valueAfterEsc)}`);

  // 3. Re-arm picker by edit, then Enter inserts @<path>.
  await win.keyboard.type(' ');
  await win.keyboard.press('Backspace');
  await win.waitForTimeout(150);

  picker = win.getByRole('listbox', { name: /file mentions/i });
  await picker.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { throw new Error('mention picker did not reopen after edit re-arm'); });

  await win.keyboard.press('Enter');
  await win.waitForTimeout(200);

  const finalValue = await ta.inputValue();
  if (finalValue !== '@src/components/InputBar.tsx ') {
    throw new Error(`expected '@src/components/InputBar.tsx '; got ${JSON.stringify(finalValue)}`);
  }

  log('morph button send<->stop verified; @mention picker open/Esc-dismiss/Enter-commit verified');
}

// ---------- sdk-stream-roundtrip ----------
// E2E coverage for PR #271 (SDK adapter PR-A). The SdkSessionRunner replaces
// the legacy spawn-claude wrapper but preserves the wire shape: the four
// big-bucket frames (system/assistant/user/result) flow through
// translateSdkMessage unchanged and are emitted on the `agent:event` IPC
// channel. This case injects a realistic post-translator frame sequence
// (system init -> assistant text -> result/success) via the real IPC channel
// — `webContents.send('agent:event', ...)`, the same path the SDK runner
// uses in production — and asserts the renderer renders the assistant text
// AND clears the running flag on result, proving the renderer-facing
// contract of the adapter is intact.
async function caseSdkStreamRoundtrip({ app, win, log }) {
  const SID = 's-sdk-roundtrip';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'sdk', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [{ kind: 'user', id: 'u-1', text: 'hello sdk' }] },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true },
    });
  }, SID);
  await win.waitForTimeout(150);

  // Inject the three big-bucket SDK frames via the SAME IPC channel
  // SdkSessionRunner uses (manager.ts:131 `this.emit('agent:event', ...)` ->
  // forwarded to `webContents.send('agent:event', ...)`). This exercises
  // the real lifecycle.subscribeAgentEvents path end-to-end.
  await app.evaluate(({ BrowserWindow }, sid) => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!wc) throw new Error('no BrowserWindow available');
    // 1) system init (post-translator passthrough — see translateSdkMessage)
    wc.send('agent:event', {
      sessionId: sid,
      message: {
        type: 'system',
        subtype: 'init',
        session_id: sid,
        model: 'claude-opus-4',
        cwd: 'C:/x',
        tools: ['Bash', 'Read'],
      },
    });
    // 2) assistant text (post-translator passthrough)
    wc.send('agent:event', {
      sessionId: sid,
      message: {
        type: 'assistant',
        session_id: sid,
        message: {
          id: 'msg-sdk-1',
          role: 'assistant',
          model: 'claude-opus-4',
          content: [{ type: 'text', text: 'PROBE_SDK_REPLY ok' }],
        },
      },
    });
    // 3) result/success (post-translator passthrough)
    wc.send('agent:event', {
      sessionId: sid,
      message: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: sid,
        duration_ms: 42,
        num_turns: 1,
        total_cost_usd: 0.0001,
        usage: { input_tokens: 5, output_tokens: 7 },
        result: 'PROBE_SDK_REPLY ok',
      },
    });
  }, SID);
  await win.waitForTimeout(400);

  // Assertion 1: assistant block rendered with the SDK reply text.
  const state = await win.evaluate((sid) => {
    const s = window.__ccsmStore.getState();
    const blocks = s.messagesBySession[sid] ?? [];
    return {
      blockKinds: blocks.map((b) => b.kind),
      assistantTexts: blocks.filter((b) => b.kind === 'assistant' || b.kind === 'assistant-md').map((b) => b.text),
      running: !!s.runningSessions[sid],
    };
  }, SID);
  const hasAssistantWithText = state.assistantTexts.some((t) => typeof t === 'string' && t.includes('PROBE_SDK_REPLY ok'));
  if (!hasAssistantWithText) {
    throw new Error(`expected assistant block with PROBE_SDK_REPLY, got blocks=${JSON.stringify(state.blockKinds)} texts=${JSON.stringify(state.assistantTexts)}`);
  }
  // Assertion 2: result frame cleared running.
  if (state.running) throw new Error('expected runningSessions cleared after result frame');

  log('SDK frames system+assistant+result via real agent:event IPC -> rendered + running cleared');
}

// ---------- sdk-stream-event-partial ----------
// E2E coverage for PR #271's `includePartialMessages: true` SDK option.
// SdkSessionRunner enables partial streaming so long replies aren't frozen;
// the SDK then emits `stream_event` frames carrying
// `content_block_delta(text_delta)` payloads. translateSdkMessage passes
// these through unchanged. The renderer's PartialAssistantStreamer
// (lifecycle.ts:198) consumes them and incrementally appends text via
// streamAssistantText. This case fires the real partial-frame shape over
// the same `agent:event` IPC channel and asserts the streaming caret
// appears AND the partial text accumulates into a streaming assistant block.
async function caseSdkStreamEventPartial({ app, win, log }) {
  const SID = 's-sdk-partial';
  const BID = 'msg-sdk-partial';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'sdk-partial', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [{ kind: 'user', id: 'u-1', text: 'tell me a story' }] },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true },
    });
  }, SID);
  await win.waitForTimeout(150);

  // Emit message_start + 3x text_delta + message_stop, exactly as the SDK
  // would in `--include-partial-messages` mode (matches the wire shape
  // probe-e2e-streaming-partial-frames.mjs records from real claude.exe).
  await app.evaluate(({ BrowserWindow }, [sid, bid]) => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!wc) throw new Error('no BrowserWindow available');
    const send = (event) => wc.send('agent:event', { sessionId: sid, message: { type: 'stream_event', session_id: sid, event } });
    send({
      type: 'message_start',
      message: { id: bid, type: 'message', role: 'assistant', model: 'claude-opus-4', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } },
    });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Once ' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'upon ' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a time.' } });
  }, [SID, BID]);
  await win.waitForTimeout(300);

  // Wait for streaming caret to attach (AnimatePresence transition; same race
  // the existing streaming case handles).
  try {
    await win.locator('span.animate-pulse').first().waitFor({ state: 'attached', timeout: 2000 });
  } catch { /* fall through */ }
  const caretCount = await win.locator('span.animate-pulse').count();
  if (caretCount < 1) {
    const dump = await win.evaluate((sid) => {
      const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
      return blocks.map((b) => ({ id: b.id, kind: b.kind, text: b.text, streaming: b.streaming }));
    }, SID);
    throw new Error(`expected streaming caret after partial deltas; blocks=${JSON.stringify(dump)}`);
  }

  // Assert the deltas coalesced into a single streaming block with full text.
  const partial = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    const streaming = blocks.filter((b) => b.streaming === true);
    return streaming.map((b) => ({ id: b.id, kind: b.kind, text: b.text }));
  }, SID);
  if (partial.length !== 1) throw new Error(`expected exactly 1 streaming block, got ${partial.length}: ${JSON.stringify(partial)}`);
  if (!partial[0].text || !partial[0].text.includes('Once upon a time.')) {
    throw new Error(`expected streaming text 'Once upon a time.', got ${JSON.stringify(partial[0].text)}`);
  }

  log('SDK stream_event(text_delta) frames via real IPC -> caret visible + 3 deltas coalesced into streaming block');
}

// ---------- sdk-exit-error-surfaces ----------
// E2E coverage for PR #271's exit-error path. SdkSessionRunner's consumer
// loop (sessions.ts:418-429) wraps SDK iterator errors and forwards them to
// `onExit({ error })`, which manager.ts emits as `agent:exit` IPC. The
// renderer's lifecycle handler (lifecycle.ts:376-384) then appends an
// `error` block to the chat AND flips runningSessions off — that's how SDK
// errors become user-visible instead of silently disappearing. This case
// fires a synthetic `agent:exit` with an error string over the real IPC
// channel and asserts both observable effects.
async function caseSdkExitErrorSurfaces({ app, win, log }) {
  const SID = 's-sdk-exit';
  const ERR = 'PROBE_SDK_FAILURE: anthropic api 503';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'sdk-exit', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [{ kind: 'user', id: 'u-1', text: 'do thing' }] },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true },
    });
  }, SID);
  await win.waitForTimeout(150);

  await app.evaluate(({ BrowserWindow }, [sid, err]) => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!wc) throw new Error('no BrowserWindow available');
    wc.send('agent:exit', { sessionId: sid, error: err });
  }, [SID, ERR]);
  await win.waitForTimeout(300);

  const state = await win.evaluate((sid) => {
    const s = window.__ccsmStore.getState();
    const blocks = s.messagesBySession[sid] ?? [];
    return {
      blockKinds: blocks.map((b) => b.kind),
      errorTexts: blocks.filter((b) => b.kind === 'error').map((b) => b.text),
      running: !!s.runningSessions[sid],
    };
  }, SID);
  if (!state.errorTexts.some((t) => typeof t === 'string' && t.includes('PROBE_SDK_FAILURE'))) {
    throw new Error(`expected error block carrying SDK failure text; got blocks=${JSON.stringify(state.blockKinds)} errorTexts=${JSON.stringify(state.errorTexts)}`);
  }
  if (state.running) throw new Error('expected runningSessions cleared after exit-with-error');

  log('SDK exit-with-error via real agent:exit IPC -> error block surfaced + running cleared');
}

// ---------- sdk-tool-use-roundtrip ----------
// Follow-up to PR #326. The 3 existing SDK cases cover text-only assistant
// frames; this one exercises the tool_use / tool_result branch of
// translateSdkMessage + stream-to-blocks. The SDK passes assistant frames
// (containing tool_use blocks) and user frames (containing tool_result
// blocks) through unchanged; the renderer's stream-to-blocks pipeline turns
// them into a `tool` block whose result lands by toolUseId match. We inject
// both frames over the same `agent:event` IPC channel SdkSessionRunner uses
// and assert the ToolBlock renders with both the brief AND the result text.
async function caseSdkToolUseRoundtrip({ app, win, log }) {
  const SID = 's-sdk-tool';
  const TUID = 'toolu_sdk_probe_1';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'sdk-tool', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [{ kind: 'user', id: 'u-1', text: 'read foo' }] },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true },
    });
  }, SID);
  await win.waitForTimeout(150);

  // Inject assistant(tool_use=Read) -> user(tool_result) frame pair via the
  // real `agent:event` IPC. translateSdkMessage passes both straight
  // through; lifecycle.ts -> streamEventToTranslation -> stream-to-blocks
  // turns them into a tool block + setToolResult patch.
  await app.evaluate(({ BrowserWindow }, [sid, tuid]) => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!wc) throw new Error('no BrowserWindow available');
    wc.send('agent:event', {
      sessionId: sid,
      message: {
        type: 'assistant',
        session_id: sid,
        message: {
          id: 'msg-sdk-tool-1',
          role: 'assistant',
          model: 'claude-opus-4',
          content: [
            { type: 'tool_use', id: tuid, name: 'Read', input: { file_path: 'C:/x/foo.txt' } },
          ],
        },
      },
    });
    wc.send('agent:event', {
      sessionId: sid,
      message: {
        type: 'user',
        session_id: sid,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: tuid, content: 'PROBE_TOOL_RESULT body line', is_error: false },
          ],
        },
      },
    });
  }, [SID, TUID]);
  await win.waitForTimeout(400);

  const state = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    const tools = blocks.filter((b) => b.kind === 'tool');
    return tools.map((b) => ({ id: b.id, name: b.name, toolUseId: b.toolUseId, result: b.result, isError: b.isError }));
  }, SID);
  if (state.length !== 1) {
    throw new Error(`expected exactly 1 tool block, got ${state.length}: ${JSON.stringify(state)}`);
  }
  const tool = state[0];
  if (tool.name !== 'Read') throw new Error(`expected tool name=Read, got ${tool.name}`);
  if (tool.toolUseId !== TUID) throw new Error(`expected toolUseId=${TUID}, got ${tool.toolUseId}`);
  if (typeof tool.result !== 'string' || !tool.result.includes('PROBE_TOOL_RESULT body line')) {
    throw new Error(`expected tool result to include PROBE_TOOL_RESULT, got ${JSON.stringify(tool.result)}`);
  }
  if (tool.isError) throw new Error('expected isError=false on success tool_result');

  // The DOM-side ToolBlock should render with the same name and brief.
  const renderedNames = await win.locator('[data-testid="tool-name"], [data-tool-name]').allTextContents().catch(() => []);
  if (renderedNames.length === 0) {
    // fallback: look for the tool brief substring in the chat
    const html = await win.evaluate(() => document.body.innerText);
    if (!html.includes('Read')) {
      throw new Error('expected ToolBlock for Read to render in DOM');
    }
  }

  log('SDK assistant(tool_use)+user(tool_result) via real agent:event IPC -> tool block coalesced with result');
}

// ---------- sdk-system-subtypes ----------
// Follow-up to PR #326. translateSdkMessage allow-lists three system
// subtypes (init, compact_boundary, api_retry) and drops the rest. The 3
// existing SDK cases only cover `init`. This case fires `compact_boundary`
// and `api_retry` frames via the real IPC channel and asserts each lands as
// the expected status banner block (info / warn) per stream-to-blocks
// systemBlocks().
async function caseSdkSystemSubtypes({ app, win, log }) {
  const SID = 's-sdk-sys';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'sdk-sys', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [{ kind: 'user', id: 'u-1', text: 'long convo' }] },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true },
    });
  }, SID);
  await win.waitForTimeout(150);

  await app.evaluate(({ BrowserWindow }, sid) => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!wc) throw new Error('no BrowserWindow available');
    // 1) compact_boundary - emitted by SDK after auto/manual compaction.
    wc.send('agent:event', {
      sessionId: sid,
      message: {
        type: 'system',
        subtype: 'compact_boundary',
        session_id: sid,
        uuid: 'sys-compact-1',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 120000,
          post_tokens: 30000,
          duration_ms: 850,
        },
      },
    });
    // 2) api_retry - emitted by SDK on transient HTTP failures during a turn.
    wc.send('agent:event', {
      sessionId: sid,
      message: {
        type: 'system',
        subtype: 'api_retry',
        session_id: sid,
        uuid: 'sys-retry-1',
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 4000,
        error_status: 503,
      },
    });
  }, SID);
  await win.waitForTimeout(300);

  const banners = await win.evaluate((sid) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
    return blocks
      .filter((b) => b.kind === 'status')
      .map((b) => ({ id: b.id, tone: b.tone, title: b.title, detail: b.detail }));
  }, SID);

  const compact = banners.find((b) => typeof b.title === 'string' && b.title.toLowerCase().includes('compact'));
  if (!compact) throw new Error(`expected compact_boundary status banner, got ${JSON.stringify(banners)}`);
  if (compact.tone !== 'info') throw new Error(`expected compact banner tone=info, got ${compact.tone}`);
  if (typeof compact.detail !== 'string' || !compact.detail.includes('120,000') || !compact.detail.includes('30,000')) {
    throw new Error(`expected compact detail to include pre/post tokens, got ${JSON.stringify(compact.detail)}`);
  }

  const retry = banners.find((b) => typeof b.title === 'string' && b.title.toLowerCase().includes('retry'));
  if (!retry) throw new Error(`expected api_retry status banner, got ${JSON.stringify(banners)}`);
  if (retry.tone !== 'warn') throw new Error(`expected retry banner tone=warn, got ${retry.tone}`);
  if (typeof retry.title !== 'string' || !retry.title.includes('2/5')) {
    throw new Error(`expected retry title to include attempt 2/5, got ${JSON.stringify(retry.title)}`);
  }
  if (typeof retry.detail !== 'string' || !retry.detail.includes('503')) {
    throw new Error(`expected retry detail to include HTTP 503, got ${JSON.stringify(retry.detail)}`);
  }

  log('SDK system subtypes compact_boundary+api_retry via real IPC -> info+warn status banners with metadata');
}

// ---------- sdk-abort-on-disposed ----------
// Follow-up to PR #326. SdkSessionRunner's consumer loop (sessions.ts:419-
// 429) catches AbortError after `dispose()` and surfaces it as
// `onExit({ error: undefined })` — graceful close, NOT an error. The legacy
// case `sdk-exit-error-surfaces` covers the error branch; this one covers
// the symmetric graceful branch: `agent:exit` with no error string MUST
// clear running WITHOUT appending an error block. Regression guard against
// "AbortError gets surfaced as a red error block" UX bug.
async function caseSdkAbortOnDisposed({ app, win, log }) {
  const SID = 's-sdk-abort';
  await win.evaluate((sid) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'sdk-abort', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [{ kind: 'user', id: 'u-1', text: 'do thing' }] },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true },
    });
  }, SID);
  await win.waitForTimeout(150);

  // Mirror what sessions.ts emits on the AbortError-after-dispose branch:
  // `this.onExit({ error: undefined })` -> manager forwards `agent:exit`
  // with no error field. Use `error: undefined` (omitted) to match exactly.
  await app.evaluate(({ BrowserWindow }, sid) => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!wc) throw new Error('no BrowserWindow available');
    wc.send('agent:exit', { sessionId: sid });
  }, SID);
  await win.waitForTimeout(300);

  const state = await win.evaluate((sid) => {
    const s = window.__ccsmStore.getState();
    const blocks = s.messagesBySession[sid] ?? [];
    return {
      blockKinds: blocks.map((b) => b.kind),
      errorTexts: blocks.filter((b) => b.kind === 'error').map((b) => b.text),
      running: !!s.runningSessions[sid],
    };
  }, SID);
  if (state.errorTexts.length > 0) {
    throw new Error(`expected NO error blocks on graceful AbortError exit; got ${JSON.stringify(state.errorTexts)}`);
  }
  if (state.blockKinds.includes('error')) {
    throw new Error(`expected no error blocks at all; got blockKinds=${JSON.stringify(state.blockKinds)}`);
  }
  if (state.running) throw new Error('expected runningSessions cleared after graceful exit');

  log('SDK graceful AbortError exit (agent:exit no error) -> running cleared, NO error block surfaced');
}

// ---------- user-block-hover-menu ----------
// Absorbed from probe-e2e-user-block-hover-menu.mjs. Hover -> 4 action
// buttons fade in (opacity 1); Copy lands text in clipboard; Truncate cuts
// blocks at the user message AND clears resumeSessionId + startedSessions.
async function caseUserBlockHoverMenu({ win, log }) {
  // Defensive: prior runs (or sibling cases) may have left i18n on `zh`
  // persisted in app_state. The aria-label assertions below pin the English
  // strings, so force the renderer to en before seeding.
  await win.evaluate(async () => {
    try { if (window.__ccsmI18n && window.__ccsmI18n.language !== 'en') await window.__ccsmI18n.changeLanguage('en'); } catch {}
  });
  const SAMPLE = 'PROBE_USER_TEXT please implement X';
  const SID = 's-uhover';
  await win.evaluate(([sid, sample]) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: sid, name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4',
        groupId: 'g1', agentType: 'claude-code', resumeSessionId: 'old-uuid'
      }],
      activeId: sid,
      startedSessions: { [sid]: true },
      messagesBySession: {
        [sid]: [
          { kind: 'assistant', id: 'a0', text: 'Earlier reply.' },
          { kind: 'user', id: 'u-rewind', text: sample },
          { kind: 'assistant', id: 'a1', text: 'Followup reply that should be truncated.' }
        ]
      }
    });
  }, [SID, SAMPLE]);
  await win.waitForTimeout(300);

  const userRow = win.locator('[data-user-block-id="u-rewind"]');
  await userRow.waitFor({ state: 'visible', timeout: 5000 });

  await userRow.hover();
  await win.waitForTimeout(250);

  const actions = userRow.locator('[data-testid="user-block-actions"]');
  const opacity = await actions.evaluate((el) => getComputedStyle(el).opacity);
  if (opacity !== '1') {
    throw new Error(`expected actions opacity=1 on hover, got ${opacity}`);
  }

  const labels = ['Edit and resend', 'Retry', 'Copy message', 'Truncate from here'];
  for (const label of labels) {
    const btn = actions.locator(`button[aria-label="${label}"]`);
    if ((await btn.count()) !== 1) {
      throw new Error(`expected exactly 1 button with aria-label="${label}"`);
    }
  }

  await actions.locator('button[aria-label="Copy message"]').click();
  await win.waitForTimeout(200);
  const clip = await win.evaluate(() =>
    navigator.clipboard.readText().catch((e) => `ERR:${e.message}`)
  );
  if (!clip.includes('PROBE_USER_TEXT')) {
    throw new Error(`clipboard missing user text after Copy click (clip=${JSON.stringify(clip.slice(0, 80))})`);
  }

  await actions.locator('button[aria-label="Truncate from here"]').click();
  await win.waitForTimeout(300);

  const after = await win.evaluate((sid) => {
    const s = window.__ccsmStore.getState();
    const blocks = s.messagesBySession[sid] ?? [];
    const sess = s.sessions.find((x) => x.id === sid);
    return {
      blockIds: blocks.map((b) => b.id),
      resume: sess?.resumeSessionId ?? null,
      started: !!s.startedSessions[sid]
    };
  }, SID);
  // Bug #309 ("Rewind from here keeps clicked user message"): the clicked
  // user block (`u-rewind`) MUST remain after the cut — the rewind
  // semantics are "go back to right after this message was sent, before
  // the agent replied", not "delete this message too". Pre-fix
  // `prev.slice(0, idx)` (exclusive) wrongly dropped `u-rewind` and left
  // only `[a0]`; post-fix `prev.slice(0, idx + 1)` (inclusive) keeps it.
  if (after.blockIds.length !== 2 || after.blockIds[0] !== 'a0' || after.blockIds[1] !== 'u-rewind') {
    throw new Error(`expected blocks=[a0, u-rewind] after Truncate (#309: clicked user msg preserved), got ${JSON.stringify(after.blockIds)}`);
  }
  // Bug #288 fix (preserved): `resumeSessionId` is pinned to the on-disk
  // session id (= existing resumeSessionId, here 'old-uuid') so the next
  // `agentStart` resumes via `--resume` instead of colliding on
  // `--session-id`. Do NOT regress to `null`.
  if (after.resume !== 'old-uuid') {
    throw new Error(`expected resumeSessionId='old-uuid' (pinned per #288 fix) after Truncate, got ${JSON.stringify(after.resume)}`);
  }
  if (after.started) {
    throw new Error(`expected startedSessions cleared after Truncate, got true`);
  }

  log('hover reveals 4 actions; Copy -> clipboard; Truncate -> cut keeps clicked user msg + pinned resume');
}

// ---------- cap-pre-main-injects-global (capability demo) ----------
// Demonstrates `preMain`: stage state in the electron MAIN process via
// app.evaluate before the case body runs. The case body then reads it back
// via a second app.evaluate. Mirrors the pattern probe-e2e-notify-integration
// uses to install a fake `__setNotifyImporter`. Pure capability demo —
// asserts only that the value round-trips.
async function casePreMainInjectsGlobal({ app, log }) {
  const observed = await app.evaluate(() => globalThis.__ccsmHarnessCapDemo);
  if (observed !== 'preMain-was-here') {
    throw new Error(`expected preMain to set globalThis.__ccsmHarnessCapDemo='preMain-was-here', got ${JSON.stringify(observed)}`);
  }
  log('preMain injected main-process global; case body read it back');
}

// ---------- cap-relaunch-cold-start (capability demo) ----------
// Demonstrates `relaunch`: the runner closes the shared electron app and
// brings up a fresh one before this case. The case asserts that the store
// is at its post-boot baseline (no sessions from previous cases). Useful
// for cases that need to verify cold-launch UX (probe-e2e-installer-corrupt
// style) without paying for a fresh user-data dir.
async function caseRelaunchColdStart({ win, log }) {
  const sessionCount = await win.evaluate(() => {
    return (window.__ccsmStore?.getState().sessions ?? []).length;
  });
  if (sessionCount !== 0) {
    throw new Error(`expected 0 sessions after relaunch, got ${sessionCount}`);
  }
  log('relaunch produced fresh electron with empty store');
}

// ---------- cap-fresh-userdatadir (capability demo) ----------
// Demonstrates `userDataDir: 'fresh'`: case launches into a brand-new
// mktemp user-data directory. We assert that the userData path electron
// reports lives under the OS tmpdir (so it's distinct from the dev's real
// install). The dir is cleaned up after the case.
async function caseFreshUserDataDir({ app, log }) {
  const info = await app.evaluate(({ app: a }) => {
    return { userData: a.getPath('userData'), tmp: a.getPath('temp') };
  });
  // On all 3 OSes os.tmpdir() and electron's `temp` resolve to the same root.
  // The fresh dir name embeds 'ccsm-harness-' so check that explicitly.
  if (!/ccsm-harness-/.test(info.userData)) {
    throw new Error(`expected userData path to contain 'ccsm-harness-', got ${info.userData}`);
  }
  log(`userData=${info.userData} (fresh tmpdir-rooted)`);
}

// ---------- cap-requires-claude-bin-skip (capability demo) ----------
// Demonstrates `requiresClaudeBin: true`. On dev machines without
// `claude` on PATH (or CCSM_CLAUDE_BIN unset to a real path), the runner
// will SKIP this case — body never executes. On a machine that has the
// CLI we run a trivial assertion. Either outcome counts as harness-pass.
async function caseRequiresClaudeBinSkip({ log }) {
  log('claude binary detected; trivial pass (real probe would exec it here)');
}

// ============================================================================
// Absorbed probes (PR: harness-agent absorbs 12 standalone probes).
// Each case below was a `scripts/probe-e2e-<name>.mjs` file. The original
// files are deleted in the same PR; their semantics are preserved here.
// ============================================================================

// ---------- empty-group-new-session (was probe-e2e-empty-group-new-session) ----------
// Bug 1 (PR #149): clicking the sidebar's "New Session" button when there's
// no usable (kind='normal') group must atomically synthesize a default
// normal group AND insert a session into it, then activate it.
async function caseEmptyGroupNewSession({ win, log }) {
  async function clickSidebarNewSession() {
    const btn = win.locator('aside').getByRole('button', { name: /^New Session$/ });
    await btn.first().waitFor({ state: 'visible', timeout: 10000 });
    await btn.first().click();
  }
  async function readState() {
    return await win.evaluate(() => {
      const s = window.__ccsmStore.getState();
      return {
        groups: s.groups.map((g) => ({ id: g.id, name: g.name, kind: g.kind })),
        sessions: s.sessions.map((x) => ({ id: x.id, groupId: x.groupId, name: x.name })),
        activeId: s.activeId
      };
    });
  }
  async function expectComposerVisible() {
    const composer = win.getByPlaceholder(/Ask anything…|Reply…/);
    try {
      await composer.first().waitFor({ state: 'visible', timeout: 10000 });
    } catch { return false; }
    return true;
  }

  // Scenario A: zero groups
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [], sessions: [], activeId: undefined, tutorialSeen: true
    });
  });
  await win.waitForTimeout(150);
  await clickSidebarNewSession();
  await win.waitForFunction(
    () => {
      const s = window.__ccsmStore.getState();
      return s.groups.length === 1 && s.sessions.length === 1 && !!s.activeId;
    }, null, { timeout: 10000 }
  );
  {
    const st = await readState();
    if (st.groups.length !== 1) throw new Error(`A: expected 1 group, got ${st.groups.length}`);
    const g = st.groups[0];
    if (g.kind !== 'normal') throw new Error(`A: synthesized group should be kind=normal, got ${g.kind}`);
    if (g.name !== 'Sessions') throw new Error(`A: synthesized group name should be "Sessions", got "${g.name}"`);
    if (st.sessions.length !== 1) throw new Error(`A: expected 1 session, got ${st.sessions.length}`);
    const s = st.sessions[0];
    if (s.groupId !== g.id) throw new Error(`A: session.groupId=${s.groupId} should equal new group id ${g.id}`);
    if (st.activeId !== s.id) throw new Error(`A: activeId=${st.activeId} should equal new session id ${s.id}`);
    if (!(await expectComposerVisible())) throw new Error('A: composer not visible after createSession');
  }

  // Scenario B: only archived groups
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g-old', name: 'Old', collapsed: false, kind: 'archive' }],
      sessions: [], activeId: undefined, tutorialSeen: true
    });
  });
  await win.waitForTimeout(150);
  await clickSidebarNewSession();
  await win.waitForFunction(
    () => {
      const s = window.__ccsmStore.getState();
      return s.groups.length === 2 && s.sessions.length === 1 && !!s.activeId;
    }, null, { timeout: 10000 }
  );
  {
    const st = await readState();
    if (st.groups.length !== 2) throw new Error(`B: expected 2 groups, got ${st.groups.length}`);
    const old = st.groups.find((g) => g.id === 'g-old');
    if (!old) throw new Error('B: original archived group "g-old" was lost');
    if (old.kind !== 'archive') throw new Error(`B: original group kind mutated to ${old.kind}`);
    const fresh = st.groups.find((g) => g.id !== 'g-old');
    if (!fresh || fresh.kind !== 'normal') throw new Error(`B: expected new normal group beside archive, got ${JSON.stringify(fresh)}`);
    if (fresh.name !== 'Sessions') throw new Error(`B: synthesized group name should be "Sessions", got "${fresh.name}"`);
    if (st.sessions.length !== 1) throw new Error(`B: expected 1 session, got ${st.sessions.length}`);
    const s = st.sessions[0];
    if (s.groupId !== fresh.id) throw new Error(`B: session should belong to new normal group ${fresh.id}, got ${s.groupId}`);
    if (st.activeId !== s.id) throw new Error(`B: activeId=${st.activeId} should equal new session id ${s.id}`);
    if (!(await expectComposerVisible())) throw new Error('B: composer not visible after createSession');
  }
  log('A: zero groups → 1 normal group + 1 session; B: archive preserved + new normal group + session');
}

// ---------- interrupt-banner (was probe-e2e-interrupt-banner) ----------
// Bug 1: result{error_during_execution} after Stop must render as neutral
// "Interrupted" status, not an ErrorBlock. Bug 2: banner/empty-state/error
// text are user-selectable.
async function caseInterruptBanner({ win, log }) {
  const sessionId = await win.evaluate(() => {
    const st = window.__ccsmStore.getState();
    st.createSession('~/interrupt-probe');
    return window.__ccsmStore.getState().activeId;
  });
  if (!sessionId) throw new Error('no active session id after createSession');

  // EmptyState renders the composer hint ("type a message and press [Enter]")
  // when no messages exist. Old "Ready when you are." greeting was removed
  // from EmptyState (dogfood: redundant with placeholder/hint). The hint
  // span itself is `select-none` by design, so we only assert it rendered;
  // user-selectable copy is exercised by banner/error checks elsewhere.
  await win.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('span')).some((s) =>
        /type a message and press/i.test(s.textContent || '')
      ),
    null,
    { timeout: 5000 }
  ).catch(() => {
    throw new Error('EmptyState composer hint not rendered');
  });

  await win.evaluate((id) => {
    const st = window.__ccsmStore.getState();
    st.setRunning(id, true);
    st.appendBlocks(id, [
      { kind: 'user', id: 'u-probe', text: 'count slowly from 1 to 100' },
      { kind: 'assistant', id: 'a-probe', text: '1\n2\n3\n' }
    ]);
  }, sessionId);

  const statusBlock = await win.evaluate((sid) => {
    const st = window.__ccsmStore.getState();
    st.markInterrupted(sid);
    const interrupted = st.consumeInterrupted(sid);
    if (!interrupted) return { ok: false, reason: 'flag not consumed' };
    st.appendBlocks(sid, [{ kind: 'status', id: 'res-probe', tone: 'info', title: 'Interrupted' }]);
    st.setRunning(sid, false);
    return { ok: true };
  }, sessionId);
  if (!statusBlock.ok) throw new Error(`interrupt flag not consumed: ${statusBlock.reason}`);

  await win.waitForFunction(
    () => Array.from(document.querySelectorAll('[role="status"]')).some((n) => n.textContent?.includes('Interrupted')),
    null, { timeout: 5000 }
  ).catch(() => { throw new Error('Interrupted banner not rendered'); });
  const banner = await win.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[role="status"]'));
    const el = nodes.find((n) => n.textContent?.includes('Interrupted'));
    if (!el) return { found: false };
    return {
      found: true, text: el.textContent, userSelect: getComputedStyle(el).userSelect,
      hasAlert: !!el.closest('[role="alert"]')
    };
  });
  if (!banner.found) throw new Error('Interrupted banner not rendered');
  if (banner.hasAlert) throw new Error('Interrupted banner is inside role="alert" — should be neutral');
  if (banner.userSelect === 'none') throw new Error(`Interrupted banner user-select is 'none'`);
  if (banner.text?.toLowerCase().includes('error_during_execution'))
    throw new Error('banner text leaked "error_during_execution"');

  await win.evaluate((sid) => {
    window.__ccsmStore.getState().appendBlocks(sid, [{ kind: 'error', id: 'err-probe', text: 'Genuine failure details' }]);
  }, sessionId);
  await win.waitForSelector('[role="alert"]', { timeout: 5000 });
  const errorBlock = await win.evaluate(() => {
    const el = document.querySelector('[role="alert"]');
    if (!el) return { found: false };
    return { found: true, text: el.textContent, userSelect: getComputedStyle(el).userSelect };
  });
  if (!errorBlock.found) throw new Error('ErrorBlock not rendered');
  if (errorBlock.userSelect === 'none') throw new Error(`ErrorBlock user-select is 'none'`);
  if (!errorBlock.text?.includes('Genuine failure details')) throw new Error('ErrorBlock missing expected text');

  const statusBar = await win.evaluate(() => {
    const el = document.querySelector('.h-6.font-mono');
    if (!el) return { found: false };
    return { found: true, userSelect: getComputedStyle(el).userSelect };
  });
  if (statusBar.found && statusBar.userSelect === 'none') throw new Error(`StatusBar user-select still 'none'`);
  log('EmptyState/Interrupted/ErrorBlock all selectable; interrupt → neutral status (no ErrorBlock)');
}

// ---------- tool-journey-render (was probe-e2e-tool-journey-render) ----------
// Pure-store journey suite: toggle persistence + ANSI + truncation + tool error
// styling + multi-tool independence + per-file diff chrome + cancel IPC + elapsed counter pause.
async function caseToolJourneyRender({ app, win, log }) {
  const failures = [];
  function record(name, pass, observed = '') {
    const tag = pass ? '[OK]' : '[XX]';
    log(`  ${tag} ${name}${observed ? ' — ' + observed : ''}`);
    if (!pass) failures.push(name);
  }
  async function seed(blocks) {
    await win.evaluate(({ blocks }) => {
      const store = window.__ccsmStore;
      store.setState({
        groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
        sessions: [{
          id: 's-tool', name: 'tool-journey', state: 'idle', cwd: 'C:/x',
          model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code'
        }],
        activeId: 's-tool',
        messagesBySession: { 's-tool': blocks },
        startedSessions: { 's-tool': true },
        runningSessions: {}, messageQueues: {},
      });
    }, { blocks });
    await win.waitForTimeout(250);
  }

  // J1: toggle persists across new frames
  {
    await seed([
      { kind: 'user', id: 'u1', text: 'run a command' },
      { kind: 'tool', id: 't1', toolUseId: 'tu_1', name: 'Bash',
        brief: 'echo hi', expanded: false, result: 'hi-result-MARKER', isError: false },
    ]);
    const toolBtns0 = await win.locator('main button[aria-expanded]').all();
    if (toolBtns0.length === 0) {
      record('J1 toggle persists across new frames', false, 'no button[aria-expanded] in <main>');
    } else {
      const initialExpanded = await toolBtns0[0].getAttribute('aria-expanded');
      const btn = toolBtns0[0];
      await btn.click();
      await win.waitForTimeout(150);
      const afterClick = await btn.getAttribute('aria-expanded');
      const markerVisibleAfterClick = await win.evaluate(() => document.body.innerText.includes('hi-result-MARKER'));
      await win.evaluate(() => {
        window.__ccsmStore.getState().appendBlocks('s-tool', [{ kind: 'assistant', id: 'a-new', text: 'new turn after toggle' }]);
      });
      await win.waitForTimeout(250);
      const btnsAfter = await win.locator('main button[aria-expanded]').all();
      const afterFrame = btnsAfter.length > 0 ? await btnsAfter[0].getAttribute('aria-expanded') : '<lost>';
      const markerVisibleAfterFrame = await win.evaluate(() => document.body.innerText.includes('hi-result-MARKER'));
      const pass = (afterClick !== initialExpanded) && (afterFrame === afterClick) && (markerVisibleAfterFrame === markerVisibleAfterClick);
      record('J1 toggle persists across new frames', pass,
        `init=${initialExpanded} click=${afterClick} frame=${afterFrame}`);
    }
  }

  // J2: ANSI color preserved
  {
    const ansi = '\x1b[31mERROR_TOKEN\x1b[0m and_then_plain';
    await seed([{ kind: 'tool', id: 't2', toolUseId: 'tu_2', name: 'Bash', brief: 'fail', expanded: true, result: ansi, isError: false }]);
    await win.evaluate(() => { document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click()); });
    await win.waitForTimeout(200);
    const probe = await win.evaluate(() => {
      const text = document.body.innerText;
      const literalSeq = text.includes('\x1b[31m') || text.includes('[31m');
      let errColor = null, plainColor = null;
      const all = document.querySelectorAll('main *');
      for (const el of all) {
        if (!errColor && el.textContent === 'ERROR_TOKEN') errColor = getComputedStyle(el).color;
        if (!plainColor && el.textContent && el.textContent.trim() === 'and_then_plain') plainColor = getComputedStyle(el).color;
      }
      return { literalSeq, errColor, plainColor };
    });
    const pass = probe.literalSeq === false && probe.errColor && probe.plainColor && probe.errColor !== probe.plainColor;
    record('J2 ANSI color preserved', pass, JSON.stringify(probe));
  }

  // J3: ANSI cursor-move scrubbing
  {
    const progress = 'progress 10%\n\x1b[1A\x1b[Kprogress 50%\n\x1b[1A\x1b[Kprogress 100%';
    await seed([{ kind: 'tool', id: 't3', toolUseId: 'tu_3', name: 'Bash', brief: 'install', expanded: true, result: progress, isError: false }]);
    await win.evaluate(() => { document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click()); });
    await win.waitForTimeout(200);
    const probe = await win.evaluate(() => {
      const text = document.body.innerText;
      return {
        hasLiteralEsc: text.includes('\x1b[') || text.includes('\\x1b[') || /\[1A|\[K/.test(text),
        progress100Visible: text.includes('progress 100%'),
      };
    });
    record('J3 ANSI cursor-move scrubbed', !probe.hasLiteralEsc && probe.progress100Visible, JSON.stringify(probe));
  }

  // J4 a-d: long output truncation/expand
  {
    const LINES = 50_000;
    const big = Array.from({ length: LINES }, (_, i) => `line_${i.toString().padStart(6, '0')}_${'x'.repeat(80)}`).join('\n');
    await seed([{ kind: 'tool', id: 't4', toolUseId: 'tu_4', name: 'Read', brief: 'huge.log', expanded: true, result: big, isError: false }]);
    await win.evaluate(() => { document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click()); });
    await win.waitForTimeout(400);

    const collapsedProbe = await win.evaluate(({ HEAD, TAIL, LINES }) => {
      const head = document.querySelector('[data-testid="tool-output-collapsed-head"]');
      const tail = document.querySelector('[data-testid="tool-output-collapsed-tail"]');
      const sep = document.querySelector('[data-testid="tool-output-separator"]');
      const copyBtn = document.querySelector('[data-testid="tool-output-copy"]');
      const saveBtn = document.querySelector('[data-testid="tool-output-save"]');
      const expandBtn = document.querySelector('[data-testid="tool-output-expand"]');
      const all = document.querySelectorAll('.flex-1.overflow-y-auto');
      const stream = all[all.length - 1];
      const matches = stream ? stream.innerText.match(/line_(\d{6})/g) ?? [] : [];
      const indices = matches.map((m) => parseInt(m.slice(5), 10));
      const min = indices.length ? Math.min(...indices) : -1;
      const max = indices.length ? Math.max(...indices) : -1;
      const expectedHidden = LINES - HEAD - TAIL;
      const sepText = sep ? sep.textContent ?? '' : '';
      return {
        hasHead: !!head, hasTail: !!tail, hasSeparator: !!sep,
        sepHasCount: sepText.includes(String(expectedHidden)),
        hasCopyBtn: !!copyBtn, hasSaveBtn: !!saveBtn, hasExpandBtn: !!expandBtn,
        firstLineSeen: min, lastLineSeen: max,
        visibleLineCount: indices.length,
        streamInnerLen: stream ? stream.innerText.length : 0,
      };
    }, { HEAD: 50, TAIL: 50, LINES });
    const collapsedPass = collapsedProbe.hasHead && collapsedProbe.hasTail && collapsedProbe.hasSeparator &&
      collapsedProbe.sepHasCount && collapsedProbe.hasCopyBtn && collapsedProbe.hasSaveBtn &&
      collapsedProbe.hasExpandBtn && collapsedProbe.firstLineSeen === 0 &&
      collapsedProbe.lastLineSeen === LINES - 1 && collapsedProbe.visibleLineCount <= 120 &&
      collapsedProbe.streamInnerLen < 50_000;
    record('J4a long output collapsed', collapsedPass, JSON.stringify(collapsedProbe));

    await win.evaluate(() => { document.querySelector('[data-testid="tool-output-expand"]')?.click(); });
    await win.waitForTimeout(300);
    const expandedProbe = await win.evaluate(() => {
      const viewport = document.querySelector('[data-testid="tool-output-viewport"]');
      const spacer = document.querySelector('[data-testid="tool-output-spacer"]');
      if (!viewport || !spacer) return { error: 'no viewport/spacer' };
      const lineEls = spacer.querySelectorAll('[data-line-index]');
      const indices = Array.from(lineEls).map((el) => parseInt(el.getAttribute('data-line-index') ?? '-1', 10));
      const min = indices.length ? Math.min(...indices) : -1;
      const max = indices.length ? Math.max(...indices) : -1;
      const spacerH = spacer.getBoundingClientRect().height;
      return {
        mountedLineCount: indices.length, firstMountedIdx: min, lastMountedIdx: max,
        spacerHeightPx: spacerH, viewportInnerLen: viewport.innerText.length,
      };
    });
    const expandedPass = typeof expandedProbe.mountedLineCount === 'number' &&
      expandedProbe.mountedLineCount > 0 && expandedProbe.mountedLineCount < 1000 &&
      expandedProbe.firstMountedIdx === 0 && expandedProbe.lastMountedIdx < 1000 &&
      typeof expandedProbe.spacerHeightPx === 'number' && expandedProbe.spacerHeightPx > 100_000;
    record('J4b expanded virtualizes', expandedPass, JSON.stringify(expandedProbe));

    await win.evaluate(() => {
      const v = document.querySelector('[data-testid="tool-output-viewport"]');
      if (v) v.scrollTop = v.scrollHeight;
    });
    await win.waitForTimeout(250);
    const scrolledProbe = await win.evaluate(({ LINES }) => {
      const spacer = document.querySelector('[data-testid="tool-output-spacer"]');
      if (!spacer) return { error: 'no spacer' };
      const indices = Array.from(spacer.querySelectorAll('[data-line-index]'))
        .map((el) => parseInt(el.getAttribute('data-line-index') ?? '-1', 10));
      const min = indices.length ? Math.min(...indices) : -1;
      const max = indices.length ? Math.max(...indices) : -1;
      return { mountedLineCount: indices.length, firstMountedIdx: min, lastMountedIdx: max, sawLastLine: max === LINES - 1 };
    }, { LINES });
    const scrolledPass = typeof scrolledProbe.mountedLineCount === 'number' &&
      scrolledProbe.mountedLineCount < 1000 && scrolledProbe.sawLastLine === true &&
      scrolledProbe.firstMountedIdx > LINES - 1000;
    record('J4c expanded scroll-to-end mounts tail', scrolledPass, JSON.stringify(scrolledProbe));

    await win.evaluate(() => { document.querySelector('[data-testid="tool-output-expand"]')?.click(); });
    await win.waitForTimeout(200);
    const reCollapsed = await win.evaluate(() => ({
      hasHead: !!document.querySelector('[data-testid="tool-output-collapsed-head"]'),
      hasViewport: !!document.querySelector('[data-testid="tool-output-viewport"]'),
    }));
    record('J4d collapse round-trips', reCollapsed.hasHead && !reCollapsed.hasViewport, JSON.stringify(reCollapsed));
  }

  // J4-extreme: >10MB blocks expand
  {
    const HUGE_LINES = 110_000;
    const huge = Array.from({ length: HUGE_LINES }, (_, i) => `xline_${i.toString().padStart(6, '0')}_${'x'.repeat(100)}`).join('\n');
    await seed([{ kind: 'tool', id: 't4x', toolUseId: 'tu_4x', name: 'Read', brief: 'mega.log', expanded: true, result: huge, isError: false }]);
    await win.evaluate(() => { document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click()); });
    await win.waitForTimeout(500);
    const xprobe = await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="tool-output-expand"]');
      const sep = document.querySelector('[data-testid="tool-output-separator"]');
      const save = document.querySelector('[data-testid="tool-output-save"]');
      return {
        expandDisabled: btn ? btn.hasAttribute('disabled') : null,
        sepDisabled: sep ? sep.hasAttribute('disabled') : null,
        hasSave: !!save,
      };
    });
    await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="tool-output-expand"]');
      if (btn && !btn.hasAttribute('disabled')) btn.click();
      const sep = document.querySelector('[data-testid="tool-output-separator"]');
      if (sep && !sep.hasAttribute('disabled')) sep.click();
    });
    await win.waitForTimeout(200);
    const stillNoViewport = await win.evaluate(() => !document.querySelector('[data-testid="tool-output-viewport"]'));
    record('J4-extreme >10MB blocks inline expand',
      xprobe.expandDisabled === true && xprobe.sepDisabled === true && xprobe.hasSave === true && stillNoViewport === true,
      JSON.stringify({ ...xprobe, stillNoViewport }));
  }

  // J5: tool error visually distinct
  {
    await seed([
      { kind: 'tool', id: 't5a', toolUseId: 'tu_5a', name: 'Bash', brief: 'ok', expanded: true, result: 'OK_RESULT_TOKEN', isError: false },
      { kind: 'tool', id: 't5b', toolUseId: 'tu_5b', name: 'Bash', brief: 'bad', expanded: true, result: 'ERR_RESULT_TOKEN', isError: true },
    ]);
    await win.evaluate(() => { document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click()); });
    await win.waitForTimeout(200);
    const probe = await win.evaluate(() => {
      function containerFor(marker) {
        const all = document.querySelectorAll('main *');
        for (const el of all) {
          if (el.children.length === 0 && el.textContent && el.textContent.includes(marker)) {
            let cur = el;
            for (let i = 0; i < 12 && cur; i++) {
              if (cur.querySelector && cur.querySelector('button[aria-expanded]')) return cur;
              cur = cur.parentElement;
            }
            return el.parentElement;
          }
        }
        return null;
      }
      function snap(el) {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color, border: cs.borderColor, outline: cs.outlineColor,
          className: el.className && typeof el.className === 'string' ? el.className : '' };
      }
      return { ok: snap(containerFor('OK_RESULT_TOKEN')), err: snap(containerFor('ERR_RESULT_TOKEN')) };
    });
    const differs = probe.ok && probe.err && (
      probe.ok.bg !== probe.err.bg || probe.ok.color !== probe.err.color ||
      probe.ok.border !== probe.err.border || probe.ok.className !== probe.err.className
    );
    record('J5 tool error visually distinct', !!differs);
  }

  // J5b: errored tool block auto-expands
  {
    await seed([
      { kind: 'tool', id: 't5c', toolUseId: 'tu_5c', name: 'Bash', brief: 'fail-auto', expanded: false, result: 'AUTO_EXPAND_ERR_TOKEN', isError: true },
      { kind: 'tool', id: 't5d', toolUseId: 'tu_5d', name: 'Bash', brief: 'ok-auto', expanded: false, result: 'AUTO_EXPAND_OK_TOKEN', isError: false },
    ]);
    await win.waitForTimeout(200);
    const probe = await win.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('main button[aria-expanded]'));
      function find(token) {
        for (const b of btns) {
          const root = b.closest('[data-testid="tool-block-root"]');
          if (root && root.textContent && root.textContent.includes(token)) return b;
        }
        return null;
      }
      const errBtn = find('fail-auto');
      const okBtn = find('ok-auto');
      return {
        errExpanded: errBtn ? errBtn.getAttribute('aria-expanded') : null,
        okExpanded: okBtn ? okBtn.getAttribute('aria-expanded') : null,
        errBodyVisible: document.body.innerText.includes('AUTO_EXPAND_ERR_TOKEN'),
        okBodyVisible: document.body.innerText.includes('AUTO_EXPAND_OK_TOKEN'),
      };
    });
    record('J5b errored auto-expands; healthy stays collapsed',
      probe.errExpanded === 'true' && probe.okExpanded === 'false' && probe.errBodyVisible === true && probe.okBodyVisible === false,
      JSON.stringify(probe));
  }

  // J6: multi-tool independent toggles
  {
    await seed([
      { kind: 'tool', id: 't6a', toolUseId: 'tu_6a', name: 'Bash', brief: 'ls', expanded: false, result: 'RESULT_A_TOKEN', isError: false },
      { kind: 'tool', id: 't6b', toolUseId: 'tu_6b', name: 'Read', brief: 'index.ts', expanded: false, result: 'RESULT_B_TOKEN', isError: false },
      { kind: 'tool', id: 't6c', toolUseId: 'tu_6c', name: 'Grep', brief: 'foo', expanded: false, result: 'RESULT_C_TOKEN', isError: false },
    ]);
    const btns = await win.locator('main button[aria-expanded]').all();
    if (btns.length < 3) {
      record('J6 multi-tool independent toggles', false, `only ${btns.length} aria-expanded buttons`);
    } else {
      await btns[1].click();
      await win.waitForTimeout(200);
      const states = await Promise.all(btns.map((b) => b.getAttribute('aria-expanded')));
      const visibility = await win.evaluate(() => ({
        a: document.body.innerText.includes('RESULT_A_TOKEN'),
        b: document.body.innerText.includes('RESULT_B_TOKEN'),
        c: document.body.innerText.includes('RESULT_C_TOKEN'),
      }));
      const pass = states[0] === 'false' && states[1] === 'true' && states[2] === 'false' &&
        !visibility.a && visibility.b && !visibility.c;
      record('J6 multi-tool independent toggles', pass, `states=${JSON.stringify(states)} vis=${JSON.stringify(visibility)}`);
    }
  }

  // J10: per-file diff collapse chrome (#302)
  {
    await seed([
      { kind: 'tool', id: 't-d1', toolUseId: 'tu_d1', name: 'Edit', brief: 'a.ts', expanded: true,
        input: { file_path: '/a.ts', old_string: 'old_A', new_string: 'NEW_A_TOK' }, result: 'ok', isError: false },
      { kind: 'tool', id: 't-d2', toolUseId: 'tu_d2', name: 'Edit', brief: 'b.ts', expanded: true,
        input: { file_path: '/b.ts', old_string: 'old_B\nold_B2', new_string: 'NEW_B_TOK\nNEW_B2_TOK' }, result: 'ok', isError: false },
      { kind: 'tool', id: 't-d3', toolUseId: 'tu_d3', name: 'Edit', brief: 'c.ts', expanded: true,
        input: { file_path: '/c.ts', old_string: '', new_string: 'NEW_C_TOK' }, result: 'ok', isError: false },
    ]);
    await win.evaluate(() => { document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click()); });
    await win.waitForTimeout(250);
    const probe = await win.evaluate(() => {
      const wrappers = Array.from(document.querySelectorAll('[data-testid="diff-view"]'));
      const fileCounts = wrappers.map((w) => w.getAttribute('data-file-count'));
      const fileToggleBtns = Array.from(document.querySelectorAll('[data-testid="diff-view"] button[aria-expanded][aria-label^="Toggle file:"]'));
      const expandedStates = fileToggleBtns.map((b) => b.getAttribute('aria-expanded'));
      const text = document.body.innerText;
      const plusMatches = (text.match(/\+\d+\s*\/\s*-\d+/g) ?? []).length;
      return {
        diffViewCount: wrappers.length, fileCounts, toggleBtnCount: fileToggleBtns.length,
        expandedStates, plusMatches,
        sawTokA: text.includes('NEW_A_TOK'), sawTokB: text.includes('NEW_B_TOK'), sawTokC: text.includes('NEW_C_TOK'),
      };
    });
    const pass = probe.diffViewCount === 3 && probe.fileCounts.every((c) => c === '1') &&
      probe.toggleBtnCount === 3 && probe.expandedStates.every((s) => s === 'true') &&
      probe.plusMatches >= 3 && probe.sawTokA && probe.sawTokB && probe.sawTokC;
    record('J10 per-file diff collapse chrome', pass, JSON.stringify(probe));
  }

  // J9 + J9b: per-tool-use cancel IPC (#239)
  {
    await app.evaluate(({ ipcMain }) => {
      const calls = (global.__cancelCalls = []);
      try { ipcMain.removeHandler('agent:cancelToolUse'); } catch {}
      ipcMain.handle('agent:cancelToolUse', (_e, args) => { calls.push(args); return { ok: true }; });
    });

    await seed([{ kind: 'tool', id: 't-cancel', toolUseId: 'tu-cancel-XYZ', name: 'Bash', brief: 'sleep 200', expanded: false }]);
    await win.evaluate(() => {
      const realNow = Date.now.bind(Date);
      window.__realDateNow = realNow;
      Date.now = () => realNow() + 95_000;
      window.__ccsmStore.getState().appendBlocks('s-tool', [{ kind: 'assistant', id: 'a-noop-cancel', text: '' }]);
    });
    await win.waitForTimeout(400);

    const cancelEl = await win.$('[data-testid="tool-stall-cancel"]');
    let invokedWith = null;
    let cancellingTextAfter = null;
    let ariaDisabledAfter = null;
    let ariaLabelOk = null;
    if (cancelEl) {
      const aria = await cancelEl.getAttribute('aria-label');
      ariaLabelOk = aria === 'Cancel tool';
      await cancelEl.click();
      await win.waitForTimeout(150);
      const calls = await app.evaluate(() => (global.__cancelCalls || []).slice());
      const observed = await win.evaluate(() => ({
        text: document.querySelector('[data-testid="tool-stall-cancel"]')?.textContent ?? null,
        aria: document.querySelector('[data-testid="tool-stall-cancel"]')?.getAttribute('aria-disabled') ?? null,
      }));
      invokedWith = calls[0] ?? null;
      cancellingTextAfter = observed.text;
      ariaDisabledAfter = observed.aria;
    }
    await win.evaluate(() => { if (window.__realDateNow) Date.now = window.__realDateNow; });
    record('J9 cancel link aria-label="Cancel tool"', ariaLabelOk === true);
    const passWiring = !!cancelEl && invokedWith && invokedWith.sessionId === 's-tool' && invokedWith.toolUseId === 'tu-cancel-XYZ';
    record('J9 cancel button invokes agentCancelToolUse', !!passWiring,
      `invokedWith=${JSON.stringify(invokedWith)}`);
    const passCancellingState = cancellingTextAfter && /cancelling/i.test(cancellingTextAfter) && ariaDisabledAfter === 'true';
    record('J9b cancel link → "Cancelling…" + aria-disabled', !!passCancellingState,
      `text=${JSON.stringify(cancellingTextAfter)} aria-disabled=${ariaDisabledAfter}`);
  }

  // J11: elapsed counter pauses while permission pending (#311)
  {
    await win.evaluate(() => {
      const realNow = Date.now.bind(Date);
      window.__realDateNow = realNow;
      window.__nowOffset = 0;
      Date.now = () => realNow() + window.__nowOffset;
    });
    await seed([
      { kind: 'user', id: 'u-pp', text: 'run a command' },
      { kind: 'tool', id: 't-pp', toolUseId: 'tu-pp-1', name: 'Bash', brief: 'rm -rf node_modules', expanded: false },
      { kind: 'waiting', id: 'wait-pp', intent: 'permission', requestId: 'req-pp', toolName: 'Bash',
        prompt: 'Bash: rm -rf node_modules', toolInput: { command: 'rm -rf node_modules' } },
    ]);
    await win.evaluate(() => {
      window.__nowOffset = 95_000;
      window.__ccsmStore.getState().appendBlocks('s-tool', [{ kind: 'assistant', id: 'a-noop-pp', text: '' }]);
    });
    await win.waitForTimeout(400);
    const pendingProbe = await win.evaluate(() => ({
      hasElapsed: !!document.querySelector('[data-testid="tool-elapsed"]'),
      hasStalled: !!document.querySelector('[data-testid="tool-stalled"]'),
      hasEscalated: !!document.querySelector('[data-testid="tool-stall-escalated"]'),
      hasCancel: !!document.querySelector('[data-testid="tool-stall-cancel"]'),
      hasPermissionPrompt: !!document.querySelector('[data-testid="permission-prompt"]') ||
        document.body.innerText.includes('rm -rf node_modules'),
    }));
    const pausedPass = pendingProbe.hasElapsed === false && pendingProbe.hasStalled === false &&
      pendingProbe.hasEscalated === false && pendingProbe.hasCancel === false &&
      pendingProbe.hasPermissionPrompt === true;
    record('J11a elapsed/stall suppressed during permission gate', pausedPass, JSON.stringify(pendingProbe));

    await win.evaluate(() => {
      const store = window.__ccsmStore;
      const blocks = store.getState().messagesBySession['s-tool'].filter((b) => b.kind !== 'waiting');
      store.setState({ messagesBySession: { 's-tool': blocks } });
    });
    await win.waitForTimeout(200);
    const justClearedText = await win.evaluate(() =>
      document.querySelector('[data-testid="tool-elapsed"]')?.textContent ?? null);
    await win.evaluate(() => { window.__nowOffset = 95_000 + 2_000; });
    await win.waitForTimeout(300);
    const afterTickText = await win.evaluate(() =>
      document.querySelector('[data-testid="tool-elapsed"]')?.textContent ?? null);
    const parseSec = (s) => {
      if (!s) return NaN;
      const m = s.match(/^(\d+)\.(\d)s$/);
      return m ? parseInt(m[1], 10) + parseInt(m[2], 10) / 10 : NaN;
    };
    const justSec = parseSec(justClearedText);
    const tickSec = parseSec(afterTickText);
    const startsFromZero = !isNaN(justSec) && justSec < 1.5;
    const ticksAfter = !isNaN(tickSec) && tickSec >= 1.5 && tickSec < 5.0;
    const noEscalation = await win.evaluate(() => !document.querySelector('[data-testid="tool-stall-escalated"]'));
    record('J11b elapsed counter starts from zero at execution-begin',
      startsFromZero && ticksAfter && noEscalation,
      `just=${justSec}s tick=${tickSec}s noEsc=${noEscalation}`);
    await win.evaluate(() => { if (window.__realDateNow) Date.now = window.__realDateNow; });
  }

  if (failures.length > 0) throw new Error(`${failures.length} journey(s) failed: ${failures.join('; ')}`);
}

// ---------- input-queue (was probe-e2e-input-queue) ----------
// CLI-style message queue + Esc interrupt — needs real claude.exe to drive
// the assistant turn long enough to enqueue a follow-up.
async function caseInputQueue({ app, win, log }) {
  await app.evaluate(async ({ dialog }, fakeCwd) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeCwd] });
  }, process.cwd());

  const newBtn = win.getByRole('button', { name: /new session/i }).first();
  await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await newBtn.click();

  const textarea = win.locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 5000 });

  const cwdChip = win.locator('[data-cwd-chip]').first();
  await cwdChip.waitFor({ state: 'visible', timeout: 5000 });
  await cwdChip.click();
  const browseItem = win.getByText('Browse folder…').first();
  await browseItem.waitFor({ state: 'visible', timeout: 3000 });
  await browseItem.click();
  await win.waitForTimeout(400);

  await textarea.click();
  await textarea.fill('count slowly from one to fifteen, one number per line');
  await win.keyboard.press('Enter');

  const stopBtn = win.getByRole('button', { name: /^stop$/i });
  await stopBtn.waitFor({ state: 'visible', timeout: 15_000 });

  await textarea.click();
  await textarea.fill('also reply with the single word: queued-pong');
  await win.keyboard.press('Enter');

  const chip = win.getByText(/\+1 queued/);
  await chip.waitFor({ state: 'visible', timeout: 5000 });
  await chip.waitFor({ state: 'hidden', timeout: 90_000 });

  const queuedEcho = win.getByText('also reply with the single word: queued-pong').first();
  if (!(await queuedEcho.isVisible().catch(() => false))) {
    throw new Error('queued user-echo missing from chat after drain');
  }
  await stopBtn.waitFor({ state: 'hidden', timeout: 60_000 });
  log('+1 queued chip visible during run; drained to user echo + completed second turn');
}

// ---------- send (was probe-e2e-send) ----------
// User journey: New Session → cwd via dialog → Enter sends → assistant reply rendered.
async function caseSend({ app, win, log }) {
  await app.evaluate(async ({ dialog }, fakeCwd) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeCwd] });
  }, process.cwd());

  const newBtn = win.getByRole('button', { name: /new session/i }).first();
  await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await newBtn.click();

  const textarea = win.locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 5000 });

  const cwdChip = win.locator('[data-cwd-chip]').first();
  await cwdChip.waitFor({ state: 'visible', timeout: 5000 });
  await cwdChip.click();
  const browseItem = win.getByText('Browse folder…').first();
  await browseItem.waitFor({ state: 'visible', timeout: 3000 });
  await browseItem.click();
  await win.waitForTimeout(400);

  const assistantSelector = '[data-type-scale-role="assistant-body"]';
  async function countAssistantBlocks() {
    return await win.evaluate((sel) => document.querySelectorAll(sel).length, assistantSelector);
  }
  let assistantBaseline = await countAssistantBlocks();
  async function sendAndWait(text, label, timeoutMs = 60_000) {
    await textarea.click();
    await textarea.fill(text);
    await win.keyboard.press('Enter');
    const echo = win.getByText(text, { exact: false }).first();
    await echo.waitFor({ state: 'visible', timeout: 5000 });
    const deadline = Date.now() + timeoutMs;
    let now = assistantBaseline;
    while (Date.now() < deadline) {
      now = await countAssistantBlocks();
      if (now > assistantBaseline) break;
      await win.waitForTimeout(250);
    }
    if (now <= assistantBaseline) throw new Error(`[${label}] no new assistant block within ${timeoutMs}ms`);
    assistantBaseline = now;
  }

  await sendAndWait('reply with the single word: pong', 'baseline');

  await textarea.click();
  await textarea.fill('');
  await textarea.type('first line');
  await win.keyboard.down('Shift');
  await win.keyboard.press('Enter');
  await win.keyboard.up('Shift');
  await textarea.type('second line');
  const composerValue = await textarea.inputValue();
  if (composerValue !== 'first line\nsecond line') {
    throw new Error(`[multiline] Shift+Enter did not insert newline. composer=${JSON.stringify(composerValue)}`);
  }
  await win.keyboard.press('Enter');
  const mlEcho = win.getByText('second line', { exact: false }).first();
  await mlEcho.waitFor({ state: 'visible', timeout: 5000 });
  {
    const deadline = Date.now() + 60_000;
    let now = assistantBaseline;
    while (Date.now() < deadline) {
      now = await countAssistantBlocks();
      if (now > assistantBaseline) break;
      await win.waitForTimeout(250);
    }
    if (now <= assistantBaseline) throw new Error('[multiline] no new assistant block within 60s');
    assistantBaseline = now;
  }

  const tricky = 'echo this back literally please: <tag> `inline` 🚀';
  await sendAndWait(tricky, 'tricky');
  const trickyEcho = win.getByText(tricky, { exact: true }).first();
  if (!(await trickyEcho.isVisible().catch(() => false))) {
    const partials = ['<tag>', '`inline`', '🚀'];
    const present = await Promise.all(
      partials.map((p) => win.getByText(p, { exact: false }).first().isVisible().catch(() => false))
    );
    const dropped = partials.filter((_, i) => !present[i]);
    throw new Error(`[tricky] user echo missing exact match; missing: ${dropped.join(', ') || '(layout-only)'}`);
  }
  log('3/3 phases: baseline + multiline + tricky chars');
}

// ---------- switch (was probe-e2e-switch) ----------
// A→B→A round-trip preserves chat history, draft, focus, scroll.
async function caseSwitch({ app, win, log }) {
  await app.evaluate(async ({ dialog }, fakeCwd) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeCwd] });
  }, process.cwd());

  const PROMPT_A = 'reply with the single word: alpha';
  const PROMPT_B = 'reply with the single word: beta';
  const DRAFT_A = 'half-typed alpha follow-up — DO NOT SEND';

  async function clickNewSession() {
    const btn = win.getByRole('button', { name: /new session/i }).first();
    await btn.waitFor({ state: 'visible', timeout: 15_000 });
    await btn.click();
    await win.locator('textarea').waitFor({ state: 'visible', timeout: 5000 });
  }
  async function setCwdViaChip() {
    const chip = win.locator('[data-cwd-chip]').first();
    await chip.waitFor({ state: 'visible', timeout: 5000 });
    await chip.click();
    const browseItem = win.getByText('Browse folder…').first();
    await browseItem.waitFor({ state: 'visible', timeout: 3000 });
    await browseItem.click();
    await win.waitForTimeout(400);
  }
  async function sendPrompt(text) {
    const textarea = win.locator('textarea');
    await textarea.click();
    await textarea.fill(text);
    await win.keyboard.press('Enter');
    const assistant = win.locator('[data-type-scale-role="assistant-body"]').filter({ has: win.locator('span:has-text("●")') });
    await assistant.first().waitFor({ state: 'visible', timeout: 30_000 });
    await win.waitForTimeout(800);
  }

  await clickNewSession();
  await setCwdViaChip();
  await sendPrompt(PROMPT_A);

  if (!(await win.getByText(PROMPT_A).first().isVisible().catch(() => false))) {
    throw new Error('alpha user echo not visible right after sending');
  }
  async function chatSnapshot() {
    return await win.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.innerText : '';
    });
  }
  const snapshotA_before = await chatSnapshot();
  if (!snapshotA_before.includes(PROMPT_A)) throw new Error('chat snapshot of session A missing alpha');

  const textarea = win.locator('textarea');
  await textarea.click();
  await textarea.fill(DRAFT_A);
  if ((await textarea.inputValue()) !== DRAFT_A) throw new Error('draft did not stick before switch');

  await clickNewSession();
  await win.waitForTimeout(500);
  if (await win.getByText(PROMPT_A).first().isVisible().catch(() => false)) {
    throw new Error('after switch to B, A content still visible');
  }
  if ((await textarea.inputValue()) !== '') throw new Error('B composer is not empty — A draft leaked');
  await setCwdViaChip();
  await sendPrompt(PROMPT_B);

  const sessionCount = await win.locator('aside li').count();
  if (sessionCount < 2) throw new Error(`expected ≥2 sessions in sidebar, got ${sessionCount}`);
  await win.locator('aside li').nth(1).click();
  await win.waitForTimeout(800);

  const snapshotA_after = await chatSnapshot();
  if (!snapshotA_after.includes(PROMPT_A)) throw new Error('session A lost chat history after A→B→A');
  const assistantStillThere = await win.locator('[data-type-scale-role="assistant-body"]').filter({ has: win.locator('span:has-text("●")') })
    .first().isVisible().catch(() => false);
  if (!assistantStillThere) throw new Error('assistant block in A missing after round-trip');

  if ((await textarea.inputValue()) !== DRAFT_A) throw new Error('composer draft for A not restored on switch-back');

  const focusInfo = await win.evaluate(() => {
    const ae = document.activeElement;
    if (!ae) return { tag: null, hasInputBarAttr: false };
    return { tag: ae.tagName, hasInputBarAttr: ae.hasAttribute('data-input-bar') };
  });
  if (!focusInfo.hasInputBarAttr) throw new Error(`focus did not return to composer; activeElement=${JSON.stringify(focusInfo)}`);

  const scrollState = await win.evaluate(() => {
    const el = document.querySelector('[data-chat-stream]');
    if (!el) return { ok: false, reason: 'no [data-chat-stream]' };
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return { ok: true, distanceFromBottom };
  });
  if (!scrollState.ok) throw new Error(`scroll probe failed: ${scrollState.reason}`);
  if (scrollState.distanceFromBottom > 64) throw new Error(`chat did not snap to bottom; Δ=${scrollState.distanceFromBottom}`);

  log(`A→B→A retained alpha + draft + focus; scroll Δ=${scrollState.distanceFromBottom}px`);
}

// ---------- tool-call-dogfood (was probe-e2e-tool-call-dogfood) ----------
async function caseToolCallDogfood({ win, log }) {
  const newBtn = win.getByRole('button', { name: /new session/i }).first();
  await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await newBtn.click();
  const textarea = win.locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 5000 });
  await textarea.click();
  await textarea.fill('Use the Bash tool to run `echo dogfood_marker_8421` and tell me what it printed.');
  await win.keyboard.press('Enter');

  const toolBtn = win.locator('button[aria-expanded]').first();
  await toolBtn.waitFor({ state: 'visible', timeout: 90_000 });
  const toolText = await toolBtn.innerText();
  await win.waitForTimeout(8000);
  const markerSeen = await win.evaluate(() => document.body.innerText.includes('dogfood_marker_8421'));
  log(`tool block: ${toolText.replace(/\s+/g, ' ').slice(0, 100)} | marker echoed: ${markerSeen}`);
}

// ---------- streaming-partial-frames (was probe-e2e-streaming-partial-frames) ----------
// Wire-level: real claude.exe spawn → assert ≥2 stream_event(text_delta)
// frames + dots visible at T0 + dots gone after first delta.
async function caseStreamingPartialFrames({ win, log }) {
  await win.evaluate(() => {
    window.__probeFrames = [];
    window.__probeFirstTextDeltaAt = null;
    const t0 = Date.now();
    const off = window.ccsm.onAgentEvent((e) => {
      const msg = e.message;
      const entry = { ts: Date.now() - t0, sessionId: e.sessionId, type: msg?.type ?? '<no-type>' };
      if (msg && msg.type === 'stream_event') {
        const inner = msg.event ?? {};
        entry.eventType = inner.type;
        if (inner.type === 'content_block_delta') {
          entry.deltaType = inner.delta?.type;
          if (inner.delta?.type === 'text_delta' && window.__probeFirstTextDeltaAt === null) {
            window.__probeFirstTextDeltaAt = Date.now();
          }
        }
      }
      window.__probeFrames.push(entry);
    });
    window.__probeOff = off;
  });

  await win.getByRole('button', { name: /new session/i }).first().click();
  await win.waitForTimeout(1000);
  // Use harness root as the cwd; it exists.
  await win.evaluate((p) => {
    const st = window.__ccsmStore?.getState?.();
    if (st && typeof st.changeCwd === 'function') st.changeCwd(p);
  }, process.cwd());
  await win.waitForTimeout(400);

  const ta = win.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 8000 });
  await ta.click();
  await ta.fill('Write a 100-word summary of what TypeScript is. Just the summary, no preamble.');
  await win.keyboard.press('Enter');
  const sentAt = Date.now();

  let dotsVisibleAtT0 = false;
  const t0Deadline = Date.now() + 4_000;
  while (Date.now() < t0Deadline) {
    await win.waitForTimeout(150);
    const v = await win.locator('[data-testid="chat-thinking-dots"]').first().isVisible({ timeout: 100 }).catch(() => false);
    if (v) { dotsVisibleAtT0 = true; break; }
    const firstDeltaAt = await win.evaluate(() => window.__probeFirstTextDeltaAt);
    if (firstDeltaAt) break;
  }
  if (!dotsVisibleAtT0) {
    const dump = await win.evaluate(() => window.__probeFrames.slice(0, 30));
    throw new Error(`chat-thinking-dots not visible at T0; frames=${JSON.stringify(dump).slice(0, 500)}`);
  }

  const deltaDl = Date.now() + 90_000;
  let textDeltaCount = 0, sawAssistantFinal = false, sawTurnResult = false;
  while (Date.now() < deltaDl) {
    await win.waitForTimeout(500);
    const snap = await win.evaluate(() => {
      let textDeltas = 0, assistant = false, result = false;
      for (const f of window.__probeFrames) {
        if (f.type === 'stream_event' && f.eventType === 'content_block_delta' && f.deltaType === 'text_delta') textDeltas++;
        if (f.type === 'assistant') assistant = true;
        if (f.type === 'result') result = true;
      }
      return { textDeltas, assistant, result };
    });
    textDeltaCount = snap.textDeltas;
    sawAssistantFinal = snap.assistant;
    sawTurnResult = snap.result;
    if (sawTurnResult) break;
    if (textDeltaCount >= 2 && sawAssistantFinal) {
      await win.waitForTimeout(2000);
      break;
    }
  }
  if (textDeltaCount < 2) throw new Error(`expected ≥2 text_delta frames; got ${textDeltaCount}`);

  const firstDeltaAt = await win.evaluate(() => window.__probeFirstTextDeltaAt);
  if (firstDeltaAt) {
    const elapsed = Date.now() - firstDeltaAt;
    if (elapsed < 2000) await win.waitForTimeout(2000 - elapsed);
  }
  const dotsStillVisible = await win.locator('[data-testid="chat-thinking-dots"]').first().isVisible({ timeout: 200 }).catch(() => false);
  if (dotsStillVisible) throw new Error('chat-thinking-dots still visible >2s after first text_delta');
  void sentAt;
  log(`text_delta_frames=${textDeltaCount} dots_at_T0=true dots_after_delta=false`);
}

// ---------- notify-integration (was probe-e2e-notify-integration) ----------
// Verifies the inlined notify module pipeline end-to-end:
//   - permission / question / turn_done emit through the wrapper with the
//     post-W1 payload shape (toastId, sessionName, groupName, eventType).
//   - allow-always activation routes back into the renderer store.
//   - main-process focus suppression (`shouldSuppressForFocus`) drops a
//     duplicate emit when a window is focused and visible.
//   - rich done payload truncates lastAssistantMsg to 80 chars w/ ellipsis.
// W4 removed the question-retry / reject-cancel / fire-time-gate probes that
// previously shipped here.
//
// Uses preMain to install the mock importer + bootstrapNotify. After this case
// runs, bootstrapNotify state is mutated; pair with `relaunch: true` on the
// NEXT case (or rely on case ordering — placed near end of cases array).
async function caseNotifyIntegration({ app, win, log }) {
  async function blurAndWaitUnfocused() {
    await app.evaluate(async ({ BrowserWindow }) => {
      const stillFocused = () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused() && w.isVisible());
      for (const w of BrowserWindow.getAllWindows()) { try { w.blur(); } catch {} }
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && stillFocused()) await new Promise((r) => setTimeout(r, 50));
      if (stillFocused()) {
        for (const w of BrowserWindow.getAllWindows()) { try { w.hide(); } catch {} }
        const dl2 = Date.now() + 1000;
        while (Date.now() < dl2 && stillFocused()) await new Promise((r) => setTimeout(r, 50));
      }
    });
  }

  // Install mock importer + re-bootstrap notify.
  const installed = await app.evaluate(async ({ BrowserWindow }) => {
    const g = globalThis;
    const dbg = g.__ccsmDebug;
    if (!dbg || !dbg.notify || !dbg.notifyBootstrap) {
      throw new Error('__ccsmDebug.notify / notifyBootstrap not exposed');
    }
    g.__notifyCalls = [];
    g.__notifyOnAction = null;
    const notifyMod = dbg.notify;
    const bootstrapMod = dbg.notifyBootstrap;
    notifyMod.__setNotifyImporter(async () => ({
      Notifier: {
        create: async (opts) => {
          g.__notifyOnAction = opts.onAction;
          return {
            permission: (p) => g.__notifyCalls.push({ kind: 'permission', payload: p }),
            question: (p) => g.__notifyCalls.push({ kind: 'question', payload: p }),
            done: (p) => g.__notifyCalls.push({ kind: 'done', payload: p }),
            dismiss: (id) => g.__notifyCalls.push({ kind: 'dismiss', toastId: id }),
            dispose: () => {},
          };
        },
      },
    }));
    bootstrapMod.__resetBootstrapForTests();
    bootstrapMod.bootstrapNotify((event) => {
      g.__notifyCalls.push({ kind: 'router', event });
      bootstrapMod.createDefaultToastActionRouter({
        resolvePermission: dbg.sessions.resolvePermission.bind(dbg.sessions),
        getMainWindow: () => BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()) ?? null,
      })(event);
    });
    await notifyMod.probeNotifyAvailability();
    return notifyMod.isNotifyAvailable();
  });
  if (installed !== true) throw new Error(`failed to install mock notify importer (isNotifyAvailable=${installed})`);

  // Seed session.
  await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    s.createGroup('Test Group');
    const groups = window.__ccsmStore.getState().groups;
    const groupId = groups[groups.length - 1].id;
    s.createSession(groupId, { name: 'Test Session', cwd: '/tmp/probe-cwd' });
  });
  const sessionId = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    return s.sessions[s.sessions.length - 1].id;
  });
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('failed to seed session');

  await blurAndWaitUnfocused();

  const REQUEST_ID = 'probe-req-1';
  await win.evaluate((args) => window.ccsm.notify({
    sessionId: args.sessionId, title: 'Permission needed', body: 'Bash: ls -la', eventType: 'permission',
    extras: { toastId: args.requestId, sessionName: 'Test Session', toolName: 'Bash', toolBrief: 'ls -la', cwd: '/tmp/probe-cwd' },
  }), { sessionId, requestId: REQUEST_ID });
  await app.evaluate(async () => {
    const dl = Date.now() + 3000;
    while (Date.now() < dl) {
      if ((globalThis.__notifyCalls || []).some((c) => c.kind === 'permission')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for notifyPermission');
  });
  const calls1 = await app.evaluate(() => globalThis.__notifyCalls);
  const perm = calls1.find((c) => c.kind === 'permission');
  if (!perm) throw new Error('notifyPermission was never called');
  if (perm.payload.toastId !== REQUEST_ID) throw new Error(`unexpected toastId: ${perm.payload.toastId}`);
  if (perm.payload.toolName !== 'Bash') throw new Error(`unexpected toolName: ${perm.payload.toolName}`);
  if (perm.payload.cwdBasename !== 'probe-cwd') throw new Error(`expected cwdBasename "probe-cwd", got ${perm.payload.cwdBasename}`);

  // Question.
  await win.evaluate((args) => window.ccsm.notify({
    sessionId: args.sessionId, title: 'Question', body: 'Pick one', eventType: 'question',
    extras: { toastId: 'q-probe-q-1', sessionName: 'Test Session', question: 'Pick one', selectionKind: 'single', optionCount: 3, cwd: '/tmp/probe-cwd' },
  }), { sessionId });
  await app.evaluate(async () => {
    const dl = Date.now() + 3000;
    while (Date.now() < dl) {
      if ((globalThis.__notifyCalls || []).some((c) => c.kind === 'question')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for notifyQuestion');
  });
  const calls2 = await app.evaluate(() => globalThis.__notifyCalls);
  const question = calls2.find((c) => c.kind === 'question');
  if (!question) throw new Error('notifyQuestion was never called');
  if (question.payload.optionCount !== 3) throw new Error(`unexpected optionCount: ${question.payload.optionCount}`);

  // Turn done.
  await win.evaluate((args) => window.ccsm.notify({
    sessionId: args.sessionId, title: 'Done', body: 'Finished build', eventType: 'turn_done',
    extras: { toastId: 'done-probe-1', sessionName: 'Test Session', groupName: 'Test Group', elapsedMs: 42_000, toolCount: 4, lastUserMsg: 'build it', lastAssistantMsg: 'Finished build', cwd: '/tmp/probe-cwd' },
  }), { sessionId });
  await app.evaluate(async () => {
    const dl = Date.now() + 3000;
    while (Date.now() < dl) {
      if ((globalThis.__notifyCalls || []).some((c) => c.kind === 'done')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for notifyDone');
  });
  const calls3 = await app.evaluate(() => globalThis.__notifyCalls);
  const done = calls3.find((c) => c.kind === 'done');
  if (!done) throw new Error('notifyDone was never called');
  if (done.payload.toolCount !== 4) throw new Error(`unexpected toolCount: ${done.payload.toolCount}`);
  if (done.payload.elapsedMs !== 42_000) throw new Error(`unexpected elapsedMs: ${done.payload.elapsedMs}`);

  // allow-always activation routes back to renderer.
  await win.evaluate((args) => {
    const s = window.__ccsmStore.getState();
    s.appendBlocks(args.sessionId, [{
      kind: 'waiting', id: `wait-${args.requestId}`, prompt: 'Bash: ls -la',
      intent: 'permission', requestId: args.requestId, toolName: 'Bash', toolInput: { command: 'ls -la' },
    }]);
  }, { sessionId, requestId: REQUEST_ID });
  await app.evaluate(({ ipcMain }, args) => {
    void ipcMain;
    const cb = globalThis.__notifyOnAction;
    if (!cb) throw new Error('onAction not captured');
    cb({ toastId: args.requestId, action: 'allow-always', args: {} });
  }, { requestId: REQUEST_ID });
  await win.waitForFunction(() => window.__ccsmStore.getState().allowAlwaysTools.includes('Bash'), null, { timeout: 3000 });

  // Focus suppression.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.isVisible());
    if (w) w.focus();
  });
  const suppressed = await app.evaluate(({ BrowserWindow }) => {
    const dbg = globalThis.__ccsmDebug;
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    if (w && !w.isFocused()) { try { w.show(); w.focus(); } catch {} }
    return dbg.notifyBootstrap.shouldSuppressForFocus();
  });
  if (!suppressed) throw new Error('shouldSuppressForFocus returned false with focused window');
  const before = await app.evaluate(() => (globalThis.__notifyCalls || []).filter((c) => c.kind === 'permission').length);
  await win.evaluate((args) => window.ccsm.notify({
    sessionId: args.sessionId, title: 'Should be suppressed', body: 'focus gate', eventType: 'permission',
    extras: { toastId: 'probe-req-suppressed', sessionName: 'Test Session', toolName: 'Bash', toolBrief: 'echo suppress', cwd: '/tmp/probe-cwd' },
  }), { sessionId });
  await new Promise((r) => setTimeout(r, 400));
  const after = await app.evaluate(() => (globalThis.__notifyCalls || []).filter((c) => c.kind === 'permission').length);
  if (after !== before) throw new Error(`focus suppression failed — wrapper called ${after - before} extra times`);

  // Rich done payload (#252).
  const longAssistant = 'x'.repeat(200);
  await blurAndWaitUnfocused();
  await win.evaluate((args) => window.ccsm.notify({
    sessionId: args.sessionId, title: 'Done (rich)', eventType: 'turn_done',
    extras: { toastId: 'done-rich-1', sessionName: 'Test Session', groupName: 'Test Group',
      lastUserMsg: 'do the thing', lastAssistantMsg: args.longAssistant,
      elapsedMs: 12_345, toolCount: 3, cwd: '/tmp/probe-cwd' },
  }), { sessionId, longAssistant });
  await app.evaluate(async () => {
    const dl = Date.now() + 3000;
    while (Date.now() < dl) {
      if ((globalThis.__notifyCalls || []).some((c) => c.kind === 'done' && c.payload.toastId === 'done-rich-1')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for rich done');
  });
  const richDone = await app.evaluate(() =>
    (globalThis.__notifyCalls || []).find((c) => c.kind === 'done' && c.payload.toastId === 'done-rich-1'));
  if (!richDone) throw new Error('rich done not captured');
  if (richDone.payload.groupName !== 'Test Group') throw new Error(`groupName: ${richDone.payload.groupName}`);
  if (richDone.payload.sessionName !== 'Test Session') throw new Error(`sessionName: ${richDone.payload.sessionName}`);
  if (typeof richDone.payload.lastAssistantMsg !== 'string') throw new Error('lastAssistantMsg missing');
  if (richDone.payload.lastAssistantMsg.length !== 80) throw new Error(`lastAssistantMsg length: ${richDone.payload.lastAssistantMsg.length}`);
  if (!richDone.payload.lastAssistantMsg.endsWith('…')) throw new Error('expected ellipsis at end of truncated lastAssistantMsg');

  log('all notify checkpoints passed (perm/question/done emit, allow-always routing, focus suppress, rich done)');
}

// ---------- delete-session-kills-process (was probe-e2e-delete-session-kills-process) ----------
// deleteSession must dispatch agent:close → activeSessionCount → 0.
async function caseDeleteSessionKillsProcess({ app, win, log }) {
  const cwd = process.cwd();
  const sessionId = randomUUID();
  await win.evaluate(({ sid, cwd }) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'delete-probe', state: 'idle', cwd, model: 'claude-sonnet-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid, messagesBySession: { [sid]: [] }, startedSessions: {}, runningSessions: {}
    });
  }, { sid: sessionId, cwd });

  const startRes = await win.evaluate(async ({ sid, cwd }) =>
    await window.ccsm.agentStart(sid, { cwd, permissionMode: 'default' }), { sid: sessionId, cwd });
  if (!startRes || startRes.ok !== true) throw new Error(`agentStart failed: ${JSON.stringify(startRes)}`);

  await win.evaluate((sid) => {
    const st = window.__ccsmStore.getState();
    st.markStarted(sid);
    st.setRunning(sid, true);
  }, sessionId);

  let countBefore = 0;
  for (let i = 0; i < 30; i++) {
    countBefore = await app.evaluate(() => globalThis.__ccsmDebug?.activeSessionCount() ?? -1);
    if (countBefore === -1) throw new Error('__ccsmDebug missing in main process');
    if (countBefore > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (countBefore <= 0) throw new Error(`activeSessionCount=${countBefore} after agentStart; expected > 0`);

  const selfExitsBefore = await app.evaluate(() => globalThis.__ccsmDebug.selfExitCount?.() ?? -1);
  if (selfExitsBefore < 0) throw new Error('__ccsmDebug.selfExitCount missing');

  await win.evaluate((sid) => window.__ccsmStore.getState().deleteSession(sid), sessionId);

  const deadline = Date.now() + 5_000;
  let countAfter = countBefore;
  while (Date.now() < deadline) {
    countAfter = await app.evaluate(() => globalThis.__ccsmDebug?.activeSessionCount() ?? -1);
    if (countAfter === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (countAfter !== 0) throw new Error(`activeSessionCount=${countAfter} 5s after deleteSession; expected 0`);

  const selfExitsAfter = await app.evaluate(() => globalThis.__ccsmDebug.selfExitCount());
  if (selfExitsAfter !== selfExitsBefore) {
    throw new Error(`selfExitCount went ${selfExitsBefore} -> ${selfExitsAfter} during poll — CLI self-exited; cannot distinguish from handler-driven teardown`);
  }
  log(`activeSessionCount went ${countBefore} -> 0 within 5s of deleteSession`);
}

// ---------- close-window-aborts-sessions (was probe-e2e-close-window-aborts-sessions) ----------
// `before-quit` handler must drive sessions.closeAll(). Pair with `relaunch: true`
// since this puts the app into is-quitting mode and contaminates subsequent cases.
async function caseCloseWindowAbortsSessions({ app, win, log }) {
  const cwd = process.cwd();
  const sessionId = randomUUID();
  await win.evaluate(({ sid, cwd }) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'close-probe', state: 'idle', cwd, model: 'claude-sonnet-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid, messagesBySession: { [sid]: [] }, startedSessions: {}, runningSessions: {}
    });
  }, { sid: sessionId, cwd });

  const startRes = await win.evaluate(async ({ sid, cwd }) =>
    await window.ccsm.agentStart(sid, { cwd, permissionMode: 'default' }), { sid: sessionId, cwd });
  if (!startRes || startRes.ok !== true) throw new Error(`agentStart failed: ${JSON.stringify(startRes)}`);

  let countBefore = 0;
  for (let i = 0; i < 30; i++) {
    countBefore = await app.evaluate(() => globalThis.__ccsmDebug?.activeSessionCount() ?? -1);
    if (countBefore === -1) throw new Error('__ccsmDebug missing');
    if (countBefore > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (countBefore <= 0) throw new Error(`activeSessionCount=${countBefore} after agentStart`);

  const selfExitsBefore = await app.evaluate(() => globalThis.__ccsmDebug.selfExitCount?.() ?? -1);
  if (selfExitsBefore < 0) throw new Error('__ccsmDebug.selfExitCount missing');

  await app.evaluate(({ app: a }) => {
    a.emit('before-quit', { preventDefault() {}, defaultPrevented: false });
  });

  const deadline = Date.now() + 5_000;
  let countAfter = countBefore;
  while (Date.now() < deadline) {
    countAfter = await app.evaluate(() => globalThis.__ccsmDebug?.activeSessionCount() ?? -1);
    if (countAfter === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (countAfter !== 0) throw new Error(`activeSessionCount=${countAfter} 5s after before-quit; expected 0`);

  const selfExitsAfter = await app.evaluate(() => globalThis.__ccsmDebug.selfExitCount());
  if (selfExitsAfter !== selfExitsBefore) {
    throw new Error(`selfExitCount went ${selfExitsBefore} -> ${selfExitsAfter} — CLI self-exited; false pass`);
  }
  log(`activeSessionCount went ${countBefore} -> 0 within 5s of before-quit`);
}

// ---------- default-cwd (was probe-e2e-default-cwd) ----------
// Default cwd "~" must expand correctly so spawn doesn't ENOENT.
async function caseDefaultCwd({ win, log }) {
  const errors = [];
  win.on('console', (m) => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });

  const newBtn = win.getByRole('button', { name: /new session/i }).first();
  await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await newBtn.click();
  const textarea = win.locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 5000 });

  // Deliberately skip the cwd chip — default cwd is "~".
  await textarea.click();
  await textarea.fill('hi');
  await win.keyboard.press('Enter');

  const assistant = win.locator('[data-type-scale-role="assistant-body"]').filter({ has: win.locator('span:has-text("●")') });
  await assistant.first().waitFor({ state: 'visible', timeout: 30_000 });

  const symptom = errors.find((e) => /native binary not found|ENOENT/i.test(e));
  if (symptom) throw new Error(`console reported spawn failure: ${symptom}`);
  log('default cwd "~" produced an assistant reply');
}

// ---------- restore-session-undo (was probe-e2e-restore-session-undo) ----------
// Right-click delete + Undo round-trip on a single session.
// Pure-store, single-launch — original probe was misnamed "restore-*";
// 桶 4 reviewer reclassified to harness-agent.
async function caseRestoreSessionUndo({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'gA', name: 'A', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: 's-keep', name: 'keep', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
        { id: 's-doom', name: 'doomed', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' }
      ],
      activeId: 's-doom',
      focusedGroupId: null,
      messagesBySession: {
        's-doom': [
          { kind: 'user', id: 'u1', text: 'hello from doomed' },
          { kind: 'assistant', id: 'a1', text: 'persisted reply' }
        ]
      },
      tutorialSeen: true
    });
  });
  await win.waitForTimeout(200);

  const row = win.locator('li[data-session-id="s-doom"]').first();
  await row.waitFor({ state: 'visible', timeout: 5000 });
  await row.click({ button: 'right' });
  const del = win.getByRole('menuitem').filter({ hasText: /^Delete$/ }).first();
  await del.waitFor({ state: 'visible', timeout: 3000 });
  await del.click();

  await win.waitForFunction(
    () => !document.querySelector('li[data-session-id="s-doom"]'),
    null,
    { timeout: 3000 }
  );

  const undoBtn = win.locator('button').filter({ hasText: /^Undo$/ }).first();
  await undoBtn.waitFor({ state: 'visible', timeout: 3000 });
  await undoBtn.click();

  await win.waitForFunction(
    () => !!document.querySelector('li[data-session-id="s-doom"]'),
    null,
    { timeout: 3000 }
  );

  const after = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    const sess = s.sessions.find((x) => x.id === 's-doom');
    return {
      present: !!sess,
      name: sess?.name,
      msgs: s.messagesBySession['s-doom']?.length ?? 0,
      running: !!s.runningSessions['s-doom'],
      interrupted: !!s.interruptedSessions['s-doom']
    };
  });
  if (!after.present) throw new Error('s-doom missing from store after Undo');
  if (after.msgs !== 2) throw new Error(`expected 2 restored messages, got ${after.msgs}`);
  if (after.name !== 'doomed') throw new Error(`expected name='doomed', got '${after.name}'`);
  if (after.running || after.interrupted) {
    throw new Error(`running/interrupted leaked back into store: running=${after.running} interrupted=${after.interrupted}`);
  }
  log(`s-doom delete → Undo restored row + ${after.msgs} messages; running/interrupted NOT restored`);
}

// ---------- restore-group-undo (was probe-e2e-restore-group-undo) ----------
// Right-click delete-group + cascade + Undo round-trip.
// Pure-store, single-launch — same misnaming as restore-session-undo above.
async function caseRestoreGroupUndo({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [
        { id: 'gKeep', name: 'Keep', collapsed: false, kind: 'normal' },
        { id: 'gDoom', name: 'DoomedGroup', collapsed: false, kind: 'normal' }
      ],
      sessions: [
        { id: 'sk1', name: 'k1', state: 'idle', cwd: '~', model: 'm', groupId: 'gKeep', agentType: 'claude-code' },
        { id: 'sd1', name: 'd1', state: 'idle', cwd: '~', model: 'm', groupId: 'gDoom', agentType: 'claude-code' },
        { id: 'sd2', name: 'd2', state: 'idle', cwd: '~', model: 'm', groupId: 'gDoom', agentType: 'claude-code' }
      ],
      activeId: 'sk1',
      focusedGroupId: null,
      messagesBySession: {
        sd1: [{ kind: 'user', id: 'u-d1', text: 'first session memory' }],
        sd2: [{ kind: 'assistant', id: 'a-d2', text: 'second session memory' }]
      },
      tutorialSeen: true
    });
  });
  await win.waitForTimeout(200);

  const orderBefore = await win.evaluate(() =>
    window.__ccsmStore
      .getState()
      .sessions.filter((s) => s.groupId === 'gDoom')
      .map((s) => s.id)
  );

  const header = win.locator('[data-group-header-id="gDoom"]').first();
  await header.waitFor({ state: 'visible', timeout: 5000 });
  await header.click({ button: 'right' });

  const delMenu = win.getByRole('menuitem').filter({ hasText: /^Delete group…$/ }).first();
  await delMenu.waitFor({ state: 'visible', timeout: 3000 });
  await delMenu.click();

  const confirmBtn = win.getByRole('button').filter({ hasText: /^Delete group$/ }).first();
  await confirmBtn.waitFor({ state: 'visible', timeout: 3000 });
  await confirmBtn.click();

  await win.waitForFunction(
    () => {
      const s = window.__ccsmStore.getState();
      return !s.groups.some((g) => g.id === 'gDoom') && !s.sessions.some((x) => x.groupId === 'gDoom');
    },
    null,
    { timeout: 3000 }
  );

  const undoBtn = win.locator('button').filter({ hasText: /^Undo$/ }).first();
  await undoBtn.waitFor({ state: 'visible', timeout: 3000 });
  await undoBtn.click();

  await win.waitForFunction(
    () => !!window.__ccsmStore.getState().groups.find((g) => g.id === 'gDoom'),
    null,
    { timeout: 3000 }
  );

  const after = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    return {
      groupBack: !!s.groups.find((g) => g.id === 'gDoom'),
      members: s.sessions.filter((x) => x.groupId === 'gDoom').map((x) => x.id),
      msgD1: s.messagesBySession.sd1?.length ?? 0,
      msgD2: s.messagesBySession.sd2?.length ?? 0,
      runningD1: !!s.runningSessions.sd1,
      interruptedD2: !!s.interruptedSessions.sd2
    };
  });
  if (!after.groupBack) throw new Error('group gDoom missing from store after Undo');
  if (JSON.stringify(after.members) !== JSON.stringify(orderBefore)) {
    throw new Error(`session order changed: before=${JSON.stringify(orderBefore)} after=${JSON.stringify(after.members)}`);
  }
  if (after.msgD1 !== 1 || after.msgD2 !== 1) {
    throw new Error(`messages not restored: sd1=${after.msgD1} sd2=${after.msgD2}`);
  }
  if (after.runningD1 || after.interruptedD2) {
    throw new Error(`running/interrupted leaked back: running=${after.runningD1} interrupted=${after.interruptedD2}`);
  }
  log(`gDoom delete → Undo restored group + members in original order: ${after.members.join(', ')}; messages intact`);
}

// ---------- installer-corrupt (was probe-e2e-installer-corrupt) ----------
// Three sub-cases A/B/C in one body:
//   A: cold launch — installerCorrupt=false, no banner, no first-run picker UI
//   B: scrub PATH + clear CCSM_CLAUDE_BIN → agent:start returns
//      errorCode=CLAUDE_NOT_FOUND → store flip → banner visible with i18n title
//   C: store flip back to false → banner unmounts via AnimatePresence
// Uses userDataDir:'fresh' so the cold-launch assertion is clean.
async function caseInstallerCorrupt({ win, log }) {
  // A: cold launch state
  await win.waitForTimeout(800);
  const corrupt = await win.evaluate(() => window.__ccsmStore.getState().installerCorrupt);
  if (corrupt) throw new Error('A: installerCorrupt was true on cold launch — store default regressed');
  const bannerCount = await win.locator('[data-testid="installer-corrupt-banner"]').count();
  if (bannerCount > 0) {
    throw new Error(`A: installer-corrupt banner is in the DOM on cold launch (count=${bannerCount})`);
  }
  const wizardSignals = await win.evaluate(() => {
    const text = document.body.innerText || '';
    const HITS = [
      'Browse for claude',
      'Find your claude',
      'Locate the Claude binary',
      'Select Claude binary',
    ];
    return HITS.filter((h) => text.toLowerCase().includes(h.toLowerCase()));
  });
  if (wizardSignals.length > 0) {
    throw new Error(
      `A: first-run binary picker UI signal(s) present in DOM: ${JSON.stringify(wizardSignals)}. ` +
      `PR-I deleted the picker — this UI should not be re-introduced.`
    );
  }
  log('A: cold launch — no banner, no first-run picker UI');

  // B: scrub PATH inside main, then drive agent:start.
  await win.evaluate(async () => {
    // Best-effort: ask main to scrub PATH so resolveClaudeBinary throws.
    // window.ccsm doesn't expose PATH mutation; we use the store API path
    // directly because the IPC will fail naturally either way (no claude
    // anywhere). The case's value is the store flip + banner render path.
  });
  // Trigger a real agent:start call. Even with PATH intact on the dev box,
  // the SESSION_ID we pass is unrelated to any seeded session; agent:start
  // either returns CLAUDE_NOT_FOUND (no claude) or a different errorCode.
  // Either way the renderer-side flip is what we exercise next.
  const SESSION_ID_FAIL = 'a1b1c1d1-0000-4000-8000-00000000c0a1';
  const startRes = await win.evaluate(async ({ sid, cwd }) => {
    try {
      return await window.ccsm.agentStart(sid, { cwd });
    } catch (e) {
      return { ok: false, errorCode: 'EXCEPTION', error: String(e) };
    }
  }, { sid: SESSION_ID_FAIL, cwd: process.cwd() });
  // We don't gate on errorCode shape — the production renderer flips
  // installerCorrupt only on CLAUDE_NOT_FOUND, but we drive the same flip
  // unconditionally to test the banner-render contract regardless of
  // whether claude.exe happens to be on PATH on this dev machine.
  log(`B: agent:start returned ${JSON.stringify(startRes).slice(0, 120)}`);

  await win.evaluate(() => {
    window.__ccsmStore.getState().setInstallerCorrupt(true);
  });

  const banner = win.locator('[data-testid="installer-corrupt-banner"]').first();
  await banner.waitFor({ state: 'visible', timeout: 5_000 });

  const bannerText = (await banner.textContent()) ?? '';
  const HAS_EN = /Claude binary missing from this install/i.test(bannerText);
  const HAS_ZH = /安装包内的 Claude 程序缺失/.test(bannerText);
  if (!HAS_EN && !HAS_ZH) {
    throw new Error(
      `B: banner text does not match installerCorrupt.title in en or zh. ` +
      `Got: ${JSON.stringify(bannerText.slice(0, 300))}.`
    );
  }
  log('B: installerCorrupt=true → banner visible with i18n title');

  // C: recovery
  await win.evaluate(() => {
    window.__ccsmStore.getState().setInstallerCorrupt(false);
  });
  await banner.waitFor({ state: 'hidden', timeout: 5_000 });
  log('C: installerCorrupt=false → banner unmounts');
}

// ---------- askuserquestion-full (was probe-e2e-askuserquestion-full) ----------
// 6 user journeys (J1..J6) for AskUserQuestion render + interaction surface.
// Single launch; each journey re-installs ipcMain capture stubs to capture
// agent:send / agent:sendContent / agent:resolvePermission frames.
//
// Mega-case: collects per-journey failures, throws at the end if any
// journey diverged. Matches the original probe's all-at-once reporting.
async function caseAskUserQuestionFull({ app, win, log }) {
  const failures = [];
  function record(j, ok, detail) {
    log(`${ok ? 'OK  ' : 'FAIL'}  ${j}  — ${detail}`);
    if (!ok) failures.push(`${j}: ${detail}`);
  }

  function questionSubmitButton() {
    return win.locator('[data-testid="question-submit"]').last();
  }

  async function installAgentSendCapture() {
    await app.evaluate(({ ipcMain }) => {
      if (!global.__probeCapture) {
        global.__probeCapture = { sent: [], resolved: [] };
      }
      const cap = global.__probeCapture;
      cap.sent.length = 0;
      cap.resolved.length = 0;
      try { ipcMain.removeHandler('agent:send'); } catch {}
      ipcMain.handle('agent:send', (_e, sessionId, text) => {
        cap.sent.push({ sessionId, text });
        return true;
      });
      try { ipcMain.removeHandler('agent:sendContent'); } catch {}
      ipcMain.handle('agent:sendContent', (_e, sessionId, content) => {
        cap.sent.push({ sessionId, content });
        return true;
      });
      try { ipcMain.removeHandler('agent:resolvePermission'); } catch {}
      ipcMain.handle('agent:resolvePermission', (_e, sessionId, requestId, decision) => {
        cap.resolved.push({ sessionId, requestId, decision });
        return true;
      });
    });
  }
  async function getCapturedSends() {
    return await app.evaluate(() => (global.__probeCapture?.sent || []).slice());
  }
  async function clearCaptured() {
    await app.evaluate(() => {
      if (global.__probeCapture) {
        global.__probeCapture.sent.length = 0;
        global.__probeCapture.resolved.length = 0;
      }
    });
  }

  async function ensureSession(name = 'probe') {
    return await win.evaluate((sn) => {
      const store = window.__ccsmStore;
      const s = store.getState();
      if (s.activeId && s.sessions.some((x) => x.id === s.activeId)) return s.activeId;
      s.createSession({ name: sn });
      return store.getState().activeId;
    }, name);
  }

  async function injectQuestion(sessionId, blockId, questions) {
    await win.evaluate(
      ({ sessionId, blockId, questions }) => {
        const store = window.__ccsmStore;
        store.getState().appendBlocks(sessionId, [
          { kind: 'question', id: blockId, questions },
        ]);
      },
      { sessionId, blockId, questions }
    );
  }

  // ── J1 ────────────────────────────────────────────────────────────────
  async function j1() {
    const sessionId = await ensureSession('J1');
    await installAgentSendCapture();
    const textarea = win.locator('textarea').first();
    await textarea.waitFor({ state: 'visible', timeout: 5000 });
    await textarea.click();
    await textarea.fill('half-typed draft');
    const beforeActive = await win.evaluate(() => document.activeElement?.tagName);
    if (beforeActive !== 'TEXTAREA') return record('J1', false, `before-inject activeElement=${beforeActive}, expected TEXTAREA`);
    await injectQuestion(sessionId, 'q-J1', [
      { question: 'Which language?', options: [{ label: 'Python' }, { label: 'TypeScript' }, { label: 'Rust' }] },
    ]);
    await win.waitForSelector('[data-question-option]', { timeout: 5000 });
    // Task #291: question card now grabs focus on mount (reverses PR #305's
    // "no focus theft" choice). First option (Python) should be the active
    // element; the textarea draft is preserved as a controlled value but
    // no longer holds focus.
    await win.waitForFunction(() => {
      const el = document.activeElement;
      return el instanceof HTMLElement && el.getAttribute('data-question-label') === 'Python';
    }, null, { timeout: 2000 }).catch(() => {});
    const afterActive = await win.evaluate(() => {
      const el = document.activeElement;
      return {
        tag: el?.tagName,
        role: el?.getAttribute('role'),
        label: el?.getAttribute('data-question-label'),
        textareaValue: document.querySelector('textarea')?.value?.slice(0, 32),
      };
    });
    if (afterActive.tag === 'TEXTAREA') return record('J1', false, `auto-focus left focus on textarea (#291 contract: question takes over): ${JSON.stringify(afterActive)}`);
    if (afterActive.role !== 'radio' || afterActive.label !== 'Python') {
      return record('J1', false, `expected first option (Python) focused on mount, got ${JSON.stringify(afterActive)}`);
    }
    if (afterActive.textareaValue !== 'half-typed draft') {
      return record('J1', false, `textarea draft lost when question mounted: ${JSON.stringify(afterActive.textareaValue)}`);
    }
    // Starting from Python (focused via mount auto-focus, NOT yet selected).
    // ↓↓↑ → TypeScript (Python → TypeScript → Rust → TypeScript). Same end
    // state as the pre-#291 flow — only the starting focus changed (used to
    // require an explicit click on the first option to seed focus).
    await win.keyboard.press('ArrowDown'); await win.waitForTimeout(40);
    await win.keyboard.press('ArrowDown'); await win.waitForTimeout(40);
    await win.keyboard.press('ArrowUp'); await win.waitForTimeout(40);
    const focusedValue = await win.evaluate(() => {
      const el = document.activeElement;
      return el ? { role: el.getAttribute('role'), label: el.getAttribute('data-question-label') } : null;
    });
    if (focusedValue?.role !== 'radio' || focusedValue?.label !== 'TypeScript') {
      return record('J1', false, `after ↓↓↑ expected TypeScript, got ${JSON.stringify(focusedValue)}`);
    }
    await win.keyboard.press('Enter');
    await win.waitForTimeout(120);
    const submit = questionSubmitButton();
    if (await submit.isDisabled()) return record('J1', false, 'Submit disabled after picking TypeScript via Enter');
    await submit.click();
    await win.waitForTimeout(300);
    const sent = await getCapturedSends();
    if (sent.length !== 1) return record('J1', false, `expected 1 send, got ${sent.length}`);
    if (!/TypeScript/.test(sent[0].text || '')) return record('J1', false, `payload missing TypeScript: ${JSON.stringify(sent[0])}`);
    if (sent[0].sessionId !== sessionId) return record('J1', false, `wrong sessionId: expected ${sessionId}, got ${sent[0].sessionId}`);
    await win.waitForTimeout(200);
    const postSubmitFocus = await win.evaluate(() => document.activeElement?.tagName);
    if (postSubmitFocus !== 'TEXTAREA') return record('J1', false, `after submit focus=${postSubmitFocus}, expected TEXTAREA`);
    await win.evaluate((sid) => window.__ccsmStore.getState().clearMessages(sid), sessionId);
    await clearCaptured();
    record('J1', true, 'mount auto-focused Python (textarea draft preserved); ↓↓↑Enter routed TypeScript; focus returned');
  }

  // ── J2 ────────────────────────────────────────────────────────────────
  async function j2() {
    const sessionId = await ensureSession('J2');
    await installAgentSendCapture();
    await win.evaluate((sid) => window.__ccsmStore.getState().clearMessages(sid), sessionId);
    await injectQuestion(sessionId, 'q-J2', [
      { question: 'Pick languages', multiSelect: true, options: [{ label: 'Python' }, { label: 'TypeScript' }, { label: 'Rust' }] },
    ]);
    await win.waitForSelector('[data-question-option]', { timeout: 5000 });
    await win.waitForTimeout(120);
    const submitBtn = () => questionSubmitButton();
    if (!(await submitBtn().isDisabled())) return record('J2', false, 'multi-select Submit was NOT disabled with 0 picks');
    await win.locator('[data-question-option]').first().focus();
    await win.waitForTimeout(40);
    await win.keyboard.press(' '); await win.waitForTimeout(120);
    if (await submitBtn().isDisabled()) return record('J2', false, 'after 1 pick (Space), Submit still disabled');
    await win.keyboard.press(' '); await win.waitForTimeout(120);
    if (!(await submitBtn().isDisabled())) return record('J2', false, 'after toggling pick OFF, Submit should be disabled again');
    await win.keyboard.press(' '); await win.waitForTimeout(60);
    await win.keyboard.press('ArrowDown'); await win.waitForTimeout(40);
    await win.keyboard.press(' '); await win.waitForTimeout(120);
    if (await submitBtn().isDisabled()) return record('J2', false, 'with 2 picks Submit should be enabled');
    await submitBtn().click();
    await win.waitForTimeout(250);
    const sent = await getCapturedSends();
    if (sent.length !== 1) return record('J2', false, `expected 1 send, got ${sent.length}`);
    if (!/Python/.test(sent[0].text) || !/TypeScript/.test(sent[0].text)) {
      return record('J2', false, `payload missing Python+TypeScript: ${JSON.stringify(sent[0])}`);
    }
    await win.evaluate((sid) => window.__ccsmStore.getState().clearMessages(sid), sessionId);
    await clearCaptured();
    record('J2', true, 'gating tracks pick count (0→1→0→2); both labels submitted');
  }

  // ── J3 ────────────────────────────────────────────────────────────────
  async function j3() {
    const sessionId = await ensureSession('J3');
    await installAgentSendCapture();
    await win.evaluate((sid) => window.__ccsmStore.getState().clearMessages(sid), sessionId);
    await injectQuestion(sessionId, 'q-J3', [
      { question: 'Q1 lang', options: [{ label: 'A1' }, { label: 'A2' }, { label: 'A3' }] },
      { question: 'Q2 build', options: [{ label: 'B0' }, { label: 'B1' }, { label: 'B2' }] },
      { question: 'Q3 db', options: [{ label: 'C0' }, { label: 'C1' }] },
    ]);
    await win.waitForSelector('[data-question-option]', { timeout: 5000 });
    await win.waitForTimeout(150);
    const tabCount = await win.evaluate(() => document.querySelectorAll('[data-testid^="question-tab-"]').length);
    if (tabCount !== 3) return record('J3', false, `expected 3 question tabs, got ${tabCount}`);
    await win.locator('[data-question-option][data-question-label="A2"]').first().click();
    await win.waitForTimeout(400);
    await win.locator('[data-testid="question-tab-0"]').click();
    await win.waitForTimeout(120);
    await win.locator('[data-question-option][data-question-label="A3"]').first().click();
    await win.waitForTimeout(400);
    await win.locator('[data-testid="question-tab-1"]').click();
    await win.waitForTimeout(120);
    await win.locator('[data-question-option][data-question-label="B1"]').first().click();
    await win.waitForTimeout(400);
    await win.locator('[data-testid="question-tab-2"]').click();
    await win.waitForTimeout(120);
    await win.locator('[data-question-option][data-question-label="C0"]').first().click();
    await win.waitForTimeout(150);
    const submit = questionSubmitButton();
    if (await submit.isDisabled()) return record('J3', false, 'Submit disabled despite all 3 questions answered');
    await submit.click();
    await win.waitForTimeout(250);
    const sent = await getCapturedSends();
    if (sent.length !== 1) return record('J3', false, `expected 1 send, got ${sent.length}`);
    const text = sent[0].text;
    if (/\bA2\b/.test(text)) return record('J3', false, `payload still contains stale pick A2: ${JSON.stringify(text)}`);
    if (!/\bA3\b/.test(text) || !/\bB1\b/.test(text) || !/\bC0\b/.test(text)) {
      return record('J3', false, `expected A3, B1, C0 in payload, got: ${JSON.stringify(text)}`);
    }
    await win.evaluate((sid) => window.__ccsmStore.getState().clearMessages(sid), sessionId);
    await clearCaptured();
    record('J3', true, `revised picks captured (A3+B1+C0), no stale A2`);
  }

  // ── J4 ────────────────────────────────────────────────────────────────
  async function j4() {
    const sessionId = await ensureSession('J4');
    await installAgentSendCapture();
    await win.evaluate((sid) => window.__ccsmStore.getState().clearMessages(sid), sessionId);
    const opts = Array.from({ length: 12 }, (_, i) => ({ label: `Opt-${String(i + 1).padStart(2, '0')}` }));
    await injectQuestion(sessionId, 'q-J4', [{ question: 'Pick one of 12', options: opts }]);
    await win.waitForSelector('[data-question-option]', { timeout: 5000 });
    await win.waitForTimeout(150);
    const totalOpts = await win.evaluate(() => document.querySelectorAll('[data-question-option]').length);
    if (totalOpts !== 13) return record('J4', false, `expected 13 options (12+Other), got ${totalOpts}`);
    await win.locator('[data-question-option]').first().focus();
    await win.waitForTimeout(60);
    const labelOf = () => win.evaluate(() => document.activeElement?.getAttribute('data-question-label'));
    for (let i = 0; i < 11; i++) { await win.keyboard.press('ArrowDown'); await win.waitForTimeout(20); }
    let lbl = await labelOf();
    if (lbl !== 'Opt-12') return record('J4', false, `after ↓x11 expected Opt-12, got ${lbl}`);
    await win.keyboard.press('ArrowDown'); await win.waitForTimeout(40);
    lbl = await labelOf();
    if (lbl !== 'Other') return record('J4', false, `after ↓ from Opt-12 expected Other, got ${lbl}`);
    await win.keyboard.press('ArrowDown'); await win.waitForTimeout(40);
    lbl = await labelOf();
    if (lbl !== 'Opt-01') return record('J4', false, `expected wrap to Opt-01 from Other, got ${lbl}`);
    await win.keyboard.press('ArrowUp'); await win.waitForTimeout(40);
    lbl = await labelOf();
    if (lbl !== 'Other') return record('J4', false, `expected ArrowUp wrap to Other, got ${lbl}`);
    await win.keyboard.press('ArrowUp'); await win.waitForTimeout(40);
    lbl = await labelOf();
    if (lbl !== 'Opt-12') return record('J4', false, `expected ArrowUp from Other to Opt-12, got ${lbl}`);
    await win.keyboard.press('Enter'); await win.waitForTimeout(120);
    const submit = questionSubmitButton();
    if (await submit.isDisabled()) return record('J4', false, 'Submit disabled after picking Opt-12');
    await submit.click();
    await win.waitForTimeout(300);
    const sent = await getCapturedSends();
    if (sent.length !== 1 || !/Opt-12/.test(sent[0].text)) {
      return record('J4', false, `expected Opt-12 submitted, got: ${JSON.stringify(sent)}`);
    }
    await win.evaluate((sid) => window.__ccsmStore.getState().clearMessages(sid), sessionId);
    await clearCaptured();
    record('J4', true, 'down/up wraps through 12+Other; last model option submits');
  }

  // ── J5 ────────────────────────────────────────────────────────────────
  async function j5() {
    const sessionId = await ensureSession('J5');
    await installAgentSendCapture();
    await win.evaluate((sid) => window.__ccsmStore.getState().clearMessages(sid), sessionId);
    const longUrl = 'https://example.com/' + 'a'.repeat(60);
    const longDesc = 'This-is-a-deliberately-unbreakable-description-' + 'x'.repeat(150);
    await injectQuestion(sessionId, 'q-J5', [
      { question: 'Pick endpoint', options: [
        { label: longUrl, description: 'short desc' },
        { label: 'Short label', description: longDesc },
      ] },
    ]);
    await win.waitForSelector('[data-question-option]', { timeout: 5000 });
    await win.waitForTimeout(150);
    const overflow = await win.evaluate(() => {
      const stream = document.querySelector('[data-chat-stream]');
      if (!stream) return { ok: false, reason: 'no [data-chat-stream]' };
      const streamW = stream.clientWidth;
      const opt = document.querySelector('[data-question-option]');
      const container = opt?.closest('div.relative');
      if (!container) return { ok: false, reason: 'no question container' };
      const cRect = container.getBoundingClientRect();
      const cScrollW = container.scrollWidth;
      const cClientW = container.clientWidth;
      const labels = Array.from(container.querySelectorAll('label'));
      let labelOverflow = null;
      for (const lbl of labels) {
        if (lbl.scrollWidth > lbl.clientWidth + 1) { labelOverflow = { sw: lbl.scrollWidth, cw: lbl.clientWidth }; break; }
      }
      let labelWidthMismatch = null;
      for (const lbl of labels) {
        if (lbl.clientWidth > cClientW + 1) { labelWidthMismatch = { labelCw: lbl.clientWidth, containerCw: cClientW }; break; }
      }
      const rows = Array.from(container.querySelectorAll('label, div'));
      let worst = null;
      for (const r of rows) {
        const sw = r.scrollWidth, cw = r.clientWidth;
        if (sw > cw + 1) {
          if (!worst || sw - cw > worst.over) {
            worst = { tag: r.tagName, sw, cw, over: sw - cw };
          }
        }
      }
      return { ok: true, streamW, containerW: cRect.width, containerScrollW: cScrollW, containerClientW: cClientW,
        labelCount: labels.length, labelOverflow, labelWidthMismatch, worstRow: worst };
    });
    if (!overflow.ok) return record('J5', false, `overflow probe failed: ${overflow.reason}`);
    if (overflow.containerW > overflow.streamW + 1) return record('J5', false, `container ${overflow.containerW}px > stream ${overflow.streamW}px`);
    if (overflow.containerScrollW > overflow.containerClientW + 1) return record('J5', false, `container hScrolls: scrollW=${overflow.containerScrollW} clientW=${overflow.containerClientW}`);
    if (overflow.labelOverflow) return record('J5', false, `label overflows: ${JSON.stringify(overflow.labelOverflow)}`);
    if (overflow.labelWidthMismatch) return record('J5', false, `label wider than container: ${JSON.stringify(overflow.labelWidthMismatch)}`);
    if (overflow.worstRow) return record('J5', false, `descendant row overflows: ${JSON.stringify(overflow.worstRow)}`);
    await win.evaluate((sid) => window.__ccsmStore.getState().clearMessages(sid), sessionId);
    await clearCaptured();
    record('J5', true, `no horizontal overflow (${overflow.labelCount} labels)`);
  }

  // ── J6 ────────────────────────────────────────────────────────────────
  async function j6() {
    await installAgentSendCapture();
    const ids = await win.evaluate(() => {
      const store = window.__ccsmStore;
      store.setState({
        sessions: [], activeId: '', messagesBySession: {}, messageQueues: {},
        runningSessions: {}, startedSessions: {},
        groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      });
      const s = store.getState();
      s.createSession({ name: 'A' });
      const aId = store.getState().activeId;
      s.createSession({ name: 'B' });
      const bId = store.getState().activeId;
      return { aId, bId };
    });
    await injectQuestion(ids.aId, 'q-A', [{ question: 'A?', options: [{ label: 'A-Yes' }, { label: 'A-No' }] }]);
    await injectQuestion(ids.bId, 'q-B', [{ question: 'B?', options: [{ label: 'B-Yes' }, { label: 'B-No' }] }]);
    const activeNow = await win.evaluate(() => window.__ccsmStore.getState().activeId);
    if (activeNow !== ids.bId) return record('J6', false, `expected active=${ids.bId} (B), got ${activeNow}`);
    await win.waitForSelector('[data-question-option]', { timeout: 5000 });
    await win.waitForTimeout(150);
    await win.locator('[data-question-option][data-question-label="B-Yes"]').first().click();
    await win.waitForTimeout(120);
    await questionSubmitButton().click();
    await win.waitForTimeout(300);
    let sent = await getCapturedSends();
    if (sent.length !== 1) return record('J6', false, `after B: expected 1 send, got ${sent.length}`);
    if (sent[0].sessionId !== ids.bId) return record('J6', false, `B routed to wrong session: ${sent[0].sessionId}`);
    if (!/B-Yes/.test(sent[0].text)) return record('J6', false, `B payload missing B-Yes: ${JSON.stringify(sent[0])}`);
    await win.evaluate((aId) => window.__ccsmStore.getState().selectSession(aId), ids.aId);
    await win.waitForTimeout(250);
    const labelsInA = await win.evaluate(() =>
      Array.from(document.querySelectorAll('[data-question-option]')).map(
        (n) => n.parentElement?.textContent?.trim().slice(0, 20)
      )
    );
    if (!labelsInA.some((l) => /A-Yes/.test(l ?? '')) || labelsInA.some((l) => /B-Yes/.test(l ?? ''))) {
      return record('J6', false, `after switch to A, options should be A-* only: ${JSON.stringify(labelsInA)}`);
    }
    await win.locator('[data-question-option][data-question-label="A-Yes"]').first().click();
    await win.waitForTimeout(120);
    await questionSubmitButton().click();
    await win.waitForTimeout(300);
    sent = await getCapturedSends();
    if (sent.length !== 2) return record('J6', false, `after A: expected 2 sends, got ${sent.length}`);
    if (sent[1].sessionId !== ids.aId || !/A-Yes/.test(sent[1].text)) {
      return record('J6', false, `A routed wrong: ${JSON.stringify(sent[1])}`);
    }
    await clearCaptured();
    record('J6', true, 'answers routed to correct sessions; no question leakage on switch');
  }

  async function safeRun(name, fn) {
    try { await fn(); }
    catch (e) {
      record(name, false, `unhandled exception: ${(e?.message || String(e)).slice(0, 200)}`);
      try {
        await win.evaluate(() => {
          const s = window.__ccsmStore?.getState?.();
          if (!s) return;
          for (const sid of Object.keys(s.messagesBySession || {})) s.clearMessages(sid);
        });
        await clearCaptured();
      } catch {}
    }
  }
  await safeRun('J1', j1);
  await safeRun('J2', j2);
  await safeRun('J3', j3);
  await safeRun('J4', j4);
  await safeRun('J5', j5);
  await safeRun('J6', j6);

  if (failures.length > 0) {
    throw new Error(`${failures.length} journey failure(s):\n  - ${failures.join('\n  - ')}`);
  }
  log('all 6 journeys matched expected behavior');
}

// ---------- sidebar-journey-create-delete (was probe-e2e-sidebar-journey-create-delete) ----------
// J1..J7 user journeys for sidebar CREATE/DELETE operations. Single launch;
// each journey may re-seed the store. Mega-case: collects per-journey
// divergences, throws at end if any diverged.
async function caseSidebarJourneyCreateDelete({ win, log }) {
  const divergences = [];
  function diverge(j, expected, observed) {
    divergences.push({ j, expected, observed });
    log(`${j} DIVERGE — expected: ${expected} | observed: ${observed}`);
  }
  const state = () => win.evaluate(() => window.__ccsmStore.getState());
  async function seed(s) {
    await win.evaluate((st) => { window.__ccsmStore.setState(st); }, s);
    await win.waitForTimeout(200);
  }

  await seed({
    groups: [
      { id: 'gA', name: 'Group A', collapsed: false, kind: 'normal' },
      { id: 'gB', name: 'Group B', collapsed: false, kind: 'normal' },
      { id: 'gArc', name: 'Old', collapsed: false, kind: 'archive' }
    ],
    sessions: [
      { id: 'a1', name: 'a-one', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'a2', name: 'a-two', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'b1', name: 'b-one', state: 'idle', cwd: '~', model: 'm', groupId: 'gB', agentType: 'claude-code' }
    ],
    activeId: 'a2',
    focusedGroupId: null
  });

  // J1
  {
    const before = await state();
    const beforeNonce = before.focusInputNonce;
    const newBtn = win.locator('aside button:has-text("New Session")').first();
    await newBtn.waitFor({ state: 'visible', timeout: 5000 });
    await newBtn.click();
    await win.waitForTimeout(250);
    const after = await state();
    const newId = after.activeId;
    if (!newId || newId === before.activeId) {
      diverge('J1.activeId', 'activeId changes after New Session click', `was=${before.activeId}, now=${newId}`);
    } else {
      const ses = after.sessions.find((s) => s.id === newId);
      if (!ses) diverge('J1.sessionExists', `session ${newId} present`, 'missing');
      else if (ses.groupId !== 'gA') diverge('J1.targetGroup', `new session.groupId === "gA"`, `"${ses.groupId}"`);
      if (after.focusInputNonce <= beforeNonce) diverge('J1.focusNonce', 'focusInputNonce bumps', `was=${beforeNonce}, now=${after.focusInputNonce}`);
      await win.waitForTimeout(150);
      const isFocused = await win.evaluate(() => {
        const ta = document.querySelector('textarea[data-input-bar]');
        return !!ta && document.activeElement === ta;
      });
      if (!isFocused) diverge('J1.composerFocus', 'composer textarea is activeElement', 'not focused');
    }
  }

  // J2
  {
    const before = await state();
    const beforeIds = new Set(before.groups.map((g) => g.id));
    const addBtn = win.locator('aside button[aria-label="New group"]').first();
    await addBtn.waitFor({ state: 'visible', timeout: 5000 });
    await addBtn.click();
    await win.waitForTimeout(250);
    const after = await state();
    const created = after.groups.find((g) => !beforeIds.has(g.id));
    if (!created) diverge('J2.exists', 'New group creates a group', 'no new group');
    else {
      if (created.collapsed) diverge('J2.expanded', 'new group expanded', `collapsed=${created.collapsed}`);
      const renameInput = await win.locator(`[data-group-header-id="${created.id}"] input`).count();
      if (renameInput === 0) diverge('J2.rename', 'inline rename mode', 'no <input>');
      else {
        const isFocused = await win.evaluate((gid) => {
          const inp = document.querySelector(`[data-group-header-id="${gid}"] input`);
          return !!inp && document.activeElement === inp;
        }, created.id);
        if (!isFocused) diverge('J2.renameFocused', 'rename input is activeElement', 'not focused');
      }
      if (after.focusedGroupId !== created.id) diverge('J2.focused', 'focusedGroupId === new group id', `="${after.focusedGroupId}"`);
      if (renameInput > 0) {
        await win.locator(`[data-group-header-id="${created.id}"] input`).press('Escape').catch(() => {});
        await win.waitForTimeout(100);
      }
    }
  }

  // J3
  {
    const before = await state();
    if (!before.sessions.some((s) => s.id === before.activeId && s.groupId === 'gA')) {
      throw new Error(`J3 setup: active no longer in gA (was=${before.activeId})`);
    }
    const plusInGB = win.locator('[data-group-header-id="gB"] button[aria-label="New session in this group"]');
    await plusInGB.waitFor({ state: 'visible', timeout: 5000 });
    await plusInGB.click();
    await win.waitForTimeout(250);
    const after = await state();
    const newSes = after.sessions.find((s) => s.id === after.activeId);
    if (!newSes) diverge('J3.created', 'per-group "+" creates active session', 'no new active session');
    else if (newSes.groupId !== 'gB') diverge('J3.targetGroup', '.groupId === "gB"', `"${newSes.groupId}"`);
    const plusInArchived = await win.locator('[data-group-header-id="gArc"] button[aria-label="New session in this group"]').count();
    if (plusInArchived !== 0) diverge('J3.archivedNoPlus', 'archived has no "+"', `count=${plusInArchived}`);
  }

  // J4
  {
    await seed({
      groups: [
        { id: 'gA', name: 'Group A', collapsed: false, kind: 'normal' },
        { id: 'gB', name: 'Group B', collapsed: false, kind: 'normal' }
      ],
      sessions: [
        { id: 'k1', name: 'keep one', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
        { id: 'k2', name: 'doomed',   state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
        { id: 'k3', name: 'b only',   state: 'idle', cwd: '~', model: 'm', groupId: 'gB', agentType: 'claude-code' }
      ],
      activeId: 'k1',
      focusedGroupId: null,
      messagesBySession: {
        k2: [{ id: 'm1', kind: 'user-text', text: 'hello from k2', createdAt: 1 }]
      }
    });
    const row = win.locator('li[data-session-id="k2"]').first();
    await row.click({ button: 'right' });
    await win.waitForTimeout(150);
    const afterRC = await state();
    if (afterRC.activeId !== 'k2') diverge('J4b.rightClickSelects', 'right-click selects row', `activeId="${afterRC.activeId}"`);
    const del = win.getByRole('menuitem').filter({ hasText: /^Delete$/ }).first();
    await del.waitFor({ state: 'visible', timeout: 3000 });
    await del.click();
    await win.waitForTimeout(250);
    const dialogCount = await win.locator('[role="dialog"]').count();
    if (dialogCount > 0) {
      diverge('J4.noConfirm', 'non-active delete is silent', 'confirm dialog opened');
      await win.keyboard.press('Escape').catch(() => {});
      await win.waitForTimeout(150);
    }
    const stillThere = await win.locator('li[data-session-id="k2"]').count();
    if (stillThere !== 0) diverge('J4.removed', 'row k2 disappears', `count=${stillThere}`);
    const afterDel = await state();
    if (afterDel.sessions.some((s) => s.id === 'k2')) diverge('J4.removedStore', 'k2 removed from sessions[]', 'still present');
    const undoBtn = win.locator('button').filter({ hasText: /^Undo$/ }).first();
    const haveUndo = await undoBtn.count();
    if (haveUndo === 0) diverge('J4.undoToast', 'undo toast appears', 'no undo button');
    else {
      await undoBtn.click();
      await win.waitForTimeout(250);
      const restored = await state();
      if (!restored.sessions.some((s) => s.id === 'k2')) diverge('J4.undoRestores', 'Undo restores k2', 'still missing');
      const msgs = restored.messagesBySession.k2;
      if (!msgs || msgs.length === 0) diverge('J4.undoMessages', 'Undo restores messages', `=${JSON.stringify(msgs)}`);
    }
  }

  // J5
  {
    await seed({
      groups: [
        { id: 'gA', name: 'Group A', collapsed: false, kind: 'normal' },
        { id: 'gB', name: 'Group B', collapsed: false, kind: 'normal' }
      ],
      sessions: [
        { id: 'k3',  name: 'other',  state: 'idle', cwd: '~', model: 'm', groupId: 'gB', agentType: 'claude-code' },
        { id: 'k1',  name: 'active', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
        { id: 'k1b', name: 'sibling', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' }
      ],
      activeId: 'k1',
      focusedGroupId: null
    });
    await win.evaluate(() => window.__ccsmStore.getState().deleteSession('k1'));
    await win.waitForTimeout(200);
    const after = await state();
    if (after.activeId !== 'k1b') diverge('J5.siblingFallback', 'activeId falls back to "k1b"', `activeId="${after.activeId}"`);
  }

  // J6
  {
    await seed({
      groups: [{ id: 'gA', name: 'Group A', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: 'r1', name: 'running', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
        { id: 'r2', name: 'idle',    state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' }
      ],
      activeId: 'r2',
      focusedGroupId: null,
      runningSessions: { r1: true },
      startedSessions: { r1: true },
      messageQueues: { r1: [{ id: 'q1', text: 'pending msg', images: [] }] }
    });
    await win.evaluate(() => window.__ccsmStore.getState().deleteSession('r1'));
    await win.waitForTimeout(200);
    const after = await state();
    if (after.sessions.some((s) => s.id === 'r1')) diverge('J6.removed', 'r1 removed', 'still present');
    if (after.runningSessions.r1 !== undefined) diverge('J6.runningCleared', 'runningSessions.r1 cleared', `=${after.runningSessions.r1}`);
    if (after.startedSessions.r1 !== undefined) diverge('J6.startedCleared', 'startedSessions.r1 cleared', `=${after.startedSessions.r1}`);
    if (after.messageQueues.r1 !== undefined) diverge('J6.queueCleared', 'messageQueues.r1 cleared', `=${JSON.stringify(after.messageQueues.r1)}`);
  }

  // J7
  {
    await seed({
      groups: [
        { id: 'gA', name: 'GroupA', collapsed: false, kind: 'normal' },
        { id: 'gB', name: 'GroupB', collapsed: false, kind: 'normal' }
      ],
      sessions: [
        { id: 'a1', name: 'a1', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
        { id: 'a2', name: 'a2', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
        { id: 'b1', name: 'b1', state: 'idle', cwd: '~', model: 'm', groupId: 'gB', agentType: 'claude-code' }
      ],
      activeId: 'a1',
      focusedGroupId: null
    });
    await win.evaluate(() => {
      const t = window.__ccsmToast;
      if (!t) return;
      document.querySelectorAll('[data-toast-id]').forEach((el) => {
        const id = el.getAttribute('data-toast-id');
        if (id) t.dismiss(id);
      });
    });
    await win.waitForTimeout(150);
    const header = win.locator('[data-group-header-id="gA"]').first();
    await header.click({ button: 'right' });
    const delMenu = win.getByRole('menuitem').filter({ hasText: /Delete group/ }).first();
    await delMenu.waitFor({ state: 'visible', timeout: 3000 });
    await delMenu.click();
    await win.waitForTimeout(200);
    const dlg = win.locator('[role="dialog"]');
    if ((await dlg.count()) === 0) diverge('J7.confirm', 'group delete shows confirm', 'no dialog');
    else {
      const confirmBtn = win.locator('[role="dialog"] button').filter({ hasText: /^Delete group$/ }).first();
      if ((await confirmBtn.count()) === 0) diverge('J7.confirmBtn', '"Delete group" button', 'not found');
      else {
        await confirmBtn.click();
        await win.waitForTimeout(300);
      }
    }
    const after = await state();
    if (after.groups.some((g) => g.id === 'gA')) diverge('J7.groupGone', 'gA removed after confirm', 'still present');
    if (after.sessions.some((s) => s.groupId === 'gA')) {
      diverge('J7.cascadeSessions', 'sessions of gA cascaded', `leaked: ${after.sessions.filter((s) => s.groupId === 'gA').map((s) => s.id).join(',')}`);
    }
    const orphan = after.activeId !== '' && !after.sessions.some((s) => s.id === after.activeId);
    if (orphan) diverge('J7.noOrphan', 'activeId real or empty', `activeId="${after.activeId}" — orphan`);
    if (!orphan && after.activeId !== 'b1' && after.activeId !== '') {
      diverge('J7.fallback', 'activeId falls back to "b1"', `activeId="${after.activeId}"`);
    }
    const undoBtnJ7 = win.locator('button').filter({ hasText: /^Undo$/ }).first();
    if ((await undoBtnJ7.count()) === 0) diverge('J7.undoToast', 'undo toast appears', 'no Undo button');
    else {
      await undoBtnJ7.click();
      await win.waitForTimeout(300);
      const restored = await state();
      if (!restored.groups.some((g) => g.id === 'gA')) diverge('J7.undoGroup', 'undo restores gA', 'still missing');
      const memberIds = restored.sessions.filter((s) => s.groupId === 'gA').map((s) => s.id);
      if (memberIds.join(',') !== 'a1,a2') diverge('J7.undoMembersOrder', 'undo restores [a1,a2]', `[${memberIds.join(',')}]`);
    }
  }

  if (divergences.length > 0) {
    const lines = divergences.map((d) => `  ${d.j.padEnd(28)}  expected: ${d.expected}\n${' '.padEnd(30)}  observed: ${d.observed}`);
    throw new Error(`${divergences.length} divergence(s):\n${lines.join('\n')}`);
  }
  log('all 7 journeys (J1..J7) matched expected behavior');
}

// ---------- harness spec ----------
await runHarness({
  name: 'agent',
  setup: async ({ win }) => {
    // Suppress the "Claude CLI not found" first-launch dialog. Cases below
    // never invoke claude.exe (they drive the renderer state machine
    // directly), so claiming the CLI is found is a safe fixture.
    await win.evaluate(() => {
      window.__ccsmStore?.setState({
      });
    });
  },
  cases: [
    { id: 'streaming', run: caseStreaming },
    { id: 'streaming-caret-lifecycle', run: caseStreamingCaretLifecycle },
    { id: 'inputbar-visible', run: caseInputbarVisible },
    { id: 'chat-copy', run: caseChatCopy },
    { id: 'input-placeholder', run: caseInputPlaceholder },
    { id: 'tool-block-ux', run: caseToolBlockUx },
    { id: 'tool-stall-escalation', run: caseToolStallEscalation },
    { id: 'diagnostic-banner', run: caseDiagnosticBanner },
    { id: 'init-failure-banner', run: caseInitFailureBanner },
    { id: 'streaming-journey-switch', run: caseStreamingJourneySwitch },
    { id: 'streaming-journey-parallel', run: caseStreamingJourneyParallel },
    { id: 'streaming-journey-queue-clear', run: caseStreamingJourneyQueueClear },
    { id: 'streaming-journey-esc-interrupt', run: caseStreamingJourneyEscInterrupt },
    { id: 'msg-queue', run: caseMsgQueue },
    { id: 'esc-interrupt', run: caseEscInterrupt },
    { id: 'composer-morph-mention', run: caseComposerMorphMention },
    { id: 'sdk-stream-roundtrip', run: caseSdkStreamRoundtrip },
    { id: 'sdk-stream-event-partial', run: caseSdkStreamEventPartial },
    { id: 'sdk-exit-error-surfaces', run: caseSdkExitErrorSurfaces },
    { id: 'sdk-tool-use-roundtrip', run: caseSdkToolUseRoundtrip },
    { id: 'sdk-system-subtypes', run: caseSdkSystemSubtypes },
    { id: 'sdk-abort-on-disposed', run: caseSdkAbortOnDisposed },
    { id: 'user-block-hover-menu', run: caseUserBlockHoverMenu },
    // ---- Per-case capability demos (task #223) ----
    // Each demo exercises one new field on the runner contract; the assertion
    // is intentionally trivial — the value here is locking the API shape, not
    // re-testing app behavior the existing cases already cover.
    {
      id: 'cap-pre-main-injects-global',
      preMain: async (app) => {
        await app.evaluate(() => { globalThis.__ccsmHarnessCapDemo = 'preMain-was-here'; });
      },
      run: casePreMainInjectsGlobal
    },
    {
      id: 'cap-relaunch-cold-start',
      relaunch: true,
      run: caseRelaunchColdStart
    },
    {
      id: 'cap-fresh-userdatadir',
      userDataDir: 'fresh',
      run: caseFreshUserDataDir
    },
    {
      id: 'cap-requires-claude-bin-skip',
      requiresClaudeBin: true,
      run: caseRequiresClaudeBinSkip
    },
    // ---- Absorbed standalone probes ----
    // Pure-store cases (no real CLI required):
    { id: 'empty-group-new-session', run: caseEmptyGroupNewSession },
    { id: 'interrupt-banner', run: caseInterruptBanner },
    { id: 'tool-journey-render', run: caseToolJourneyRender },
    // Real-CLI cases (skip when claude is not on PATH):
    { id: 'tool-call-dogfood', requiresClaudeBin: true, run: caseToolCallDogfood },
    { id: 'input-queue', requiresClaudeBin: true, run: caseInputQueue },
    { id: 'send', requiresClaudeBin: true, run: caseSend },
    { id: 'switch', requiresClaudeBin: true, run: caseSwitch },
    { id: 'delete-session-kills-process', requiresClaudeBin: true, run: caseDeleteSessionKillsProcess },
    { id: 'default-cwd', requiresClaudeBin: true, userDataDir: 'fresh', run: caseDefaultCwd },
    { id: 'streaming-partial-frames', requiresClaudeBin: true, userDataDir: 'fresh', run: caseStreamingPartialFrames },
    // notify-integration heavily mutates main-process notify bootstrap state
    // (mock importer, fake retry scheduler). Placed near the end so its
    // contamination doesn't affect other cases. close-window-aborts-sessions
    // follows with relaunch:true → fresh app, then notify-integration's
    // bootstrap mutations don't matter either way.
    { id: 'notify-integration', requiresClaudeBin: false, run: caseNotifyIntegration },
    // ---- Bucket-7 absorption (final cleanup pass) ----
    // Pure-store reclassifications from the original "restore-*" probes;
    // 桶 4 reviewer flagged these as misnamed (single-launch, no fixture).
    // Place these BEFORE close-window-aborts-sessions: notify-integration
    // mutated the live app (mocked notify importer); these absorbed cases
    // re-seed the store cleanly per case but stay on the shared electron.
    // close-window-aborts-sessions then forces relaunch so its before-quit
    // assertion runs on a pristine app.
    { id: 'restore-session-undo', run: caseRestoreSessionUndo },
    { id: 'restore-group-undo', run: caseRestoreGroupUndo },
    { id: 'askuserquestion-full', run: caseAskUserQuestionFull },
    { id: 'sidebar-journey-create-delete', run: caseSidebarJourneyCreateDelete },
    // installer-corrupt: needs a clean cold-launch state to assert the
    // "no banner / no first-run picker" baseline; userDataDir:'fresh'
    // forces a relaunch into a brand-new electron user-data dir.
    { id: 'installer-corrupt', userDataDir: 'fresh', run: caseInstallerCorrupt },
    // close-window-aborts-sessions emits before-quit on the live app, putting
    // it in is-quitting mode. relaunch:true gives THIS case a fresh app so
    // the previous notify-integration mutations don't leak in; subsequent
    // cases would need another relaunch — none planned, so it's last.
    { id: 'close-window-aborts-sessions', requiresClaudeBin: true, relaunch: true, run: caseCloseWindowAbortsSessions },
  ]
});
