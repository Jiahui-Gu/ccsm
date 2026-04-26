// Themed harness — PERMISSION cluster, Phase-3.
//
// Per docs/e2e/single-harness-brainstorm.md §8 (option B + C). Each case
// below is the de-duplicated body of one of the per-file probes in
// scripts/probe-e2e-*.mjs. Absorbed probe files have been deleted (#72
// no-skipped-e2e rule — no breadcrumb files).
//
// Scope (12 cases — all pure-store / no real claude.exe required):
//   - permission-prompt              (probe-e2e-permission-prompt)
//   - permission-mode-strict         (probe-e2e-permission-mode-strict)
//   - permission-focus-not-stolen    (probe-e2e-permission-focus-not-stolen)
//   - permission-shortcut-scope      (probe-e2e-permission-shortcut-scope)
//   - permission-nested-input        (probe-e2e-permission-nested-input)
//   - permission-truncate-width      (probe-e2e-permission-truncate-width)
//   - permission-sequential-focus    (probe-e2e-permission-sequential-focus)
//   - permission-allow-always        (probe-e2e-permission-allow-always)
//   - permission-a11y                (probe-e2e-permission-a11y)
//   - permission-partial-accept      (probe-e2e-permission-partial-accept)
//   - permission-auto-and-titles     (probe-e2e-permission-auto-and-titles)
//   - permission-reject-stops-agent  (probe-e2e-permission-reject-stops-agent)
//
// Probes intentionally NOT merged (require real claude.exe subprocess):
//   - permission-allow-write, permission-allow-bash,
//     permission-allow-parallel-batch, permission-prompt-default-mode
//
// Run: `node scripts/harness-perm.mjs`
// Run one case: `node scripts/harness-perm.mjs --only=permission-prompt`

import { runHarness } from './probe-helpers/harness-runner.mjs';

// Shared helper: ensure a session exists with a usable cwd so InputBar enables
// the textarea. Mirrors the seed pattern used across the source probes.
async function seedSession(win, { sid = 's-perm', cwd = 'C:/x' } = {}) {
  // Scrub the composer-draft cache BEFORE touching the store. The drafts
  // module (src/stores/drafts.ts) keeps a module-scope `cache` Map that
  // outlives `resetBetweenCases` — once a prior case typed into the
  // composer (e.g. the `keyboard.press('n')` in casePermissionPrompt that
  // landed inside the textarea before autoFocus committed), the cached
  // entry hydrates back into InputBar's initial `value` on the next case's
  // mount, focuses the composer, and PermissionPromptBlock's auto-focus
  // exception clause (composer focused + non-empty → don't steal) keeps
  // Reject from getting focus. That's the root cause #320 chased.
  //
  // Two-pronged scrub (no DOM input — PR #320 used composer.fill('') + blur
  // and that introduced a NEW focus race against the permission-prompt
  // autoFocus path, ~50% flake on the previously-stable case):
  //   1. `__ccsmDrafts._resetForTests()` clears the in-memory Map. Exposed
  //      from drafts.ts purely for harness use, mirroring `__ccsmStore` /
  //      `__ccsmI18n`.
  //   2. `saveState('drafts', empty)` zeroes the persisted blob so a
  //      future renderer reload (or next launch) doesn't re-hydrate the
  //      stale entry.
  await win.evaluate(async () => {
    window.__ccsmDrafts?._resetForTests?.();
    try {
      await window.ccsm?.saveState?.('drafts', JSON.stringify({ version: 1, drafts: {} }));
    } catch {
      /* persist failure here is non-fatal — in-memory wipe is what matters
       * for the in-process focus race; persisted-blob wipe is defense in
       * depth for next-launch hydration. */
    }
  });

  await win.evaluate(({ sid, cwd }) => {
    window.__ccsmStore.setState({
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
    const s = window.__ccsmStore.getState();
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

  const heading = win.locator('[role="alertdialog"]').first();
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
  if (!allowAlways || !/Always allow .* this session/i.test(allowAlways.label ?? '')) throw new Error(`bad allow-always label: ${allowAlways?.label}`);
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
    const bogus = await window.ccsm.agentSetPermissionMode('s-nonexistent', 'not-a-real-mode');
    const valid = await window.ccsm.agentSetPermissionMode('s-nonexistent', 'default');
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

  const heading = win.locator('[role="alertdialog"]').first();
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
    const store = window.__ccsmStore;
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
  const heading = win.locator('[role="alertdialog"]').first();
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

  const heading = win.locator('[role="alertdialog"]').first();
  await heading.waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(300);

  const inspect = await win.evaluate(() => {
    const container = document.querySelector('[role="alertdialog"]');
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

  const heading = win.locator('[role="alertdialog"]').first();
  await heading.waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(300);

  const measure = await win.evaluate(({ marker, padded }) => {
    const container = document.querySelector('[role="alertdialog"]');
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

  // Note: previously this case did `ta.fill('') + blur` here to defend
  // against a stale draft (e.g. shortcut-scope leaves "helloY") stealing
  // focus during subsequent autoFocus assertions. seedSession now scrubs
  // the drafts cache directly via `__ccsmDrafts._resetForTests()`, so the
  // DOM-level workaround is unnecessary — and the blur half of it
  // introduced a focus race against permission-prompt's autoFocus on
  // some Chromium builds.

  // Inject first permission.
  await injectWaiting(win, {
    id: 'wait-PROBE-SEQ-1',
    requestId: 'PROBE-SEQ-1',
    toolInput: { command: 'echo first' },
    prompt: 'Bash 1'
  });

  const heading = win.locator('[role="alertdialog"]').first();
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
    const store = window.__ccsmStore;
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

  const heading = win.locator('[role="alertdialog"]').first();
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
    const s = window.__ccsmStore.getState();
    return { list: s.allowAlwaysTools.slice() };
  });
  if (!snapshot1.list.includes('Bash')) {
    throw new Error(`allowAlwaysTools missing Bash after click: ${JSON.stringify(snapshot1)}`);
  }

  // 2. Second prompt via the real lifecycle fast-path. Must auto-resolve
  // (Allow IPC) and must NOT append any waiting block.
  await win.evaluate(() => { window.__permIpcCalls = []; });
  const blocksBefore = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    return (s.messagesBySession[s.activeId] || []).filter((b) => b.kind === 'waiting').length;
  });

  const autoResolved = await win.evaluate(() => {
    const fn = window.__ccsmMaybeAutoResolveAllowAlways;
    if (typeof fn !== 'function') return null;
    const sid = window.__ccsmStore.getState().activeId;
    return fn({ sessionId: sid, requestId: 'PROBE-AA-2', toolName: 'Bash' });
  });
  if (autoResolved !== true) {
    throw new Error(`expected fast-path to auto-resolve (returned true), got ${JSON.stringify(autoResolved)}`);
  }

  await win.waitForTimeout(200);

  const blocksAfter = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
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

  const heading = win.locator('[role="alertdialog"]').first();
  await heading.waitFor({ state: 'visible', timeout: 5000 });

  const attrs = await win.evaluate(() => {
    const container = document.querySelector('[role="alertdialog"]');
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

// ---------- permission-partial-accept (#306) ----------
// Per-hunk diff selection wires into agentResolvePermissionPartial. Locks
// down both the render contract (checkboxes per hunk) and the IPC payload
// shape. Reverse-verify: stashing the per-hunk render path collapses the
// flow back to a flat summary with no [data-perm-hunk-checkbox] elements
// → this case fails on the first assertion.
async function casePermissionPartialAccept({ win, log }) {
  await seedSession(win);

  // Spy on the STORE actions (not window.ccsm — direct assignment on the
  // contextBridge proxy is a no-op, see casePermissionAllowAlways for the
  // same pattern). The store action is the one-stop callsite that the
  // preload IPC, so observing it is sufficient to lock down both the
  // partial vs whole choice and the acceptedHunks payload.
  await win.evaluate(() => {
    window.__permIpcCalls = [];
    const store = window.__ccsmStore;
    const origPartial = store.getState().resolvePermissionPartial;
    const origWhole = store.getState().resolvePermission;
    store.setState({
      resolvePermissionPartial: (sid, rid, acceptedHunks) => {
        window.__permIpcCalls.push({ kind: 'partial', sid, rid, acceptedHunks: [...acceptedHunks] });
        return origPartial(sid, rid, acceptedHunks);
      },
      resolvePermission: (sid, rid, decision) => {
        window.__permIpcCalls.push({ kind: 'whole', sid, rid, decision });
        return origWhole(sid, rid, decision);
      }
    });
  });

  await injectWaiting(win, {
    id: 'wait-PROBE-PARTIAL',
    requestId: 'PROBE-PARTIAL',
    toolName: 'MultiEdit',
    toolInput: {
      file_path: '/tmp/probe-multi.ts',
      edits: [
        { old_string: 'old-1', new_string: 'new-1' },
        { old_string: 'old-2', new_string: 'new-2' },
        { old_string: 'old-3', new_string: 'new-3' }
      ]
    },
    prompt: 'MultiEdit /tmp/probe-multi.ts'
  });

  const heading = win.locator('[role="alertdialog"]').first();
  await heading.waitFor({ state: 'visible', timeout: 5_000 });

  // Per-hunk render contract: 3 checkboxes, all checked, primary button
  // shows "Allow selected (3/3)".
  const initial = await win.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('[data-perm-hunk-checkbox]'));
    const allow = document.querySelector('[data-perm-action="allow"]');
    return {
      hunkCount: boxes.length,
      allChecked: boxes.every((b) => b.getAttribute('data-state') === 'checked'),
      primaryLabel: allow?.textContent?.trim() ?? null
    };
  });
  if (initial.hunkCount !== 3) throw new Error(`expected 3 per-hunk checkboxes, got ${initial.hunkCount}`);
  if (!initial.allChecked) throw new Error('expected all hunk checkboxes checked by default');
  if (!/Allow selected \(3\/3\)/.test(initial.primaryLabel ?? '')) {
    throw new Error(`expected primary "Allow selected (3/3)", got "${initial.primaryLabel}"`);
  }

  // Click the middle hunk's checkbox to deselect it.
  await win.evaluate(() => {
    const boxes = document.querySelectorAll('[data-perm-hunk-checkbox]');
    boxes[1].click();
  });
  await win.waitForFunction(() => {
    const allow = document.querySelector('[data-perm-action="allow"]');
    return /Allow selected \(2\/3\)/.test(allow?.textContent ?? '');
  }, null, { timeout: 2000 });

  // Click primary -> partial IPC fires with [0, 2].
  await win.evaluate(() => {
    document.querySelector('[data-perm-action="allow"]').click();
  });
  await heading.waitFor({ state: 'detached', timeout: 3_000 });

  const calls = await win.evaluate(() => window.__permIpcCalls);
  const partial = calls.find((c) => c.kind === 'partial');
  if (!partial) throw new Error(`expected partial IPC call; got ${JSON.stringify(calls)}`);
  if (partial.rid !== 'PROBE-PARTIAL') throw new Error(`bad rid: ${partial.rid}`);
  if (JSON.stringify(partial.acceptedHunks) !== JSON.stringify([0, 2])) {
    throw new Error(`expected acceptedHunks=[0,2], got ${JSON.stringify(partial.acceptedHunks)}`);
  }

  // Second prompt: keep all hunks checked → fall through to whole-allow IPC
  // (saves the main-process `updatedInput` reconstruction in the common case).
  await win.evaluate(() => { window.__permIpcCalls = []; });
  await injectWaiting(win, {
    id: 'wait-PROBE-PARTIAL-2',
    requestId: 'PROBE-PARTIAL-2',
    toolName: 'MultiEdit',
    toolInput: {
      file_path: '/tmp/probe-multi.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' }
      ]
    },
    prompt: 'MultiEdit (all)'
  });
  await heading.waitFor({ state: 'visible', timeout: 5_000 });
  await win.waitForFunction(() => {
    return document.activeElement?.getAttribute?.('data-perm-action') === 'reject';
  }, null, { timeout: 2000 });
  await win.evaluate(() => {
    document.querySelector('[data-perm-action="allow"]').click();
  });
  await heading.waitFor({ state: 'detached', timeout: 3_000 });
  const calls2 = await win.evaluate(() => window.__permIpcCalls);
  const whole = calls2.find((c) => c.kind === 'whole');
  if (!whole) throw new Error(`expected whole-allow IPC; got ${JSON.stringify(calls2)}`);
  if (whole.decision !== 'allow') throw new Error(`expected decision=allow, got ${whole.decision}`);
  if (calls2.some((c) => c.kind === 'partial')) {
    throw new Error(`unexpected partial IPC fired when all hunks selected: ${JSON.stringify(calls2)}`);
  }

  // Third prompt: deselect everything → primary becomes "Reject all" → whole-deny IPC.
  await win.evaluate(() => { window.__permIpcCalls = []; });
  await injectWaiting(win, {
    id: 'wait-PROBE-PARTIAL-3',
    requestId: 'PROBE-PARTIAL-3',
    toolName: 'Edit',
    toolInput: { file_path: '/tmp/probe.ts', old_string: 'x', new_string: 'y' },
    prompt: 'Edit (none)'
  });
  await heading.waitFor({ state: 'visible', timeout: 5_000 });
  await win.evaluate(() => {
    document.querySelector('[data-perm-select-none]').click();
  });
  await win.waitForFunction(() => {
    const allow = document.querySelector('[data-perm-action="allow"]');
    return /Reject all/.test(allow?.textContent ?? '');
  }, null, { timeout: 2000 });
  await win.evaluate(() => {
    document.querySelector('[data-perm-action="allow"]').click();
  });
  await heading.waitFor({ state: 'detached', timeout: 3_000 });
  const calls3 = await win.evaluate(() => window.__permIpcCalls);
  const deny = calls3.find((c) => c.kind === 'whole' && c.decision === 'deny');
  if (!deny) throw new Error(`expected whole-deny IPC after Reject all; got ${JSON.stringify(calls3)}`);

  log('per-hunk render OK; partial IPC=[0,2] OK; full-select fallthrough OK; Reject all OK');
}

// ---------- permission-auto-and-titles ----------
// Was: probe-e2e-permission-auto-and-titles.mjs (PR #288).
// Locks down: store accepts setPermission('auto'); main-process IPC
// validation accepts 'auto' as a known mode; i18n keys for the per-tool
// permission prompt titles + Auto chip copy resolve to the spec text.
// Pure-store/IPC/i18n — no real claude.exe.
async function casePermissionAutoAndTitles({ win, log }) {
  // Make sure the store is in a clean baseline (a previous case may have
  // poisoned `permission` to 'auto' or left state behind). seedSession
  // resets the relevant slices.
  await seedSession(win);

  // Pin English so the i18n assertions below are deterministic regardless
  // of OS locale or earlier case mutations.
  await win.evaluate(async () => {
    if (window.__ccsmI18n?.changeLanguage) {
      await window.__ccsmI18n.changeLanguage('en');
    }
  });

  // 1. Store accepts setPermission('auto').
  const stateAfter = await win.evaluate(() => {
    const store = window.__ccsmStore;
    const before = store.getState().permission;
    store.getState().setPermission('auto');
    return { before, after: store.getState().permission };
  });
  if (stateAfter.after !== 'auto') {
    throw new Error(`expected store.permission='auto', got ${stateAfter.after}`);
  }

  // 2. i18n keys for chip copy + per-tool titles + auto-unsupported toast.
  const i18nText = await win.evaluate(() => {
    const t = window.__ccsmI18n.t.bind(window.__ccsmI18n);
    return {
      autoLabel: t('statusBar.modeAutoLabel'),
      autoTooltip: t('statusBar.modeAutoTooltip'),
      autoDesc: t('statusBar.modeAutoDesc'),
      bashTitle: t('permissionPrompt.titleByTool.bash'),
      webFetchTitle: t('permissionPrompt.titleByTool.webFetch'),
      editTitle: t('permissionPrompt.titleByTool.edit'),
      skillTitle: t('permissionPrompt.titleByTool.skill'),
      fallbackTitle: t('permissionPrompt.titleByTool.fallback'),
      autoUnsupportedTitle: t('permissions.autoUnsupportedTitle')
    };
  });
  if (i18nText.autoLabel !== 'Auto') throw new Error(`autoLabel expected "Auto", got ${i18nText.autoLabel}`);
  if (!/sonnet 4\.6\+/i.test(i18nText.autoTooltip)) {
    throw new Error(`autoTooltip should mention "Sonnet 4.6+", got ${JSON.stringify(i18nText.autoTooltip)}`);
  }
  if (!/research preview/i.test(i18nText.autoDesc)) {
    throw new Error(`autoDesc should mention "research preview", got ${JSON.stringify(i18nText.autoDesc)}`);
  }
  if (!/allow this bash command/i.test(i18nText.bashTitle)) {
    throw new Error(`bashTitle wrong: ${JSON.stringify(i18nText.bashTitle)}`);
  }
  if (!/allow fetching this url/i.test(i18nText.webFetchTitle)) {
    throw new Error(`webFetchTitle wrong: ${JSON.stringify(i18nText.webFetchTitle)}`);
  }
  if (!/allow editing this file/i.test(i18nText.editTitle)) {
    throw new Error(`editTitle wrong: ${JSON.stringify(i18nText.editTitle)}`);
  }
  if (!/allow running this skill/i.test(i18nText.skillTitle)) {
    throw new Error(`skillTitle wrong: ${JSON.stringify(i18nText.skillTitle)}`);
  }
  if (!/permission required/i.test(i18nText.fallbackTitle)) {
    throw new Error(`fallbackTitle wrong: ${JSON.stringify(i18nText.fallbackTitle)}`);
  }
  if (!/auto mode unavailable/i.test(i18nText.autoUnsupportedTitle)) {
    throw new Error(`autoUnsupportedTitle wrong: ${JSON.stringify(i18nText.autoUnsupportedTitle)}`);
  }

  // 3. Main-process IPC validation accepts 'auto'. Session does not exist
  // (manager.setPermissionMode no-ops cleanly), so handler returns ok:true
  // proving 'auto' is in the KNOWN_MODES allowlist (sister to
  // permission-mode-strict's 'default' assertion).
  const ipc = await win.evaluate(async () => {
    return await window.ccsm.agentSetPermissionMode('s-nonexistent-auto', 'auto');
  });
  if (!ipc || ipc.ok !== true) {
    throw new Error(`expected IPC to accept 'auto' for nonexistent session (ok:true), got ${JSON.stringify(ipc)}`);
  }

  // Restore default permission so subsequent cases (esp. allow-always
  // fast-path) don't see a stale 'auto' setting.
  await win.evaluate(() => {
    window.__ccsmStore.getState().setPermission('default');
  });

  log('auto mode wired through store + i18n + IPC; per-tool titles localized');
}

// ---------- permission-reject-stops-agent ----------
// Was: probe-e2e-permission-reject-stops-agent.mjs (Journey 5).
// Locks down: pressing N on a permission prompt fires
// agentResolvePermission(deny) EXACTLY once (no retry), and the chat
// retains a visible "denied"/"rejected" trace so the user can scroll
// back. Pure-store — no real claude.exe.
async function casePermissionRejectStopsAgent({ win, log }) {
  const sid = await seedSession(win, { sid: 's-perm-reject' });

  // Spy on the store action — see permission-shortcut-scope for the
  // contextBridge-freeze rationale.
  await win.evaluate(() => {
    window.__permRejectCalls = [];
    const store = window.__ccsmStore;
    const origAction = store.getState().resolvePermission;
    store.setState({
      resolvePermission: (sessionId, requestId, decision) => {
        window.__permRejectCalls.push({ sessionId, requestId, decision, at: Date.now() });
        return origAction(sessionId, requestId, decision);
      }
    });
  });

  await injectWaiting(win, {
    id: 'wait-PROBE-REJECT',
    requestId: 'PROBE-REJECT',
    toolName: 'Bash',
    toolInput: { command: 'rm -rf /tmp/danger' },
    prompt: 'Bash dangerous'
  });

  const heading = win.locator('[role="alertdialog"]').first();
  await heading.waitFor({ state: 'visible', timeout: 5000 });

  // Move focus off textarea so 'n' triggers the hotkey.
  await win.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus?.();
  });
  await win.waitForTimeout(150);

  await win.keyboard.press('n');

  try {
    await heading.waitFor({ state: 'detached', timeout: 3000 });
  } catch {
    throw new Error('block still visible after pressing N');
  }
  await win.waitForTimeout(300);

  // CONTRACT 1: agentResolvePermission called exactly once with 'deny'.
  const calls = await win.evaluate(() => window.__permRejectCalls.slice());
  if (calls.length !== 1) {
    throw new Error(`expected exactly 1 IPC call, got ${calls.length}: ${JSON.stringify(calls)}`);
  }
  if (calls[0].requestId !== 'PROBE-REJECT' || calls[0].decision !== 'deny' || calls[0].sessionId !== sid) {
    throw new Error(`wrong IPC payload: ${JSON.stringify(calls[0])}`);
  }

  // Wait a beat then re-check no retry IPC fires (silent re-attempt).
  await win.waitForTimeout(800);
  const callsLater = await win.evaluate(() => window.__permRejectCalls.slice());
  if (callsLater.length !== 1) {
    throw new Error(`renderer retried IPC after deny: ${JSON.stringify(callsLater)}`);
  }

  // CONTRACT 2: chat retains a visible "denied"/"rejected" trace.
  const chatText = await win.evaluate(() => document.body.innerText);
  if (!/permission denied|rejected|denied/i.test(chatText)) {
    throw new Error(`no visible "denied"/"rejected" trace remains in chat after rejection. Body excerpt: ${chatText.slice(0, 800)}`);
  }

  log('deny IPC fired exactly once, no retry, chat retained denial trace');
}

// ---------- harness spec ----------
await runHarness({
  name: 'perm',
  // Opt out of CCSM_E2E_HIDDEN: permission-prompt asserts that Reject
  // is focused immediately on mount via Radix's autoFocus + a rAF
  // callback. With show:true off-screen the rAF fires before Radix's
  // focus-trap commits in some Chromium versions, so the synchronous
  // snapshot at line 88 sees no focused button. Visible window
  // restores deterministic focus delivery; the other 9 cases in this
  // harness still pass either way. ~2s window pop during run-all-e2e.
  launch: { env: { CCSM_E2E_HIDDEN: '0' } },
  setup: async ({ win }) => {
    // Suppress the "Claude CLI not found" first-launch dialog.
    await win.evaluate(() => {
      window.__ccsmStore?.setState({
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
    { id: 'permission-a11y', run: casePermissionA11y },
    { id: 'permission-partial-accept', run: casePermissionPartialAccept },
    { id: 'permission-auto-and-titles', run: casePermissionAutoAndTitles },
    { id: 'permission-reject-stops-agent', run: casePermissionRejectStopsAgent }
  ]
});
