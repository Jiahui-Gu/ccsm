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

// ---------- streaming ----------
async function caseStreaming({ win, log }) {
  // Seed a session directly (instead of `createSession`, which triggers the
  // CLI check and pops the "Claude CLI not found" dialog when claude.exe
  // isn't on PATH — which is the default in CI). Same observable behaviour
  // for the streamAssistantText/appendBlocks code path the case actually
  // exercises.
  const sessionId = 's-stream';
  await win.evaluate((sid) => {
    window.__agentoryStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'streaming-probe', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [] }
    });
  }, sessionId);
  await win.waitForTimeout(150);

  await win.evaluate((sid) => {
    const st = window.__agentoryStore.getState();
    st.streamAssistantText(sid, 'msg-probe:c0', 'Hel', false);
    st.streamAssistantText(sid, 'msg-probe:c0', 'lo, ', false);
    st.streamAssistantText(sid, 'msg-probe:c0', 'world!', false);
  }, sessionId);
  await win.waitForTimeout(200);

  const midState = await win.evaluate((sid) => {
    const blocks = window.__agentoryStore.getState().messagesBySession[sid] ?? [];
    return blocks.map((b) => ({ id: b.id, kind: b.kind, text: b.text, streaming: b.streaming }));
  }, sessionId);
  const streamingBlocks = midState.filter((b) => b.id === 'msg-probe:c0');
  if (streamingBlocks.length !== 1) throw new Error(`expected 1 streaming block, got ${streamingBlocks.length}`);
  if (streamingBlocks[0].text !== 'Hello, world!') throw new Error(`expected 'Hello, world!', got '${streamingBlocks[0].text}'`);
  if (streamingBlocks[0].streaming !== true) throw new Error('streaming flag not set');

  const caretCount = await win.locator('span.animate-pulse').count();
  if (caretCount < 1) throw new Error('streaming caret not rendered in DOM');

  await win.evaluate((sid) => {
    window.__agentoryStore.getState().appendBlocks(sid, [
      { kind: 'assistant', id: 'msg-probe:c0', text: 'Final reply.' }
    ]);
  }, sessionId);
  await win.waitForTimeout(200);

  const finalState = await win.evaluate((sid) => {
    const blocks = window.__agentoryStore.getState().messagesBySession[sid] ?? [];
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
    window.__agentoryStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'caret-final', state: 'idle', cwd: 'C:/x', model: 'm', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [{ kind: 'user', id: 'u-1', text: 'hi' }] },
      startedSessions: { [sid]: true },
      runningSessions: { [sid]: true }
    });
  }, SID1);

  await win.evaluate(([sid, bid]) => {
    const st = window.__agentoryStore.getState();
    st.streamAssistantText(sid, bid, 'partial ', false);
    st.streamAssistantText(sid, bid, 'reply ', false);
  }, [SID1, BID1]);
  await win.waitForTimeout(150);

  const caretDuring = await win.locator('span.animate-pulse').count();
  if (caretDuring < 1) throw new Error('Part 1: expected caret during stream, found 0');

  await win.evaluate(([sid, bid]) => {
    window.__agentoryStore.getState().appendBlocks(sid, [{ kind: 'assistant', id: bid, text: 'final reply' }]);
    window.__agentoryStore.getState().setRunning(sid, false);
  }, [SID1, BID1]);
  await win.waitForTimeout(150);

  const caretAfterFinal = await win.locator('span.animate-pulse').count();
  if (caretAfterFinal !== 0) throw new Error(`Part 2: expected caret gone after finalize, found ${caretAfterFinal}`);

  const blockAfterFinal = await win.evaluate(([sid, bid]) => {
    const blocks = window.__agentoryStore.getState().messagesBySession[sid] ?? [];
    return blocks.find((b) => b.id === bid);
  }, [SID1, BID1]);
  if (!blockAfterFinal) throw new Error('Part 2: finalized block missing');
  if (blockAfterFinal.streaming) throw new Error('Part 2: block.streaming should be false after finalize');

  // Part 3: Esc-interrupt mid-stream — distinct session in same renderer.
  const SID2 = 's-caret-int';
  const BID2 = 'msg-caret:int';
  await win.evaluate((sid) => {
    const cur = window.__agentoryStore.getState();
    const sessions = cur.sessions.some((s) => s.id === sid)
      ? cur.sessions
      : [{ id: sid, name: 'caret-int', state: 'idle', cwd: 'C:/x', model: 'm', groupId: 'g1', agentType: 'claude-code' }, ...cur.sessions];
    window.__agentoryStore.setState({
      sessions,
      activeId: sid,
      messagesBySession: { ...cur.messagesBySession, [sid]: [{ kind: 'user', id: 'u-2', text: 'count' }] },
      startedSessions: { ...cur.startedSessions, [sid]: true },
      runningSessions: { ...cur.runningSessions, [sid]: true }
    });
  }, SID2);

  await win.evaluate(([sid, bid]) => {
    const st = window.__agentoryStore.getState();
    st.streamAssistantText(sid, bid, '1 ', false);
    st.streamAssistantText(sid, bid, '2 ', false);
    st.streamAssistantText(sid, bid, '3 ', false);
  }, [SID2, BID2]);
  await win.waitForTimeout(150);

  const caretMid = await win.locator('span.animate-pulse').count();
  if (caretMid < 1) throw new Error('Part 3: caret should be visible mid-stream before interrupt');

  await win.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await win.waitForTimeout(150);

  await win.evaluate(([sid, bid]) => {
    const st = window.__agentoryStore.getState();
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

  log('Part 1 caret-during, Part 2 caret-gone-after-finalize, Part 3 caret-gone-after-interrupt');
}

// ---------- inputbar-visible ----------
async function caseInputbarVisible({ win, log }) {
  await win.evaluate(() => {
    const store = window.__agentoryStore;
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
    window.__agentoryStore.setState({
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
      try { if (window.__agentoryI18n) await window.__agentoryI18n.changeLanguage('en'); } catch {}
    });
  });

  await win.evaluate(() => {
    window.__agentoryStore.setState({
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
    window.__agentoryStore.setState({
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
    window.__agentoryStore.setState({ messagesBySession: { s1: many } });
  });
  await win.waitForTimeout(200);
  const longReplyPh = await ta.getAttribute('placeholder');
  if (longReplyPh !== 'Reply…') throw new Error(`after long stream, placeholder should still be "Reply…", got ${JSON.stringify(longReplyPh)}`);

  await win.evaluate(() => window.__agentoryStore.getState().setRunning('s1', true));
  await win.waitForTimeout(150);
  const runningPh = await ta.getAttribute('placeholder');
  if (!runningPh || !runningPh.includes('Esc')) throw new Error(`running placeholder should mention Esc, got ${JSON.stringify(runningPh)}`);
  await win.evaluate(() => window.__agentoryStore.getState().setRunning('s1', false));
  await win.waitForTimeout(150);
  const backToReply = await ta.getAttribute('placeholder');
  if (backToReply !== 'Reply…') throw new Error(`after running off, placeholder should return to "Reply…", got ${JSON.stringify(backToReply)}`);

  // zh.
  const switched = await win.evaluate(async () => {
    for (let i = 0; i < 20 && !window.__agentoryI18n; i++) await new Promise((r) => setTimeout(r, 100));
    if (!window.__agentoryI18n) return { ok: false, err: 'window.__agentoryI18n missing' };
    await window.__agentoryI18n.changeLanguage('zh');
    return { ok: true, lang: window.__agentoryI18n.language };
  });
  if (switched.ok) {
    await win.waitForTimeout(200);
    const zhPlaceholder = await ta.getAttribute('placeholder');
    if (zhPlaceholder !== '回复…') throw new Error(`zh with-messages placeholder should be "回复…", got ${JSON.stringify(zhPlaceholder)}`);
    await win.evaluate(() => window.__agentoryStore.setState({ messagesBySession: { s1: [] } }));
    await win.waitForTimeout(150);
    const zhEmpty = await ta.getAttribute('placeholder');
    if (zhEmpty !== '问点什么…') throw new Error(`zh empty placeholder should be "问点什么…", got ${JSON.stringify(zhEmpty)}`);
  } else {
    log(`[skip] could not switch language dynamically: ${switched.err}`);
  }

  log('en+zh placeholder transitions verified');
}

// ---------- harness spec ----------
await runHarness({
  name: 'agent',
  setup: async ({ win }) => {
    // Suppress the "Claude CLI not found" first-launch dialog. Cases below
    // never invoke claude.exe (they drive the renderer state machine
    // directly), so claiming the CLI is found is a safe fixture.
    await win.evaluate(() => {
      window.__agentoryStore?.setState({
        cliStatus: { state: 'found', binaryPath: '<harness>', version: null }
      });
    });
  },
  cases: [
    { id: 'streaming', run: caseStreaming },
    { id: 'streaming-caret-lifecycle', run: caseStreamingCaretLifecycle },
    { id: 'inputbar-visible', run: caseInputbarVisible },
    { id: 'chat-copy', run: caseChatCopy },
    { id: 'input-placeholder', run: caseInputPlaceholder }
  ]
});
