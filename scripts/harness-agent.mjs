// Themed harness — AGENT cluster, Phase-2 pilot.
//
// Per docs/e2e/single-harness-brainstorm.md §8 (option B + C). Each case
// below is the de-duplicated body of one of the per-file probes in
// scripts/probe-e2e-*.mjs. The original probe files have been left in place
// with a `// MERGED INTO harness-agent.mjs` marker on line 1 and are
// excluded from the per-file runner via scripts/run-all-e2e.mjs's
// MERGED_INTO_HARNESS skip list.
//
// Pilot scope (5 cases, all pure-store / no real claude.exe required):
//   - streaming
//   - streaming-caret-lifecycle
//   - inputbar-visible
//   - chat-copy
//   - input-placeholder
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
  const initial = await win.locator('[data-agent-diagnostic-banner]').count();
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

  const banner = win.locator('[data-agent-diagnostic-banner]').first();
  await banner.waitFor({ state: 'visible', timeout: 3000 });
  const severity = await banner.getAttribute('data-severity');
  if (severity !== 'error') throw new Error(`expected severity=error, got ${severity}`);
  const bannerText = await banner.innerText();
  if (!bannerText.includes('E2E_PROBE')) throw new Error(`banner text missing probe message, got: ${JSON.stringify(bannerText)}`);

  // Store entry exists and is not dismissed.
  const entryBefore = await win.evaluate(() => {
    const d = window.__ccsmStore.getState().diagnostics;
    return d.map((x) => ({ code: x.code, level: x.level, dismissed: !!x.dismissed }));
  });
  if (entryBefore.length !== 1) throw new Error(`expected 1 diagnostic, got ${entryBefore.length}`);
  if (entryBefore[0].dismissed) throw new Error('diagnostic should not be dismissed yet');

  // Dismiss — banner should disappear.
  await win.locator('[data-agent-diagnostic-dismiss]').first().click();
  await win.waitForTimeout(300);
  const afterDismiss = await win.locator('[data-agent-diagnostic-banner]').count();
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
  const crossSession = await win.locator('[data-agent-diagnostic-banner]').count();
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

  // No banner initially.
  const initialCount = await win.locator('[data-agent-init-failed-banner]').count();
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

  const banner = win.locator('[data-agent-init-failed-banner]').first();
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
  const afterClear = await win.locator('[data-agent-init-failed-banner]').count();
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
  const crossSession = await win.locator('[data-agent-init-failed-banner]').count();
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

  log('3 deltas coalesced into 1 block; caret shown then hidden on finalize');
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

// ---------- harness spec ----------
await runHarness({
  name: 'agent',
  setup: async ({ win }) => {
    // Suppress the "Claude CLI not found" first-launch dialog. Cases below
    // never invoke claude.exe (they drive the renderer state machine
    // directly), so claiming the CLI is found is a safe fixture.
    await win.evaluate(() => {
      window.__ccsmStore?.setState({
        cliStatus: { state: 'found', binaryPath: '<harness>', version: null }
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
  ]
});
