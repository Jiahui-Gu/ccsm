// Themed harness — PERMISSION cluster, Phase-3.
//
// Per docs/e2e/single-harness-brainstorm.md §8 (option B + C). Each case
// below is the de-duplicated body of one of the per-file probes in
// scripts/probe-e2e-*.mjs. The original probe files have been left in
// place with a `// MERGED INTO harness-perm.mjs` marker on line 1 and are
// excluded from the per-file runner via scripts/run-all-e2e.mjs's
// MERGED_INTO_HARNESS skip list.
//
// Scope (7 cases — all pure-store / no real claude.exe required):
//   - permission-prompt              (probe-e2e-permission-prompt)
//   - permission-mode-strict         (probe-e2e-permission-mode-strict)
//   - permission-focus-not-stolen    (probe-e2e-permission-focus-not-stolen)
//   - permission-shortcut-scope      (probe-e2e-permission-shortcut-scope)
//   - permission-nested-input        (probe-e2e-permission-nested-input)
//   - permission-truncate-width      (probe-e2e-permission-truncate-width)
//   - permission-sequential-focus    (probe-e2e-permission-sequential-focus)
//
// Probes intentionally NOT merged (require real claude.exe subprocess):
//   - permission-allow-write, permission-allow-bash,
//     permission-allow-parallel-batch, permission-reject-stops-agent,
//     permission-prompt-default-mode
//
// Run: `node scripts/harness-perm.mjs`
// Run one case: `node scripts/harness-perm.mjs --only=permission-prompt`

import { runHarness } from './probe-helpers/harness-runner.mjs';

// Shared helper: ensure a session exists with a usable cwd so InputBar enables
// the textarea. Mirrors the seed pattern used across the source probes.
async function seedSession(win, { sid = 's-perm', cwd = 'C:/x' } = {}) {
  await win.evaluate(({ sid, cwd }) => {
    window.__agentoryStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: sid, name: 'perm-probe', state: 'idle', cwd, model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: sid,
      messagesBySession: { [sid]: [] }
    });
  }, { sid, cwd });
  await win.waitForTimeout(200);
  return sid;
}

async function injectWaiting(win, { id, requestId, toolName = 'Bash', toolInput, prompt = 'Bash op' }) {
  await win.evaluate((args) => {
    const s = window.__agentoryStore.getState();
    s.appendBlocks(s.activeId, [{
      kind: 'waiting',
      id: args.id,
      prompt: args.prompt,
      intent: 'permission',
      requestId: args.requestId,
      toolName: args.toolName,
      toolInput: args.toolInput
    }]);
  }, { id, requestId, toolName, toolInput, prompt });
}

// ---------- permission-prompt ----------
async function casePermissionPrompt({ win, log }) {
  await seedSession(win);
  await injectWaiting(win, {
    id: 'wait-PROBE-RID',
    requestId: 'PROBE-RID',
    toolInput: { command: 'rm -rf /tmp/probe', description: 'Remove probe tmp dir' },
    prompt: 'Bash: rm -rf /tmp/probe'
  });

  const heading = win.locator('text=Permission required').first();
  await heading.waitFor({ state: 'visible', timeout: 5_000 });

  const snapshot = await win.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('[data-perm-action]')).map((b) => ({
      action: b.getAttribute('data-perm-action'),
      label: b.textContent?.trim(),
      focused: b === document.activeElement
    }));
    return { buttons: btns };
  });

  if (snapshot.buttons.length !== 3) throw new Error(`expected 3 perm buttons, got ${snapshot.buttons.length}`);
  const reject = snapshot.buttons.find((b) => b.action === 'reject');
  const allow = snapshot.buttons.find((b) => b.action === 'allow');
  const allowAlways = snapshot.buttons.find((b) => b.action === 'allow-always');
  if (!reject || !/Reject \(N\)/i.test(reject.label ?? '')) throw new Error(`bad reject label: ${reject?.label}`);
  if (!allow || !/Allow \(Y\)/i.test(allow.label ?? '')) throw new Error(`bad allow label: ${allow?.label}`);
  if (!allowAlways || !/Allow always/i.test(allowAlways.label ?? '')) throw new Error(`bad allow-always label: ${allowAlways?.label}`);
  if (!reject.focused) throw new Error(`expected Reject focused; got ${JSON.stringify(snapshot.buttons)}`);

  // Press N -> Reject. Block should disappear.
  await win.keyboard.press('n');
  try {
    await heading.waitFor({ state: 'detached', timeout: 3_000 });
  } catch {
    throw new Error('prompt still visible after pressing N');
  }

  // Inject a second one and press Y.
  await injectWaiting(win, {
    id: 'wait-PROBE-RID-2',
    requestId: 'PROBE-RID-2',
    toolInput: { command: 'echo allowed' },
    prompt: 'Bash: echo allowed'
  });
  await win.waitForTimeout(400);
  await heading.waitFor({ state: 'visible', timeout: 3_000 });
  // Wait for autoFocus effect to move focus onto the block's Reject button —
  // otherwise a just-launched InputBar can still hold focus and the Y keystroke
  // gets typed into the textarea instead of resolving the permission.
  // Surface the timeout loudly (was `.catch(() => {})` — silently swallowed
  // the race so the test continued and falsely "passed" even when the 2nd Y
  // didn't resolve the prompt). Per PR #178 reviewer feedback.
  await win.waitForFunction(() => {
    const el = document.activeElement;
    return el?.getAttribute?.('data-perm-action') === 'reject';
  }, null, { timeout: 2000 }).catch((err) => {
    throw new Error(`[case=permission-prompt] autoFocus never moved to Reject before 2nd Y press: ${err.message}`);
  });
  await win.keyboard.press('y');
  try {
    await heading.waitFor({ state: 'detached', timeout: 3_000 });
  } catch {
    throw new Error('prompt still visible after pressing Y');
  }

  log('expanded=yes rejectFocused=yes keyboard Y/N works');
}

// ---------- permission-mode-strict ----------
async function casePermissionModeStrict({ win, log }) {
  // Pure IPC contract test — no DOM.
  const result = await win.evaluate(async () => {
    const bogus = await window.agentory.agentSetPermissionMode('s-nonexistent', 'not-a-real-mode');
    const valid = await window.agentory.agentSetPermissionMode('s-nonexistent', 'default');
    return { bogus, valid };
  });

  if (!result.bogus || result.bogus.ok !== false || result.bogus.error !== 'unknown_mode') {
    throw new Error(`bogus mode expected { ok:false, error:'unknown_mode' }, got ${JSON.stringify(result.bogus)}`);
  }
  if (!result.valid || result.valid.ok !== true) {
    throw new Error(`valid mode 'default' expected { ok:true }, got ${JSON.stringify(result.valid)}`);
  }
  log('unknown permission modes are rejected; known modes pass through');
}

// ---------- permission-focus-not-stolen ----------
async function casePermissionFocusNotStolen({ win, log }) {
  await seedSession(win);

  const textarea = win.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });

  // Focus + start typing a partial command.
  await textarea.click();
  await textarea.fill('docker rmi xxx');

  const focusedBefore = await win.evaluate(() => document.activeElement?.tagName?.toLowerCase());
  if (focusedBefore !== 'textarea') throw new Error(`pre-inject focus expected textarea, got ${focusedBefore}`);

  await injectWaiting(win, {
    id: 'wait-PROBE-FOCUS',
    requestId: 'PROBE-FOCUS',
    toolInput: { command: 'docker rmi xxx' },
    prompt: 'Bash: docker rmi xxx'
  });

  const heading = win.locator('text=Permission required').first();
  await heading.waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(250);

  const focusedAfter = await win.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName?.toLowerCase() ?? null,
      isTextarea: el instanceof HTMLTextAreaElement,
      insideAlertdialog: !!el?.closest('[role="alertdialog"]')
    };
  });
  if (!focusedAfter.isTextarea) throw new Error(`focus stolen: activeElement=${JSON.stringify(focusedAfter)}`);
  if (focusedAfter.insideAlertdialog) throw new Error('focus moved into permission alertdialog');

  await win.keyboard.type(' more');
  await win.waitForTimeout(150);
  const afterType = await textarea.inputValue();
  if (afterType !== 'docker rmi xxx more') throw new Error(`textarea content changed unexpectedly: ${JSON.stringify(afterType)}`);

  const stillVisible = await heading.isVisible();
  if (!stillVisible) throw new Error('permission block disappeared while user was typing');

  log('focus retained on textarea, typing not intercepted by permission block');
}

// ---------- permission-shortcut-scope ----------
async function casePermissionShortcutScope({ win, log }) {
  await seedSession(win);

  // Wrap the store's resolvePermission action to spy on calls.
  await win.evaluate(() => {
    window.__permCalls = [];
    const store = window.__agentoryStore;
    const origAction = store.getState().resolvePermission;
    store.setState({
      resolvePermission: (sessionId, requestId, decision) => {
        window.__permCalls.push({ sessionId, requestId, decision });
        return origAction(sessionId, requestId, decision);
      }
    });
  });

  const textarea = win.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });

  // Case A: focus outside textarea, press Y -> Allow.
  await injectWaiting(win, {
    id: 'wait-PROBE-SCOPE-A',
    requestId: 'PROBE-SCOPE-A',
    toolInput: { command: 'echo a' },
    prompt: 'Bash A'
  });
  const heading = win.locator('text=Permission required').first();
  await heading.waitFor({ state: 'visible', timeout: 5000 });

  await win.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus?.();
  });
  await win.waitForTimeout(150);
  const focusedTagA = await win.evaluate(() => document.activeElement?.tagName?.toLowerCase() ?? null);
  if (focusedTagA === 'textarea') throw new Error(`A: could not move focus off textarea (still ${focusedTagA})`);

  await win.keyboard.press('y');
  try {
    await heading.waitFor({ state: 'detached', timeout: 3000 });
  } catch {
    throw new Error('A: pressing Y outside textarea did not resolve the permission');
  }
  const callsAfterA = await win.evaluate(() => window.__permCalls.slice());
  const allowCall = callsAfterA.find((c) => c.requestId === 'PROBE-SCOPE-A');
  if (!allowCall || allowCall.decision !== 'allow') {
    throw new Error(`A: expected allow IPC for PROBE-SCOPE-A, got ${JSON.stringify(callsAfterA)}`);
  }

  // Case B: focus INSIDE textarea, press Y -> textarea gets "Y", perm stays pending.
  await win.evaluate(() => { window.__permCalls = []; });
  await injectWaiting(win, {
    id: 'wait-PROBE-SCOPE-B',
    requestId: 'PROBE-SCOPE-B',
    toolInput: { command: 'echo b' },
    prompt: 'Bash B'
  });
  await heading.waitFor({ state: 'visible', timeout: 5000 });

  await textarea.click();
  await textarea.fill('hello');
  const focusB = await win.evaluate(() => document.activeElement?.tagName?.toLowerCase());
  if (focusB !== 'textarea') throw new Error(`B: could not focus textarea (got ${focusB})`);

  await win.keyboard.type('Y');
  await win.waitForTimeout(250);

  const taValue = await textarea.inputValue();
  if (taValue !== 'helloY') throw new Error(`B: expected textarea to receive literal "Y" (helloY), got ${JSON.stringify(taValue)}`);
  const stillVisible = await heading.isVisible();
  if (!stillVisible) throw new Error('B: permission resolved while typing into textarea');
  const callsAfterB = await win.evaluate(() => window.__permCalls.slice());
  const leakedB = callsAfterB.find((c) => c.requestId === 'PROBE-SCOPE-B');
  if (leakedB) throw new Error(`B: hotkey fired despite focus inside textarea: ${JSON.stringify(leakedB)}`);

  log('A=Y triggers allow off-textarea; B=Y types literal in-textarea');
}

// ---------- permission-nested-input ----------
async function casePermissionNestedInput({ win, log }) {
  await seedSession(win);
  await injectWaiting(win, {
    id: 'wait-PROBE-NESTED',
    requestId: 'PROBE-NESTED',
    toolInput: { command: 'ls', flags: { a: true, l: true } },
    prompt: 'Bash ls'
  });

  const heading = win.locator('text=Permission required').first();
  await heading.waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(300);

  const inspect = await win.evaluate(() => {
    const heading = Array.from(document.querySelectorAll('*')).find(
      (n) => n.textContent?.trim() === 'Permission required'
    );
    const container = heading?.closest('[role="alertdialog"]');
    if (!container) return { ok: false };
    const text = container.textContent ?? '';
    return {
      ok: true,
      text,
      hasObjectObject: text.includes('[object Object]'),
      hasCommand: text.includes('ls'),
      mentionsFlags: /flags/i.test(text),
      hasFlagA: /\ba\b/.test(text) && /true/i.test(text),
      hasFlagL: /\bl\b/.test(text)
    };
  });

  if (!inspect.ok) throw new Error('container missing');
  if (inspect.hasObjectObject) throw new Error(`rendered "[object Object]" — nested toolInput not properly serialized. Text: ${inspect.text.slice(0, 500)}`);
  if (!inspect.hasCommand) throw new Error(`command "ls" not visible in permission body. Text: ${inspect.text.slice(0, 500)}`);
  if (!inspect.mentionsFlags) throw new Error(`nested key "flags" not surfaced in permission body. Text: ${inspect.text.slice(0, 500)}`);
  if (!(inspect.hasFlagA && inspect.hasFlagL)) throw new Error(`nested flag values not summarised (need keys a/l + true visible). Text: ${inspect.text.slice(0, 500)}`);

  log('nested toolInput rendered without [object Object]');
}

// ---------- permission-truncate-width ----------
async function casePermissionTruncateWidth({ win, log }) {
  await seedSession(win);

  const MARKER = 'ZZUNIQUEMARKERZZ';
  const longSql = 'SELECT ' +
    Array.from({ length: 60 }, (_, i) => `col_${i}`).join(', ') +
    ' FROM users WHERE ' +
    Array.from({ length: 30 }, (_, i) => `flag_${i}=1`).join(' AND ') +
    ` -- ${MARKER}`;
  const padded = longSql.length < 800
    ? longSql + ' /* ' + 'x'.repeat(800 - longSql.length - 5) + ' */'
    : longSql;

  await injectWaiting(win, {
    id: 'wait-PROBE-LONG',
    requestId: 'PROBE-LONG',
    toolInput: { command: padded, description: 'huge query' },
    prompt: 'Bash: long sql'
  });

  const heading = win.locator('text=Permission required').first();
  await heading.waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(300);

  const measure = await win.evaluate(({ marker, padded }) => {
    const heading = Array.from(document.querySelectorAll('*')).find(
      (n) => n.textContent?.trim() === 'Permission required'
    );
    const container = heading?.closest('[role="alertdialog"]');
    if (!container) return { ok: false };
    const rect = container.getBoundingClientRect();
    const text = container.textContent ?? '';
    const body = document.body.getBoundingClientRect();
    return {
      ok: true,
      width: rect.width,
      bodyWidth: body.width,
      overflowsViewport: rect.right > body.right + 1,
      fullSqlLen: padded.length,
      rawTextHasFullSql: text.includes(padded),
      rawTextHasMarker: text.includes(marker),
      hasEllipsis: /[…]|\.{3}/.test(text),
      horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  }, { marker: MARKER, padded });

  if (!measure.ok) throw new Error('could not locate permission alertdialog container');
  if (measure.rawTextHasFullSql) throw new Error('full 800-char toolInput rendered verbatim — no truncation');
  if (!measure.hasEllipsis) throw new Error('no ellipsis ("…" or "...") in permission body — truncation not signalled');
  if (measure.overflowsViewport) throw new Error(`container right edge ${measure.width} overflows viewport (body ${measure.bodyWidth})`);
  if (measure.horizontalScroll) throw new Error('document developed a horizontal scrollbar after rendering long permission');

  log(`long toolInput truncated (len=${measure.fullSqlLen}), container fits viewport (${measure.width.toFixed(0)} ≤ ${measure.bodyWidth.toFixed(0)})`);
}

// ---------- permission-sequential-focus ----------
async function casePermissionSequentialFocus({ win, log }) {
  await seedSession(win);

  // Reset draft-cache + blur textarea so a prior case's leftover text
  // (e.g. shortcut-scope leaves "helloY") doesn't steal focus during
  // subsequent autoFocus assertions. The drafts cache is module-scope and
  // DB cleanup alone can't reach it.
  const ta = win.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 5000 });
  await ta.fill('');
  await win.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus?.();
  });
  await win.waitForTimeout(100);

  // Inject first permission.
  await injectWaiting(win, {
    id: 'wait-PROBE-SEQ-1',
    requestId: 'PROBE-SEQ-1',
    toolInput: { command: 'echo first' },
    prompt: 'Bash 1'
  });

  const heading = win.locator('text=Permission required').first();
  await heading.waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(200);

  const firstFocus = await win.evaluate(() => {
    const el = document.activeElement;
    return {
      action: el?.getAttribute?.('data-perm-action') ?? null,
      inWaitingBlock: el?.closest?.('[data-block-id]')?.getAttribute('data-block-id') ?? null
    };
  });
  if (firstFocus.action !== 'reject') throw new Error(`first block: expected Reject focused, got ${JSON.stringify(firstFocus)}`);

  await win.keyboard.press('y');
  try {
    await heading.waitFor({ state: 'detached', timeout: 3000 });
  } catch {
    throw new Error('first block did not unmount after Y');
  }

  // Inject second permission.
  await injectWaiting(win, {
    id: 'wait-PROBE-SEQ-2',
    requestId: 'PROBE-SEQ-2',
    toolInput: { command: 'echo second' },
    prompt: 'Bash 2'
  });

  await heading.waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(400);

  const secondFocus = await win.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName?.toLowerCase() ?? null,
      action: el?.getAttribute?.('data-perm-action') ?? null,
      text: el?.textContent?.trim() ?? null,
      isConnected: !!el?.isConnected
    };
  });
  if (!secondFocus.isConnected) throw new Error(`focus is on a detached element: ${JSON.stringify(secondFocus)}`);
  if (secondFocus.action !== 'reject') throw new Error(`second block: expected Reject focused, got ${JSON.stringify(secondFocus)}`);

  await win.keyboard.press('n');
  try {
    await heading.waitFor({ state: 'detached', timeout: 3000 });
  } catch {
    throw new Error('second block did not unmount after N');
  }

  log('focus correctly transfers to second block\'s Reject');
}

// ---------- permission-allow-always ----------
// Covers UI-6 (#214) and guards the session-scoped auto-resolve fast-path:
//   1. First prompt arrives, user clicks "Allow always" -> store records the
//      tool name AND dispatches Allow IPC.
//   2. Second prompt for the same tool name must NOT render a waiting block
//      and must dispatch Allow IPC automatically via the lifecycle fast-path
//      (`maybeAutoResolveAllowAlways`).
async function casePermissionAllowAlways({ win, log }) {
  await seedSession(win);

  // Spy on the store action so we can confirm allow decisions reach the
  // resolve path (which in turn fires the preload IPC). Mirrors the pattern
  // used by permission-shortcut-scope — direct assignment to the
  // contextBridge proxy is a no-op.
  await win.evaluate(() => {
    window.__permIpcCalls = [];
    const store = window.__agentoryStore;
    const orig = store.getState().resolvePermission;
    store.setState({
      resolvePermission: (sessionId, requestId, decision) => {
        window.__permIpcCalls.push({ sessionId, requestId, decision });
        return orig(sessionId, requestId, decision);
      }
    });
  });

  // 1. Inject first prompt and click "Allow always".
  await injectWaiting(win, {
    id: 'wait-PROBE-AA-1',
    requestId: 'PROBE-AA-1',
    toolName: 'Bash',
    toolInput: { command: 'echo first' },
    prompt: 'Bash: echo first'
  });

  const heading = win.locator('text=Permission required').first();
  await heading.waitFor({ state: 'visible', timeout: 5000 });

  const allowAlwaysBtn = win.locator('[data-perm-action="allow-always"]').first();
  await allowAlwaysBtn.waitFor({ state: 'visible', timeout: 3000 });
  await allowAlwaysBtn.click();

  try {
    await heading.waitFor({ state: 'detached', timeout: 3000 });
  } catch {
    throw new Error('first block did not unmount after clicking Allow always');
  }

  const firstIpc = await win.evaluate(() => window.__permIpcCalls.slice());
  const firstCall = firstIpc.find((c) => c.requestId === 'PROBE-AA-1');
  if (!firstCall || firstCall.decision !== 'allow') {
    throw new Error(`first Allow always did not fire IPC allow: ${JSON.stringify(firstIpc)}`);
  }

  const snapshot1 = await win.evaluate(() => {
    const s = window.__agentoryStore.getState();
    return { list: s.allowAlwaysTools.slice() };
  });
  if (!snapshot1.list.includes('Bash')) {
    throw new Error(`allowAlwaysTools missing Bash after click: ${JSON.stringify(snapshot1)}`);
  }

  // 2. Second prompt via the real lifecycle fast-path. Must auto-resolve
  // (Allow IPC) and must NOT append any waiting block.
  await win.evaluate(() => { window.__permIpcCalls = []; });
  const blocksBefore = await win.evaluate(() => {
    const s = window.__agentoryStore.getState();
    return (s.messagesBySession[s.activeId] || []).filter((b) => b.kind === 'waiting').length;
  });

  const autoResolved = await win.evaluate(() => {
    const fn = window.__agentoryMaybeAutoResolveAllowAlways;
    if (typeof fn !== 'function') return null;
    const sid = window.__agentoryStore.getState().activeId;
    return fn({ sessionId: sid, requestId: 'PROBE-AA-2', toolName: 'Bash' });
  });
  if (autoResolved !== true) {
    throw new Error(`expected fast-path to auto-resolve (returned true), got ${JSON.stringify(autoResolved)}`);
  }

  await win.waitForTimeout(200);

  const blocksAfter = await win.evaluate(() => {
    const s = window.__agentoryStore.getState();
    return (s.messagesBySession[s.activeId] || []).filter((b) => b.kind === 'waiting').length;
  });
  if (blocksAfter !== blocksBefore) {
    throw new Error(`expected 0 new waiting blocks on second allow-always tool use; before=${blocksBefore} after=${blocksAfter}`);
  }

  const stillHidden = await heading.isVisible().catch(() => false);
  if (stillHidden) throw new Error('permission block rendered for allow-always tool (should have been auto-resolved)');

  const secondIpc = await win.evaluate(() => window.__permIpcCalls.slice());
  const secondCall = secondIpc.find((c) => c.requestId === 'PROBE-AA-2');
  if (!secondCall || secondCall.decision !== 'allow') {
    throw new Error(`fast-path did not dispatch Allow IPC for PROBE-AA-2: ${JSON.stringify(secondIpc)}`);
  }

  // 3. Guard: a non-allow-listed tool still renders a prompt.
  await injectWaiting(win, {
    id: 'wait-PROBE-AA-3',
    requestId: 'PROBE-AA-3',
    toolName: 'Write',
    toolInput: { file_path: '/tmp/x', content: 'x' },
    prompt: 'Write: /tmp/x'
  });
  await heading.waitFor({ state: 'visible', timeout: 5000 });
  // dismiss via reject to keep state clean
  await win.keyboard.press('n');
  try {
    await heading.waitFor({ state: 'detached', timeout: 3000 });
  } catch {
    // non-fatal — tool-not-in-list still shows a prompt, which was the point.
  }

  log('allow-always persists for Bash in-session; Write still prompts; IPC allow dispatched');
}

// ---------- permission-a11y ----------
// Covers UI-11 (#194): role=alertdialog + aria-modal + labelled/described.
async function casePermissionA11y({ win, log }) {
  await seedSession(win);
  await injectWaiting(win, {
    id: 'wait-PROBE-A11Y',
    requestId: 'PROBE-A11Y',
    toolInput: { command: 'echo a11y' },
    prompt: 'Bash a11y'
  });

  const heading = win.locator('text=Permission required').first();
  await heading.waitFor({ state: 'visible', timeout: 5000 });

  const attrs = await win.evaluate(() => {
    const heading = Array.from(document.querySelectorAll('*')).find(
      (n) => n.textContent?.trim() === 'Permission required'
    );
    const container = heading?.closest('[role="alertdialog"]');
    if (!container) return null;
    const labelId = container.getAttribute('aria-labelledby');
    const descId = container.getAttribute('aria-describedby');
    const labelEl = labelId ? document.getElementById(labelId) : null;
    const descEl = descId ? document.getElementById(descId) : null;
    return {
      role: container.getAttribute('role'),
      ariaModal: container.getAttribute('aria-modal'),
      labelId,
      descId,
      labelHasText: !!labelEl?.textContent?.trim(),
      descHasText: !!descEl?.textContent?.trim()
    };
  });

  if (!attrs) throw new Error('container with role=alertdialog missing');
  if (attrs.role !== 'alertdialog') throw new Error(`role must be alertdialog, got ${attrs.role}`);
  if (attrs.ariaModal !== 'true') throw new Error(`aria-modal must be "true", got ${attrs.ariaModal}`);
  if (!attrs.labelId) throw new Error('aria-labelledby missing');
  if (!attrs.descId) throw new Error('aria-describedby missing');
  if (!attrs.labelHasText) throw new Error(`aria-labelledby target #${attrs.labelId} has no text`);
  if (!attrs.descHasText) throw new Error(`aria-describedby target #${attrs.descId} has no text`);

  // Esc dismisses (acts as reject). Focus must be inside the prompt first.
  const rejectBtn = win.locator('[data-perm-action="reject"]').first();
  await rejectBtn.focus();
  await win.keyboard.press('Escape');
  try {
    await heading.waitFor({ state: 'detached', timeout: 3000 });
  } catch {
    throw new Error('Escape did not dismiss the alertdialog');
  }

  // Focus trap: inject a new prompt, verify Tab cycles between perm buttons
  // when focus is inside the prompt.
  await injectWaiting(win, {
    id: 'wait-PROBE-A11Y-2',
    requestId: 'PROBE-A11Y-2',
    toolInput: { command: 'echo cycle' },
    prompt: 'Bash cycle'
  });
  await heading.waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForFunction(() => {
    return document.activeElement?.getAttribute?.('data-perm-action') === 'reject';
  }, null, { timeout: 2000 });

  await win.keyboard.press('Tab');
  const afterTab1 = await win.evaluate(() => document.activeElement?.getAttribute('data-perm-action'));
  if (afterTab1 !== 'allow-always') throw new Error(`Tab from reject expected allow-always, got ${afterTab1}`);
  await win.keyboard.press('Tab');
  const afterTab2 = await win.evaluate(() => document.activeElement?.getAttribute('data-perm-action'));
  if (afterTab2 !== 'allow') throw new Error(`Tab from allow-always expected allow, got ${afterTab2}`);
  await win.keyboard.press('Tab');
  const afterTab3 = await win.evaluate(() => document.activeElement?.getAttribute('data-perm-action'));
  if (afterTab3 !== 'reject') throw new Error(`Tab cycle should wrap to reject, got ${afterTab3}`);

  await win.keyboard.press('n');
  try {
    await heading.waitFor({ state: 'detached', timeout: 3000 });
  } catch {
    // cleanup, non-fatal
  }

  log('role=alertdialog + aria-modal=true + labelled/described; Esc dismisses; Tab cycles');
}

// ---------- harness spec ----------
await runHarness({
  name: 'perm',
  setup: async ({ win }) => {
    // Suppress the "Claude CLI not found" first-launch dialog.
    await win.evaluate(() => {
      window.__agentoryStore?.setState({
        cliStatus: { state: 'found', binaryPath: '<harness>', version: null }
      });
    });
  },
  cases: [
    { id: 'permission-prompt', run: casePermissionPrompt },
    { id: 'permission-mode-strict', run: casePermissionModeStrict },
    { id: 'permission-focus-not-stolen', run: casePermissionFocusNotStolen },
    { id: 'permission-shortcut-scope', run: casePermissionShortcutScope },
    { id: 'permission-nested-input', run: casePermissionNestedInput },
    { id: 'permission-truncate-width', run: casePermissionTruncateWidth },
    { id: 'permission-sequential-focus', run: casePermissionSequentialFocus },
    { id: 'permission-allow-always', run: casePermissionAllowAlways },
    { id: 'permission-a11y', run: casePermissionA11y }
  ]
});
