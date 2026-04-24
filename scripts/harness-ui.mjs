// Themed harness — UI cluster, Phase-3.
//
// Per docs/e2e/single-harness-brainstorm.md §8 (option B + C). Each case
// below is the de-duplicated body of one of the per-file probes in
// scripts/probe-e2e-*.mjs. The original probe files have been left in
// place with a `// MERGED INTO harness-ui.mjs` marker on line 1 and are
// excluded from the per-file runner via scripts/run-all-e2e.mjs's
// MERGED_INTO_HARNESS skip list.
//
// Scope (6 cases — pure UI / store-driven, no real claude.exe required):
//   - sidebar-align             (probe-e2e-sidebar-align)
//   - no-sessions-landing       (probe-e2e-no-sessions-landing)
//   - empty-state-minimal       (probe-e2e-empty-state-minimal)
//   - a11y-focus-restore        (probe-e2e-a11y-focus-restore)
//   - shortcut-overlay-opens    (new — UI-1 / #188)
//   - popover-cross-dismiss     (new — popover-mutex / #221)
//   - type-scale-snapshot       (new — #225, guards 4-step type token system)
//
// Related UI probes already absorbed into harness-agent.mjs:
//   - inputbar-visible, chat-copy, input-placeholder
//
// Run: `node scripts/harness-ui.mjs`
// Run one case: `node scripts/harness-ui.mjs --only=sidebar-align`

import { runHarness } from './probe-helpers/harness-runner.mjs';

// ---------- sidebar-align ----------
async function caseSidebarAlign({ win, log }) {
  // The empty ("No sessions yet") main panel exhibits the same geometry as
  // the populated one — no need to seed sessions here.
  await win.waitForFunction(
    () => !!document.querySelector('main') && !!document.querySelector('aside'),
    null,
    { timeout: 10000 }
  );
  await win.waitForTimeout(200);

  const geo = await win.evaluate(() => {
    const aside = document.querySelector('aside');
    const main = document.querySelector('main');
    if (!aside || !main) return null;
    const a = aside.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    return {
      aside: { top: a.top, bottom: a.bottom, left: a.left, right: a.right },
      main: { top: m.top, bottom: m.bottom, left: m.left, right: m.right },
      vh: window.innerHeight
    };
  });
  if (!geo) throw new Error('no aside or main element');

  const topDelta = Math.abs(geo.aside.top - geo.main.top);
  const botDelta = Math.abs(geo.aside.bottom - geo.main.bottom);
  const tolerance = 1;

  if (topDelta > tolerance) {
    throw new Error(`top edges misaligned: aside=${geo.aside.top.toFixed(1)} main=${geo.main.top.toFixed(1)} delta=${topDelta.toFixed(1)}`);
  }
  if (botDelta > tolerance) {
    throw new Error(`bottom edges misaligned: aside=${geo.aside.bottom.toFixed(1)} main=${geo.main.bottom.toFixed(1)} delta=${botDelta.toFixed(1)}`);
  }

  log(`aside=${geo.aside.top.toFixed(1)}/${geo.aside.bottom.toFixed(1)} main=${geo.main.top.toFixed(1)}/${geo.main.bottom.toFixed(1)} vh=${geo.vh}`);
}

// ---------- no-sessions-landing ----------
async function caseNoSessionsLanding({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({ sessions: [], activeId: undefined, tutorialSeen: true });
  });
  await win.waitForTimeout(300);

  const main = win.locator('main');
  const newBtn = main.getByRole('button', { name: /^New Session$/ });
  const importBtn = main.getByRole('button', { name: /^Import Session$/ });
  await newBtn.waitFor({ state: 'visible', timeout: 5000 });
  await importBtn.waitFor({ state: 'visible', timeout: 5000 });

  const [a, b] = await Promise.all([newBtn.boundingBox(), importBtn.boundingBox()]);
  if (!a || !b) throw new Error('button box missing');
  if (Math.abs(a.width - b.width) > 0.5) throw new Error(`button widths differ: new=${a.width.toFixed(1)} import=${b.width.toFixed(1)}`);
  if (Math.abs(a.height - b.height) > 0.5) throw new Error(`button heights differ: new=${a.height.toFixed(1)} import=${b.height.toFixed(1)}`);

  // The old "No sessions yet" / "Create a session to start …" copy must be gone.
  const oldCopy = await win.getByText(/No sessions yet|Create a session to start|Import from Claude Code/i).count();
  if (oldCopy > 0) throw new Error('legacy no-sessions copy still present');

  log(`both buttons ${a.width.toFixed(1)}x${a.height.toFixed(1)}`);
}

// ---------- empty-state-minimal ----------
async function caseEmptyStateMinimal({ win, log }) {
  // Note: the source probe additionally asserts that the "Claude CLI detected"
  // flash doesn't leak on automatic startup when cliStatus==='found'. In the
  // harness environment the reset between cases unconditionally sets
  // cliStatus to {state:'found', binaryPath:'<harness>'} WITHOUT going through
  // the startup detection pipeline that produces the flash — so the CLI flash
  // assertion degenerates to "startup flow never ran", which is always true
  // here and therefore not a meaningful guard. The one-per-file probe remains
  // the canonical guard for that specific regression; see the SKIPPED note in
  // run-all-e2e.mjs. The minimal-empty-state (hero + no starter cards + no
  // "Working in" line) contract IS absorbed here.

  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      messagesBySession: {}
    });
  });
  await win.waitForTimeout(300);

  const hero = win.getByText(/Ready when you are\./i);
  try {
    await hero.first().waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    throw new Error('empty-state hero "Ready when you are." not visible');
  }

  for (const removed of ['Explain this codebase', 'Find and fix a bug', 'Add tests', 'Refactor for clarity']) {
    const n = await win.getByText(removed, { exact: false }).count();
    if (n > 0) throw new Error(`starter card "${removed}" still rendered (count=${n})`);
  }

  const workingIn = await win.getByText(/Working in /i).count();
  if (workingIn > 0) throw new Error('old "Working in …" line still rendered');

  log('hero visible, no starter cards, no "Working in" line');
}

// ---------- a11y-focus-restore ----------
async function caseA11yFocusRestore({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'Group One', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: 'sA', name: 'session-a', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
        { id: 'sB', name: 'session-b', state: 'idle', cwd: 'C:/y', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }
      ],
      activeId: 'sA',
      messagesBySession: { sA: [], sB: [] }
    });
  });
  await win.waitForTimeout(300);

  // Contract 4: aria-live on chat stream.
  const liveAttrs = await win.evaluate(() => {
    const el = document.querySelector('[data-chat-stream]');
    if (!el) return null;
    return {
      live: el.getAttribute('aria-live'),
      relevant: el.getAttribute('aria-relevant'),
      role: el.getAttribute('role')
    };
  });
  if (!liveAttrs) throw new Error('chat stream container [data-chat-stream] not found');
  if (liveAttrs.live !== 'polite') throw new Error(`expected aria-live=polite on chat stream, got ${liveAttrs.live}`);
  if (liveAttrs.relevant !== 'additions') throw new Error(`expected aria-relevant="additions" on chat stream, got ${liveAttrs.relevant}`);

  // Contract 1: clicking a session row wires a11y attributes.
  const sessionLi = win.locator('[data-session-id="sA"]');
  await sessionLi.waitFor({ state: 'visible', timeout: 5000 });
  await win.locator('textarea[data-input-bar]').waitFor({ state: 'visible', timeout: 5000 });
  await sessionLi.click();

  const sessionAttrs = await win.evaluate(() => {
    const el = document.querySelector('[data-session-id="sA"]');
    if (!el) return null;
    return {
      tabindex: el.getAttribute('tabindex'),
      ariaSelected: el.getAttribute('aria-selected'),
      role: el.getAttribute('role')
    };
  });
  if (!sessionAttrs) throw new Error('session sA li missing after click');
  if (sessionAttrs.role !== 'option') throw new Error(`expected role=option on session row, got ${sessionAttrs.role}`);
  if (sessionAttrs.tabindex !== '0') throw new Error(`expected tabindex=0 on selected session, got ${sessionAttrs.tabindex}`);
  if (sessionAttrs.ariaSelected !== 'true') throw new Error(`expected aria-selected=true on active session, got ${sessionAttrs.ariaSelected}`);

  // Precondition for contracts 2/3: focus the chat textarea directly.
  const textarea = win.locator('textarea[data-input-bar]');
  await textarea.focus();
  const textareaReady = await win.waitForFunction(
    () => {
      const el = document.activeElement;
      return el instanceof HTMLTextAreaElement && el.hasAttribute('data-input-bar');
    },
    null,
    { timeout: 1500 }
  ).then(() => true).catch(() => false);
  if (!textareaReady) throw new Error('expected chat textarea focused after focus() precondition');

  // Contract 2: Settings dialog focus restore.
  await win.keyboard.press('Control+,');
  await win.locator('[role="tablist"]').first().waitFor({ state: 'visible', timeout: 5000 });

  const tablistOk = await win.evaluate(() => {
    const list = document.querySelector('[role="tablist"]');
    if (!list) return null;
    const tabs = list.querySelectorAll('[role="tab"]');
    if (tabs.length === 0) return null;
    let selected = 0;
    let withControls = 0;
    for (const t of tabs) {
      if (t.getAttribute('aria-selected') === 'true') selected++;
      if (t.getAttribute('aria-controls')) withControls++;
    }
    return { count: tabs.length, selected, withControls };
  });
  if (!tablistOk) throw new Error('settings tablist missing or empty');
  if (tablistOk.selected !== 1) throw new Error(`expected exactly one tab with aria-selected=true, got ${tablistOk.selected}`);
  if (tablistOk.withControls !== tablistOk.count) throw new Error(`expected every tab to have aria-controls, got ${tablistOk.withControls}/${tablistOk.count}`);

  await win.keyboard.press('Escape');
  const settingsRestored = await win.waitForFunction(
    () => {
      const el = document.activeElement;
      return el instanceof HTMLTextAreaElement && el.hasAttribute('data-input-bar');
    },
    null,
    { timeout: 1500 }
  ).then(() => true).catch(() => false);
  if (!settingsRestored) throw new Error('expected focus restored to chat textarea after Settings close within 1.5s');

  // Contract 3: CommandPalette focus restore.
  await textarea.focus();
  await win.waitForFunction(
    () => {
      const el = document.activeElement;
      return el instanceof HTMLTextAreaElement && el.hasAttribute('data-input-bar');
    },
    null,
    { timeout: 1000 }
  ).catch(() => { throw new Error('expected chat textarea focused before opening CommandPalette'); });

  await win.keyboard.press('Control+f');
  await win.locator('input[placeholder]').first().waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(50);
  await win.keyboard.press('Escape');
  const paletteRestored = await win.waitForFunction(
    () => {
      const el = document.activeElement;
      return el instanceof HTMLTextAreaElement && el.hasAttribute('data-input-bar');
    },
    null,
    { timeout: 1500 }
  ).then(() => true).catch(() => false);
  if (!paletteRestored) throw new Error('expected focus restored to chat textarea after CommandPalette close within 1.5s');

  log('contracts 1-4: session-row attrs, Settings restore, Palette restore, chat-stream aria-live');
}

// ---------- shortcut-overlay-opens ----------
async function caseShortcutOverlayOpens({ win, log }) {
  // Seed a normal active session so the full App branch renders (the
  // overlay is wired into both branches, but this keeps the test closer
  // to real usage).
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      messagesBySession: { s1: [] }
    });
  });
  await win.waitForTimeout(200);

  // Press `?` on the body (not in any input) → overlay should open.
  await win.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus();
  });
  await win.keyboard.press('Shift+Slash');

  const overlay = win.locator('[data-shortcut-overlay]');
  try {
    await overlay.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    throw new Error('shortcut overlay did not appear after pressing ?');
  }

  // Title (rendered via DialogContent's title prop) must be present.
  const hasTitle = await overlay.evaluate((el) => {
    const id = el.getAttribute('aria-labelledby');
    if (!id) return false;
    const t = document.getElementById(id);
    return !!t && /Keyboard shortcuts/i.test(t.textContent || '');
  });
  if (!hasTitle) {
    const dump = await overlay.evaluate((el) => {
      const id = el.getAttribute('aria-labelledby');
      const t = id ? document.getElementById(id) : null;
      return { id, text: t?.textContent, bodyText: el.textContent?.slice(0, 200), html: el.innerHTML.slice(0, 500) };
    });
    throw new Error('overlay title "Keyboard shortcuts" missing; dump=' + JSON.stringify(dump));
  }
  const kbdCount = await overlay.locator('kbd').count();
  if (kbdCount < 6) throw new Error(`expected >=6 kbd chips in overlay, got ${kbdCount}`);

  // Escape dismisses.
  await win.keyboard.press('Escape');
  const closed = await win.waitForFunction(
    () => !document.querySelector('[data-shortcut-overlay]'),
    null,
    { timeout: 2000 }
  ).then(() => true).catch(() => false);
  if (!closed) throw new Error('overlay still present after Escape');

  // Cmd/Ctrl+/ as the alternative trigger — Control on all harness hosts.
  await win.keyboard.press('Control+/');
  try {
    await overlay.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    throw new Error('shortcut overlay did not appear after Ctrl+/');
  }
  await win.keyboard.press('Escape');

  log(`overlay opened via ? and Ctrl+/, ${kbdCount} kbd chips`);
}

// ---------- popover-cross-dismiss ----------
async function casePopoverCrossDismiss({ win, log }) {
  // Seed an active session so the StatusBar renders with the cwd chip and
  // the model + permission ChipMenus. The model id is the trigger label,
  // so a fixed value gives us a stable selector.
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      model: 'claude-opus-4',
      models: [{ id: 'claude-opus-4', source: 'manual' }, { id: 'claude-sonnet-4', source: 'manual' }],
      modelsLoaded: true,
      messagesBySession: { s1: [] },
      openPopoverId: null
    });
  });
  await win.waitForTimeout(200);

  const cwdChip = win.locator('[data-cwd-chip]');
  await cwdChip.waitFor({ state: 'visible', timeout: 5000 });

  // Step 1: open the cwd popover, assert visible.
  await cwdChip.click();
  const cwdPopover = win.locator('[role="dialog"][aria-label="Working directory"]');
  await cwdPopover.waitFor({ state: 'visible', timeout: 3000 });
  let openId = await win.evaluate(() => window.__ccsmStore.getState().openPopoverId);
  if (openId !== 'cwd') throw new Error(`expected openPopoverId=cwd after cwd click, got ${openId}`);

  // Step 2: click the model selector trigger.
  const modelChip = win.locator('button', { hasText: 'claude-opus-4' });
  await modelChip.first().click();

  // Step 3: cwd popover must be hidden, model menu must be visible.
  await win.waitForFunction(
    () => !document.querySelector('[role="dialog"][aria-label="Working directory"]'),
    null,
    { timeout: 2000 }
  ).catch(() => { throw new Error('cwd popover did not auto-close after clicking model chip'); });
  const modelMenu = win.locator('[role="menu"]');
  await modelMenu.first().waitFor({ state: 'visible', timeout: 3000 });
  openId = await win.evaluate(() => window.__ccsmStore.getState().openPopoverId);
  if (openId !== 'model') throw new Error(`expected openPopoverId=model after model click, got ${openId}`);

  // Step 4: click the cwd selector trigger again.
  await cwdChip.click();

  // Step 5: model menu must be hidden, cwd popover visible.
  await win.waitForFunction(
    () => document.querySelectorAll('[role="menu"]').length === 0,
    null,
    { timeout: 2000 }
  ).catch(() => { throw new Error('model menu did not auto-close after clicking cwd chip') });
  await cwdPopover.waitFor({ state: 'visible', timeout: 3000 });
  openId = await win.evaluate(() => window.__ccsmStore.getState().openPopoverId);
  if (openId !== 'cwd') throw new Error(`expected openPopoverId=cwd after re-clicking cwd, got ${openId}`);

  // Step 6 (bonus): Escape closes the cwd popover (CwdPopover's onKey
  // listener calls closePopover('cwd')). After Escape, openPopoverId is null
  // and no popover/menu is mounted.
  await win.keyboard.press('Escape');
  await win.waitForFunction(
    () => !document.querySelector('[role="dialog"][aria-label="Working directory"]') &&
          document.querySelectorAll('[role="menu"]').length === 0,
    null,
    { timeout: 2000 }
  ).catch(() => { throw new Error('Escape did not close all popovers') });
  openId = await win.evaluate(() => window.__ccsmStore.getState().openPopoverId);
  if (openId !== null) throw new Error(`expected openPopoverId=null after Escape, got ${openId}`);

  log('cwd→model→cwd cross-dismiss + Escape clears mutex slot');
}

// ---------- type-scale-snapshot ----------
// Guards the 4-step semantic type token system introduced in #225.
// We seed the store with one session that has an assistant message + a tool
// block, open the Settings dialog, then walk the DOM to read the computed
// font-size of one element from each semantic tier and assert it matches the
// spec. Any future drift (someone reverting `text-chrome` back to `text-sm`,
// or a Tailwind config change that breaks the token resolution) trips here.
//
// Spec (from docs/design/type-scale-audit.md):
//   text-meta    = 11px : status pills, durations, hint chips
//   text-chrome  = 13px : sidebar list rows, tool block name, status bar
//   text-body    = 15px : assistant + user message body
//   text-heading = 16px : dialog titles, section headers
async function caseTypeScaleSnapshot({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 'session-one', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      messagesBySession: {
        s1: [
          // One assistant text block — drives text-body sample.
          { kind: 'assistant', id: 'm-asst', text: 'Hello from the assistant.' },
          // One tool block — drives text-chrome sample (tool name).
          { kind: 'tool', id: 'm-tool', name: 'read_file', brief: '/tmp/x', expanded: false, result: 'ok', input: { path: '/tmp/x' } }
        ]
      }
    });
  });
  await win.waitForTimeout(400);

  // Open Settings to capture a dialog title.
  await win.keyboard.press('Control+,');
  await win.locator('[role="dialog"]').first().waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(150);

  const sizes = await win.evaluate(() => {
    const px = (el) => Math.round(parseFloat(getComputedStyle(el).fontSize));
    const pickFirst = (sel) => document.querySelector(sel);
    const sidebarRow = pickFirst('[data-session-id="s1"]');
    const assistantBody = pickFirst('[data-type-scale-role="assistant-body"]');
    const toolName = pickFirst('[data-type-scale-role="tool-name"]');
    const dialogTitle = pickFirst('[role="dialog"] h2, [role="dialog"] [id$="-title"]');
    const messagesAny = document.querySelectorAll('[data-message-id], [data-message]').length;
    return {
      sidebar: sidebarRow ? { px: px(sidebarRow), tag: sidebarRow.tagName, cls: sidebarRow.className } : null,
      assistant: assistantBody ? { px: px(assistantBody), tag: assistantBody.tagName } : null,
      tool: toolName ? { px: px(toolName), tag: toolName.tagName } : null,
      dialog: dialogTitle ? { px: px(dialogTitle), tag: dialogTitle.tagName, text: (dialogTitle.textContent || '').slice(0, 40) } : null,
      messageCount: messagesAny,
      bodyText: document.querySelector('main')?.textContent?.slice(0, 160) ?? null
    };
  });

  await win.keyboard.press('Escape');

  const failures = [];
  // text-chrome = 13px (audit allows 12-13; we picked 13 in global.css).
  if (!sizes.sidebar) failures.push('sidebar row [data-session-id="s1"] not found');
  else if (sizes.sidebar.px !== 13) failures.push(`sidebar row expected 13px (text-chrome), got ${sizes.sidebar.px}px`);
  // text-body = 15px.
  if (!sizes.assistant) failures.push('assistant body [data-type-scale-role="assistant-body"] not found');
  else if (sizes.assistant.px !== 15) failures.push(`assistant body expected 15px (text-body), got ${sizes.assistant.px}px`);
  // tool name inherits text-chrome (13px) from the parent ToolBlock container.
  if (!sizes.tool) failures.push('tool name [data-type-scale-role="tool-name"] not found');
  else if (sizes.tool.px !== 13) failures.push(`tool name expected 13px (text-chrome), got ${sizes.tool.px}px`);
  // dialog title = text-heading (16px). Audit says 16-18; we picked 16.
  if (!sizes.dialog) failures.push('dialog title not found');
  else if (sizes.dialog.px < 16 || sizes.dialog.px > 18) failures.push(`dialog title expected 16-18px (text-heading), got ${sizes.dialog.px}px`);

  if (failures.length > 0) {
    throw new Error('type-scale snapshot mismatch:\n  - ' + failures.join('\n  - ') + '\n  sizes=' + JSON.stringify(sizes));
  }

  log(`sidebar=${sizes.sidebar.px}px assistant=${sizes.assistant.px}px tool=${sizes.tool.px}px dialog=${sizes.dialog.px}px`);
}

// ---------- banner-i18n-toggle ----------
// Asserts AgentInitFailedBanner + AgentDiagnosticBanner re-render with the
// active i18n catalog when the language preference flips. The banners read
// their copy from the `banner.*` namespace via `useTranslation()`; if any
// future regression hard-codes one of those strings, the corresponding
// title check below will keep showing the English literal in zh and trip.
//
// Reverse-verify: temporarily change `<TopBanner title={t('banner...')}>`
// in either AgentInitFailedBanner.tsx or AgentDiagnosticBanner.tsx to a
// hardcoded English literal — this case must FAIL.
async function caseBannerI18nToggle({ win, log }) {
  // Seed an active session + a sessionInitFailures entry + a diagnostic
  // entry so both banners mount above the chat surface.
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 'session-one', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      messagesBySession: { s1: [] },
      sessionInitFailures: {
        s1: { error: 'spawn ENOENT', errorCode: 'EUNKNOWN', timestamp: Date.now() }
      },
      diagnostics: [
        { id: 'd1', sessionId: 's1', level: 'warn', code: 'INIT_HANDSHAKE_TIMEOUT', message: 'init handshake timed out', timestamp: Date.now(), dismissed: false }
      ]
    });
  });
  // Wait for the chat surface to render so the banners are mounted.
  await win.locator('textarea[data-input-bar]').waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(250);

  async function setLang(lang) {
    // Drive through window.ccsm.i18n.setLanguage which mirrors what
    // SettingsDialog calls when the user picks a language. Also update
    // the renderer i18next directly through __ccsmI18n to ensure the
    // catalog swap is observed before the banner re-render assertion.
    await win.evaluate((l) => {
      window.ccsm?.i18n?.setLanguage?.(l);
      const i18n = window.__ccsmI18n;
      if (i18n && typeof i18n.changeLanguage === 'function') {
        return i18n.changeLanguage(l);
      }
      return undefined;
    }, lang);
    await win.waitForTimeout(200);
  }

  async function readBannerTitles() {
    return await win.evaluate(() => {
      const initEl = document.querySelector('[data-testid="agent-init-failed-banner"]');
      const diagEl = document.querySelector('[data-testid="agent-diagnostic-banner"]');
      // The title slot inside <TopBanner /> is the first text element
      // inside the grow column (font-semibold text-meta).
      const text = (el) => (el?.textContent || '').trim();
      return {
        initText: text(initEl),
        diagText: text(diagEl),
        initFound: !!initEl,
        diagFound: !!diagEl
      };
    });
  }

  // ---- English baseline ----
  await setLang('en');
  const en = await readBannerTitles();
  if (!en.initFound) throw new Error('agent-init-failed-banner not mounted (en); did seeding miss sessionInitFailures?');
  if (!en.diagFound) throw new Error('agent-diagnostic-banner not mounted (en); did seeding miss diagnostics?');
  if (!/Failed to start Claude/i.test(en.initText)) {
    throw new Error(`expected init banner to contain English title in en, got: ${en.initText}`);
  }
  if (!/Agent warning/i.test(en.diagText)) {
    throw new Error(`expected diagnostic banner to contain English title in en, got: ${en.diagText}`);
  }
  if (/[\u4e00-\u9fff]/.test(en.initText) || /[\u4e00-\u9fff]/.test(en.diagText)) {
    throw new Error(`unexpected CJK in en banners: init=${en.initText} diag=${en.diagText}`);
  }

  // ---- Switch to Chinese ----
  await setLang('zh');
  const zh = await readBannerTitles();
  if (!zh.initFound || !zh.diagFound) {
    throw new Error('banners disappeared after language switch (should re-render, not unmount)');
  }
  if (!/[\u4e00-\u9fff]/.test(zh.initText)) {
    throw new Error(`expected CJK in init banner after zh switch, got: ${zh.initText}`);
  }
  if (!/[\u4e00-\u9fff]/.test(zh.diagText)) {
    throw new Error(`expected CJK in diagnostic banner after zh switch, got: ${zh.diagText}`);
  }
  // Source-of-truth strings from src/i18n/locales/zh.ts. If these change
  // intentionally update the assertions; if they change unintentionally
  // the parity test will trip elsewhere.
  if (!/无法启动 Claude/.test(zh.initText)) {
    throw new Error(`expected zh init title '无法启动 Claude' in: ${zh.initText}`);
  }
  if (!/Agent 警告/.test(zh.diagText)) {
    throw new Error(`expected zh diag title 'Agent 警告' in: ${zh.diagText}`);
  }

  // ---- Flip back to English ----
  await setLang('en');
  const en2 = await readBannerTitles();
  if (!/Failed to start Claude/i.test(en2.initText)) {
    throw new Error(`flip back to en: init banner did not revert, got: ${en2.initText}`);
  }
  if (/[\u4e00-\u9fff]/.test(en2.initText)) {
    throw new Error(`flip back to en: CJK still present, got: ${en2.initText}`);
  }

  log('banners flip en→zh→en (init: "Failed to start Claude" ↔ "无法启动 Claude"; diag: "Agent warning" ↔ "Agent 警告")');
}

// ---------- toast-a11y ----------
// Asserts the Toast a11y contract (#298 follow-up):
//   - Error toasts live inside a region with role=alert + aria-live=assertive
//     AND render a glyph icon (currently AlertCircle from lucide).
//   - Default/info/waiting toasts live inside role=status + aria-live=polite.
//   - Body click does NOT dismiss the toast (clicks anywhere outside the
//     close button + outside the action button must be no-ops).
//   - Close button DOES dismiss the toast.
//
// Reverse-verify: flip the error region role to "status" in
// src/components/ui/Toast.tsx — this case must FAIL on the role check.
async function caseToastA11y({ win, log }) {
  // Wait for the ToastProvider to expose its bridge.
  await win.waitForFunction(() => !!window.__ccsmToast, null, { timeout: 5000 });

  // Push one of each variant. Use unique titles so we can locate them
  // by text after.
  const ids = await win.evaluate(() => {
    const tx = window.__ccsmToast;
    return {
      errId: tx.push({ kind: 'error', title: 'TOAST-A11Y-ERR', body: 'boom', persistent: true }),
      infoId: tx.push({ kind: 'info', title: 'TOAST-A11Y-INFO', persistent: true })
    };
  });
  await win.waitForTimeout(200);

  const regions = await win.evaluate(() => {
    const errToast = document.querySelector('[data-testid="toast-error"]');
    const infoToast = document.querySelector('[data-testid="toast-info"]');
    const climb = (el) => {
      let cur = el?.parentElement || null;
      while (cur) {
        const role = cur.getAttribute('role');
        if (role === 'alert' || role === 'status') {
          return { role, live: cur.getAttribute('aria-live') };
        }
        cur = cur.parentElement;
      }
      return null;
    };
    return {
      errFound: !!errToast,
      infoFound: !!infoToast,
      errRegion: climb(errToast),
      infoRegion: climb(infoToast),
      errIcon: !!errToast?.querySelector('svg'),
      errCloseBtn: !!errToast?.querySelector('button[aria-label]')
    };
  });

  if (!regions.errFound) throw new Error('error toast did not render after push()');
  if (!regions.infoFound) throw new Error('info toast did not render after push()');
  if (!regions.errRegion) throw new Error('error toast has no ancestor live region');
  if (!regions.infoRegion) throw new Error('info toast has no ancestor live region');
  if (regions.errRegion.role !== 'alert' || regions.errRegion.live !== 'assertive') {
    throw new Error(`error toast region expected role=alert + aria-live=assertive, got role=${regions.errRegion.role} live=${regions.errRegion.live}`);
  }
  if (regions.infoRegion.role !== 'status' || regions.infoRegion.live !== 'polite') {
    throw new Error(`info toast region expected role=status + aria-live=polite, got role=${regions.infoRegion.role} live=${regions.infoRegion.live}`);
  }
  if (!regions.errIcon) throw new Error('error toast missing glyph icon (svg)');
  if (!regions.errCloseBtn) throw new Error('error toast missing aria-labeled close button');

  // Body-click does NOT dismiss. Click on the title element specifically.
  await win.evaluate(() => {
    const errToast = document.querySelector('[data-testid="toast-error"]');
    const title = errToast?.querySelector('div.text-chrome, div.font-medium');
    title?.click();
  });
  await win.waitForTimeout(150);
  const stillThere = await win.evaluate(() => !!document.querySelector('[data-testid="toast-error"]'));
  if (!stillThere) throw new Error('error toast was dismissed by body click — should be sticky to close button + Esc');

  // Close button DOES dismiss.
  await win.evaluate(() => {
    const errToast = document.querySelector('[data-testid="toast-error"]');
    const btn = errToast?.querySelector('button[aria-label]');
    btn?.click();
  });
  await win.waitForTimeout(250);
  const gone = await win.evaluate(() => !document.querySelector('[data-testid="toast-error"]'));
  if (!gone) throw new Error('error toast survived close-button click');

  // Cleanup the persistent info toast.
  await win.evaluate((id) => window.__ccsmToast?.dismiss(id), ids.infoId);

  log('error: role=alert/assertive + glyph + close-only dismiss; info: role=status/polite');
}

// ---------- harness spec ----------
await runHarness({
  name: 'ui',
  setup: async ({ win }) => {
    // Suppress the "Claude CLI not found" first-launch dialog.
    await win.evaluate(() => {
      window.__ccsmStore?.setState({
        cliStatus: { state: 'found', binaryPath: '<harness>', version: null }
      });
    });
  },
  cases: [
    { id: 'sidebar-align', run: caseSidebarAlign },
    { id: 'no-sessions-landing', run: caseNoSessionsLanding },
    { id: 'empty-state-minimal', run: caseEmptyStateMinimal },
    { id: 'a11y-focus-restore', run: caseA11yFocusRestore },
    { id: 'shortcut-overlay-opens', run: caseShortcutOverlayOpens },
    { id: 'popover-cross-dismiss', run: casePopoverCrossDismiss },
    { id: 'type-scale-snapshot', run: caseTypeScaleSnapshot },
    { id: 'banner-i18n-toggle', run: caseBannerI18nToggle },
    { id: 'toast-a11y', run: caseToastA11y }
  ]
});
