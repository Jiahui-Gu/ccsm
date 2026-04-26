// Themed harness — PERMISSION cluster, Phase-3 + Phase-4 (#223 capability absorption).
//
// Per docs/e2e/single-harness-brainstorm.md §8 (option B + C). Each case
// below is the de-duplicated body of one of the per-file probes in
// scripts/probe-e2e-*.mjs. Absorbed probe files have been deleted (#72
// no-skipped-e2e rule — no breadcrumb files).
//
// Phase-3 scope (pure-store / no real claude.exe required):
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
// Phase-4 absorption (#223 per-case capability rollout — bucket 3):
//   Cases below use the new `userDataDir: 'fresh'`, `relaunch`,
//   `requiresClaudeBin`, and `preMain` capabilities. First production use of
//   the harness-runner cap surface — bucket 4 (harness-restore) waits on this
//   to verify the contract is stable.
//
//   - permission-allow-bash             fresh + requiresClaudeBin
//   - permission-allow-write            fresh + requiresClaudeBin
//   - permission-allow-parallel-batch   fresh + requiresClaudeBin
//   - ipc-unc-rejection                 (shared launch — pure IPC contract)
//   - jsonl-filename-matches-session    fresh + requiresClaudeBin
//   - askuserquestion-no-dup-and-resolves  preMain (ipcMain stubs)
//   - env-passthrough                   fresh + requiresClaudeBin (skips on no auth env)
//   - connection-pane                   fresh + preMain (HOME/USERPROFILE override)
//
// Probes deferred to bucket 4 (multi-launch with state hand-off):
//   - permission-prompt-default-mode (seed-via-saveState then close+relaunch)
//   - askuserquestion-full           (3-launch lifecycle)
//
// Run: `node scripts/harness-perm.mjs`
// Run one case: `node scripts/harness-perm.mjs --only=permission-prompt`

import { runHarness } from './probe-helpers/harness-runner.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Spec-wide CLAUDE_CONFIG_DIR sandbox — shared across all cases that need a
// real `claude` subprocess. Empty allowlist + copied credentials so the dev's
// real `~/.claude/settings.json` allowlist can't auto-allow the tool calls
// we're trying to test. Allow-list state inside the renderer (`allowAlwaysTools`)
// is reset by per-case `userDataDir: 'fresh'`; this sandbox handles the
// CLI-side allowlist orthogonally.
const HARNESS_CONFIG_DIR = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-perm-cfg-'));
  // Inherit the `env` block from real settings.json (ANTHROPIC_BASE_URL etc.)
  // and ALWAYS empty allowlist.
  const sandbox = { permissions: { allow: [], deny: [] } };
  try {
    const realSettings = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(realSettings)) {
      const raw = JSON.parse(fs.readFileSync(realSettings, 'utf8'));
      if (raw && typeof raw === 'object' && raw.env && typeof raw.env === 'object') {
        sandbox.env = raw.env;
      }
    }
  } catch { /* ignore */ }
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(sandbox, null, 2), 'utf8');
  // Inherit credentials so spawned CLI can authenticate.
  const realCreds = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(realCreds)) {
    try { fs.copyFileSync(realCreds, path.join(dir, '.credentials.json')); } catch {}
  }
  // Best-effort cleanup at process exit — runner doesn't expose a post-run hook.
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return dir;
})();

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

// ---------- cap-setup-before-i18n-pin (capability demo) ----------
// Demonstrates `setupBefore`: per-case renderer-side hook. Pins i18n to
// English BEFORE the case body so an English-anchored assertion is
// deterministic regardless of OS locale or earlier-case mutations. Mirrors
// the inline pattern at the top of casePermissionAutoAndTitles, but lifted
// into a reusable hook.
async function caseSetupBeforeI18nPin({ win, log }) {
  const lang = await win.evaluate(() => window.__ccsmI18n?.language ?? null);
  if (lang !== 'en') {
    throw new Error(`expected setupBefore to pin i18n to 'en', got ${lang}`);
  }
  // Confirm a known en string resolves so we know i18n actually responded.
  const sample = await win.evaluate(() => window.__ccsmI18n?.t?.('statusBar.modeAutoLabel'));
  if (sample !== 'Auto') {
    throw new Error(`expected i18n.t('statusBar.modeAutoLabel')='Auto' under en, got ${JSON.stringify(sample)}`);
  }
  log('setupBefore pinned i18n to en; English-anchored key resolves');
}

// =============================================================================
// Phase-4 absorbed cases (#223 capability rollout — bucket 3).
// Each case below corresponds 1:1 to a deleted probe-e2e-*.mjs file.
// =============================================================================

// ---------- shared helpers for absorbed cases ----------

/**
 * Wait for a renderer Allow button to appear, click it, optionally observing
 * the underlying tool name via the store. Used by the Bug-L family.
 */
async function clickAllowOnce(win) {
  const visible = await win.locator('[data-perm-action="allow"]').first()
    .isVisible({ timeout: 200 }).catch(() => false);
  if (visible) {
    await win.locator('[data-perm-action="allow"]').first().click().catch(() => {});
    return true;
  }
  return false;
}

/**
 * Drive a New Session click + cwd seed. The harness boot does NOT auto-select
 * a session, so each absorbed claude-spawn case must press the button itself.
 */
async function newSessionWithCwd(win, cwd) {
  await win.getByRole('button', { name: /new session/i }).first().click();
  await win.waitForTimeout(1000);
  await win.evaluate((p) => {
    const st = window.__ccsmStore?.getState?.();
    if (st && typeof st.changeCwd === 'function') st.changeCwd(p);
  }, cwd);
  await win.waitForTimeout(400);
}

// ---------- permission-allow-bash ----------
// Was: probe-e2e-permission-allow-bash.mjs.
// Asserts: clicking Allow on a Bash permission prompt actually delivers the
// nested control_response envelope to claude.exe (Bug L) AND the PreToolUse
// hook (#94 fix) defers Bash to canUseTool so the prompt fires at all.
async function casePermissionAllowBash({ win, log }) {
  const TS = new Date().toISOString().replace(/[:.]/g, '-');
  const proj = path.join(os.tmpdir(), `ccsm-harness-perm-bash-proj-${TS}`);
  fs.mkdirSync(proj, { recursive: true });
  await newSessionWithCwd(win, proj);

  const PROMPT = 'Run the bash command `node --version` and tell me the version number.';
  const ta = win.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 8000 });
  await ta.click();
  await ta.fill(PROMPT);
  await win.keyboard.press('Enter');
  log('prompt sent');

  const waitDl = Date.now() + 90_000;
  let allowClicked = false;
  let storeHit = null;
  while (Date.now() < waitDl) {
    await win.waitForTimeout(1000);
    if (!allowClicked && await clickAllowOnce(win)) {
      allowClicked = true;
      log('clicked Allow');
    }
    const snap = await win.evaluate(() => {
      const st = window.__ccsmStore?.getState?.();
      const sid = st?.activeId;
      const blocks = st?.messagesBySession?.[sid] || [];
      const b = blocks.find((x) => x.kind === 'tool' && (x.toolName || x.name) === 'Bash');
      return b ? {
        hasResult: typeof b.result === 'string' && b.result.length > 0,
        isError: b.isError === true,
        head: typeof b.result === 'string' ? b.result.slice(0, 200) : null,
      } : null;
    }).catch(() => null);
    if (snap?.hasResult) { storeHit = snap; break; }
  }

  if (!storeHit) throw new Error('Bash tool block never received tool_result (Bug L regression)');
  if (storeHit.isError) throw new Error(`Bash tool returned error: ${storeHit.head}`);
  if (!allowClicked) throw new Error('Allow button never rendered — PreToolUse hook (#94) regression');
  log(`OK: bash executed, tool_result delivered`);
}

// ---------- permission-allow-write ----------
// Was: probe-e2e-permission-allow-write.mjs.
// Same Bug L assertion via the Write tool: clicking Allow must actually let
// the file land on disk AND the tool_result must reach the renderer.
async function casePermissionAllowWrite({ win, log }) {
  const TS = new Date().toISOString().replace(/[:.]/g, '-');
  const proj = path.join(os.tmpdir(), `ccsm-harness-perm-write-proj-${TS}`);
  fs.mkdirSync(proj, { recursive: true });
  await newSessionWithCwd(win, proj);

  const PROMPT = "Use the Write tool to create a NEW file at ./hello.txt with exactly the content 'world' (no trailing newline). Do not use Edit or MultiEdit.";
  const ta = win.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 8000 });
  await ta.click();
  await ta.fill(PROMPT);
  await win.keyboard.press('Enter');
  log('prompt sent');

  const filePath = path.join(proj, 'hello.txt');
  const WRITE_LIKE = new Set(['Write', 'Edit', 'MultiEdit']);
  const dl = Date.now() + 90_000;
  let firstAllowAt = null;
  let fsHit = null;
  let storeHit = null;
  while (Date.now() < dl) {
    await win.waitForTimeout(1000);
    if (await clickAllowOnce(win)) {
      if (!firstAllowAt) firstAllowAt = Date.now();
      log('clicked Allow');
      await win.waitForTimeout(400);
    }
    if (!fsHit && fs.existsSync(filePath)) {
      fsHit = { content: fs.readFileSync(filePath, 'utf8') };
    }
    const snap = await win.evaluate(() => {
      const st = window.__ccsmStore?.getState?.();
      const sid = st?.activeId;
      const blocks = st?.messagesBySession?.[sid] || [];
      const w = blocks.find((b) => b.kind === 'tool' && ['Write','Edit','MultiEdit'].includes(b.toolName || b.name));
      return w ? {
        hasResult: typeof w.result === 'string' && w.result.length > 0,
        isError: w.isError === true,
        toolName: w.toolName || w.name,
      } : null;
    }).catch(() => null);
    if (!storeHit && snap?.hasResult) storeHit = snap;
    if (fsHit && storeHit) break;
  }

  if (!firstAllowAt) throw new Error('never saw Allow button within 90s');
  if (!fsHit) throw new Error(`Write never executed — file ${filePath} missing`);
  if (fsHit.content.trim() !== 'world') throw new Error(`unexpected content: ${JSON.stringify(fsHit.content)}`);
  if (!storeHit) throw new Error('Write block never received tool_result');
  if (storeHit.isError) throw new Error('Write block returned error');
  log(`OK: file written, tool_result delivered (${storeHit.toolName})`);
}

// ---------- permission-allow-parallel-batch ----------
// Was: probe-e2e-permission-allow-parallel-batch.mjs.
// Two sub-cases (parallel-bash-N4 and parallel-read-N5) preserved as they
// jointly assert the renderer block-id fix + the Bug L IPC envelope fix
// stay alive for both Bash and Read.
async function casePermissionAllowParallelBatch({ win, log }) {
  const TS = new Date().toISOString().replace(/[:.]/g, '-');

  async function runSubCase({ caseName, files, prompt, toolName, expectedClicks, minTools }) {
    log(`-- sub: ${caseName} --`);
    const proj = path.join(os.tmpdir(), `ccsm-harness-perm-par-${caseName}-${TS}`);
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    for (const [i, f] of files.entries()) {
      fs.writeFileSync(path.join(proj, f), `// file-${i}: ${path.basename(f)} placeholder\n`);
    }
    await newSessionWithCwd(win, proj);
    const ta = win.locator('textarea').first();
    await ta.waitFor({ state: 'visible', timeout: 8000 });
    await ta.click();
    const filledPrompt = prompt.replace(/\{\{ABSPATH:([^}]+)\}\}/g, (_, rel) => path.resolve(proj, rel));
    await ta.fill(filledPrompt);
    await win.keyboard.press('Enter');

    const dl = Date.now() + 180_000;
    let clicks = 0;
    let snap = null;
    let lastProgressAt = Date.now();
    const targetN = expectedClicks ?? 0;
    while (Date.now() < dl) {
      await win.waitForTimeout(750);
      if (await clickAllowOnce(win)) {
        clicks += 1;
        lastProgressAt = Date.now();
        log(`[${caseName}] clicked Allow #${clicks}`);
        continue;
      }
      snap = await win.evaluate((tn) => {
        const st = window.__ccsmStore?.getState?.();
        const sid = st?.activeId;
        const blocks = st?.messagesBySession?.[sid] || [];
        const tools = blocks.filter((b) => b.kind === 'tool' && (b.toolName || b.name) === tn)
          .map((b) => ({
            hasResult: typeof b.result === 'string' && b.result.length > 0,
            isError: b.isError === true,
          }));
        const resolvedTraces = blocks.filter((b) =>
          b.kind === 'system' && b.subkind === 'permission-resolved' &&
          (b.decision === 'allowed' || b.decision === 'allow')).length;
        return { tools, resolvedTraces, totalBlocks: blocks.length };
      }, toolName).catch(() => null);
      const succeeded = snap?.tools.filter((t) => t.hasResult).length ?? 0;
      const reqN = targetN || minTools || 1;
      if (snap && snap.tools.length >= reqN && succeeded >= reqN) break;
      if (succeeded > 0 && Date.now() - lastProgressAt > 12_000) break;
      if (succeeded > 0) lastProgressAt = Date.now();
    }
    if (!snap) throw new Error(`[${caseName}] could not snapshot store`);
    if (expectedClicks && clicks !== expectedClicks) {
      throw new Error(`[${caseName}] expected ${expectedClicks} Allow clicks, got ${clicks}`);
    }
    if (snap.resolvedTraces < clicks) {
      throw new Error(`[${caseName}] clicked Allow ${clicks}x but only ${snap.resolvedTraces} resolved traces`);
    }
    const ttarget = expectedClicks ?? Math.max(clicks, minTools ?? 0);
    if (snap.tools.length < ttarget) {
      throw new Error(`[${caseName}] expected >=${ttarget} ${toolName} blocks, got ${snap.tools.length}`);
    }
    const succeeded = snap.tools.filter((t) => t.hasResult);
    if (succeeded.length < ttarget) {
      throw new Error(`[${caseName}] expected >=${ttarget} blocks with tool_result, got ${succeeded.length}`);
    }
    if (snap.tools.some((t) => t.isError)) {
      throw new Error(`[${caseName}] one or more ${toolName} blocks errored`);
    }
    log(`[${caseName}] OK: ${clicks} clicks, ${succeeded.length}/${ttarget} results`);
  }

  await runSubCase({
    caseName: 'parallel-bash-N4',
    files: ['a.txt', 'b.txt', 'c.txt', 'd.txt'],
    prompt: 'Run these four bash commands IN PARALLEL in a SINGLE message containing FOUR tool_use blocks: `cat a.txt`, `cat b.txt`, `cat c.txt`, `cat d.txt`. Do NOT serialize. Emit all four Bash tool_use blocks in the SAME assistant message.',
    toolName: 'Bash',
    expectedClicks: 4,
  });

  await runSubCase({
    caseName: 'parallel-read-N5',
    files: ['README.md', 'package.json', 'src/strings.js', 'src/math.js', 'src/cart.js'],
    prompt:
      'Use the Read tool to read the following files IN PARALLEL — emit FIVE Read tool_use blocks in a SINGLE assistant message. Do NOT serialize.\n\n' +
      'IMPORTANT: the Read tool requires ABSOLUTE file paths. Use these exact absolute paths (already on disk):\n' +
      '- {{ABSPATH:README.md}}\n- {{ABSPATH:package.json}}\n- {{ABSPATH:src/strings.js}}\n- {{ABSPATH:src/math.js}}\n- {{ABSPATH:src/cart.js}}\n',
    toolName: 'Read',
    minTools: 4, // model occasionally folds; tolerate 4-5
  });

  log('OK: parallel batches deliver every tool_result');
}

// ---------- ipc-unc-rejection ----------
// Was: probe-e2e-ipc-unc-rejection.mjs.
// Pure renderer-IPC contract — runs on the shared launch.
async function caseIpcUncRejection({ win, log }) {
  const benign = process.platform === 'win32' ? 'C:\\Windows' : '/tmp';
  const benignExists = fs.existsSync(benign);
  const result = await win.evaluate(async ({ benign }) => {
    const uncWin = '\\\\evil-host\\share\\probe';
    const uncPosix = '//evil-host/share/probe';
    const relativ = 'relative/path';
    const pathsRes = await window.ccsm.pathsExist([uncWin, uncPosix, relativ, benign]);
    const cmdsUnc = await window.ccsm.commands.list(uncWin);
    const cmdsPosixUnc = await window.ccsm.commands.list(uncPosix);
    return { pathsRes, cmdsUnc, cmdsPosixUnc };
  }, { benign });

  const uncWin = '\\\\evil-host\\share\\probe';
  const uncPosix = '//evil-host/share/probe';
  const relativ = 'relative/path';
  if (result.pathsRes[uncWin] !== false) throw new Error(`paths:exist UNC win expected false, got ${result.pathsRes[uncWin]}`);
  if (result.pathsRes[uncPosix] !== false) throw new Error(`paths:exist UNC posix expected false`);
  if (result.pathsRes[relativ] !== false) throw new Error(`paths:exist relative expected false`);
  if (result.pathsRes[benign] !== benignExists) throw new Error(`paths:exist benign mismatch (over-eager guard?)`);
  if (!Array.isArray(result.cmdsUnc) || result.cmdsUnc.length !== 0) throw new Error(`commands:list UNC expected []`);
  if (!Array.isArray(result.cmdsPosixUnc) || result.cmdsPosixUnc.length !== 0) throw new Error(`commands:list // UNC expected []`);
  log('UNC inputs rejected before fs');
}

// ---------- jsonl-filename-matches-session ----------
// Was: probe-e2e-jsonl-filename-matches-session.mjs.
// Asserts PR-D contract: SDK respects sessionId option (positive case) AND
// rejects malformed presets via defence-in-depth gate (negative case).
async function caseJsonlFilenameMatchesSession({ win, log }) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const POSITIVE_SID = 'b2c0d000-0000-4000-8000-000000000001';
  const NEGATIVE_RUNNER_SID = 'b2c0d000-0000-4000-8000-000000000002';
  const NEGATIVE_BAD_PRESET = 's-bad-not-a-uuid';

  const PROBE_TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-jsonl-cwd-'));
  const POSITIVE_CWD = path.join(PROBE_TMP_BASE, 'positive');
  const NEGATIVE_CWD = path.join(PROBE_TMP_BASE, 'negative');
  fs.mkdirSync(POSITIVE_CWD, { recursive: true });
  fs.mkdirSync(NEGATIVE_CWD, { recursive: true });
  const projectsRoot = path.join(HARNESS_CONFIG_DIR, 'projects');
  const createdProjectDirs = new Set();

  function findJsonlFor(sid) {
    let dirs;
    try { dirs = fs.readdirSync(projectsRoot); } catch { return null; }
    for (const dir of dirs) {
      const candidate = path.join(projectsRoot, dir, `${sid}.jsonl`);
      if (fs.existsSync(candidate)) return { file: candidate, projectDir: dir };
    }
    return null;
  }
  function scanProjectsForCwdSegment(seg) {
    const out = [];
    let dirs;
    try { dirs = fs.readdirSync(projectsRoot); } catch { return out; }
    for (const dir of dirs) {
      if (!dir.includes(seg)) continue;
      let entries;
      try { entries = fs.readdirSync(path.join(projectsRoot, dir)); } catch { continue; }
      for (const f of entries) {
        if (f.endsWith('.jsonl')) out.push({ file: path.join(projectsRoot, dir, f), projectDir: dir });
      }
    }
    return out;
  }

  try {
    await win.evaluate(() => {
      window.__probeDiag = [];
      window.ccsm.onAgentDiagnostic((d) => window.__probeDiag.push(d));
    });

    // ── POSITIVE ──
    await win.evaluate(({ sid, cwd }) => {
      window.__ccsmStore.setState({
        groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
        sessions: [{ id: sid, name: 'jsonl-pos', state: 'idle', cwd, model: 'claude-sonnet-4', groupId: 'g1', agentType: 'claude-code' }],
        activeId: sid,
        messagesBySession: { [sid]: [] },
        startedSessions: {},
        runningSessions: {},
      });
    }, { sid: POSITIVE_SID, cwd: POSITIVE_CWD });

    const startRes = await win.evaluate(async ({ sid, cwd }) =>
      await window.ccsm.agentStart(sid, { cwd, permissionMode: 'default', sessionId: sid }),
      { sid: POSITIVE_SID, cwd: POSITIVE_CWD });
    if (!startRes || startRes.ok !== true) {
      throw new Error(`positive agentStart failed: ${JSON.stringify(startRes)}`);
    }
    await win.evaluate(async (sid) => await window.ccsm.agentSend(sid, 'hi'), POSITIVE_SID);

    const activeIdAfter = await win.evaluate(() => window.__ccsmStore.getState().activeId);
    if (activeIdAfter !== POSITIVE_SID) throw new Error(`store.activeId drifted: ${activeIdAfter}`);

    let positiveHit = null;
    const flushDl = Date.now() + 30_000;
    while (Date.now() < flushDl) {
      positiveHit = findJsonlFor(POSITIVE_SID);
      if (positiveHit) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!positiveHit) throw new Error(`positive: no <projectKey>/${POSITIVE_SID}.jsonl appeared in 30s`);
    createdProjectDirs.add(positiveHit.projectDir);

    const buf = fs.readFileSync(positiveHit.file, 'utf8');
    const firstLines = buf.split(/\r?\n/).slice(0, 50);
    let foundIdBearing = 0;
    let mismatch = null;
    for (const line of firstLines) {
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const id = parsed?.sessionId ?? parsed?.session_id;
      if (typeof id !== 'string') continue;
      foundIdBearing++;
      if (id !== POSITIVE_SID) { mismatch = { id, line: line.slice(0, 200) }; break; }
    }
    if (foundIdBearing === 0) throw new Error('positive: no id-bearing records in first 50 lines');
    if (mismatch) throw new Error(`positive: jsonl record id=${mismatch.id} != filename ${POSITIVE_SID}`);
    log(`positive jsonl=${path.relative(projectsRoot, positiveHit.file)}, ${foundIdBearing} ids match`);

    await win.evaluate(async (sid) => await window.ccsm.agentClose(sid), POSITIVE_SID);
    await new Promise((r) => setTimeout(r, 500));

    // ── NEGATIVE ──
    await win.evaluate(({ sid, cwd }) => {
      window.__ccsmStore.setState({
        sessions: [{ id: sid, name: 'jsonl-neg', state: 'idle', cwd, model: 'claude-sonnet-4', groupId: 'g1', agentType: 'claude-code' }],
        activeId: sid,
        messagesBySession: { [sid]: [] },
        startedSessions: {},
        runningSessions: {},
      });
      window.__probeDiag.length = 0;
    }, { sid: NEGATIVE_RUNNER_SID, cwd: NEGATIVE_CWD });

    const negStart = await win.evaluate(async ({ sid, badPreset, cwd }) =>
      await window.ccsm.agentStart(sid, { cwd, permissionMode: 'default', sessionId: badPreset }),
      { sid: NEGATIVE_RUNNER_SID, badPreset: NEGATIVE_BAD_PRESET, cwd: NEGATIVE_CWD });
    if (!negStart || negStart.ok !== true) {
      throw new Error(`negative: agentStart failed unexpectedly: ${JSON.stringify(negStart)}`);
    }
    await win.evaluate(async (sid) => await window.ccsm.agentSend(sid, 'hi'), NEGATIVE_RUNNER_SID);

    let negDiag = null;
    const diagDl = Date.now() + 5_000;
    while (Date.now() < diagDl) {
      const diags = await win.evaluate((sid) =>
        (window.__probeDiag || []).filter((d) => d?.sessionId === sid && d?.code === 'preset_session_id_invalid'),
        NEGATIVE_RUNNER_SID);
      if (diags.length > 0) { negDiag = diags[0]; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!negDiag) throw new Error(`negative: no 'preset_session_id_invalid' diagnostic emitted`);

    await new Promise((r) => setTimeout(r, 5_000));
    const negFiles = scanProjectsForCwdSegment(path.basename(NEGATIVE_CWD));
    if (negFiles.length === 0) throw new Error(`negative: no jsonl found for cwd 'negative'`);
    for (const f of negFiles) createdProjectDirs.add(f.projectDir);
    for (const f of negFiles) {
      const sid = path.basename(f.file, '.jsonl');
      if (sid === NEGATIVE_RUNNER_SID) throw new Error(`negative: jsonl named after runner id (binding leaked)`);
      if (sid === NEGATIVE_BAD_PRESET) throw new Error(`negative: jsonl named after bad preset (SDK accepted it)`);
      if (!UUID_RE.test(sid)) throw new Error(`negative: filename ${sid} not UUID-shaped`);
    }
    log(`negative: ${negFiles.length} jsonl(s), all UUID-shaped, none == runner/bad-preset`);

    await win.evaluate(async (sid) => await window.ccsm.agentClose(sid), NEGATIVE_RUNNER_SID);
  } finally {
    try { fs.rmSync(PROBE_TMP_BASE, { recursive: true, force: true }); } catch {}
    for (const dir of createdProjectDirs) {
      try { fs.rmSync(path.join(projectsRoot, dir), { recursive: true, force: true }); } catch {}
    }
  }
}

// ---------- bypass-mid-session-toggle ----------
// Regression for the "Agent unresponsive" toast users hit when clicking the
// bypassPermissions chip on a session launched in default mode. Root cause
// (eval doc bypass-perm-eval-2026-04-26.md): the bundled CLI's
// setPermissionMode handler refuses transitions INTO bypassPermissions
// unless the session was started with --dangerously-skip-permissions. ccsm
// previously only sent that flag when the INITIAL mode was bypass, so any
// runtime upgrade was silently rejected and surfaced as a vague timeout
// diagnostic. Fix: always pass allowDangerouslySkipPermissions:true at
// launch (sessions.ts:391); the SDK gate is one-way so this is harmless
// when the active mode isn't bypass.
//
// Forward verification: start a real SDK session in default mode, toggle
// to bypass via IPC, assert ok:true. Toggle back to default to confirm
// downgrade still works. Reverse-verified manually by reverting the
// conditional flag — the case fails with `{ ok:false, error:'... was not
// launched ...' }` from the rethrown SDK rejection.
async function caseBypassMidSessionToggle({ win, log }) {
  const TS = Date.now();
  const SID = `b3c0d000-0000-4000-8000-${String(TS).padStart(12, '0').slice(-12)}`;
  const PROBE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-bypass-mid-'));

  try {
    await win.evaluate(({ sid, cwd }) => {
      window.__ccsmStore.setState({
        groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
        sessions: [{ id: sid, name: 'bypass-mid', state: 'idle', cwd, model: 'claude-sonnet-4', groupId: 'g1', agentType: 'claude-code' }],
        activeId: sid,
        messagesBySession: { [sid]: [] },
        startedSessions: {},
        runningSessions: {},
      });
    }, { sid: SID, cwd: PROBE_TMP });

    // 1. Start in default mode — the failure case before the fix.
    const startRes = await win.evaluate(async ({ sid, cwd }) =>
      await window.ccsm.agentStart(sid, { cwd, permissionMode: 'default', sessionId: sid }),
      { sid: SID, cwd: PROBE_TMP });
    if (!startRes || startRes.ok !== true) {
      throw new Error(`agentStart(default) failed: ${JSON.stringify(startRes)}`);
    }
    log('session started in default mode');

    // Brief settle so the SDK init handshake completes before the runtime
    // mode change (matches what a real user toggling the chip looks like).
    await win.waitForTimeout(500);

    // 2. Toggle to bypassPermissions — pre-fix this rejected with
    //    "session was not launched with --dangerously-skip-permissions".
    const upRes = await win.evaluate(async (sid) =>
      await window.ccsm.agentSetPermissionMode(sid, 'bypassPermissions'), SID);
    if (!upRes || upRes.ok !== true) {
      throw new Error(`agentSetPermissionMode(bypass) expected ok:true, got ${JSON.stringify(upRes)}`);
    }
    log('default → bypass accepted');

    // 3. Toggle back to default — should always succeed (downgrade is
    //    ungated by the SDK).
    const downRes = await win.evaluate(async (sid) =>
      await window.ccsm.agentSetPermissionMode(sid, 'default'), SID);
    if (!downRes || downRes.ok !== true) {
      throw new Error(`agentSetPermissionMode(default) expected ok:true, got ${JSON.stringify(downRes)}`);
    }
    log('bypass → default accepted');

    await win.evaluate(async (sid) => await window.ccsm.agentClose(sid), SID);
  } finally {
    try { fs.rmSync(PROBE_TMP, { recursive: true, force: true }); } catch {}
  }
}

// ---------- askuserquestion-no-dup-and-resolves ----------
// Was: probe-e2e-askuserquestion-no-dup-and-resolves.mjs.
// preMain installs ipcMain stubs to capture resolvePermission + send calls
// without spawning real claude.exe. After the case, registerDispose restores
// (the next case's userDataDir/launch handles cleanup of the override here
// since the IPC handlers are global-process state — see preMain restore
// pattern in harness-runner doc).
async function caseAskUserQuestionNoDupAndResolves({ app, win, log }) {
  const sessionId = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    if (s.activeId && s.sessions.some((x) => x.id === s.activeId)) return s.activeId;
    s.createSession({ name: 'no-dup-probe' });
    return window.__ccsmStore.getState().activeId;
  });
  await win.evaluate((sid) => window.__ccsmStore.getState().setRunning(sid, true), sessionId);

  // J1: same requestId duplicate
  const Q1 = [{ question: 'Pick a stack', options: [{ label: 'TypeScript' }, { label: 'Rust' }, { label: 'Go' }] }];
  await win.evaluate(({ sid, q }) => {
    const store = window.__ccsmStore.getState();
    store.appendBlocks(sid, [{ kind: 'question', id: 'q-perm-J1', requestId: 'perm-J1', questions: q }]);
    store.appendBlocks(sid, [{ kind: 'question', id: 'q-perm-J1-DUP', requestId: 'perm-J1', questions: q }]);
  }, { sid: sessionId, q: Q1 });

  await win.waitForSelector('[data-question-option]', { timeout: 5000 });
  await win.waitForTimeout(150);

  const j1 = await win.evaluate(() => ({
    groups: document.querySelectorAll('[role="radiogroup"], [role="group"]').length,
    opts: document.querySelectorAll('[data-question-option]').length,
  }));
  if (j1.groups !== 1) throw new Error(`J1: expected 1 question card, got ${j1.groups} (opts=${j1.opts})`);
  const storeQ1 = await win.evaluate((sid) => (window.__ccsmStore.getState().messagesBySession[sid] || [])
    .filter((b) => b.kind === 'question').length, sessionId);
  if (storeQ1 !== 1) throw new Error(`J1: expected 1 question block in store, got ${storeQ1}`);

  await win.locator('[data-question-option][data-question-label="TypeScript"]').first().click();
  await win.waitForTimeout(120);
  const submit = win.locator('[data-testid="question-submit"]');
  if (await submit.isDisabled()) throw new Error('J1: Submit disabled after pick — block was rendered as duplicate/read-only');
  await submit.click();
  await win.waitForTimeout(400);

  const captured = await app.evaluate(() => ({
    resolved: global.__probeNoDup.resolved.slice(),
    sent: global.__probeNoDup.sent.slice(),
  }));
  if (captured.resolved.length !== 1) throw new Error(`J1: expected 1 resolvePermission, got ${captured.resolved.length}`);
  if (captured.resolved[0].requestId !== 'perm-J1' || captured.resolved[0].decision !== 'deny') {
    throw new Error(`J1: wrong resolve payload: ${JSON.stringify(captured.resolved[0])}`);
  }
  if (captured.sent.length !== 1) throw new Error(`J1: expected 1 agentSend, got ${captured.sent.length}`);
  if (!/TypeScript/.test(captured.sent[0].text || '')) throw new Error(`J1: agentSend missing TypeScript: ${JSON.stringify(captured.sent[0])}`);

  // simulate lifecycle drop
  await win.evaluate((sid) => window.__ccsmStore.getState().setRunning(sid, false), sessionId);
  const stillRunning = await win.evaluate((sid) => !!window.__ccsmStore.getState().runningSessions[sid], sessionId);
  if (stillRunning) throw new Error('J1: runningSessions[sid] still true after setRunning(false)');

  // J2: same toolUseId duplicate
  await win.evaluate((sid) => window.__ccsmStore.getState().clearMessages(sid), sessionId);
  await app.evaluate(() => { global.__probeNoDup.resolved.length = 0; global.__probeNoDup.sent.length = 0; });
  await win.waitForTimeout(120);

  const Q2 = [{ question: 'Pick a build tool', options: [{ label: 'esbuild' }, { label: 'rollup' }] }];
  await win.evaluate(({ sid, q }) => {
    const store = window.__ccsmStore.getState();
    store.appendBlocks(sid, [{ kind: 'question', id: 'q-J2-A', toolUseId: 'tu-J2', questions: q }]);
    store.appendBlocks(sid, [{ kind: 'question', id: 'q-J2-B', toolUseId: 'tu-J2', questions: q }]);
  }, { sid: sessionId, q: Q2 });
  await win.waitForSelector('[data-question-option]', { timeout: 5000 });
  await win.waitForTimeout(150);

  const groupsJ2 = await win.evaluate(() => document.querySelectorAll('[role="radiogroup"], [role="group"]').length);
  const storeQ2 = await win.evaluate((sid) => (window.__ccsmStore.getState().messagesBySession[sid] || [])
    .filter((b) => b.kind === 'question').length, sessionId);
  if (groupsJ2 !== 1) throw new Error(`J2: expected 1 card for same-toolUseId duplicate, got ${groupsJ2}`);
  if (storeQ2 !== 1) throw new Error(`J2: expected 1 question block in store, got ${storeQ2}`);

  log('AskUserQuestion dedup + resolve routing locked down');
}

// ---------- askuserquestion-routes-via-permission-request ----------
// Regression for: "agent invoked AskUserQuestion but no question card showed
// up in the UI". The SDK runner used to short-circuit PASSTHROUGH_TOOLS in
// canUseTool / PreToolUse to `behavior: 'allow'`, which skipped
// onPermissionRequest entirely. Result: SDK got synthetic allow with empty
// input, no `agent:permissionRequest` IPC frame ever fired, no question card
// ever mounted, and the agent received an empty tool_result body.
//
// This case asserts the IPC frame the renderer relies on actually mounts a
// question card. We send the frame directly from main's webContents to skip
// the cost of spawning real claude and getting the model to call AskUser-
// Question — but the renderer-side wiring (lifecycle.ts permissionRequest →
// permissionRequestToWaitingBlock → store.appendBlocks → QuestionStickyHost)
// is exercised end-to-end exactly as it would be from a real SDK call.
//
// If the SDK runner regresses to swallowing PASSTHROUGH_TOOLS, the unit
// test in electron/agent-sdk/__tests__/sessions.test.ts catches the SDK side;
// this case catches the renderer-IPC side.
async function caseAskUserQuestionRoutesViaPermissionRequest({ app, win, log }) {
  const sessionId = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    if (s.activeId && s.sessions.some((x) => x.id === s.activeId)) return s.activeId;
    s.createSession({ name: 'aq-route-probe' });
    return window.__ccsmStore.getState().activeId;
  });
  // Simulate "agent is running" so the renderer doesn't reject the in-flight
  // permission frame as orphaned.
  await win.evaluate((sid) => window.__ccsmStore.getState().setRunning(sid, true), sessionId);

  const REQUEST_ID = 'perm-aq-route-1';
  const QUESTION = 'Pick a color';
  // Emit the IPC frame the SDK runner's onPermissionRequest path produces.
  // Mirrors manager.ts L146: `this.emit('agent:permissionRequest', { sessionId, ...req })`.
  await app.evaluate(({ BrowserWindow }, payload) => {
    const wcs = BrowserWindow.getAllWindows().map((w) => w.webContents);
    for (const wc of wcs) {
      if (!wc.isDestroyed()) wc.send('agent:permissionRequest', payload);
    }
  }, {
    sessionId,
    requestId: REQUEST_ID,
    toolName: 'AskUserQuestion',
    input: {
      questions: [
        { question: QUESTION, options: [{ label: 'red' }, { label: 'blue' }] },
      ],
    },
  });

  // Question card MUST mount. Before the fix nothing rendered — the
  // PASSTHROUGH short-circuit skipped onPermissionRequest, so this IPC frame
  // never fired in production and the bug went undetected by every existing
  // probe (all of which inject blocks directly into the store).
  await win.waitForSelector('[data-question-sticky] [data-question-option]', { timeout: 5000 });

  const observed = await win.evaluate(({ sid, q }) => {
    const blocks = window.__ccsmStore.getState().messagesBySession[sid] || [];
    const qb = blocks.find((b) => b.kind === 'question');
    return {
      hasQuestionBlock: !!qb,
      requestId: qb?.requestId,
      firstQuestion: qb?.questions?.[0]?.question,
      optionCount: qb?.questions?.[0]?.options?.length,
      domQuestionText: document.querySelector('[data-question-sticky]')?.innerText?.includes(q) ?? false,
      genericPermBlock: blocks.some((b) => b.kind === 'waiting' && b.toolName === 'AskUserQuestion'),
    };
  }, { sid: sessionId, q: QUESTION });

  if (!observed.hasQuestionBlock) throw new Error('expected question block in store, got none');
  if (observed.requestId !== REQUEST_ID) throw new Error(`requestId not threaded into block: got ${observed.requestId}`);
  if (observed.firstQuestion !== QUESTION) throw new Error(`question text mismatch: ${observed.firstQuestion}`);
  if (observed.optionCount !== 2) throw new Error(`expected 2 options, got ${observed.optionCount}`);
  if (!observed.domQuestionText) throw new Error('question text not visible in QuestionStickyHost DOM');
  if (observed.genericPermBlock) throw new Error('AskUserQuestion fell through to generic waiting/permission block — parseQuestions failed?');

  log('AskUserQuestion permission-request frame mounts a question card');
}

// ---------- env-passthrough ----------
// Was: probe-e2e-env-passthrough.mjs.
// Auth env (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN) flows through
// buildSpawnEnv to claude.exe. Skips when neither is set in the parent env
// (treated as inability to test, not a failure).
async function caseEnvPassthrough({ win, log }) {
  const hasAuth =
    (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0) ||
    (process.env.ANTHROPIC_AUTH_TOKEN && process.env.ANTHROPIC_AUTH_TOKEN.length > 0);
  if (!hasAuth) {
    log('SKIP: neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN in parent env');
    return;
  }
  const PROMPT = 'Reply with exactly the single word OK and nothing else.';

  const newBtn = win.getByRole('button', { name: /new session/i }).first();
  await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await newBtn.click();
  const ta = win.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 5000 });
  await ta.click();
  await ta.fill(PROMPT);
  await win.keyboard.press('Enter');

  const dl = Date.now() + 60_000;
  let assistantSeen = false;
  let lastDump = '';
  while (Date.now() < dl) {
    const snap = await win.evaluate(() => {
      const m = document.querySelector('main');
      return m ? m.innerText : '';
    });
    lastDump = snap;
    if (/not logged in/i.test(snap) || /please run .*\/login/i.test(snap)) {
      throw new Error(`"Not logged in" banner — env did not reach claude.exe: ${snap.slice(0, 500)}`);
    }
    const idx = snap.indexOf(PROMPT);
    const after = idx >= 0 ? snap.slice(idx + PROMPT.length) : snap;
    if (/\bOK\b/i.test(after) && after.trim().length > 2) { assistantSeen = true; break; }
    await win.waitForTimeout(500);
  }
  if (!assistantSeen) throw new Error(`no assistant "OK" reply within 60s. Last dump: ${lastDump.slice(0, 500)}`);
  log('OK: assistant replied, env passthrough working');
}

// ---------- connection-pane ----------
// Was: probe-e2e-connection-pane.mjs.
// preMain swaps process.env.HOME/USERPROFILE so the IPC handler's
// `os.homedir()` resolves to a fresh fixture dir. The connection IPC reads
// settings.json on demand, so the swap takes effect before the case clicks
// the Settings button. Cleanup via registerDispose restores HOME/USERPROFILE
// (defensive — fresh-userData relaunch isolates from later cases anyway).
async function caseConnectionPane({ win, log, registerDispose }) {
  // The fixture file path must match what preMain created. We read the
  // path back from the main process via a side channel (process.env).
  const FIXTURE_BASE_URL = 'https://probe.example.com/v1';
  const FIXTURE_MODEL = 'claude-probe-fixture-1';
  const FIXTURE_TOKEN = 'sk-ant-PROBE-DO-NOT-LEAK-1234567890';

  const sidebarBtn = win.getByRole('button', { name: /^settings$/i }).first();
  await sidebarBtn.waitFor({ state: 'visible', timeout: 5000 });
  await sidebarBtn.click();
  const dialog = win.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 3000 });

  const connectionTab = dialog.getByRole('tab', { name: /^connection$/i });
  await connectionTab.click();
  const pane = win.locator('[data-connection-pane]');
  await pane.waitFor({ state: 'visible', timeout: 3000 });

  const baseUrlEl = win.locator('[data-connection-base-url]');
  await baseUrlEl.waitFor({ state: 'visible', timeout: 3000 });
  await win.waitForFunction((expected) => {
    const el = document.querySelector('[data-connection-base-url]');
    return el?.textContent?.includes(expected) ?? false;
  }, FIXTURE_BASE_URL, { timeout: 5000 }).catch(async () => {
    const got = await baseUrlEl.innerText().catch(() => '<unavailable>');
    throw new Error(`base URL did not render fixture: got ${got.slice(0, 200)}`);
  });

  const modelText = await win.locator('[data-connection-model]').innerText();
  if (!modelText.includes(FIXTURE_MODEL)) throw new Error(`model fixture mismatch: ${modelText.slice(0, 200)}`);

  const configured = await dialog.getByText(/^configured$/i).first().isVisible().catch(() => false);
  if (!configured) throw new Error('expected "Configured" status for auth token');

  const screamingBadges = await win.evaluate(() => {
    const list = document.querySelector('[data-connection-models]');
    if (!list) return [];
    const offenders = [];
    list.querySelectorAll('*').forEach((el) => {
      const txt = (el.textContent || '').trim();
      if (!txt || el.children.length > 0) return;
      const tt = window.getComputedStyle(el).textTransform;
      if (tt === 'uppercase') offenders.push(`${el.tagName}: ${txt.slice(0, 60)}`);
    });
    return offenders;
  });
  if (screamingBadges.length > 0) throw new Error(`uppercase text in discovered-models: ${screamingBadges.join(', ')}`);

  const fullText = await win.evaluate(() => document.body.innerText);
  if (fullText.includes(FIXTURE_TOKEN)) throw new Error('FIXTURE_TOKEN leaked into DOM');
  const fullHtml = await win.evaluate(() => document.documentElement.outerHTML);
  if (fullHtml.includes(FIXTURE_TOKEN)) throw new Error('FIXTURE_TOKEN found in outerHTML');

  const openBtn = win.locator('[data-connection-open-file]');
  await openBtn.waitFor({ state: 'visible', timeout: 2000 });
  if (await openBtn.isDisabled()) throw new Error('Open settings.json button starts disabled');
  await openBtn.click();
  await win.waitForFunction(() => {
    const b = document.querySelector('[data-connection-open-file]');
    return !!b && !b.hasAttribute('disabled');
  }, null, { timeout: 5000 });
  const errorMsg = await win
    .locator('[data-connection-open-file] ~ .text-state-error, .text-state-error')
    .filter({ hasText: /\S/ }).first().innerText().catch(() => '');
  if (errorMsg && errorMsg.trim().length > 0) throw new Error(`Open settings.json IPC error: ${errorMsg}`);

  log('OK: settings.json read, no token leak, Open IPC fired');
}

// ---------- permission-focus-returns-to-textarea ----------
// Task #291 part B: after the user resolves a permission prompt (allow / reject),
// keyboard focus should return to the composer textarea so the next keystroke
// types into the chat. PR #357 fixed the *mount* race (Reject focused on
// arrival); this case covers the *response* → textarea contract.
//
// Reproduces the user-reported bug: "permission appears, I press n, focus
// stays on the (now-unmounted) Reject button → next keystroke goes nowhere".
async function casePermissionFocusReturnsToTextarea({ win, log }) {
  await seedSession(win);

  const textarea = win.locator('[data-input-bar]').first();
  await textarea.waitFor({ state: 'visible', timeout: 5_000 });
  // Empty composer — within the existing PermissionPromptBlock contract this
  // means the prompt MAY steal focus on mount (composer-empty exception).
  await textarea.click();
  await textarea.fill('');

  await injectWaiting(win, {
    id: 'wait-FOCUS-RETURN',
    requestId: 'FOCUS-RETURN',
    toolInput: { command: 'echo hi' },
    prompt: 'Bash: echo hi'
  });

  const heading = win.locator('[role="alertdialog"]').first();
  await heading.waitFor({ state: 'visible', timeout: 5_000 });
  // Wait for the autoFocus effect to land on Reject so 'n' is consumed by the
  // global hotkey handler (not by the textarea) — same defensive wait used in
  // casePermissionPrompt.
  await win.waitForFunction(() => {
    const el = document.activeElement;
    return el?.getAttribute?.('data-perm-action') === 'reject';
  }, null, { timeout: 2000 });

  await win.keyboard.press('n');

  try {
    await heading.waitFor({ state: 'detached', timeout: 3_000 });
  } catch {
    throw new Error('permission prompt still visible after pressing N');
  }

  // Wait briefly for the focusInputNonce → InputBar effect to commit.
  await win.waitForFunction(() => {
    const el = document.activeElement;
    return el instanceof HTMLTextAreaElement && el.hasAttribute('data-input-bar');
  }, null, { timeout: 2_000 }).catch(() => {});

  const after = await win.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName?.toLowerCase() ?? null,
      isInputBarTextarea: el instanceof HTMLTextAreaElement && el.hasAttribute('data-input-bar')
    };
  });
  if (!after.isInputBarTextarea) {
    throw new Error(`expected focus to return to composer textarea after Reject (empty composer); got ${JSON.stringify(after)}`);
  }

  // Smoke test: typing now lands in the textarea.
  await win.keyboard.type('after-reject');
  await win.waitForTimeout(80);
  const value = await textarea.inputValue();
  if (!value.endsWith('after-reject')) {
    throw new Error(`expected textarea to receive keystrokes after reject; got value=${JSON.stringify(value)}`);
  }

  // ----- Round 2: composer was non-empty when the prompt arrived. The
  // existing "composer focused + non-empty → don't steal" exception in
  // PermissionPromptBlock means Reject is NOT focused on mount — focus stays
  // on the textarea. The user clicks Reject (or Allow) instead of the 'n'
  // hotkey path. After the prompt resolves the focus contract is the same:
  // composer textarea is the resting focus surface for the next keystroke.
  await textarea.click();
  await textarea.fill('mid-typed message');

  await injectWaiting(win, {
    id: 'wait-FOCUS-RETURN-2',
    requestId: 'FOCUS-RETURN-2',
    toolInput: { command: 'echo hi2' },
    prompt: 'Bash: echo hi2'
  });
  await heading.waitFor({ state: 'visible', timeout: 5_000 });
  // Pre-click sanity: focus retained on textarea (composer-empty exception
  // does NOT apply when composer has content).
  const preClick = await win.evaluate(() => {
    const el = document.activeElement;
    return {
      isInputBarTextarea: el instanceof HTMLTextAreaElement && el.hasAttribute('data-input-bar'),
      val: el instanceof HTMLTextAreaElement ? el.value : null
    };
  });
  if (!preClick.isInputBarTextarea || preClick.val !== 'mid-typed message') {
    throw new Error(`round2: expected focus retained on typed textarea pre-click; got ${JSON.stringify(preClick)}`);
  }

  // Click Reject explicitly — focus moves into the alertdialog button.
  await win.locator('[data-perm-action="reject"]').click();

  try {
    await heading.waitFor({ state: 'detached', timeout: 3_000 });
  } catch {
    throw new Error('round2: permission prompt still visible after clicking Reject');
  }

  await win.waitForFunction(() => {
    const el = document.activeElement;
    return el instanceof HTMLTextAreaElement && el.hasAttribute('data-input-bar');
  }, null, { timeout: 2_000 }).catch(() => {});

  const after2 = await win.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName?.toLowerCase() ?? null,
      isInputBarTextarea: el instanceof HTMLTextAreaElement && el.hasAttribute('data-input-bar'),
      val: el instanceof HTMLTextAreaElement ? el.value : null
    };
  });
  if (!after2.isInputBarTextarea) {
    throw new Error(`round2: expected focus to return to composer textarea after click-Reject; got ${JSON.stringify(after2)}`);
  }
  if (after2.val !== 'mid-typed message') {
    throw new Error(`round2: textarea draft changed; got ${JSON.stringify(after2.val)}`);
  }

  log('focus returned to textarea after permission reject in both empty + typed composer cases');
}

// ---------- question-focus-on-mount ----------
// Task #291 part A: when an AskUserQuestion card mounts, keyboard focus should
// move to the first option even if the user was typing in the composer at the
// moment the question arrived. The composer draft is a controlled value and
// won't be lost; the user's expectation (per real-use feedback) is that ↑/↓
// + Enter just work without an extra Tab.
//
// PR #305 deliberately set autoFocus={false} on the QuestionStickyHost ("no
// focus theft") — this case codifies the reversal: question takes focus on
// mount unconditionally.
async function caseQuestionFocusOnMount({ win, log }) {
  await seedSession(win);

  const textarea = win.locator('[data-input-bar]').first();
  await textarea.waitFor({ state: 'visible', timeout: 5_000 });
  await textarea.click();
  await textarea.fill('half-typed message');

  // Sanity: textarea actually focused with content before the question lands.
  const before = await win.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName?.toLowerCase() ?? null,
      isTextarea: el instanceof HTMLTextAreaElement,
      value: el instanceof HTMLTextAreaElement ? el.value : null
    };
  });
  if (!before.isTextarea || before.value !== 'half-typed message') {
    throw new Error(`pre-mount focus expected typed textarea; got ${JSON.stringify(before)}`);
  }

  // Inject a question block.
  await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    s.appendBlocks(s.activeId, [{
      kind: 'question',
      id: 'q-FOCUS-MOUNT',
      requestId: 'q-FOCUS-MOUNT',
      questions: [{
        question: 'Pick a stack',
        options: [{ label: 'TypeScript' }, { label: 'Rust' }, { label: 'Go' }]
      }]
    }]);
  });

  await win.waitForSelector('[data-question-option]', { timeout: 5_000 });

  // The mount-focus effect runs on rAF; wait until activeElement is a question
  // option (or until the timeout — we then snapshot to produce a clear failure).
  await win.waitForFunction(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement && el.hasAttribute('data-question-option');
  }, null, { timeout: 2_000 }).catch(() => {});

  const onMount = await win.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName?.toLowerCase() ?? null,
      isOption: el instanceof HTMLElement && el.hasAttribute('data-question-option'),
      label: el instanceof HTMLElement ? el.getAttribute('data-question-label') : null,
      isTextarea: el instanceof HTMLTextAreaElement
    };
  });
  if (onMount.isTextarea) {
    throw new Error(`question mount did not move focus off textarea: ${JSON.stringify(onMount)}`);
  }
  if (!onMount.isOption) {
    throw new Error(`expected first question option focused on mount; got ${JSON.stringify(onMount)}`);
  }
  if (onMount.label !== 'TypeScript') {
    throw new Error(`expected first option (TypeScript) focused, got label=${onMount.label}`);
  }

  // ↓ moves to the next option.
  await win.keyboard.press('ArrowDown');
  await win.waitForTimeout(80);
  const afterDown = await win.evaluate(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement.getAttribute('data-question-label')
      : null
  );
  if (afterDown !== 'Rust') {
    throw new Error(`expected ArrowDown to move focus to Rust, got ${afterDown}`);
  }

  // Space to toggle the radio (Enter on a single-select w/ auto-advance is
  // tricky; Space is the deterministic pick path inside QuestionBlock).
  await win.keyboard.press(' ');
  await win.waitForTimeout(80);

  // Submit via the Submit button — clicking is more deterministic than
  // synthesising Enter while focus is on the option (single-question form
  // doesn't auto-submit on Enter).
  await win.locator('[data-testid="question-submit"]').click();

  // After submit, QuestionStickyHost calls bumpComposerFocus → focus should
  // return to the textarea.
  await win.waitForFunction(() => {
    const el = document.activeElement;
    return el instanceof HTMLTextAreaElement && el.hasAttribute('data-input-bar');
  }, null, { timeout: 2_000 }).catch(() => {});

  const afterSubmit = await win.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName?.toLowerCase() ?? null,
      isInputBarTextarea: el instanceof HTMLTextAreaElement && el.hasAttribute('data-input-bar')
    };
  });
  if (!afterSubmit.isInputBarTextarea) {
    throw new Error(`expected focus back on composer textarea after submit; got ${JSON.stringify(afterSubmit)}`);
  }

  log('question stole focus from typed textarea on mount; ↑/↓ navigated; submit returned focus to textarea');
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
  launch: {
    env: {
      CCSM_E2E_HIDDEN: '0',
      // Sandbox the upstream CLI's allowlist so dev's real ~/.claude/settings.json
      // can't auto-allow tool calls that absorbed cases need to drive through
      // the permission prompt path.
      CCSM_CLAUDE_CONFIG_DIR: HARNESS_CONFIG_DIR,
    },
  },
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
    { id: 'permission-focus-returns-to-textarea', run: casePermissionFocusReturnsToTextarea },
    { id: 'question-focus-on-mount', run: caseQuestionFocusOnMount },
    { id: 'permission-shortcut-scope', run: casePermissionShortcutScope },
    { id: 'permission-nested-input', run: casePermissionNestedInput },
    { id: 'permission-truncate-width', run: casePermissionTruncateWidth },
    { id: 'permission-sequential-focus', run: casePermissionSequentialFocus },
    { id: 'permission-allow-always', run: casePermissionAllowAlways },
    { id: 'permission-a11y', run: casePermissionA11y },
    { id: 'permission-partial-accept', run: casePermissionPartialAccept },
    { id: 'permission-auto-and-titles', run: casePermissionAutoAndTitles },
    { id: 'permission-reject-stops-agent', run: casePermissionRejectStopsAgent },
    // ---- Per-case capability demo (task #223) ----
    {
      id: 'cap-setup-before-i18n-pin',
      setupBefore: async ({ win }) => {
        await win.evaluate(async () => {
          if (window.__ccsmI18n?.changeLanguage) await window.__ccsmI18n.changeLanguage('en');
        });
      },
      run: caseSetupBeforeI18nPin
    },
    // =========================================================================
    // Phase-4 absorbed cases — first production use of fresh + relaunch +
    // requiresClaudeBin + preMain capabilities (#223 bucket 3).
    // Bucket 4 (harness-restore) waits on this to verify the cap surface.
    // =========================================================================
    // ipc-unc-rejection: pure renderer-IPC contract, runs on shared launch.
    { id: 'ipc-unc-rejection', run: caseIpcUncRejection },
    // askuserquestion-no-dup-and-resolves: preMain installs ipcMain stubs to
    // capture resolvePermission + send without spawning real claude.exe. Uses
    // fresh udd so the stubbed handlers + in-renderer state can't leak into
    // later cases. registerDispose restores the IPC handlers (defence in
    // depth — fresh-udd relaunch already re-registers main-side handlers
    // because the electron app is torn down between cases).
    {
      id: 'askuserquestion-no-dup-and-resolves',
      userDataDir: 'fresh',
      preMain: async (app) => {
        await app.evaluate(({ ipcMain }) => {
          if (!global.__probeNoDup) global.__probeNoDup = { resolved: [], sent: [] };
          const cap = global.__probeNoDup;
          cap.resolved.length = 0;
          cap.sent.length = 0;
          try { ipcMain.removeHandler('agent:resolvePermission'); } catch {}
          ipcMain.handle('agent:resolvePermission', (_e, sessionId, requestId, decision) => {
            cap.resolved.push({ sessionId, requestId, decision });
            return true;
          });
          try { ipcMain.removeHandler('agent:send'); } catch {}
          ipcMain.handle('agent:send', (_e, sessionId, text) => {
            cap.sent.push({ sessionId, text });
            return true;
          });
        });
      },
      run: caseAskUserQuestionNoDupAndResolves,
    },
    // askuserquestion-routes-via-permission-request: regression for
    // "agent asked but no question card showed up". Fires the
    // agent:permissionRequest IPC frame the SDK runner emits in production
    // (after the PASSTHROUGH short-circuit was removed) and asserts a
    // question card mounts in the renderer. Pure renderer-IPC contract — no
    // real claude needed; pairs with the SDK-side unit test in
    // electron/agent-sdk/__tests__/sessions.test.ts that asserts onPermission-
    // Request is invoked for AskUserQuestion.
    {
      id: 'askuserquestion-routes-via-permission-request',
      userDataDir: 'fresh',
      run: caseAskUserQuestionRoutesViaPermissionRequest,
    },
    // permission-allow-bash: requires real claude.exe to round-trip the
    // nested control_response envelope (Bug L). Fresh udd so the renderer's
    // allowAlwaysTools allow-list state from earlier cases can't auto-allow
    // and bypass the prompt path.
    {
      id: 'permission-allow-bash',
      userDataDir: 'fresh',
      requiresClaudeBin: true,
      run: casePermissionAllowBash,
    },
    // permission-allow-write: same Bug L assertion via the Write tool —
    // file must land on disk AND tool_result must reach the renderer.
    {
      id: 'permission-allow-write',
      userDataDir: 'fresh',
      requiresClaudeBin: true,
      run: casePermissionAllowWrite,
    },
    // permission-allow-parallel-batch: 4-Bash + 5-Read parallel batches —
    // asserts renderer block-id derivation from tool_use.id (not msgId+pos)
    // AND Bug L envelope holds for all N tool_results.
    {
      id: 'permission-allow-parallel-batch',
      userDataDir: 'fresh',
      requiresClaudeBin: true,
      run: casePermissionAllowParallelBatch,
    },
    // jsonl-filename-matches-session: asserts SDK respects sessionId option
    // (positive UUID case) AND defence-in-depth gate rejects malformed
    // presets (negative case). Writes into the user's real
    // ~/.claude/projects via the spawned CLI; the case cleans up the project
    // dirs it created. Fresh udd isolates renderer state across runs.
    {
      id: 'jsonl-filename-matches-session',
      userDataDir: 'fresh',
      requiresClaudeBin: true,
      run: caseJsonlFilenameMatchesSession,
    },
    // bypass-mid-session-toggle: regression for "Agent unresponsive" toast
    // when toggling default→bypass via the chip. Real session, real SDK,
    // both directions verified.
    {
      id: 'bypass-mid-session-toggle',
      userDataDir: 'fresh',
      requiresClaudeBin: true,
      run: caseBypassMidSessionToggle,
    },
    // env-passthrough: ANTHROPIC_API_KEY/AUTH_TOKEN must flow through to
    // claude.exe so the CLI authenticates without an isolated CLAUDE_CONFIG_DIR
    // login. Fresh udd to start clean. SKIPS at runtime (does NOT fail) when
    // neither auth env var is set in the parent process.
    {
      id: 'env-passthrough',
      userDataDir: 'fresh',
      requiresClaudeBin: true,
      run: caseEnvPassthrough,
    },
    // connection-pane: Settings → Connection pane reads ~/.claude/settings.json
    // via os.homedir(). preMain swaps process.env.HOME / USERPROFILE to a
    // fixture dir BEFORE the renderer triggers the IPC, so the IPC handler
    // resolves the fixture instead of the dev's real settings. Fresh udd
    // because the swap is global to the electron main process and shouldn't
    // leak into later cases.
    {
      id: 'connection-pane',
      userDataDir: 'fresh',
      preMain: async (app, ctx) => {
        // The IPC handler reads `os.homedir()`, which on Windows resolves via
        // SHGetFolderPath() and on POSIX via getpwuid_r() — both IGNORE the
        // HOME / USERPROFILE env vars. Worse, the eval context that
        // app.evaluate() uses blocks `require()` and dynamic `import()`, so
        // we can't even load the `fs` module in main to redirect the read.
        //
        // Workaround: precompute the connection:read response payload on the
        // harness side and have the monkey-patched handler return it verbatim.
        // Same trick for openSettingsFile (it just calls shell.openPath, which
        // IS available via the destructured first arg) and models:list (a
        // static fixture is enough).
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-perm-conn-home-'));
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        const settingsPath = path.join(home, '.claude', 'settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({
          model: 'claude-probe-fixture-1',
          env: {
            ANTHROPIC_BASE_URL: 'https://probe.example.com/v1',
            ANTHROPIC_AUTH_TOKEN: 'sk-ant-PROBE-DO-NOT-LEAK-1234567890',
          },
        }, null, 2), 'utf8');
        const fixtureResponse = {
          baseUrl: 'https://probe.example.com/v1',
          model: 'claude-probe-fixture-1',
          hasAuthToken: true,
        };
        await app.evaluate(({ ipcMain, shell }, args) => {
          try { ipcMain.removeHandler('connection:read'); } catch {}
          ipcMain.handle('connection:read', () => args.fixture);
          try { ipcMain.removeHandler('connection:openSettingsFile'); } catch {}
          ipcMain.handle('connection:openSettingsFile', async () => {
            const result = await shell.openPath(args.settingsPath);
            return result === '' ? { ok: true } : { ok: false, error: result };
          });
          try { ipcMain.removeHandler('models:list'); } catch {}
          ipcMain.handle('models:list', async () => [
            { id: 'claude-probe-fixture-1', source: 'settings', label: 'claude-probe-fixture-1' },
          ]);
        }, { fixture: fixtureResponse, settingsPath });
        ctx.registerDispose(async () => {
          try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
        });
      },
      run: caseConnectionPane,
    },
  ]
});
