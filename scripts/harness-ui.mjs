// Themed harness — UI cluster.
//
// Per docs/e2e/single-harness-brainstorm.md §8 (option B + C). Each case
// below is the de-duplicated body of one of the per-file probes in
// scripts/probe-e2e-*.mjs. Absorbed probe files are deleted outright (no
// breadcrumb files); run-all-e2e.mjs auto-discovers via glob so the runner
// just stops seeing them.
//
// Scope:
//   - sidebar-align                        (probe-e2e-sidebar-align)
//   - no-sessions-landing                  (probe-e2e-no-sessions-landing)
//   - empty-state-minimal                  (probe-e2e-empty-state-minimal)
//   - a11y-focus-restore                   (probe-e2e-a11y-focus-restore)
//   - shortcut-overlay-opens               (UI-1 / #188)
//   - popover-cross-dismiss                (popover-mutex / #221)
//   - type-scale-snapshot                  (#225, 4-step type token system)
//   - banner-i18n-toggle                   (banner i18n)
//   - toast-a11y                           (#298 follow-up)
//   - cwd-popover-recent-unfiltered        (probe-e2e-cwd-popover-recent-unfiltered)
//   - palette-empty                        (probe-e2e-palette-empty, #117 / #258)
//   - palette-nav                          (probe-e2e-palette-nav)
//   - settings-open                        (probe-e2e-settings-open)
//   - search-shortcut-f                    (probe-e2e-search-shortcut-f)
//   - tutorial                             (probe-e2e-tutorial)
//   - titlebar                             (probe-e2e-titlebar)
//   - tray                                 (probe-e2e-tray)
//   - focus-orchestration                  (probe-e2e-focus-orchestration)
//   - theme-toggle                         (probe-e2e-theme-toggle)
//   - language-toggle                      (probe-e2e-language-toggle)
//   - i18n-settings-zh                     (probe-e2e-i18n-settings-zh)
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
  // Task #329: empty-state CTA copy is sentence case ("New session" /
  // "Import a CLI session"). The test stays anchored to the i18n strings
  // surfaced under [data-testid="first-run-empty"].
  const newBtn = main.getByRole('button', { name: /^New session$/ });
  const importBtn = main.getByRole('button', { name: /^Import a CLI session$/ });
  await newBtn.waitFor({ state: 'visible', timeout: 5000 });
  await importBtn.waitFor({ state: 'visible', timeout: 5000 });

  const [a, b] = await Promise.all([newBtn.boundingBox(), importBtn.boundingBox()]);
  if (!a || !b) throw new Error('button box missing');
  if (Math.abs(a.width - b.width) > 0.5) throw new Error(`button widths differ: new=${a.width.toFixed(1)} import=${b.width.toFixed(1)}`);
  if (Math.abs(a.height - b.height) > 0.5) throw new Error(`button heights differ: new=${a.height.toFixed(1)} import=${b.height.toFixed(1)}`);

  // The old "No sessions yet" / "Create a session to start …" copy must be gone.
  const oldCopy = await win.getByText(/No sessions yet|Create a session to start|Import from Claude Code/i).count();
  if (oldCopy > 0) throw new Error('legacy no-sessions copy still present');

  // Welcome line + tertiary group CTA + tip should all render (task #329).
  const welcome = await win.getByText(/Welcome to ccsm\./i).count();
  if (welcome === 0) throw new Error('first-run welcome line missing');
  const groupCta = await win.getByRole('button', { name: /^Create a new group$/ }).count();
  if (groupCta === 0) throw new Error('first-run "Create a new group" tertiary CTA missing');
  const tip = await win.getByText(/groups organize sessions by task, not by repo/i).count();
  if (tip === 0) throw new Error('first-run tip line missing');

  log(`both buttons ${a.width.toFixed(1)}x${a.height.toFixed(1)}`);
}

// ---------- empty-state-minimal ----------
async function caseEmptyStateMinimal({ win, log }) {
  // The minimal-empty-state (hero + no starter cards + no "Working in" line)
  // contract is absorbed here. The cold-launch-only assertions in the per-file
  // probe (e.g. installerCorrupt staying false on boot) remain a separate
  // probe — see the SKIPPED note in run-all-e2e.mjs.

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

// ---------- cwd-popover-recent-unfiltered ----------
// Regression probe: opening the StatusBar cwd popover must show the FULL
// Recent list, regardless of the active session's current cwd. Pre-fix,
// CwdPopover seeded its query input with the current cwd AND filtered on it.
async function caseCwdPopoverRecentUnfiltered({ app, win, log, registerDispose }) {
  const RECENT = ['/proj/foo', '/work/bar', '/code/baz'];
  const ACTIVE_CWD = RECENT[0];

  // Replace the IPC handler so defaultLoadRecent returns our fixture.
  await app.evaluate(async ({ ipcMain }, list) => {
    try { ipcMain.removeHandler('import:recentCwds'); } catch {}
    ipcMain.handle('import:recentCwds', () => list);
  }, RECENT);
  registerDispose(async () => {
    await app.evaluate(({ ipcMain }) => {
      try { ipcMain.removeHandler('import:recentCwds'); } catch {}
    });
  });

  await win.evaluate((cwd) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'Sessions', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: 's1', groupId: 'g1', name: 'Test', state: 'idle', cwd,
        cwdMissing: false, model: 'claude-sonnet-4-5', agentType: 'claude-code'
      }],
      activeId: 's1',
      tutorialSeen: true
    });
  }, ACTIVE_CWD);
  await win.waitForTimeout(200);

  const trigger = win.locator('[data-cwd-chip]').first();
  await trigger.waitFor({ state: 'visible', timeout: 10_000 });
  await trigger.click();

  const dialog = win.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 5_000 });

  await win.waitForFunction(
    (expected) => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return false;
      return dlg.querySelectorAll('[role="option"]').length === expected;
    },
    RECENT.length,
    { timeout: 5_000 }
  ).catch(async () => {
    const count = await dialog.locator('[role="option"]').count();
    const texts = await dialog.locator('[role="option"]').allTextContents();
    throw new Error(`expected ${RECENT.length} recent options on open, got ${count}: ${JSON.stringify(texts)}`);
  });

  for (const p of RECENT) {
    const found = await dialog.locator('[role="option"]').filter({ hasText: p }).count();
    if (found === 0) throw new Error(`recent entry "${p}" not visible on open`);
  }

  const input = dialog.getByRole('textbox');
  const initialValue = await input.inputValue();
  if (initialValue !== '') throw new Error(`input value should be empty on open, got "${initialValue}"`);
  const placeholder = await input.getAttribute('placeholder');
  if (!placeholder || !placeholder.includes('foo')) {
    throw new Error(`expected placeholder to surface current cwd "${ACTIVE_CWD}", got "${placeholder}"`);
  }

  await input.fill('bar');
  await win.waitForFunction(
    () => {
      const dlg = document.querySelector('[role="dialog"]');
      return dlg && dlg.querySelectorAll('[role="option"]').length === 1;
    },
    null,
    { timeout: 3_000 }
  ).catch(async () => {
    const count = await dialog.locator('[role="option"]').count();
    throw new Error(`typing "bar" should filter to 1 option, got ${count}`);
  });

  await input.fill('');
  await win.waitForFunction(
    (expected) => {
      const dlg = document.querySelector('[role="dialog"]');
      return dlg && dlg.querySelectorAll('[role="option"]').length === expected;
    },
    RECENT.length,
    { timeout: 3_000 }
  ).catch(async () => {
    const count = await dialog.locator('[role="option"]').count();
    throw new Error(`clearing input should restore all ${RECENT.length} options, got ${count}`);
  });

  // SCREAMING-strings guard.
  const recentHeader = dialog.locator('text=/^Recent$/').first();
  const recentOffender = await recentHeader.evaluate((el) => {
    return window.getComputedStyle(el).textTransform === 'uppercase' ? el.textContent : null;
  });
  if (recentOffender) throw new Error(`"Recent" header is CSS-uppercased — forbidden`);

  log(`open with cwd "${ACTIVE_CWD}" → all ${RECENT.length} visible; "bar" filters to 1; clear restores`);
}

// ---------- palette-empty ----------
// CommandPalette empty state (#117): on open, NO results shown until user
// types. Plus #258 CP3 (no-matches block) and CP4 (kbd hint footer).
async function casePaletteEmpty({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      sessions: [{
        id: 's-palette-1', name: 'Alpha session', state: 'idle', cwd: '~/alpha',
        model: 'claude-opus-4', groupId: 'g-default', agentType: 'claude-code'
      }],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      activeId: 's-palette-1',
      tutorialSeen: true
    });
  });
  await win.waitForTimeout(200);

  await win.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true })
    );
  });

  const searchInput = win.locator('input[placeholder*="Search"]');
  await searchInput.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
    throw new Error('palette did not open via Ctrl+F — search input never appeared');
  });

  const paletteDialog = win.locator('[role="dialog"]').filter({ has: win.locator('input[placeholder*="Search"]') });
  const paletteOptions = paletteDialog.locator('[role="option"]');
  const optionsBeforeType = await paletteOptions.count();
  if (optionsBeforeType !== 0) {
    throw new Error(`palette rendered ${optionsBeforeType} option(s) on open; expected 0 until user types`);
  }

  const hintVisible = await win.getByText(/Type to search/i).isVisible().catch(() => false);
  if (!hintVisible) throw new Error('empty-state hint "Type to search…" not visible on freshly-opened palette');

  await searchInput.click();
  await searchInput.fill('alpha');
  await win.waitForTimeout(150);

  const optionsAfterType = await paletteOptions.count();
  if (optionsAfterType < 1) throw new Error(`after typing "alpha", expected ≥1 option, got ${optionsAfterType}`);
  const alphaRowVisible = await paletteOptions.filter({ hasText: 'Alpha session' }).first().isVisible();
  if (!alphaRowVisible) throw new Error('typing "alpha" did not surface the seeded "Alpha session" row');

  // #258 CP4: kbd hint footer.
  const kbdHints = paletteDialog.locator('[data-testid="cmd-palette-kbd-hints"]');
  const kbdHintsVisible = await kbdHints.isVisible().catch(() => false);
  if (!kbdHintsVisible) throw new Error('kbd hint row [data-testid=cmd-palette-kbd-hints] not visible (#258 CP4)');
  const hintsText = (await kbdHints.innerText()).replace(/\s+/g, ' ').trim();
  for (const expected of ['Navigate', 'Select', 'Close']) {
    if (!hintsText.includes(expected)) throw new Error(`kbd hint row missing label "${expected}" — got: ${hintsText}`);
  }

  // #258 CP3: no-matches block.
  await searchInput.fill('zzz-no-such-thing-zzz');
  await win.waitForTimeout(150);
  const noMatchesBlock = paletteDialog.locator('[data-testid="cmd-palette-no-matches"]');
  const noMatchesVisible = await noMatchesBlock.isVisible().catch(() => false);
  if (!noMatchesVisible) throw new Error('no-matches block not visible after typing nonsense (#258 CP3)');
  const noMatchesText = await noMatchesBlock.innerText();
  if (!noMatchesText.includes('No matches')) throw new Error(`no-matches block missing "No matches" copy — got: ${noMatchesText}`);
  if (!noMatchesText.includes('zzz-no-such-thing-zzz')) throw new Error(`no-matches block did not echo typed query — got: ${noMatchesText}`);
  const noMatchesSvg = await noMatchesBlock.locator('svg').count();
  if (noMatchesSvg < 1) throw new Error('no-matches block has no SVG icon (expected SearchX) (#258 CP3)');

  await searchInput.fill('');
  await searchInput.focus();
  await searchInput.press('Escape');
  await win.waitForTimeout(400);
  const stillOpen = await searchInput.isVisible().catch(() => false);
  if (stillOpen) throw new Error('palette did not close on Esc');

  log(`empty state OK; "alpha" → ${optionsAfterType} option(s); kbd hints + no-matches block + Esc close`);
}

// ---------- palette-nav ----------
// CommandPalette keyboard nav: ↓/↑ moves active row, Enter selects.
async function casePaletteNav({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      sessions: [
        { id: 's-nav-A', name: 'session alpha', state: 'idle', cwd: '~/a', model: 'claude-opus-4', groupId: 'g-default', agentType: 'claude-code' },
        { id: 's-nav-B', name: 'session bravo', state: 'idle', cwd: '~/b', model: 'claude-opus-4', groupId: 'g-default', agentType: 'claude-code' }
      ],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      activeId: 's-nav-A',
      tutorialSeen: true
    });
  });
  await win.waitForTimeout(200);

  await win.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true })
    );
  });

  const searchInput = win.locator('input[placeholder*="Search"]');
  await searchInput.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
    throw new Error('palette did not open via Ctrl+F');
  });

  await searchInput.click();
  await searchInput.fill('session');
  await win.waitForTimeout(150);

  const paletteDialog = win.locator('[role="dialog"]').filter({ has: win.locator('input[placeholder*="Search"]') });
  const options = paletteDialog.locator('[role="option"]');
  const optionCount = await options.count();
  if (optionCount < 2) throw new Error(`expected ≥2 option rows after typing "session", got ${optionCount}`);

  async function activeIndex() {
    const flags = await options.evaluateAll((els) =>
      els.map((el) => el.getAttribute('aria-selected') === 'true')
    );
    return flags.indexOf(true);
  }

  let idx = await activeIndex();
  if (idx !== 0) throw new Error(`initial active index expected 0, got ${idx}`);

  await searchInput.press('ArrowDown');
  await win.waitForTimeout(80);
  idx = await activeIndex();
  if (idx !== 1) throw new Error(`after ArrowDown, expected active=1, got ${idx}`);

  await searchInput.press('ArrowUp');
  await win.waitForTimeout(80);
  idx = await activeIndex();
  if (idx !== 0) throw new Error(`after ArrowUp, expected active=0, got ${idx}`);

  const labels = await options.evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ''));
  const bravoIdx = labels.findIndex((l) => l.includes('bravo'));
  if (bravoIdx < 0) throw new Error(`"session bravo" row not present: ${JSON.stringify(labels)}`);
  const steps = bravoIdx - (await activeIndex());
  for (let i = 0; i < steps; i++) await searchInput.press('ArrowDown');
  await win.waitForTimeout(80);

  await searchInput.press('Enter');
  await win.waitForTimeout(400);

  const activeId = await win.evaluate(() => window.__ccsmStore.getState().activeId);
  if (activeId !== 's-nav-B') throw new Error(`Enter on "session bravo" did not select s-nav-B; activeId=${activeId}`);
  const stillOpen = await searchInput.isVisible().catch(() => false);
  if (stillOpen) throw new Error('palette did not close after Enter');

  log('Ctrl+F opens; ↓/↑ moves active row; Enter selects s-nav-B');
}

// ---------- settings-open ----------
// Settings dialog open/close — three entry points reach ONE dialog.
async function caseSettingsOpen({ win, log }) {
  // Need a session for the InputBar to render (entry #2 uses /config in textarea).
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      messagesBySession: { s1: [] },
      tutorialSeen: true
    });
  });
  await win.waitForTimeout(200);

  const dialog = win.getByRole('dialog');

  async function expectDialogClosed(label) {
    await dialog.waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {});
    if ((await dialog.count()) > 0) throw new Error(`${label}: dialog still in DOM after expected close`);
  }
  async function expectSettingsDialogOpen(label) {
    await dialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
      throw new Error(`${label}: dialog never became visible`);
    });
    const conn = dialog.getByRole('tab', { name: /^connection$/i });
    await conn.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {
      throw new Error(`${label}: Settings tabs not visible — wrong dialog opened?`);
    });
  }
  async function pressEscAndExpectClosed(label) {
    await win.keyboard.press('Escape');
    await expectDialogClosed(label);
  }

  // 1. Sidebar Settings button.
  const sidebarBtn = win.getByRole('button', { name: /^settings$/i }).first();
  await sidebarBtn.waitFor({ state: 'visible', timeout: 5000 });
  await sidebarBtn.click();
  await expectSettingsDialogOpen('sidebar button');
  await pressEscAndExpectClosed('sidebar button');

  // 2. /config slash command.
  const textarea = win.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });
  await textarea.click();
  await textarea.fill('/config');
  await win.waitForTimeout(80);
  await win.keyboard.press('Escape');
  await win.waitForTimeout(80);
  await win.keyboard.press('Enter');
  await expectSettingsDialogOpen('/config');
  await pressEscAndExpectClosed('/config');

  // 3. Keyboard shortcut Cmd/Ctrl+,.
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control';
  await textarea.fill('');
  await win.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await win.keyboard.press(`${accel}+,`);
  await expectSettingsDialogOpen('keyboard shortcut');
  await pressEscAndExpectClosed('keyboard shortcut');

  log('sidebar / /config / Cmd+, all open Settings; Esc closes');
}

// ---------- search-shortcut-f ----------
// Cmd/Ctrl+F opens palette, toggles closed; Cmd/Ctrl+K does NOT open it.
async function caseSearchShortcutF({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      tutorialSeen: true
    });
  });
  await win.waitForTimeout(200);

  const searchInput = win.locator('input[placeholder*="Search"]');
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control';

  // 1. Open via Cmd/Ctrl+F.
  await win.keyboard.press(`${accel}+f`);
  await searchInput.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
    throw new Error('palette did not open via Ctrl+F — search input never appeared');
  });

  // 2. Toggle closed via the same shortcut.
  await searchInput.focus();
  await win.keyboard.press(`${accel}+f`);
  await searchInput.waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {
    throw new Error('palette did not close on second Ctrl+F (toggle broken)');
  });

  // 3. Cmd/Ctrl+K must NOT open it.
  await win.keyboard.press(`${accel}+k`);
  await win.waitForTimeout(500);
  const openedByK = await searchInput.isVisible().catch(() => false);
  if (openedByK) throw new Error('Ctrl+K opened the palette — the K binding for search should be removed');

  log('Ctrl+F opens; Ctrl+F toggles closed; Ctrl+K does NOT open');
}

// ---------- tutorial ----------
// First-run tutorial: shows when sessions=[] && tutorialSeen=false; Step 1/4
// indicator + Skip button; Next advances; Done flips tutorialSeen.
async function caseTutorial({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({ sessions: [], activeId: undefined, tutorialSeen: false });
  });
  await win.waitForTimeout(200);

  const stepCounter = win.locator('text=/Step 1 of 4/i').first();
  await stepCounter.waitFor({ state: 'visible', timeout: 5000 });
  await win.locator('text=/A workbench for AI sessions/i').first().waitFor({ state: 'visible', timeout: 3000 });

  // SCREAMING-strings guard (PR #248 Gap #1, task #315).
  const screaming = await win.evaluate(() => {
    const root = document.querySelector('[data-testid="tutorial"], main, body');
    if (!root) return [];
    const offenders = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      const el = node;
      if (el && el.textContent && el.children.length === 0) {
        const txt = el.textContent.trim();
        if (txt && /[a-zA-Z]/.test(txt)) {
          const tt = window.getComputedStyle(el).textTransform;
          if (tt === 'uppercase') offenders.push(`${el.tagName}: ${txt.slice(0, 60)}`);
        }
      }
      node = walker.nextNode();
    }
    return offenders;
  });
  if (screaming.length > 0) {
    throw new Error(`tutorial has CSS-uppercased text (forbidden):\n  ${screaming.join('\n  ')}`);
  }

  const skipBtn = win.getByRole('button', { name: /^Skip$/ });
  await skipBtn.waitFor({ state: 'visible', timeout: 3000 });

  const nextBtn = win.getByRole('button', { name: /^Next$/ });
  await nextBtn.click();
  await win.waitForTimeout(150);
  await nextBtn.click();
  await win.waitForTimeout(150);
  await nextBtn.click();
  await win.waitForTimeout(200);

  await win.locator('text=/Step 4 of 4/i').first().waitFor({ state: 'visible', timeout: 3000 });
  await win.locator('text=/Ready when you are/i').first().waitFor({ state: 'visible', timeout: 3000 });

  await win.getByRole('button', { name: /^New Session$/ }).first().waitFor({ state: 'visible', timeout: 3000 });
  await win.getByRole('button', { name: /^Import Session$/ }).first().waitFor({ state: 'visible', timeout: 3000 });

  await win.getByRole('button', { name: /^Done$/ }).click();
  await win.waitForTimeout(300);

  const seen = await win.evaluate(() => window.__ccsmStore.getState().tutorialSeen);
  if (!seen) throw new Error('Done did not set tutorialSeen=true');

  const stillTutorial = await win.locator('text=/Step \\d of 4/i').count();
  if (stillTutorial > 0) throw new Error('tutorial still rendered after Done');

  log('Step 1→4 advance; Done sets tutorialSeen=true');
}

// ---------- titlebar ----------
// No native frame on win/linux; >=2 top drag regions of expected height;
// window controls inside right pane (not sidebar) on win/linux.
async function caseTitlebar({ app, win, log }) {
  await win.waitForFunction(() => !!document.querySelector('main') && !!document.querySelector('aside'), null, { timeout: 10000 });

  const platform = await app.evaluate(() => process.platform);

  const dragRegions = await win.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[style*="app-region: drag"]'));
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      return { height: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width) };
    }).filter((r) => r.top === 0);
  });
  if (dragRegions.length < 2) {
    throw new Error(`expected >=2 top drag regions, got ${dragRegions.length}: ${JSON.stringify(dragRegions)}`);
  }
  const EXPECTED_STRIP = 32;
  for (const r of dragRegions) {
    if (Math.abs(r.height - EXPECTED_STRIP) > 2) {
      throw new Error(`drag region height expected ~${EXPECTED_STRIP}, got ${r.height}. all=${JSON.stringify(dragRegions)}`);
    }
  }

  if (platform !== 'darwin') {
    for (const name of ['Minimize', 'Close']) {
      await win.locator(`button[aria-label="${name}"]`).waitFor({ state: 'visible', timeout: 5000 });
    }
    await win.locator('button[aria-label="Maximize"], button[aria-label="Restore"]').first().waitFor({ state: 'visible', timeout: 5000 });

    const geometry = await win.evaluate(() => {
      const sidebar = document.querySelector('aside');
      const close = Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Close');
      if (!sidebar || !close) return null;
      const s = sidebar.getBoundingClientRect();
      const c = close.getBoundingClientRect();
      return { sidebarRight: s.right, closeLeft: c.left, closeRight: c.right, windowWidth: window.innerWidth };
    });
    if (!geometry) throw new Error('sidebar or Close button missing');
    if (geometry.closeLeft < geometry.sidebarRight) {
      throw new Error(`Close button is not inside the right pane (closeLeft=${geometry.closeLeft} < sidebarRight=${geometry.sidebarRight})`);
    }
    if (geometry.windowWidth - geometry.closeRight > 4) {
      throw new Error(`Close button not flush to window right edge (gap=${geometry.windowWidth - geometry.closeRight})`);
    }
  }

  log(`platform=${platform} dragRegions=${dragRegions.length}`);
}

// ---------- tray ----------
// Closing the window hides it (does NOT quit) on win32/linux; show() restores.
async function caseTray({ app, win, log, registerDispose }) {
  // Belt-and-suspenders: ensure the window is visible after we're done so
  // subsequent cases can interact with it (the harness window is shared).
  registerDispose(async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
      try { w?.show(); } catch {}
    });
  });

  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
    w?.close();
  });
  // Main process fades for 180ms before hide().
  await new Promise((r) => setTimeout(r, 600));

  const state = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
    return { exists: !!w, visible: w?.isVisible() ?? null };
  });
  if (!state.exists) throw new Error('window was destroyed; expected hide-on-close');
  if (state.visible !== false) throw new Error(`window should be hidden after close; visible=${state.visible}`);

  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
    w?.show();
  });
  const after = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
    return w?.isVisible() ?? null;
  });
  if (after !== true) throw new Error(`window should be visible after show; visible=${after}`);

  log('hide-on-close=true; restore-via-show=true');
}

// ---------- focus-orchestration ----------
// Composer focus contracts: send / switch-session / group-click / modal /
// preserve-other-input. See probe-e2e-focus-orchestration.mjs for full notes.
async function caseFocusOrchestration({ win, log }) {
  await win.evaluate(() => {
    try {
      const real = window.ccsm;
      if (real) {
        real.agentSend = async () => true;
        real.agentStart = async () => ({ ok: true, sessionId: 'sdk-1' });
        real.agentInterrupt = async () => true;
      }
    } catch {}
  });

  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [
        { id: 'g1', name: 'Group One', collapsed: false, kind: 'normal' },
        { id: 'g2', name: 'Group Two', collapsed: false, kind: 'normal' }
      ],
      sessions: [
        { id: 'sA', name: 'session-a', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
        { id: 'sB', name: 'session-b', state: 'idle', cwd: 'C:/y', model: 'claude-opus-4', groupId: 'g2', agentType: 'claude-code' }
      ],
      activeId: 'sA',
      messagesBySession: { sA: [{ kind: 'user', id: 'u-a', text: 'hi A' }], sB: [] },
      startedSessions: { sA: true }
    });
  });
  await win.waitForTimeout(300);

  const textarea = win.locator('textarea');
  await textarea.waitFor({ state: 'visible', timeout: 5000 });

  const activeTag = () => win.evaluate(() => document.activeElement ? document.activeElement.tagName : null);
  const activeIsTextarea = () => win.evaluate(() => document.activeElement?.tagName === 'TEXTAREA');

  // Contract 1: focus returns (or is acceptable as BUTTON) after Send.
  await textarea.click();
  await textarea.fill('hello there');
  await win.evaluate(() => { document.querySelector('textarea')?.blur(); document.body.focus(); });
  if (await activeIsTextarea()) throw new Error('precondition: textarea should not be focused right before Send');
  const sendBtn = win.getByRole('button', { name: /send message/i }).first();
  await sendBtn.waitFor({ state: 'visible', timeout: 3000 });
  await sendBtn.click();
  await win.waitForTimeout(200);
  const echoLanded = await win.evaluate(() => {
    const blocks = window.__ccsmStore.getState().messagesBySession['sA'] ?? [];
    return blocks.some((b) => b.kind === 'user' && b.text === 'hello there');
  });
  if (!echoLanded) throw new Error('Send click did not produce a user-echo block — send() never ran');
  // BUTTON-after-send is currently soft-acceptable; we just log.
  const tagAfterSend = await activeTag();
  log(`post-Send activeElement=${tagAfterSend}`);

  // Contract 2: switching session via sidebar focuses target textarea.
  await win.evaluate(() => { document.querySelector('textarea')?.blur(); document.body.focus(); });
  const rows = win.locator('aside li[role="option"]');
  const rowCount = await rows.count();
  if (rowCount < 2) throw new Error(`expected ≥2 sidebar rows, got ${rowCount}`);
  await rows.nth(1).click();
  await win.waitForTimeout(150);
  if (!(await activeIsTextarea())) {
    const tag = await activeTag();
    throw new Error(`after switching session via sidebar click, expected TEXTAREA focus, got ${tag}`);
  }

  // Contract 3: clicking a group header doesn't drop focus to <body>.
  await textarea.click();
  await textarea.fill('drafting…');
  if (!(await activeIsTextarea())) throw new Error('precondition: textarea should be focused before group click');
  const groupHeader = win.locator('aside').getByText('Group Two').first();
  if (await groupHeader.count()) {
    const headerVisible = await groupHeader.isVisible().catch(() => false);
    if (headerVisible) {
      await groupHeader.click();
      await win.waitForTimeout(120);
      const stillTextarea = await activeIsTextarea();
      const tag = await activeTag();
      if (!stillTextarea && tag === 'BODY') {
        throw new Error('clicking group header while typing dropped focus to <body>');
      }
      const value = await textarea.inputValue();
      if (value !== 'drafting…') throw new Error(`group header click corrupted draft: got ${JSON.stringify(value)}`);
    }
  }

  // Contract 4: open Settings → focus inside dialog; close → composer usable.
  await win.evaluate(() => { document.querySelector('textarea')?.blur(); document.body.focus(); });
  const settingsBtn = win.getByRole('button', { name: /^settings$/i }).first();
  if (await settingsBtn.count()) {
    await settingsBtn.click();
    const dialog = win.locator('[role="dialog"]').first();
    await dialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { throw new Error('Settings dialog never opened'); });
    const insideDialog = await win.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!(d && d.contains(document.activeElement));
    });
    if (!insideDialog) {
      const tag = await activeTag();
      throw new Error(`Settings open: focus not inside dialog, activeElement=${tag}`);
    }
    await win.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => { throw new Error('Settings dialog did not close on Esc'); });
    await win.waitForTimeout(300);
    await textarea.click();
    await textarea.fill('post-modal');
    const v = await textarea.inputValue();
    if (v !== 'post-modal') throw new Error('composer not usable after closing Settings');
    await textarea.fill('');
  }

  // Contract 5: focusInputNonce bump must NOT yank focus from another <input>.
  await win.evaluate(() => {
    const inp = document.createElement('input');
    inp.id = '__probeInput';
    inp.type = 'text';
    document.body.appendChild(inp);
    inp.focus();
  });
  const beforeBump = await win.evaluate(() => document.activeElement?.id);
  if (beforeBump !== '__probeInput') throw new Error(`failed to focus probe input pre-bump (id=${beforeBump})`);
  await win.evaluate(() => window.__ccsmStore.getState().bumpComposerFocus());
  await win.waitForTimeout(120);
  const afterBump = await win.evaluate(() => document.activeElement?.id);
  if (afterBump !== '__probeInput') {
    const tag = await win.evaluate(() => document.activeElement?.tagName);
    throw new Error(`focusInputNonce bump stole focus: now id="${afterBump}" tag="${tag}"`);
  }
  await win.evaluate(() => document.getElementById('__probeInput')?.remove());

  log('contracts 1-5: send / switch / group-click / modal / preserve-other-input');
}

// ---------- theme-toggle ----------
// Theme dark↔light: class flip lands within a frame, body bg luminance
// changes substantially, contrast remains readable. Restores theme to dark.
async function caseThemeToggle({ win, log, registerDispose }) {
  registerDispose(async () => {
    // Restore to dark (the harness baseline) so subsequent cases aren't
    // surprised by light-mode CSS variables.
    await win.evaluate(() => {
      try { window.__ccsmStore.getState().setTheme('dark'); } catch {}
    });
  });

  async function snapshot() {
    return await win.evaluate(() => {
      const html = document.documentElement;
      function parseLum(s) {
        if (!s) return null;
        let m = s.match(/^oklch\(\s*([0-9.]+)/i) || s.match(/^oklab\(\s*([0-9.]+)/i);
        if (m) return parseFloat(m[1]);
        m = s.match(/rgba?\(\s*(\d+)[, ]+(\d+)[, ]+(\d+)/);
        if (m) {
          const r = +m[1], g = +m[2], b = +m[3];
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        }
        return null;
      }
      const bgRaw = getComputedStyle(html).getPropertyValue('--color-bg-app').trim() ||
        getComputedStyle(html).backgroundColor;
      const fgRaw = getComputedStyle(html).getPropertyValue('--color-fg-primary').trim() ||
        getComputedStyle(html).color;
      const sidebar = document.querySelector('aside');
      const sidebarBg = sidebar ? getComputedStyle(sidebar).backgroundColor : bgRaw;
      const bgLum = parseLum(bgRaw);
      const fgLum = parseLum(fgRaw);
      return {
        themeClassDark: html.classList.contains('dark'),
        themeClassLight: html.classList.contains('theme-light'),
        dataTheme: html.dataset.theme,
        sidebarBg, fg: fgRaw,
        contrast: bgLum != null && fgLum != null ? Math.abs(bgLum - fgLum) : 0,
        bgLum: bgLum ?? -1
      };
    });
  }

  await win.evaluate(() => { window.__ccsmStore.getState().setTheme('dark'); });
  await win.waitForTimeout(150);
  const dark1 = await snapshot();
  if (!dark1.themeClassDark || dark1.themeClassLight) throw new Error(`expected initial dark theme classes, got ${JSON.stringify(dark1)}`);
  if (dark1.dataTheme !== 'dark') throw new Error(`html[data-theme] should be 'dark', got ${dark1.dataTheme}`);
  if (dark1.contrast < 0.3) throw new Error(`dark-mode contrast too low (${dark1.contrast.toFixed(2)}). snapshot=${JSON.stringify(dark1)}`);

  // Need a session for the sidebar Settings button to be visible? No — it
  // renders regardless. But it is rendered as the first sidebar button.
  const sidebarBtn = win.getByRole('button', { name: /^settings$/i }).first();
  await sidebarBtn.click();
  const dialog = win.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 3000 });
  const lightRadio = dialog.getByRole('radio', { name: /^light$/i });
  await lightRadio.click();
  await win.waitForFunction(
    () => document.documentElement.classList.contains('theme-light'),
    null,
    { timeout: 1000 }
  );
  const light1 = await snapshot();
  if (light1.themeClassDark) throw new Error('html.dark still set after switching to Light');
  if (!light1.themeClassLight) throw new Error('html.theme-light not set after switching to Light');
  if (light1.dataTheme !== 'light') throw new Error(`html[data-theme] should be 'light', got ${light1.dataTheme}`);
  if (!(light1.bgLum > dark1.bgLum + 0.4)) {
    throw new Error(`light-mode bg not noticeably brighter (dark=${dark1.bgLum.toFixed(2)}, light=${light1.bgLum.toFixed(2)})`);
  }
  if (light1.contrast < 0.3) throw new Error(`light-mode contrast too low (${light1.contrast.toFixed(2)})`);
  if (light1.sidebarBg === 'rgba(0, 0, 0, 0)' || light1.sidebarBg === 'transparent') {
    throw new Error(`sidebar background is transparent in light mode (${light1.sidebarBg})`);
  }

  const darkRadio = dialog.getByRole('radio', { name: /^dark$/i });
  await darkRadio.click();
  await win.waitForFunction(
    () => document.documentElement.classList.contains('dark') && !document.documentElement.classList.contains('theme-light'),
    null,
    { timeout: 1000 }
  );
  const dark2 = await snapshot();
  if (dark2.dataTheme !== 'dark') throw new Error(`html[data-theme] should be back to 'dark', got ${dark2.dataTheme}`);
  if (!(dark2.bgLum < light1.bgLum - 0.4)) {
    throw new Error(`dark-mode bg lum (${dark2.bgLum.toFixed(2)}) not noticeably darker than light (${light1.bgLum.toFixed(2)})`);
  }

  await win.keyboard.press('Escape');

  log(`dark1=${dark1.bgLum.toFixed(2)} light=${light1.bgLum.toFixed(2)} dark2=${dark2.bgLum.toFixed(2)}`);
}

// ---------- language-toggle ----------
// Live language flip via Settings → Appearance Language segmented; sidebar /
// composer / settings strings flip between en and zh; protected English proper
// nouns survive the translation. Restores language to en.
async function caseLanguageToggle({ win, log, registerDispose }) {
  registerDispose(async () => {
    // Restore en so subsequent cases (which assert English UI) aren't broken.
    // Language preference lives in localStorage under `ccsm:preferences` AND
    // in i18next's runtime + the main-process mirror; we clear/reset all three
    // to guarantee the next case (and the next harness launch) sees `en`.
    await win.evaluate(async () => {
      try { window.localStorage.removeItem('ccsm:preferences'); } catch {}
      try { window.ccsm?.i18n?.setLanguage?.('en'); } catch {}
      try {
        const i18n = window.__ccsmI18n;
        if (i18n && typeof i18n.changeLanguage === 'function') await i18n.changeLanguage('en');
      } catch {}
    });
  });

  const PROTECTED_TERMS = [
    'MCP', 'CLI', 'IPC', 'API', 'URL', 'JSONL', 'JSON', 'SDK', 'REST',
    'Claude', 'Anthropic', 'CCSM', 'Electron', 'GitHub'
  ];

  async function openSettingsAppearance() {
    const dialog = win.getByRole('dialog');
    if ((await dialog.count()) === 0) {
      const btn = win.getByRole('button', { name: /^(settings|设置)$/i }).first();
      await btn.waitFor({ state: 'visible', timeout: 5000 });
      await btn.click();
    }
    await dialog.waitFor({ state: 'visible', timeout: 3000 });
    const appearanceTab = dialog.getByRole('button', { name: /^(appearance|外观)$/i });
    if (await appearanceTab.isVisible().catch(() => false)) await appearanceTab.click();
    return dialog;
  }
  async function pickLanguage(dialog, name) {
    const radio = dialog.getByRole('radio', { name });
    await radio.click();
  }
  async function closeDialog() {
    await win.keyboard.press('Escape');
    await win.getByRole('dialog').waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {});
  }

  // Force English baseline.
  let dialog = await openSettingsAppearance();
  await pickLanguage(dialog, /^english$/i);
  await win.waitForTimeout(150);
  await closeDialog();

  async function snapshotStrings() {
    return await win.evaluate(() => {
      const settingsBtn = document.querySelector(
        'aside button[aria-label="Settings"], aside button[aria-label="设置"]'
      );
      const settingsLabel =
        (settingsBtn && (settingsBtn.getAttribute('aria-label') || settingsBtn.textContent || '').trim()) ||
        Array.from(document.querySelectorAll('aside button')).map((b) => b.textContent?.trim() || '')
          .find((t) => /Settings|设置/.test(t)) || null;
      const newSessionBtn = document.querySelector(
        'aside button[aria-label="New session"], aside button[aria-label="新会话"]'
      );
      const newSessionText =
        (newSessionBtn && (newSessionBtn.getAttribute('aria-label') || newSessionBtn.textContent || '').trim()) ||
        Array.from(document.querySelectorAll('aside button')).map((b) => b.textContent?.trim() || '')
          .find((t) => /New Session|新会话/.test(t)) || null;
      const ta = document.querySelector('textarea');
      const placeholder = ta ? ta.getAttribute('placeholder') : null;
      return { settingsLabel, newSessionText, placeholder };
    });
  }

  const en1 = await snapshotStrings();
  if (!en1.settingsLabel || !/Settings/i.test(en1.settingsLabel)) {
    throw new Error(`English baseline: settings label not English. got: ${JSON.stringify(en1)}`);
  }
  if (en1.placeholder && /[一-鿿]/.test(en1.placeholder)) {
    throw new Error(`English baseline: placeholder contains CJK chars. got: ${en1.placeholder}`);
  }

  dialog = await openSettingsAppearance();
  await pickLanguage(dialog, /^中文$/);
  await win.waitForTimeout(200);
  await closeDialog();

  const zh1 = await snapshotStrings();
  if (!zh1.settingsLabel || !/设置/.test(zh1.settingsLabel)) {
    throw new Error(`After zh switch: settings label not Chinese. got: ${JSON.stringify(zh1)}`);
  }
  if (zh1.newSessionText && !/[一-鿿]/.test(zh1.newSessionText)) {
    throw new Error(`After zh switch: new session text contains no CJK. got: ${zh1.newSessionText}`);
  }
  if (zh1.placeholder && !/[一-鿿]/.test(zh1.placeholder)) {
    throw new Error(`After zh switch: placeholder contains no CJK. got: ${zh1.placeholder}`);
  }

  dialog = await openSettingsAppearance();
  await pickLanguage(dialog, /^english$/i);
  await win.waitForTimeout(200);
  await closeDialog();
  const en2 = await snapshotStrings();
  if (!en2.settingsLabel || !/Settings/i.test(en2.settingsLabel)) {
    throw new Error(`After en switch back: settings label not English. got: ${JSON.stringify(en2)}`);
  }

  // Protected-terms parity scan.
  const parity = await win.evaluate((terms) => {
    const i18next = (window).__ccsmI18n;
    if (!i18next || !i18next.store) return { error: 'i18next not exposed on window.__ccsmI18n' };
    const enRes = i18next.store.data.en?.translation;
    const zhRes = i18next.store.data.zh?.translation;
    if (!enRes || !zhRes) return { error: 'translation namespace missing' };
    const violations = [];
    function walk(enNode, zhNode, prefix) {
      if (typeof enNode === 'string') {
        if (typeof zhNode !== 'string') return;
        for (const term of terms) {
          const re = new RegExp(`\\b${term}\\b`);
          if (re.test(enNode)) {
            if (!new RegExp(`\\b${term}\\b`).test(zhNode)) {
              violations.push({ key: prefix, term, en: enNode, zh: zhNode });
            }
          }
        }
        return;
      }
      if (enNode && typeof enNode === 'object') {
        for (const k of Object.keys(enNode)) {
          walk(enNode[k], zhNode ? zhNode[k] : undefined, prefix ? `${prefix}.${k}` : k);
        }
      }
    }
    walk(enRes, zhRes, '');
    return { violations };
  }, PROTECTED_TERMS);

  if (parity.error) throw new Error(`could not read i18n catalogs: ${parity.error}`);
  if (parity.violations.length > 0) {
    const sample = parity.violations.slice(0, 5).map((v) => `${v.key} [${v.term}] en="${v.en}" zh="${v.zh}"`).join('\n  ');
    throw new Error(`${parity.violations.length} zh strings dropped a protected English proper noun:\n  ${sample}`);
  }

  log(`en→zh→en flip OK; protected-term parity 0 violations across ${PROTECTED_TERMS.length} terms`);
}

// ---------- i18n-settings-zh ----------
// All four Settings panes (Appearance / Notifications / Updates / Connection)
// render Chinese labels when language=zh. Restores language to en.
async function caseI18nSettingsZh({ win, log, registerDispose }) {
  registerDispose(async () => {
    // Same restore strategy as language-toggle — strip the persisted
    // preference so the next harness launch boots English again.
    await win.evaluate(async () => {
      try { window.localStorage.removeItem('ccsm:preferences'); } catch {}
      try { window.ccsm?.i18n?.setLanguage?.('en'); } catch {}
      try {
        const i18n = window.__ccsmI18n;
        if (i18n && typeof i18n.changeLanguage === 'function') await i18n.changeLanguage('en');
      } catch {}
    });
  });

  async function openSettings() {
    const dialog = win.getByRole('dialog');
    if ((await dialog.count()) === 0) {
      const btn = win.getByRole('button', { name: /^(settings|设置)$/i }).first();
      await btn.waitFor({ state: 'visible', timeout: 5000 });
      await btn.click();
    }
    await dialog.waitFor({ state: 'visible', timeout: 3000 });
    return dialog;
  }
  async function closeDialog() {
    await win.keyboard.press('Escape');
    await win.getByRole('dialog').waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {});
  }

  let dialog = await openSettings();
  const zhRadio = dialog.getByRole('radio', { name: /^中文$/ });
  await zhRadio.waitFor({ state: 'visible', timeout: 3000 });
  await zhRadio.click();
  await win.waitForTimeout(250);

  async function switchTab(name) {
    const tab = dialog.getByRole('tab', { name });
    await tab.waitFor({ state: 'visible', timeout: 2000 });
    await tab.click();
    await win.waitForTimeout(150);
  }
  function assertHasText(haystack, needle, where) {
    if (!haystack.includes(needle)) {
      throw new Error(`${where}: expected to find "${needle}" in pane text. Got snippet:\n${haystack.slice(0, 800)}`);
    }
  }
  function assertNotHasText(haystack, needle, where) {
    if (haystack.includes(needle)) {
      throw new Error(`${where}: unexpected English string "${needle}" leaked into zh pane.\n${haystack.slice(0, 800)}`);
    }
  }
  async function paneText() {
    return await dialog.evaluate((el) => {
      const main = el.querySelector('div.overflow-y-auto');
      return ((main && main.textContent) || el.textContent || '').trim();
    });
  }

  // Appearance.
  let txt = await paneText();
  assertHasText(txt, '主题', 'appearance');
  assertHasText(txt, '字号', 'appearance');
  assertHasText(txt, '密度', 'appearance');
  assertNotHasText(txt, 'Theme', 'appearance');
  assertNotHasText(txt, 'Density', 'appearance');

  // Notifications.
  await switchTab(/^通知$/);
  txt = await paneText();
  assertHasText(txt, '启用通知', 'notifications');
  assertHasText(txt, '权限请求', 'notifications');
  assertHasText(txt, '发送测试通知', 'notifications');
  assertNotHasText(txt, 'Enable notifications', 'notifications');
  assertNotHasText(txt, 'Test notification', 'notifications');

  // Updates.
  await switchTab(/^更新$/);
  txt = await paneText();
  assertHasText(txt, '版本', 'updates');
  assertHasText(txt, '检查更新', 'updates');
  assertHasText(txt, '自动检查', 'updates');
  assertNotHasText(txt, 'Check for updates', 'updates');
  assertNotHasText(txt, 'Automatic checks', 'updates');

  // Connection.
  await switchTab(/^连接$/);
  txt = await paneText();
  assertHasText(txt, '默认模型', 'connection');
  assertHasText(txt, 'Auth Token', 'connection');
  assertHasText(txt, '打开 settings.json', 'connection');
  assertNotHasText(txt, 'Default model', 'connection');
  assertNotHasText(txt, 'Open settings.json', 'connection');

  await closeDialog();

  log('Appearance / Notifications / Updates / Connection panes all render Chinese labels');
}

// ---------- harness spec ----------
await runHarness({
  name: 'ui',
  setup: async ({ win }) => {
    // Suppress the "Claude CLI not found" first-launch dialog AND force the
    // i18n preference back to English on every harness boot. The language
    // pref persists in localStorage (`ccsm:preferences`); a previous run
    // that left zh persisted would otherwise break every English-anchored
    // assertion in subsequent cases.
    await win.evaluate(async () => {
      try { window.localStorage.removeItem('ccsm:preferences'); } catch {}
      try { window.ccsm?.i18n?.setLanguage?.('en'); } catch {}
      try {
        const i18n = window.__ccsmI18n;
        if (i18n && typeof i18n.changeLanguage === 'function') await i18n.changeLanguage('en');
      } catch {}
      window.__ccsmStore?.setState({});
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
    { id: 'toast-a11y', run: caseToastA11y },
    { id: 'cwd-popover-recent-unfiltered', run: caseCwdPopoverRecentUnfiltered },
    { id: 'palette-empty', run: casePaletteEmpty },
    { id: 'palette-nav', run: casePaletteNav },
    { id: 'settings-open', run: caseSettingsOpen },
    { id: 'search-shortcut-f', run: caseSearchShortcutF },
    { id: 'tutorial', run: caseTutorial },
    { id: 'titlebar', run: caseTitlebar },
    { id: 'tray', run: caseTray },
    { id: 'focus-orchestration', run: caseFocusOrchestration },
    { id: 'theme-toggle', run: caseThemeToggle },
    { id: 'language-toggle', run: caseLanguageToggle },
    { id: 'i18n-settings-zh', run: caseI18nSettingsZh }
  ]
});
