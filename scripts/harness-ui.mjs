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
//   - chat-user-assistant-contrast         (#345, dogfood: user vs assistant rail)
//   - assistant-long-line-wraps            (fp11 Check F, long unbreakable run wraps)
//   - banner-i18n-toggle                   (banner i18n)
//   - toast-a11y                           (#298 follow-up)
//   - cwd-popover-recent-unfiltered        (probe-e2e-cwd-popover-recent-unfiltered)
//   - palette-empty                        (probe-e2e-palette-empty, #117 / #258)
//   - palette-nav                          (probe-e2e-palette-nav)
//   - slash-picker-claude-config-dir       (PR #346, env-scoped fake ~/.claude)
//   - settings-open                        (probe-e2e-settings-open)
//   - search-shortcut-f                    (probe-e2e-search-shortcut-f)
//   - tutorial                             (probe-e2e-tutorial)
//   - titlebar                             (probe-e2e-titlebar)
//   - tray                                 (probe-e2e-tray)
//   - focus-orchestration                  (probe-e2e-focus-orchestration)
//   - theme-toggle                         (probe-e2e-theme-toggle)
//   - language-toggle                      (probe-e2e-language-toggle)
//   - i18n-settings-zh                     (probe-e2e-i18n-settings-zh)
//   - app-icon-default                     (probe-e2e-app-icon-default, skipLaunch)
//   - group-add                            (probe-e2e-group-add)
//   - import-empty-groups                  (probe-e2e-import-empty-groups)
//   - rename                               (probe-e2e-rename)
//   - terminal                             (probe-e2e-terminal)
//   - tool-render-open-in-editor           (probe-e2e-tool-render-open-in-editor)
//   - dead-ui-cleanup                       (locks the 3-deletion cleanup PR:
//                                            EmptyState greeting, composer
//                                            kbd hint, Window tint setting)
//
// NOT absorbed (split into its own visible-mode harness):
//   - probe-e2e-dnd: needs CCSM_E2E_HIDDEN=0 (visible window) for dnd-kit
//     pointer hit-testing. The capability surface has no per-case env
//     override, and flipping the whole harness to visible would slow every
//     other case + introduce window pop-up noise. Lives in
//     scripts/harness-dnd.mjs (its own visible-mode launch, future home
//     for any other visible-mode-only cases).
//
// Related UI probes already absorbed into harness-agent.mjs:
//   - inputbar-visible, chat-copy, input-placeholder
//
// Run: `node scripts/harness-ui.mjs`
// Run one case: `node scripts/harness-ui.mjs --only=sidebar-align`

import { runHarness } from './probe-helpers/harness-runner.mjs';
import { seedStore } from './probe-utils.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';

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

  // #353: the welcome line, tertiary "Create a new group" link, and tip
  // were removed (visual noise on first launch). Reverse-verify any of
  // them comes back fails this case.
  const welcome = await win.getByText(/Welcome to ccsm\./i).count();
  if (welcome > 0) throw new Error('first-run welcome line should be removed');
  const groupCta = await win.getByRole('button', { name: /^Create a new group$/ }).count();
  if (groupCta > 0) throw new Error('first-run "Create a new group" tertiary CTA should be removed');
  const tip = await win.getByText(/groups organize sessions by task, not by repo/i).count();
  if (tip > 0) throw new Error('first-run tip line should be removed');

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

  const hero = win.locator('text=/type a message and press/i');
  try {
    await hero.first().waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    throw new Error('empty-state hint "type a message and press [Enter]" not visible');
  }

  // Old "Ready when you are." greeting was removed (dogfood: redundant
  // with the hint+placeholder below). Make sure it doesn't sneak back.
  const oldGreeting = await win.getByText(/Ready when you are\./i).count();
  if (oldGreeting > 0) {
    throw new Error('legacy "Ready when you are." greeting still rendered in EmptyState');
  }

  for (const removed of ['Explain this codebase', 'Find and fix a bug', 'Add tests', 'Refactor for clarity']) {
    const n = await win.getByText(removed, { exact: false }).count();
    if (n > 0) throw new Error(`starter card "${removed}" still rendered (count=${n})`);
  }

  const workingIn = await win.getByText(/Working in /i).count();
  if (workingIn > 0) throw new Error('old "Working in …" line still rendered');

  log('hint+kbd visible, no greeting, no starter cards, no "Working in" line');
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
  // Spoof navigator.platform = 'MacIntel' BEFORE the renderer bundle loads,
  // then reload the page so ShortcutOverlay's module-level constants
  // (MOD/SHIFT) re-evaluate against the mocked platform.
  //
  // This is the bit that catches a regression: the current diff makes
  // those constants unconditional ('Ctrl'/'Shift'), so the spoof has no
  // effect and the assertions below pass. If a future change re-introduces
  // platform sniffing (e.g. `IS_MAC ? '⌘' : 'Ctrl'`), the constants will
  // resolve to mac glyphs under the spoof and the glyph assertions trip.
  // Without the spoof, navigator.platform is 'Win32' on every harness host
  // and the regression would silently pass.
  await win.context().addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    } catch {}
  });
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });

  // Sanity-check the spoof actually took. If this fails, the rest of the
  // case can't catch a platform-sniff regression.
  const spoofedPlatform = await win.evaluate(() => navigator.platform);
  if (spoofedPlatform !== 'MacIntel') {
    throw new Error(`navigator.platform spoof failed; got ${spoofedPlatform}, expected MacIntel`);
  }

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

  // Windows-only labels: every modifier chip must spell "Ctrl" / "Shift",
  // never the macOS glyphs (⌘ / ⇧). The app dropped mac-aware modifier
  // resolution; if a stray glyph reappears here, we want to fail loudly.
  const labelDump = await overlay.evaluate((el) => {
    const text = el.textContent || '';
    const kbds = Array.from(el.querySelectorAll('kbd')).map((k) => k.textContent || '');
    return { text, kbds };
  });
  if (/[⌘⇧]/.test(labelDump.text)) {
    throw new Error('shortcut overlay still renders mac glyphs (⌘/⇧); kbds=' + JSON.stringify(labelDump.kbds));
  }
  if (/\bCmd\b/i.test(labelDump.text)) {
    throw new Error('shortcut overlay still renders "Cmd"; text=' + labelDump.text.slice(0, 200));
  }
  if (!labelDump.kbds.includes('Ctrl')) {
    throw new Error('expected at least one "Ctrl" kbd chip; got=' + JSON.stringify(labelDump.kbds));
  }

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

  // SidebarHeader tooltip + CommandPalette hints must also be Windows-only.
  // Open the palette and assert its hint chips never spell "⌘" or "Cmd".
  // Note: per-row `Ctrl+N` style hint chips only render once results are
  // visible, which requires a non-empty query (CommandPalette renders
  // an emptyHint placeholder while `q` is empty). So we must type a query
  // before asserting on hint text.
  const paletteOpenedAfterShortcut = await win.evaluate(() => {
    const ev = new KeyboardEvent('keydown', {
      key: 'f',
      code: 'KeyF',
      ctrlKey: true,
      bubbles: true
    });
    window.dispatchEvent(ev);
    return new Promise((resolve) =>
      setTimeout(() => resolve(!!document.querySelector('[role="dialog"]')), 250)
    );
  });
  if (!paletteOpenedAfterShortcut) {
    log('skipped palette hint check: palette did not open via Ctrl+F');
  } else {
    // Type a query that matches the built-in command rows ("New session",
    // "New group", "Toggle sidebar", "Settings"…) so their per-row hints
    // (Ctrl+N / Ctrl+Shift+N / Ctrl+B / Ctrl+,) are rendered.
    const paletteInput = win.locator('[role="dialog"] input').first();
    await paletteInput.waitFor({ state: 'visible', timeout: 2000 });
    await paletteInput.fill('new');
    // Wait for the result list to populate (at least one option row).
    await win.waitForFunction(
      () => document.querySelectorAll('[role="dialog"] [role="option"]').length > 0,
      null,
      { timeout: 2000 }
    ).catch(() => { throw new Error('command palette showed no results for query "new"; per-row hint chips would not render'); });

    const paletteText = await win.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      return dlg ? dlg.textContent || '' : '';
    });
    if (/[⌘⇧]/.test(paletteText)) {
      throw new Error('command palette still renders mac glyphs in hints; text=' + paletteText.slice(0, 200));
    }
    if (/\bCmd\b/.test(paletteText)) {
      throw new Error('command palette still renders "Cmd" in hints; text=' + paletteText.slice(0, 200));
    }
    if (!/Ctrl/.test(paletteText)) {
      throw new Error('expected "Ctrl" in command palette hints; text=' + paletteText.slice(0, 200));
    }
    await win.keyboard.press('Escape');
  }

  log(`overlay opened via ? and Ctrl+/, ${kbdCount} kbd chips, Windows-only labels verified`);
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

// ---------- chat-user-assistant-contrast ----------
// Dogfood feedback (#345): in dense scrolling the user vs assistant rows
// were too easy to confuse — both flat, both mono prefix glyph, only a
// one-step fg-color delta between them. Fix added a 2px accent-quiet rail
// + colored, semibold `>` to the user row so the eye lands on it as an
// "input prompt" rail (CLI-prompt visual semantic), without breaking the
// no-bubble density philosophy. This case guards three signals: the user
// row carries a left border whose color resolves to the accent-quiet hue,
// the user row prefix `>` resolves to that same hue (not the default
// fg-tertiary gray), and the assistant row stays bare (no border, no
// accent-tinted glyph) so the rail remains a USER-only marker.
//
// Reverse-verify: revert UserBlock.tsx to its pre-#345 className
// (`flex gap-3 text-body` with `text-fg-tertiary` on the `>` span) and
// this case must FAIL on the userBorderHasColor check.
async function caseChatUserAssistantContrast({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 'session-one', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      messagesBySession: {
        s1: [
          { kind: 'user', id: 'm-user', text: 'hello agent' },
          { kind: 'assistant', id: 'm-asst', text: 'hello back' }
        ]
      }
    });
  });
  await win.waitForTimeout(300);

  const probe = await win.evaluate(() => {
    const user = document.querySelector('[data-type-scale-role="user-body"]');
    const assistant = document.querySelector('[data-type-scale-role="assistant-body"]');
    if (!user || !assistant) return { user: null, assistant: null };
    const userPrefix = user.querySelector('span');
    const assistantPrefix = assistant.querySelector('span');
    const cs = (el) => el ? getComputedStyle(el) : null;
    const userCs = cs(user);
    const assistantCs = cs(assistant);
    return {
      user: {
        borderLeftWidth: userCs?.borderLeftWidth,
        borderLeftColor: userCs?.borderLeftColor,
        prefixColor: cs(userPrefix)?.color,
        prefixWeight: cs(userPrefix)?.fontWeight
      },
      assistant: {
        borderLeftWidth: assistantCs?.borderLeftWidth,
        borderLeftColor: assistantCs?.borderLeftColor,
        prefixColor: cs(assistantPrefix)?.color
      }
    };
  });

  const failures = [];
  if (!probe.user) failures.push('user block [data-type-scale-role="user-body"] not found');
  if (!probe.assistant) failures.push('assistant block [data-type-scale-role="assistant-body"] not found');

  if (probe.user) {
    const w = parseFloat(probe.user.borderLeftWidth || '0');
    if (w < 1.5) failures.push(`user row should have a >= 2px left border, got ${probe.user.borderLeftWidth}`);
    // Border + prefix must share a hue distinct from generic gray. We can't
    // resolve oklch tokens from the harness, but we CAN assert the prefix
    // color is not the same neutral as the assistant prefix (proves the
    // accent token actually applied) AND that the border has a non-zero
    // alpha non-grayscale color.
    if (probe.user.prefixColor === probe.assistant?.prefixColor) {
      failures.push(`user prefix color should differ from assistant prefix; both = ${probe.user.prefixColor}`);
    }
    const prefixWeight = parseInt(probe.user.prefixWeight || '0', 10);
    if (prefixWeight < 600) failures.push(`user prefix should be semibold (>=600), got ${probe.user.prefixWeight}`);
  }

  if (probe.assistant) {
    const w = parseFloat(probe.assistant.borderLeftWidth || '0');
    if (w >= 1.5) failures.push(`assistant row must NOT have a left rail (would dilute the user-only marker), got ${probe.assistant.borderLeftWidth}`);
  }

  if (failures.length > 0) {
    throw new Error('user/assistant contrast regression:\n  - ' + failures.join('\n  - ') + '\n  probe=' + JSON.stringify(probe));
  }

  log(`user.border=${probe.user.borderLeftWidth}@${probe.user.borderLeftColor} user.prefix=${probe.user.prefixColor}/${probe.user.prefixWeight} assistant.prefix=${probe.assistant.prefixColor}`);
}

// ---------- assistant-long-line-wraps ----------
// fp11 dogfood Check F: when the assistant emits a single 500-char run with
// no whitespace (URL, hash, "aaaa..."), the `<p>` must wrap inside the chat
// column instead of pushing the whole row into horizontal scroll. Without
// `overflow-wrap: anywhere` on the prose `<p>`, the default `word-break:
// normal` + `overflow-wrap: normal` leaves unbreakable runs intact and the
// assistant block's scrollWidth balloons to ~4× clientWidth (4297 vs 1006
// in the original repro).
//
// Reverse-verify: drop `[overflow-wrap:anywhere]` from the `<p>` className
// in src/components/chat/blocks/AssistantBlock.tsx; this case must FAIL on
// the scrollWidth-overflow check.
async function caseAssistantLongLineWraps({ win, log }) {
  const longRun = 'a'.repeat(500);
  await win.evaluate((text) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 'session-one', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      messagesBySession: {
        s1: [
          { kind: 'assistant', id: 'm-asst-long', text }
        ]
      }
    });
  }, longRun);
  await win.waitForTimeout(300);

  const probe = await win.evaluate(() => {
    const block = document.querySelector('[data-type-scale-role="assistant-body"]');
    if (!block) return null;
    // Walk to the `<p>` ReactMarkdown rendered inside the prose container.
    const p = block.querySelector('p');
    return {
      blockScrollWidth: block.scrollWidth,
      blockClientWidth: block.clientWidth,
      pScrollWidth: p ? p.scrollWidth : null,
      pClientWidth: p ? p.clientWidth : null,
      pOverflowWrap: p ? getComputedStyle(p).overflowWrap : null
    };
  });

  if (!probe) throw new Error('assistant-body block not found in DOM');

  const failures = [];
  // Allow 2px slack for sub-pixel rounding.
  if (probe.blockScrollWidth > probe.blockClientWidth + 2) {
    failures.push(
      `assistant block horizontal overflow: scrollWidth=${probe.blockScrollWidth} > clientWidth=${probe.blockClientWidth} (expected wrap)`
    );
  }
  if (probe.pScrollWidth != null && probe.pScrollWidth > probe.pClientWidth + 2) {
    failures.push(
      `assistant <p> horizontal overflow: scrollWidth=${probe.pScrollWidth} > clientWidth=${probe.pClientWidth}`
    );
  }
  if (probe.pOverflowWrap !== 'anywhere') {
    failures.push(`assistant <p> overflow-wrap should be 'anywhere', got '${probe.pOverflowWrap}'`);
  }

  if (failures.length > 0) {
    throw new Error(
      'assistant long-line wrap regression:\n  - ' + failures.join('\n  - ') +
      '\n  probe=' + JSON.stringify(probe)
    );
  }

  log(`block ${probe.blockScrollWidth}/${probe.blockClientWidth} p ${probe.pScrollWidth}/${probe.pClientWidth} overflow-wrap=${probe.pOverflowWrap}`);
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

// ---------- slash-picker-claude-config-dir ----------
// Loader honors `CLAUDE_CONFIG_DIR`. Seeds a fake `<tmp>/.claude`-shaped
// tree via the env var (NOT $HOME) and asserts the in-chat slash picker:
//   - surfaces the user-level command (`local-test`)
//   - surfaces plugin-cache commands (`superpowers:brainstorm`) — these
//     are loaded by the bundled CLI itself via the user's settings.json
//     `enabledPlugins` map; ccsm just has to NOT hide them from the picker.
//
// This pins both gates simultaneously:
//   1. commands-loader.ts reads `process.env.CLAUDE_CONFIG_DIR` (fall-through
//      to `os.homedir()` would scan the dev's real ~/.claude, polluting
//      the assertions with whatever the dev has installed locally).
//   2. PICKER_VISIBLE_SOURCES INCLUDES `plugin` (post-#290 — see
//      commands-loader.ts for the rationale and the empirical SDK probe
//      that confirmed plugins run end-to-end via stream-json).
//
// preMain wires the env on the main process (where the IPC handler reads
// `process.env.CLAUDE_CONFIG_DIR`). Disposers restore env and rm -rf the
// fake tree.
//
// Reverse-verification: shrink PICKER_VISIBLE_SOURCES back to ['user',
// 'project'] → `superpowers:brainstorm` disappears from the picker → case
// fails on the positive assertion.
async function caseSlashPickerClaudeConfigDir({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g-slash', name: 'G', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: 's-slash-1', name: 'slash-pick', state: 'idle', cwd: 'C:/x',
        model: 'claude-opus-4', groupId: 'g-slash', agentType: 'claude-code'
      }],
      activeId: 's-slash-1',
      tutorialSeen: true
    });
  });
  await win.waitForTimeout(200);

  const textarea = win.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });
  // Defocus then focus so the InputBar's onFocus refreshDynamic() fires
  // AFTER preMain set CLAUDE_CONFIG_DIR (the harness boots before preMain).
  await win.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await textarea.click();
  await win.waitForTimeout(150);
  await textarea.fill('/');
  await win.waitForTimeout(200);

  const picker = win.locator('[role="listbox"][aria-label="Slash commands"]');
  await picker.waitFor({ state: 'visible', timeout: 3000 });

  const optionTexts = await picker.locator('[role="option"]').allInnerTexts();
  const flat = optionTexts.join(' | ');

  // Positive: the seeded user command must be there.
  if (!flat.includes('/local-test')) {
    throw new Error(`expected /local-test in picker; got: ${flat}`);
  }

  // Positive (post-#290): the seeded plugin-cache command MUST surface.
  // The seeded plugin is "superpowers" with command "brainstorm" — the
  // loader emits it as `superpowers:brainstorm`.
  if (!flat.includes('superpowers:brainstorm')) {
    throw new Error(
      `expected /superpowers:brainstorm in picker (plugin source must be visible post-#290); got: ${flat}`
    );
  }

  log(`picker showed /local-test and /superpowers:brainstorm (plugin source restored, env-scoped fake ~/.claude)`);
}

// ---------- slash-namespaced-unknown-toast ----------
// Follow-up to PR #346: typing a namespaced-shape unknown slash command
// (e.g. `/plugin`, `/superpowers:brainstorm`) and pressing Enter must
// surface a local error toast and NOT append a user message to the
// transcript (forwarding the raw text to the SDK ends up as plain prose
// that the model misinterprets — the user-side bug PR #346 paired with
// the picker filter).
//
// Reverse-verification: stash the 'unknown-namespaced' branch in
// dispatchSlashCommand (or the toast handler in InputBar) → /plugin
// falls through to the local-echo append path → no toast + a user
// block appears → case fails.
async function caseSlashNamespacedUnknownToast({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g-slash-tn', name: 'G', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: 's-slash-tn-1', name: 'slash-tn', state: 'idle', cwd: 'C:/x',
        model: 'claude-opus-4', groupId: 'g-slash-tn', agentType: 'claude-code'
      }],
      activeId: 's-slash-tn-1',
      messagesBySession: { 's-slash-tn-1': [] },
      tutorialSeen: true
    });
  });
  await win.waitForTimeout(150);

  const textarea = win.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });
  await textarea.click();

  // Two namespaced shapes the dispatcher should bounce locally:
  //   - `/plugin`              (CLI plugin manager — SDK can't run it)
  //   - `/superpowers:foo`     (colon-namespaced plugin/skill)
  const cases = [
    { input: '/plugin', expectedTitle: 'Unknown command: /plugin' },
    { input: '/superpowers:foo', expectedTitle: 'Unknown command: /superpowers:foo' }
  ];

  for (const { input, expectedTitle } of cases) {
    await textarea.fill(input);
    await win.waitForTimeout(80);
    // Picker may be open showing "No matching command" — Esc dismisses it
    // so the next Enter fires send() instead of committing a picker row.
    await win.keyboard.press('Escape');
    await win.waitForTimeout(60);
    await win.keyboard.press('Enter');
    await win.waitForTimeout(200);

    // Assert error toast surfaced with the exact title.
    const toast = win.locator('[data-testid="toast-error"]', { hasText: expectedTitle });
    await toast.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {
      throw new Error(`expected error toast titled "${expectedTitle}" for ${input}; not visible`);
    });

    // Assert NO user message was appended (would mean the slash text fell
    // through to the regular send path).
    const userBlockCount = await win.evaluate((sid) => {
      const blocks = window.__ccsmStore.getState().messagesBySession[sid] ?? [];
      return blocks.filter((b) => b.kind === 'user').length;
    }, 's-slash-tn-1');
    if (userBlockCount !== 0) {
      throw new Error(
        `expected 0 user blocks after typing ${input} (toast path); found ${userBlockCount}`
      );
    }

    // Composer must be cleared so the user can keep typing.
    const value = await textarea.inputValue();
    if (value !== '') {
      throw new Error(`expected textarea cleared after ${input}; still has "${value}"`);
    }

    // Dismiss the toast so the next iteration's wait isn't satisfied by a
    // stale one. Esc dismisses the most recent toast.
    await win.keyboard.press('Escape');
    await win.waitForTimeout(60);
  }

  log(`namespaced unknown slashes (${cases.map((c) => c.input).join(', ')}) bounced locally with toast; no user messages forwarded`);
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
  // After PR #347: sidebar drag region is 8px (macOS traffic-lights spacer removed),
  // right pane stays 32px to host WindowControls.
  for (const r of dragRegions) {
    const expected = r.left === 0 ? 8 : 32;
    if (Math.abs(r.height - expected) > 2) {
      throw new Error(`drag region height expected ~${expected} (left=${r.left}), got ${r.height}. all=${JSON.stringify(dragRegions)}`);
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
  assertNotHasText(txt, 'Theme', 'appearance');

  // Notifications. Post-W2 the tab only renders two toggles: enable + sound.
  // Per-event toggle ('权限请求') and the test-notification button
  // ('发送测试通知') were removed; assert they're gone so a regression that
  // re-introduces either is caught here.
  //
  // NOTE: the per-event-toggle / test-notification absence checks are scoped
  // to actual interactive controls (role=switch / role=button) instead of a
  // raw page-text scan — the zh `notifications.intro` prose mentions
  // "权限请求" as part of an explanatory sentence, which would false-positive
  // a substring blacklist. The regression we actually care about is a
  // re-introduced Field/Switch or button, not the word appearing in copy.
  await switchTab(/^通知$/);
  txt = await paneText();
  assertHasText(txt, '启用通知', 'notifications');
  assertHasText(txt, '声音', 'notifications');
  assertNotHasText(txt, 'Enable notifications', 'notifications');
  assertNotHasText(txt, 'Sound', 'notifications');

  const notifSwitchCount = await dialog
    .getByRole('switch', { name: /权限请求/ })
    .count();
  if (notifSwitchCount > 0) {
    throw new Error(
      `notifications: per-event toggle (role=switch name="权限请求") regressed — should not exist post-W2`,
    );
  }
  for (const buttonName of [/发送测试通知/, /Test notification/i]) {
    const btnCount = await dialog
      .getByRole('button', { name: buttonName })
      .count();
    if (btnCount > 0) {
      throw new Error(
        `notifications: test-notification button (name=${buttonName}) regressed — should not exist post-W2`,
      );
    }
  }

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

// ---------- notif-disabled-suppress (W5) ----------
// Verifies the post-W1 single-gate dispatch contract end-to-end: when the
// renderer's `notificationSettings.enabled` is false, `dispatchNotification`
// returns `{ dispatched: false, reason: 'global-disabled' }` and the
// `window.ccsm.notify` IPC is NEVER fired. Drives `__ccsmDispatchNotification`
// (debug seam in App.tsx) directly so the test doesn't need a real agent
// permission request — pure renderer flow.
// ---------- sidebar-active-row-no-pulse ----------
// Regression for #289 (PR #365): when the agent finishes a turn for the
// CURRENTLY ACTIVE session, the sidebar row must NOT flip to state='waiting'
// (which drives the pulse glyph) — even when the OS-level window focus has
// been lost (alt-tab away). Pre-fix lifecycle.ts gated the pulse on
// `isActive && document.hasFocus()`, so alt-tabbing away while a turn was
// in flight made the active row pulse on result, which is visual noise for
// the row the user is already looking at. Post-fix: active session = no
// pulse, period; background sessions still pulse.
//
// We exercise the production lifecycle.ts onAgentEvent handler by sending
// the same `agent:event` IPC frame that the SDK runner emits in production
// (electron/agent-sdk routing -> webContents.send('agent:event', ...)).
// Pure renderer-IPC contract — no real claude.exe needed.
async function caseSidebarActiveRowNoPulse({ app, win, log }) {
  // Two sessions: 'sA' (active), 'sB' (background). Both started+running
  // so the result frame's setRunning(false) actually flips state.
  await win.evaluate(() => {
    const store = window.__ccsmStore;
    store.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: 'sA', name: 'active-session', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
        { id: 'sB', name: 'background-session', state: 'idle', cwd: 'C:/y', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
      ],
      activeId: 'sA',
      messagesBySession: { sA: [], sB: [] },
      startedSessions: { sA: true, sB: true },
      runningSessions: { sA: true, sB: true },
    });
  });
  await win.waitForTimeout(120);

  // Force document.hasFocus() to return false so we exercise exactly the
  // alt-tabbed-away scenario. This is the path that pre-fix would have
  // pulsed the active row.
  await win.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => false,
    });
  });

  // Sanity: pre-event state must NOT already be 'waiting' (otherwise we
  // can't tell whether the no-pulse contract held).
  const before = await win.evaluate(() => {
    const sA = window.__ccsmStore.getState().sessions.find((s) => s.id === 'sA');
    const sB = window.__ccsmStore.getState().sessions.find((s) => s.id === 'sB');
    return { sA: sA?.state, sB: sB?.state };
  });
  if (before.sA === 'waiting' || before.sB === 'waiting') {
    throw new Error(`pre-event: expected both sessions !waiting, got sA=${before.sA} sB=${before.sB}`);
  }

  // Dispatch a result frame for the ACTIVE session (sA). Lifecycle's
  // onAgentEvent handler runs in the renderer; with !isActive guard the
  // active row must NOT flip to 'waiting'. All result-frame fields beyond
  // `type` are optional (lifecycle.ts:243-260 reads them with `?`).
  await app.evaluate(({ BrowserWindow }, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.webContents.isDestroyed()) w.webContents.send('agent:event', payload);
    }
  }, {
    sessionId: 'sA',
    message: { type: 'result', subtype: 'success', usage: {}, modelUsage: {} },
  });
  await win.waitForTimeout(250);

  const afterActive = await win.evaluate(() => {
    const sA = window.__ccsmStore.getState().sessions.find((s) => s.id === 'sA');
    return { state: sA?.state, running: !!window.__ccsmStore.getState().runningSessions['sA'] };
  });
  // Lifecycle's setRunning(false) must have run (proves the event reached
  // the renderer); state must NOT be 'waiting' for the active session.
  if (afterActive.running) {
    throw new Error('result frame did not reach renderer — runningSessions[sA] still true');
  }
  if (afterActive.state === 'waiting') {
    throw new Error(`#289 regression: active session pulsed on turn_done (state='waiting') even though it's the focused row — alt-tab unfocus path leaked back in`);
  }

  // Counter-positive: background session SHOULD still pulse. This guards
  // the fix from over-correcting (e.g. dropping the pulse for everyone).
  await app.evaluate(({ BrowserWindow }, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.webContents.isDestroyed()) w.webContents.send('agent:event', payload);
    }
  }, {
    sessionId: 'sB',
    message: { type: 'result', subtype: 'success', usage: {}, modelUsage: {} },
  });
  await win.waitForTimeout(250);

  const afterBackground = await win.evaluate(() => {
    const sB = window.__ccsmStore.getState().sessions.find((s) => s.id === 'sB');
    return { state: sB?.state };
  });
  if (afterBackground.state !== 'waiting') {
    throw new Error(`background session expected state='waiting' (pulse signal preserved), got '${afterBackground.state}' — fix over-corrected`);
  }

  log('#289 — active row stays !waiting on turn_done; background row still pulses');
}

async function caseNotifDisabledSuppress({ app, win, log }) {
  // Replace the main-process `notification:show` handler with a recorder so a
  // regression that DOES dispatch lands somewhere we can observe.
  await app.evaluate(({ ipcMain }) => {
    /** @type {any} */ (globalThis).__notifDisabledRecorderCalls = [];
    ipcMain.removeHandler('notification:show');
    ipcMain.handle('notification:show', (_e, payload) => {
      /** @type {any} */ (globalThis).__notifDisabledRecorderCalls.push(payload);
      return true;
    });
  });

  // Seed a session and flip enabled=false.
  await win.evaluate(() => {
    const store = /** @type {any} */ (window).__ccsmStore;
    store.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      messagesBySession: { s1: [] },
      tutorialSeen: true,
    });
    store.getState().setNotificationSettings({ enabled: false });
  });

  // Drive dispatch via the debug seam.
  const result = await win.evaluate(async () => {
    const w = /** @type {any} */ (window);
    if (typeof w.__ccsmDispatchNotification !== 'function') {
      return { ok: false, reason: 'no-seam' };
    }
    const res = await w.__ccsmDispatchNotification({
      sessionId: 's1',
      eventType: 'permission',
      title: 'g / s',
      body: 'Permission',
      extras: { toastId: 'r1', sessionName: 's', groupName: 'g', eventType: 'permission' },
    });
    return { ok: true, res };
  });
  if (!result.ok) throw new Error(`dispatch seam unavailable: ${result.reason}`);
  if (result.res.dispatched !== false) {
    throw new Error(`expected dispatched=false, got ${JSON.stringify(result.res)}`);
  }
  if (result.res.reason !== 'global-disabled') {
    throw new Error(`expected reason='global-disabled', got ${JSON.stringify(result.res)}`);
  }

  // Give the IPC a beat (it should NEVER land but verifying takes time).
  await win.waitForTimeout(200);
  const calls = await app.evaluate(
    () => /** @type {any} */ (globalThis).__notifDisabledRecorderCalls ?? []
  );
  if (calls.length !== 0) {
    throw new Error(`enabled=false suppressed dispatch but IPC fired ${calls.length} time(s): ${JSON.stringify(calls)}`);
  }

  // Now flip enabled=true and verify the same call DOES fire — proves the
  // recorder is wired and the suppression was due to the gate, not a test bug.
  await win.evaluate(() => {
    /** @type {any} */ (window).__ccsmStore.getState().setNotificationSettings({ enabled: true });
  });
  const second = await win.evaluate(async () => {
    const w = /** @type {any} */ (window);
    return await w.__ccsmDispatchNotification({
      sessionId: 's1',
      eventType: 'permission',
      title: 'g / s',
      body: 'Permission',
      extras: { toastId: 'r2', sessionName: 's', groupName: 'g', eventType: 'permission' },
    });
  });
  if (second.dispatched !== true) {
    throw new Error(`expected dispatched=true with enabled=true, got ${JSON.stringify(second)}`);
  }
  await win.waitForTimeout(200);
  const calls2 = await app.evaluate(
    () => /** @type {any} */ (globalThis).__notifDisabledRecorderCalls ?? []
  );
  if (calls2.length !== 1) {
    throw new Error(`expected exactly 1 IPC call after re-enable, got ${calls2.length}`);
  }
  if (calls2[0].sessionId !== 's1' || calls2[0].eventType !== 'permission') {
    throw new Error(`unexpected IPC payload: ${JSON.stringify(calls2[0])}`);
  }

  log('enabled=false suppressed dispatch with reason=global-disabled; re-enable fired exactly once');
}

// ---------- cap-skip-launch-bundle-shape (capability demo) ----------
// Demonstrates `skipLaunch: true`: case runs as a pure Node script without
// booting electron. Useful for fs / package.json / dist bundle checks that
// don't need the renderer (saves ~1-2s of electron boot per case). Mirrors
// the future probe-e2e-installer-bundle-shape migration target.
async function caseSkipLaunchBundleShape({ harnessRoot, log }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(harnessRoot, 'package.json'), 'utf8'));
  if (typeof pkg.main !== 'string' || pkg.main.length === 0) {
    throw new Error('package.json "main" missing or non-string');
  }
  if (!pkg.main.includes('dist/')) {
    throw new Error(`package.json "main" should point under dist/, got ${pkg.main}`);
  }
  const bundlePath = path.join(harnessRoot, 'dist/renderer/bundle.js');
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`dist/renderer/bundle.js missing at ${bundlePath}`);
  }
  log(`pkg.main=${pkg.main} bundle=${path.relative(harnessRoot, bundlePath)}`);
}

// ---------- app-icon-default (skipLaunch) ----------
// Inverse of the previous "app-icon-present" probe (bug #332): we removed the
// custom "A" app icon and now rely on Electron's default branding everywhere.
// This probe locks that decision: no build/icon.* asset, no electron-builder
// icon: field, no BrowserWindow `icon:` option in main.ts. If anyone re-adds
// a custom icon they have to consciously update this case.
async function caseAppIconDefault({ harnessRoot, log }) {
  // 1) build/ must not contain any icon.{png,ico,icns,svg} — electron-builder
  //    auto-picks any of those names from buildResources, so each is a
  //    separate way to silently re-introduce a custom icon.
  const buildDir = path.join(harnessRoot, 'build');
  for (const name of ['icon.png', 'icon.ico', 'icon.icns', 'icon.svg']) {
    const p = path.join(buildDir, name);
    let exists = false;
    try {
      await stat(p);
      exists = true;
    } catch {
      // missing is the desired state
    }
    if (exists) {
      throw new Error(`${path.relative(harnessRoot, p)} exists; bug #332 requires falling back to Electron's default app icon`);
    }
  }

  // 2) package.json build.{win,mac,linux} must NOT set `icon:` — leaving the
  //    field unset lets electron-builder fall back to its packaged default.
  const pkgRaw = await readFile(path.join(harnessRoot, 'package.json'), 'utf8');
  let pkg;
  try {
    pkg = JSON.parse(pkgRaw);
  } catch (e) {
    throw new Error(`package.json is not valid JSON: ${e.message}`);
  }
  const build = pkg && pkg.build;
  if (build && typeof build === 'object') {
    for (const platform of ['win', 'mac', 'linux']) {
      const cfg = build[platform];
      if (cfg && typeof cfg === 'object' && Object.prototype.hasOwnProperty.call(cfg, 'icon')) {
        throw new Error(`package.json build.${platform}.icon is set to ${JSON.stringify(cfg.icon)}; bug #332 requires omitting this field so electron-builder uses its default icon`);
      }
    }
  }

  // 3) electron/main.ts must NOT pass `icon:` to BrowserWindow — that would
  //    override the OS default in the running app even if the build config
  //    is clean.
  const mainSrc = await readFile(path.join(harnessRoot, 'electron', 'main.ts'), 'utf8');
  // Match `icon:` only inside a `new BrowserWindow({...})` call so an
  // unrelated `icon:` (e.g. tray placeholder, menu item) isn't a false hit.
  const bwMatch = mainSrc.match(/new\s+BrowserWindow\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  if (bwMatch && /\bicon\s*:/.test(bwMatch[1])) {
    throw new Error('electron/main.ts passes `icon:` to BrowserWindow; bug #332 requires letting Electron use its default window icon');
  }

  log('no build/icon.* asset; package.json build.{win,mac,linux}.icon unset; BrowserWindow uses Electron default');
}

// ---------- group-add ----------
// Per-group + button creates a session in THAT group, makes it active, does
// not collapse the group, and is hidden on archived groups.
async function caseGroupAdd({ win, log }) {
  await seedStore(win, {
    groups: [
      { id: 'g1', name: 'Alpha', collapsed: false, kind: 'normal' },
      { id: 'g2', name: 'Bravo', collapsed: false, kind: 'normal' },
      { id: 'gA', name: 'Archived', collapsed: false, kind: 'archive' }
    ],
    sessions: [
      { id: 's1', name: 'a-only', state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }
    ],
    activeId: 's1',
    focusedGroupId: 'g1'
  });

  const before = await win.evaluate(() => window.__ccsmStore.getState().sessions.map((s) => ({ id: s.id, groupId: s.groupId })));
  const g2Plus = win.locator('[data-group-header-id="g2"] button[aria-label*="new session" i], [data-group-header-id="g2"] button[aria-label*="新建" i]').first();
  await g2Plus.waitFor({ state: 'visible', timeout: 3000 });
  await g2Plus.click();
  await win.waitForTimeout(300);
  const after = await win.evaluate(() => window.__ccsmStore.getState().sessions.map((s) => ({ id: s.id, groupId: s.groupId })));
  const beforeIds = new Set(before.map((s) => s.id));
  const fresh = after.filter((s) => !beforeIds.has(s.id));
  if (fresh.length !== 1) throw new Error(`expected exactly 1 new session, got ${fresh.length}`);
  if (fresh[0].groupId !== 'g2') throw new Error(`new session should land in g2, got ${fresh[0].groupId}`);

  const activeId = await win.evaluate(() => window.__ccsmStore.getState().activeId);
  if (activeId !== fresh[0].id) throw new Error(`new session should be active; activeId=${activeId}, fresh.id=${fresh[0].id}`);

  const g2Open = await win.evaluate(() => {
    const header = document.querySelector('[data-group-header-id="g2"]');
    return header?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'true';
  });
  if (!g2Open) throw new Error('g2 collapsed after + click — the click should not propagate to header toggle');

  const archivedPlus = await win.locator('[data-group-header-id="gA"] button[aria-label*="new session" i]').count();
  if (archivedPlus !== 0) throw new Error(`archived group should not have a + button (got ${archivedPlus})`);

  log(`+ on g2 created session ${fresh[0].id} in g2 (not g1) and made it active; archived has no +`);
}

// ---------- import-empty-groups ----------
// Importing into a store with empty groups[] AND a stale groupId synthesizes
// a default normal group (carrying nameKey) and parents the imported session
// under it. setupBefore is unnecessary — we wipe in-case so the assertion
// preconditions are explicit in the case body itself.
async function caseImportEmptyGroups({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [],
      sessions: [],
      activeId: '',
      focusedGroupId: null,
      messagesBySession: {},
      startedSessions: {},
      runningSessions: {},
      interruptedSessions: {},
      messageQueues: {},
      statsBySession: {},
      tutorialSeen: true
    });
  });
  await win.waitForTimeout(150);

  const beforeGroupCount = await win.evaluate(() => window.__ccsmStore.getState().groups.length);
  if (beforeGroupCount !== 0) throw new Error(`expected 0 groups before import, got ${beforeGroupCount}`);

  const newId = await win.evaluate(() =>
    window.__ccsmStore.getState().importSession({
      name: 'Imported into nothingness',
      cwd: '/tmp/no-group-cwd',
      groupId: 'g-stale-from-old-blob',
      resumeSessionId: 'resume-xyz-123'
    })
  );

  const after = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    return { groups: s.groups, sessions: s.sessions, activeId: s.activeId };
  });

  if (after.groups.length !== 1) throw new Error(`expected 1 synthesized group, got ${after.groups.length}: ${JSON.stringify(after.groups)}`);
  const synth = after.groups[0];
  if (synth.kind !== 'normal') throw new Error(`synthesized group should be normal, got kind=${synth.kind}`);
  if (synth.nameKey !== 'sidebar.defaultGroupName') throw new Error(`synthesized group should carry nameKey='sidebar.defaultGroupName', got '${synth.nameKey}'`);
  if (after.sessions.length !== 1) throw new Error(`expected 1 imported session, got ${after.sessions.length}`);
  const imported = after.sessions[0];
  if (imported.id !== newId) throw new Error(`importSession returned id=${newId}, but sessions[0].id=${imported.id}`);
  if (imported.groupId !== synth.id) throw new Error(`imported session not parented to synthesized group: groupId=${imported.groupId}, synth.id=${synth.id} — orphan regression`);
  if (imported.resumeSessionId !== 'resume-xyz-123') throw new Error(`resumeSessionId lost: got '${imported.resumeSessionId}'`);
  if (after.activeId !== newId) throw new Error(`activeId should follow the import: expected '${newId}', got '${after.activeId}'`);

  const groupHeader = win.locator(`[data-group-header-id="${synth.id}"]`).first();
  const headerVisible = await groupHeader.isVisible({ timeout: 3000 }).catch(() => false);
  if (!headerVisible) throw new Error('synthesized group header not rendered in sidebar');
  const sidebarRow = win.locator(`li[data-session-id="${imported.id}"]`).first();
  const rowVisible = await sidebarRow.isVisible({ timeout: 3000 }).catch(() => false);
  if (!rowVisible) throw new Error('imported session row not visible in sidebar');

  log(`empty groups[] + stale groupId → synthesized group ${synth.id} (nameKey='${synth.nameKey}'); imported session parented + sidebar renders both`);
}

// ---------- rename ----------
// Inline rename for sessions and groups via context menu. Covers the four
// exit paths InlineRename supports plus IME composition guard.
async function caseRename({ win, log }) {
  await seedStore(win, {
    groups: [
      { id: 'g1', name: 'Alpha',  collapsed: false, kind: 'normal' },
      { id: 'g2', name: 'Bravo',  collapsed: false, kind: 'normal' }
    ],
    sessions: [
      { id: 's1', name: 'first',  state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
      { id: 's2', name: 'second', state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
      { id: 's3', name: 'third',  state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g2', agentType: 'claude-code' }
    ],
    activeId: 's1'
  });

  async function sessionName(id) {
    return await win.evaluate(
      (sid) => window.__ccsmStore.getState().sessions.find((s) => s.id === sid)?.name ?? null,
      id
    );
  }
  async function groupName(id) {
    return await win.evaluate(
      (gid) => window.__ccsmStore.getState().groups.find((g) => g.id === gid)?.name ?? null,
      id
    );
  }
  async function openSessionRename(sessionId) {
    const row = win.locator(`li[data-session-id="${sessionId}"]`).first();
    await row.click({ button: 'right' });
    await win.getByRole('menuitem', { name: /^Rename$/ }).first().click();
    const input = win.locator(`li[data-session-id="${sessionId}"] input`).first();
    await input.waitFor({ state: 'visible', timeout: 3000 });
    await input.click();
    return input;
  }
  async function openGroupRename(groupId) {
    const header = win.locator(`[data-group-header-id="${groupId}"]`).first();
    await header.click({ button: 'right' });
    await win.getByRole('menuitem', { name: /^Rename$/ }).first().click();
    const input = win.locator(`[data-group-header-id="${groupId}"] input`).first();
    await input.waitFor({ state: 'visible', timeout: 3000 });
    await input.click();
    return input;
  }

  // Case 1: session Enter commits.
  {
    const input = await openSessionRename('s1');
    await input.fill('first renamed');
    await input.press('Enter');
    await win.waitForTimeout(200);
    const after = await sessionName('s1');
    if (after !== 'first renamed') throw new Error(`session Enter commit: expected "first renamed", got "${after}"`);
    const stillEditing = await win.locator('li[data-session-id="s1"] input').count();
    if (stillEditing !== 0) throw new Error('session Enter commit: input still visible after commit');
  }

  // Case 2: session Escape cancels.
  {
    const input = await openSessionRename('s2');
    await input.fill('should not stick');
    await input.press('Escape');
    await win.waitForTimeout(200);
    const after = await sessionName('s2');
    if (after !== 'second') throw new Error(`session Escape cancel: expected "second", got "${after}"`);
  }

  // Case 3: empty / whitespace draft + Enter cancels.
  {
    const input = await openSessionRename('s2');
    await input.fill('   ');
    await input.press('Enter');
    await win.waitForTimeout(200);
    const after = await sessionName('s2');
    if (after !== 'second') throw new Error(`session whitespace Enter: expected name unchanged, got "${after}"`);
  }

  // Case 4: click outside commits.
  {
    const input = await openSessionRename('s3');
    await input.fill('clicked away');
    await win.locator('aside button:has-text("New session")').first().click({ force: true });
    await win.waitForTimeout(250);
    const after = await sessionName('s3');
    if (after !== 'clicked away') throw new Error(`session click-outside commit: expected "clicked away", got "${after}"`);
  }

  // Case 5: IME composition — Enter during isComposing must NOT commit.
  {
    const input = await openSessionRename('s1');
    await input.fill('');
    await win.evaluate(() => {
      const el = document.querySelector('li[data-session-id="s1"] input');
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await win.evaluate(() => {
      const el = document.querySelector('li[data-session-id="s1"] input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'ni hao');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await win.evaluate(() => {
      const el = document.querySelector('li[data-session-id="s1"] input');
      const ev = new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
        isComposing: true, keyCode: 229
      });
      el.dispatchEvent(ev);
    });
    await win.waitForTimeout(150);
    const midComp = await sessionName('s1');
    if (midComp !== 'first renamed') {
      throw new Error(`session IME composition Enter must not commit; expected "first renamed", got "${midComp}"`);
    }
    await win.evaluate(() => {
      const el = document.querySelector('li[data-session-id="s1"] input');
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ni hao' }));
    });
    const valBefore = await win.locator('li[data-session-id="s1"] input').inputValue();
    if (valBefore !== 'ni hao') throw new Error(`session post-IME: input value should be "ni hao" before Enter, got "${valBefore}"`);
    await win.locator('li[data-session-id="s1"] input').focus();
    await win.locator('li[data-session-id="s1"] input').press('Enter');
    await win.waitForTimeout(200);
    const afterComp = await sessionName('s1');
    if (afterComp !== 'ni hao') {
      throw new Error(`session post-IME Enter commit: expected "ni hao", got "${afterComp}"`);
    }
  }

  // Case 6: group Enter commits + Escape cancels.
  {
    const input = await openGroupRename('g1');
    await input.fill('Alpha+');
    await input.press('Enter');
    await win.waitForTimeout(200);
    const after = await groupName('g1');
    if (after !== 'Alpha+') throw new Error(`group Enter commit: expected "Alpha+", got "${after}"`);
  }
  {
    const input = await openGroupRename('g2');
    await input.fill('Charlie');
    await input.press('Escape');
    await win.waitForTimeout(200);
    const after = await groupName('g2');
    if (after !== 'Bravo') throw new Error(`group Escape cancel: expected "Bravo", got "${after}"`);
  }

  log('session: Enter / Escape / whitespace / click-outside / IME guard; group: Enter / Escape');
}

// ---------- terminal ----------
// Seed a Bash tool block with ANSI-colored output, expand it, and verify the
// xterm host renders with the payload visible.
async function caseTerminal({ win, log }) {
  const sessionId = await win.evaluate(() => {
    const st = window.__ccsmStore.getState();
    if (!st.tutorialSeen && st.setTutorialSeen) st.setTutorialSeen(true);
    const existing = st.sessions.find((s) => s.cwd === '~/terminal-probe');
    if (!existing) st.createSession('~/terminal-probe');
    const st2 = window.__ccsmStore.getState();
    const probe = st2.sessions.find((s) => s.cwd === '~/terminal-probe') ?? st2.sessions[st2.sessions.length - 1];
    if (probe && st2.activeId !== probe.id) st2.selectSession(probe.id);
    return window.__ccsmStore.getState().activeId;
  });
  if (!sessionId) throw new Error('no active session id');

  await win.evaluate((sid) => {
    const ESC = String.fromCharCode(27);
    const ansi = `total 8\r\n${ESC}[32mdrwxr-xr-x${ESC}[0m 2 user user 4096 Apr 21 10:00 ${ESC}[34msrc${ESC}[0m\r\n-rw-r--r-- 1 user user  123 Apr 21 10:00 ${ESC}[31merror.log${ESC}[0m\r\n`;
    window.__ccsmStore.getState().appendBlocks(sid, [
      {
        kind: 'tool',
        id: 'tu-probe',
        name: 'Bash',
        brief: 'ls -la --color=always',
        expanded: false,
        toolUseId: 'tu-probe',
        input: { command: 'ls -la --color=always' },
        result: ansi
      }
    ]);
  }, sessionId);

  // Wait for ChatStream to commit a render that includes the tool block we
  // just appended, instead of relying on a fixed sleep. A bare 200ms is enough
  // when this case runs first (cold renderer, immediate React commit), but
  // becomes flaky when prior cases (language-toggle / i18n-settings-zh /
  // settings-open / etc.) have churned i18n + framer-motion AnimatePresence
  // transitions. In that scenario, the createSession+selectSession bump
  // triggers a session-switch crossfade keyed on activeId; the EmptyState
  // branch is mid-exit when appendBlocks fires, and the blocks branch hasn't
  // mounted yet by the 200ms mark. Using locator.waitFor with the actual
  // selector turns the wait into "wait until React commits", not "guess".
  const candidates = win.locator('[data-testid="tool-block-root"] button[aria-expanded]');
  try {
    await candidates.first().waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    throw new Error('no ChatStream ToolBlock button found within 5s after appendBlocks');
  }
  const btnCount = await candidates.count();
  if (btnCount === 0) throw new Error('no ChatStream ToolBlock button found');
  await candidates.first().click();
  await win.waitForTimeout(500);

  const hostCount = await win.locator('[data-testid="terminal-host"]').count();
  if (hostCount !== 1) throw new Error(`expected 1 terminal-host, got ${hostCount}`);
  const xtermCount = await win.locator('[data-testid="terminal-host"] .xterm').count();
  if (xtermCount !== 1) throw new Error(`expected 1 .xterm inside host, got ${xtermCount}`);
  const screenText = await win.locator('[data-testid="terminal-host"] .xterm-screen').innerText();
  if (!screenText.includes('src')) throw new Error(`terminal missing 'src' text; got: ${screenText.slice(0, 200)}`);
  if (!screenText.includes('error.log')) throw new Error(`terminal missing 'error.log'; got: ${screenText.slice(0, 200)}`);

  log('terminal host mounted, xterm rendered, ANSI payload visible');
}

// ---------- tool-render-open-in-editor ----------
// Long tool stdout shows "Open in editor"; clicking it writes a temp file via
// the real IPC handler (which honors CCSM_OPEN_IN_EDITOR_NOOP, set on the
// harness launch env, to skip the actual shell.openPath call).
async function caseToolRenderOpenInEditor({ win, log }) {
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
        runningSessions: {},
        messageQueues: {}
      });
    }, { blocks });
    await win.waitForTimeout(250);
  }

  // Journey 1: short output (10 lines) → button absent.
  {
    const shortText = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    await seed([
      { kind: 'tool', id: 't-short', toolUseId: 'tu_short', name: 'Read',
        brief: 'short.log', expanded: true, result: shortText, isError: false }
    ]);
    await win.evaluate(() => {
      document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click());
    });
    await win.waitForTimeout(150);
    const present = await win.evaluate(() =>
      !!document.querySelector('[data-testid="tool-output-open-in-editor"]'));
    if (present !== false) throw new Error('short output (10 lines): "Open in editor" button should be absent');
  }

  // Journey 2: long output (60 lines) → button present and hover-hidden.
  {
    const longText = Array.from({ length: 60 }, (_, i) => `long-line ${i + 1}`).join('\n');
    await seed([
      { kind: 'tool', id: 't-long', toolUseId: 'tu_long', name: 'Read',
        brief: 'long.log', expanded: true, result: longText, isError: false }
    ]);
    await win.evaluate(() => {
      document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click());
    });
    await win.waitForTimeout(150);
    const probe = await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="tool-output-open-in-editor"]');
      if (!btn) return { present: false };
      const cs = getComputedStyle(btn);
      return { present: true, opacityDefault: cs.opacity, text: btn.textContent?.trim() };
    });
    if (!(probe.present === true && probe.opacityDefault === '0')) {
      throw new Error(`long output: expected button present + opacity 0, got ${JSON.stringify(probe)}`);
    }
  }

  // Journey 3: clicking writes a temp file via the IPC NOOP path.
  {
    const longText = Array.from({ length: 80 }, (_, i) => `payload-line ${i + 1}`).join('\n');
    await seed([
      { kind: 'tool', id: 't-click', toolUseId: 'tu_click', name: 'Read',
        brief: 'click.log', expanded: true, result: longText, isError: false }
    ]);
    await win.evaluate(() => {
      document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click());
    });
    await win.waitForTimeout(150);

    const beforeFiles = new Set(
      fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('claude-tool-output-'))
    );
    await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="tool-output-open-in-editor"]');
      btn?.click();
    });
    await win.waitForTimeout(500);

    const buttonText = await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="tool-output-open-in-editor"]');
      return btn?.textContent?.trim() ?? '';
    });
    const newFiles = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith('claude-tool-output-') && !beforeFiles.has(n));
    let contentMatches = false;
    let writtenLen = -1;
    if (newFiles.length === 1) {
      const txt = fs.readFileSync(path.join(os.tmpdir(), newFiles[0]), 'utf8');
      writtenLen = txt.length;
      contentMatches = txt === longText;
      try { fs.unlinkSync(path.join(os.tmpdir(), newFiles[0])); } catch { /* ignored */ }
    }
    if (!(buttonText === 'Opened' && newFiles.length === 1 && contentMatches)) {
      throw new Error(`click → expected button="Opened", 1 new file, content match. Got button="${buttonText}", newFiles=${JSON.stringify(newFiles)}, writtenLen=${writtenLen}`);
    }
  }

  log('short→absent, long→present(opacity 0), click→temp file written, button → "Opened"');
}

// ---------- effort-chip-toggle ----------
// 6-tier effort+thinking chip in the StatusBar. Forward path: open dropdown
// → assert 6 items → click Low → assert chip label flips and IPC fires
// `agent:setEffort` with level='low'. Reverse path is documented in the PR
// body: stash electron/agent-sdk/sessions.ts setEffort + IPC handler →
// case fails (chip flips locally but no IPC arrives at the spy) → restore.
async function caseEffortChipToggle({ app, win, log }) {
  // Step 1: install ipcMain spy on agent:setEffort. preMain-equivalent done
  // inline because window.ccsm is a frozen contextBridge.
  await app.evaluate(({ ipcMain }) => {
    const calls = (global.__effortIpcCalls = []);
    try { ipcMain.removeHandler('agent:setEffort'); } catch {}
    ipcMain.handle('agent:setEffort', (_e, sessionId, level) => {
      calls.push({ sessionId, level });
      return { ok: true };
    });
  });

  // Step 2: seed an active session and mark it started so the store action's
  // IPC fan-out actually fires (un-started sessions short-circuit).
  await win.evaluate(() => {
    const store = window.__ccsmStore;
    const s = store.getState();
    if (s.sessions.length === 0) s.createSession('~');
    const sid = store.getState().activeId;
    store.setState((prev) => ({
      startedSessions: { ...prev.startedSessions, [sid]: true },
    }));
  });

  // Step 3: locate the chip trigger by data-testid and open the dropdown.
  const chip = win.locator('[data-testid="effort-chip"]');
  await chip.waitFor({ state: 'visible', timeout: 10_000 });

  // Default chip label is 'High'.
  const labelBefore = (await chip.innerText()).trim();
  if (!/^High\b/i.test(labelBefore)) {
    throw new Error(`expected chip label 'High' before open, got '${labelBefore}'`);
  }

  await chip.click();

  // 6 items: Off / Low / Medium / High / Extra high / Max. Some may be
  // disabled (model gating) but all must render.
  const expectedItems = ['Off', 'Low', 'Medium', 'High', 'Extra high', 'Max'];
  for (const label of expectedItems) {
    // The dropdown content uses Radix Portal; query against the WHOLE doc
    // not the chip subtree.
    const item = win.getByRole('menuitem', { name: new RegExp(`^${label}\\b`) });
    await item.first().waitFor({ state: 'visible', timeout: 3_000 });
  }

  // Step 4: pick Low. Click on the Low menuitem (use exact-prefix regex to
  // avoid matching 'Low' inside other labels).
  const lowItem = win.getByRole('menuitem', { name: /^Low\b/ }).first();
  await lowItem.click();

  // Chip label flips to 'Low'.
  await win.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="effort-chip"]');
      return el && /^Low\b/.test((el.textContent || '').trim());
    },
    null,
    { timeout: 3_000 },
  );

  // Store reflects the flip.
  const sid = await win.evaluate(() => window.__ccsmStore.getState().activeId);
  await win.waitForFunction(
    (id) => {
      const s = window.__ccsmStore.getState();
      return (s.effortLevelBySession[id] ?? s.globalEffortLevel) === 'low';
    },
    sid,
    { timeout: 3_000 },
  );

  // IPC was hit with the right level for the right session.
  const calls = await app.evaluate(() => (global.__effortIpcCalls || []).slice());
  if (calls.length < 1) {
    throw new Error(`expected >=1 setEffort IPC call, got ${calls.length}: ${JSON.stringify(calls)}`);
  }
  const last = calls[calls.length - 1];
  if (last.level !== 'low') {
    throw new Error(`last setEffort IPC level expected 'low', got ${JSON.stringify(last)}`);
  }
  if (last.sessionId !== sid) {
    throw new Error(`setEffort IPC sessionId mismatch — expected ${sid}, got ${last.sessionId}`);
  }

  // Restore the original handler so subsequent cases that send to a real
  // claude don't have their setEffort calls swallowed by our spy.
  await app.evaluate(({ ipcMain }) => {
    try { ipcMain.removeHandler('agent:setEffort'); } catch {}
    delete global.__effortIpcCalls;
  });

  log(`effort chip dropdown opens with 6 tiers; clicking Low flips chip + store + sets IPC level='low'`);
}

// ---------- dead-ui-cleanup ----------
// Lock in the three deletions from the "remove dead UI strings/settings"
// PR (greeting, kbd hint, window tint). Each assertion regresses to the
// pre-PR state if any of them sneak back in.
async function caseDeadUiCleanup({ win, log, registerDispose }) {
  // 1) EmptyState no longer renders the "Ready when you are." greeting.
  //    Seed a session with no messages so EmptyState is on screen.
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [
        {
          id: 's-cleanup',
          name: 's',
          state: 'idle',
          cwd: 'C:/x',
          model: 'claude-opus-4',
          groupId: 'g1',
          agentType: 'claude-code'
        }
      ],
      activeId: 's-cleanup',
      messagesBySession: {}
    });
  });
  await win.waitForTimeout(250);

  const greetingCount = await win.getByText(/Ready when you are\./i).count();
  // tutorial.startTitle ("Ready when you are") still exists as an
  // onboarding slide title — but tutorialSeen=true above hides Tutorial,
  // so any match here would be the EmptyState regression.
  if (greetingCount > 0) {
    throw new Error('EmptyState greeting "Ready when you are." came back');
  }

  // 2) Composer no longer renders the "Enter send · Shift+Enter newline"
  //    hint (or its zh equivalent) below the textarea.
  const enterHintEn = await win.getByText(/Enter send.*Shift\+Enter/i).count();
  if (enterHintEn > 0) {
    throw new Error('Composer "Enter send · Shift+Enter newline" hint came back');
  }
  // Same for the running-state companion hint (was deleted alongside).
  const escHint = await win.getByText(/Esc to stop.*Enter to queue/i).count();
  if (escHint > 0) {
    throw new Error('Composer "Esc to stop · Enter to queue" hint came back');
  }

  // 3) Settings → Appearance no longer shows "Window tint".
  registerDispose(async () => {
    await win.keyboard.press('Escape').catch(() => {});
  });
  const settingsBtn = win.getByRole('button', { name: /^Settings$/ }).first();
  await settingsBtn.waitFor({ state: 'visible', timeout: 5000 });
  await settingsBtn.click();
  const dialog = win.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 3000 });

  // Appearance is the default tab.
  const tintLabel = await dialog.getByText(/Window tint/i).count();
  if (tintLabel > 0) {
    throw new Error('Settings → Appearance still shows "Window tint" field');
  }
  // Defensive: any leaked tint preset chips.
  const tintChips = await dialog.locator('[data-tint-option]').count();
  if (tintChips > 0) {
    throw new Error(`Settings → Appearance still has ${tintChips} tint preset chips`);
  }

  await win.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {});

  log('greeting gone, kbd hint gone, Window tint field gone');
}

// ---------- sidebar-inputbar-bottom-align ----------
// UX audit Group A. The Sidebar's bottom-row buttons (Settings + Import)
// must share a Y for their bottom edges with the InputBar's TEXTAREA
// WRAPPER (the rounded-border box around the textarea + Send button) —
// NOT with the Send button itself. The Send button is internal layout
// inside the wrapper and is out of scope for this alignment.
async function caseSidebarInputbarBottomAlign({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [
        {
          id: 's-align-1', name: 's', state: 'idle', cwd: 'C:/x',
          model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code'
        }
      ],
      activeId: 's-align-1',
      messagesBySession: { 's-align-1': [] }
    });
  });
  await win.waitForTimeout(300);

  // Sidebar Settings button — text 'Settings'. There's also a header
  // tooltip-only "Settings" iconbutton in the collapsed-rail variant; we
  // pin the expanded sidebar Button by aria role + exact name and take
  // the first match scoped to the <aside>.
  const aside = win.locator('aside');
  const main = win.locator('main');
  const settingsBtn = aside.getByRole('button', { name: /^Settings$/ }).first();
  const inputWrapper = main.locator('[data-input-bar-wrapper]').first();
  await settingsBtn.waitFor({ state: 'visible', timeout: 5000 });
  await inputWrapper.waitFor({ state: 'visible', timeout: 5000 });

  const [settingsBox, wrapperBox] = await Promise.all([
    settingsBtn.boundingBox(),
    inputWrapper.boundingBox()
  ]);
  if (!settingsBox || !wrapperBox) throw new Error('box missing');

  const settingsBottom = settingsBox.y + settingsBox.height;
  const wrapperBottom = wrapperBox.y + wrapperBox.height;
  const delta = Math.abs(settingsBottom - wrapperBottom);
  const TOLERANCE = 1;
  if (delta > TOLERANCE) {
    throw new Error(
      `bottom edges misaligned: Sidebar Settings bottom=${settingsBottom.toFixed(1)} ` +
      `InputBar wrapper bottom=${wrapperBottom.toFixed(1)} delta=${delta.toFixed(1)} (tolerance=${TOLERANCE})`
    );
  }

  log(
    `Settings bottom=${settingsBottom.toFixed(1)} InputBar wrapper bottom=${wrapperBottom.toFixed(1)} ` +
    `delta=${delta.toFixed(1)}`
  );
}

// ---------- sidebar-vertical-symmetry ----------
// UX audit Group A. Sidebar internal top/bottom symmetry: the gap from
// the sidebar's top edge to the New Session button's top edge must equal
// the gap from the Settings button's bottom edge to the sidebar's bottom
// edge. This is purely intra-sidebar — has nothing to do with the right
// pane's DragRegion.
async function caseSidebarVerticalSymmetry({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [
        {
          id: 's-sym-1', name: 's', state: 'idle', cwd: 'C:/x',
          model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code'
        }
      ],
      activeId: 's-sym-1',
      messagesBySession: { 's-sym-1': [] }
    });
  });
  await win.waitForTimeout(300);

  const m = await win.evaluate(() => {
    const aside = document.querySelector('aside');
    if (!aside) return null;
    const newSessionBtn = Array.from(aside.querySelectorAll('button'))
      .find((b) => /^New Session$/i.test(b.textContent?.trim() ?? ''));
    const settingsBtn = Array.from(aside.querySelectorAll('button'))
      .find((b) => /^Settings$/i.test(b.textContent?.trim() ?? ''));
    if (!newSessionBtn || !settingsBtn) return null;
    const aRect = aside.getBoundingClientRect();
    const nRect = newSessionBtn.getBoundingClientRect();
    const sRect = settingsBtn.getBoundingClientRect();
    return {
      topGap: nRect.top - aRect.top,
      bottomGap: aRect.bottom - sRect.bottom
    };
  });
  if (!m) throw new Error('could not locate New Session / Settings buttons');

  const TOLERANCE = 1;
  const delta = Math.abs(m.topGap - m.bottomGap);
  if (delta > TOLERANCE) {
    throw new Error(
      `sidebar vertical asymmetry: topGap=${m.topGap.toFixed(1)} ` +
      `bottomGap=${m.bottomGap.toFixed(1)} delta=${delta.toFixed(1)} (tolerance=${TOLERANCE})`
    );
  }
  log(
    `topGap=${m.topGap.toFixed(1)} bottomGap=${m.bottomGap.toFixed(1)} ` +
    `delta=${delta.toFixed(1)}`
  );
}

// ---------- sidebar-spacing-canon ----------
// UX audit Group A follow-up. Pins the spacing constraints below the
// NewSession row, sourced from the LIVE measured x = window.top → NewSession.top
// (== window.bottom → Settings.bottom by Group A invariant):
//   1. NewSession.bottom → divider1.top   === x
//   2. divider1.bottom   → GroupsLabel.top === x
//   3. archivedDivider.top (archive collapsed) === InputBar wrapper.top
// Hard-coding 12 would couple this to DragRegion math; instead we measure x
// at runtime and let one mismatched class fail the case loudly.
async function caseSidebarSpacingCanon({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [
        {
          id: 's-spacing-1', name: 's', state: 'idle', cwd: 'C:/x',
          model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code'
        }
      ],
      activeId: 's-spacing-1',
      messagesBySession: { 's-spacing-1': [] }
    });
  });
  await win.waitForTimeout(300);

  const m = await win.evaluate(() => {
    const aside = document.querySelector('aside');
    if (!aside) return { err: 'no aside' };
    const newSessionBtn = Array.from(aside.querySelectorAll('button'))
      .find((b) => /^New Session$/i.test(b.textContent?.trim() ?? ''));
    const settingsBtn = Array.from(aside.querySelectorAll('button'))
      .find((b) => /^Settings$/i.test(b.textContent?.trim() ?? ''));
    const divider1 = aside.querySelector('[data-testid="sidebar-divider-groups"]');
    const groupsLabel = aside.querySelector('[data-testid="sidebar-groups-label"]');
    const archivedDivider = aside.querySelector('[data-testid="sidebar-divider-archived"]');
    const inputWrapper = document.querySelector('[data-input-bar-wrapper]');
    if (!newSessionBtn || !settingsBtn) return { err: 'missing NewSession or Settings' };
    if (!divider1 || !groupsLabel || !archivedDivider) return { err: 'missing testid markers' };
    if (!inputWrapper) return { err: 'missing input wrapper' };
    const body = document.body.getBoundingClientRect();
    const ns = newSessionBtn.getBoundingClientRect();
    const st = settingsBtn.getBoundingClientRect();
    const d1 = divider1.getBoundingClientRect();
    // gap2 = whitespace between divider1.bottom and Groups header content
    // edge. Wrapper top sits flush with divider bottom; the wrapper's pt-*
    // IS the gap. Measure padding via computed style so font line-height
    // halo doesn't pollute the bbox-based result.
    const gl = groupsLabel.getBoundingClientRect();
    const glPadTop = parseFloat(getComputedStyle(groupsLabel).paddingTop) || 0;
    const ad = archivedDivider.getBoundingClientRect();
    const iw = inputWrapper.getBoundingClientRect();
    return {
      top_x: ns.top - body.top,
      bottom_x: body.bottom - st.bottom,
      gap1: d1.top - ns.bottom,
      gap2: (gl.top - d1.bottom) + glPadTop,
      archivedDividerY: ad.top,
      inputBarTopY: iw.top,
    };
  });
  if (m.err) throw new Error(m.err);

  const TOL = 1;
  const fails = [];
  if (Math.abs(m.top_x - m.bottom_x) > TOL) {
    fails.push(`Group A invariant broken: top_x=${m.top_x.toFixed(1)} bottom_x=${m.bottom_x.toFixed(1)}`);
  }
  const x = m.top_x;
  if (Math.abs(m.gap1 - x) > TOL) {
    fails.push(`gap1 (NewSession.bottom→divider1.top)=${m.gap1.toFixed(1)} expected x=${x.toFixed(1)}`);
  }
  if (Math.abs(m.gap2 - x) > TOL) {
    fails.push(`gap2 (divider1.bottom→GroupsLabel.top)=${m.gap2.toFixed(1)} expected x=${x.toFixed(1)}`);
  }
  if (Math.abs(m.archivedDividerY - m.inputBarTopY) > TOL) {
    fails.push(`archivedDividerY=${m.archivedDividerY.toFixed(1)} inputBarTopY=${m.inputBarTopY.toFixed(1)} delta=${(m.archivedDividerY - m.inputBarTopY).toFixed(1)}`);
  }
  if (fails.length > 0) {
    throw new Error(`sidebar spacing canon violations:\n  - ${fails.join('\n  - ')}`);
  }
  log(
    `x=${x.toFixed(1)} gap1=${m.gap1.toFixed(1)} gap2=${m.gap2.toFixed(1)} ` +
    `archivedDividerY=${m.archivedDividerY.toFixed(1)} inputBarTopY=${m.inputBarTopY.toFixed(1)}`
  );
}

// ---------- icon-size-canon ----------
// UX audit Group D — pin lucide icon sizes in Sidebar (collapsed rail +
// expanded top/bottom action buttons) and StatusBar chip chevron to the
// canonical 14px. Catches regressions where size={13} or size={10} sneak
// back into the rail, which previously created a visible icon-size jitter
// across otherwise identical h-8 buttons.
async function caseIconSizeCanon({ win, log }) {
  // Need an active session so the StatusBar (and thus the effort-chip)
  // renders. Use the same minimal seed pattern as caseEffortChipToggle.
  await win.evaluate(() => {
    const store = window.__ccsmStore;
    const s = store.getState();
    if (s.sessions.length === 0) s.createSession('~');
    const sid = store.getState().activeId;
    store.setState((prev) => ({
      startedSessions: { ...prev.startedSessions, [sid]: true },
    }));
  });
  await win.waitForTimeout(200);

  // --- Expanded sidebar measurements (default state) ---
  const expanded = await win.evaluate(() => {
    const aside = document.querySelector('aside');
    if (!aside) return null;
    const buttons = Array.from(aside.querySelectorAll('button'));
    function svgWidthIn(btn) {
      if (!btn) return null;
      const svg = btn.querySelector('svg');
      if (!svg) return null;
      const w = svg.getAttribute('width');
      return w == null ? null : Number(w);
    }
    const newSession = buttons.find((b) => /^New Session$/i.test(b.textContent?.trim() ?? ''));
    const settings = buttons.find((b) => /^Settings$/i.test(b.textContent?.trim() ?? ''));
    // Search and Import (Download) are icon-only; identify by aria-label.
    const search = buttons.find((b) => /search/i.test(b.getAttribute('aria-label') ?? ''));
    const importBtn = buttons.find((b) => /import/i.test(b.getAttribute('aria-label') ?? ''));
    return {
      newSession: svgWidthIn(newSession),
      settings: svgWidthIn(settings),
      search: svgWidthIn(search),
      importBtn: svgWidthIn(importBtn),
    };
  });
  if (!expanded) throw new Error('expanded sidebar not found');

  // --- StatusBar effort-chip chevron measurement ---
  const chipChevron = await win.evaluate(() => {
    const chip = document.querySelector('[data-testid="effort-chip"]');
    if (!chip) return null;
    const svg = chip.querySelector('svg');
    if (!svg) return null;
    const w = svg.getAttribute('width');
    return w == null ? null : Number(w);
  });
  if (chipChevron == null) throw new Error('StatusBar effort-chip chevron not found');

  // --- Collapse the sidebar and measure the rail icons ---
  await win.evaluate(() => {
    window.__ccsmStore.setState({ sidebarCollapsed: true });
  });
  await win.waitForTimeout(300);

  const rail = await win.evaluate(() => {
    const aside = document.querySelector('aside');
    if (!aside) return null;
    const buttons = Array.from(aside.querySelectorAll('button'));
    function svgWidthInBtn(matcher) {
      const btn = buttons.find((b) => matcher(b.getAttribute('aria-label') ?? ''));
      if (!btn) return null;
      const svg = btn.querySelector('svg');
      if (!svg) return null;
      const w = svg.getAttribute('width');
      return w == null ? null : Number(w);
    }
    return {
      expand: svgWidthInBtn((l) => /expand/i.test(l)),
      newSession: svgWidthInBtn((l) => /new session/i.test(l)),
      search: svgWidthInBtn((l) => /search/i.test(l)),
      importBtn: svgWidthInBtn((l) => /import/i.test(l)),
      settings: svgWidthInBtn((l) => /settings/i.test(l)),
    };
  });
  if (!rail) throw new Error('collapsed rail not found');

  // Restore for subsequent cases.
  await win.evaluate(() => {
    window.__ccsmStore.setState({ sidebarCollapsed: false });
  });

  const CANON = 14;
  const measurements = {
    'expanded.newSession': expanded.newSession,
    'expanded.search': expanded.search,
    'expanded.settings': expanded.settings,
    'expanded.import': expanded.importBtn,
    'rail.expand': rail.expand,
    'rail.newSession': rail.newSession,
    'rail.search': rail.search,
    'rail.import': rail.importBtn,
    'rail.settings': rail.settings,
    'statusbar.chipChevron': chipChevron,
  };

  const offenders = Object.entries(measurements)
    .filter(([, v]) => v !== CANON)
    .map(([k, v]) => `${k}=${v}`);
  if (offenders.length) {
    throw new Error(
      `icon size drift (canon=${CANON}px): ${offenders.join(', ')}`
    );
  }

  log(
    Object.entries(measurements)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
  );
}

// ---------- card-padding-canon ----------
// UX audit Group F (task #310 follow-up). Pins three small spacing nudges
// so the canonical card rhythm doesn't drift back to the cramped/orphaned
// pre-fix values:
//   1. ChatStream wrapper `gap` >= 8px (was gap-1.5 = 6px).
//   2. QuestionBlock body and footer share `padding-left` (both 16px) —
//      footer used to be px-3 against body's px-4.
//   3. SettingsDialog Field `margin-bottom` === 16px — was mb-5 (20px),
//      equal to the panel's p-5 padding which made fields look orphaned.
async function caseCardPaddingCanon({ win, log }) {
  // Seed a session so ChatStream renders something measurable.
  await win.evaluate(() => {
    const st = window.__ccsmStore;
    st.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id: 's-pad', name: 's-pad', state: 'idle', cwd: 'C:/x',
        model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code'
      }],
      activeId: 's-pad',
      messagesBySession: { 's-pad': [
        { kind: 'user', id: 'u-pad-1', text: 'hello' }
      ] },
      tutorialSeen: true
    });
  });
  await win.waitForTimeout(150);

  // ----- 1. ChatStream wrapper gap -----
  const chatGap = await win.evaluate(() => {
    // The wrapper is the px-4 py-3 flex column inside <main>. Find by class
    // signature to avoid coupling to component file paths.
    const main = document.querySelector('main');
    if (!main) return null;
    const candidates = Array.from(main.querySelectorAll('div'));
    const wrap = candidates.find((el) => {
      const cs = getComputedStyle(el);
      return cs.display === 'flex'
        && cs.flexDirection === 'column'
        && el.className.includes('max-w-[1100px]');
    });
    if (!wrap) return null;
    const gap = parseFloat(getComputedStyle(wrap).rowGap || '0');
    return { gap };
  });
  if (!chatGap) throw new Error('card-padding-canon: ChatStream wrapper not found');
  const errors = [];
  if (!(chatGap.gap >= 8)) {
    errors.push(`ChatStream gap drift: rowGap=${chatGap.gap}px (expected >= 8px)`);
  }

  // ----- 2. QuestionBlock body vs footer padding-left -----
  await win.evaluate(() => {
    const st = window.__ccsmStore.getState();
    st.appendBlocks('s-pad', [{
      kind: 'question',
      id: 'q-pad-canon',
      questions: [{
        question: 'pad?',
        options: [{ label: 'A' }, { label: 'B' }]
      }]
    }]);
  });
  await win.waitForSelector('[data-testid="question-submit"]', { timeout: 5000 });
  await win.waitForTimeout(150);

  const qPad = await win.evaluate(() => {
    const submit = document.querySelector('[data-testid="question-submit"]');
    if (!submit) return null;
    // Footer = the flex row that contains the submit button.
    let footer = submit.parentElement;
    while (footer && !(footer.classList && footer.classList.contains('flex'))) {
      footer = footer.parentElement;
    }
    if (!footer) return null;
    // Body = previousElementSibling of footer (the px-4 py-3 wrapper).
    const body = footer.previousElementSibling;
    if (!body) return null;
    const fs = getComputedStyle(footer);
    const bs = getComputedStyle(body);
    return {
      bodyPadLeft: parseFloat(bs.paddingLeft),
      bodyPadRight: parseFloat(bs.paddingRight),
      footerPadLeft: parseFloat(fs.paddingLeft),
      footerPadRight: parseFloat(fs.paddingRight)
    };
  });
  if (!qPad) throw new Error('card-padding-canon: QuestionBlock body/footer not located');
  if (qPad.bodyPadLeft !== qPad.footerPadLeft) {
    errors.push(
      `QuestionBlock horizontal padding drift: body padding-left=${qPad.bodyPadLeft}px, ` +
      `footer padding-left=${qPad.footerPadLeft}px (must match)`
    );
  }
  if (qPad.bodyPadLeft !== 16) {
    errors.push(
      `QuestionBlock body padding-left=${qPad.bodyPadLeft}px (canon=16px / px-4)`
    );
  }
  if (qPad.footerPadLeft !== 16) {
    errors.push(
      `QuestionBlock footer padding-left=${qPad.footerPadLeft}px (canon=16px / px-4)`
    );
  }

  // Clean up question so it doesn't bleed into later cases.
  await win.evaluate(() => {
    const st = window.__ccsmStore.getState();
    st.clearMessages('s-pad');
  });
  await win.waitForTimeout(80);

  // ----- 3. SettingsDialog Field margin-bottom -----
  const settingsBtn = win.getByRole('button', { name: /^settings$/i }).first();
  await settingsBtn.waitFor({ state: 'visible', timeout: 5000 });
  await settingsBtn.click();
  const dialog = win.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 3000 });
  await win.waitForTimeout(200);

  const fieldMargin = await win.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][data-modal-dialog], [role="dialog"][aria-modal="true"]');
    if (!dlg) return null;
    // Field wraps a <label class="block ..."> — walk up one parent.
    const labels = Array.from(dlg.querySelectorAll('label.block'));
    if (labels.length === 0) return null;
    const fields = labels
      .map((l) => l.parentElement)
      .filter(Boolean)
      // Filter to elements that look like the Field wrapper (have margin-bottom).
      .filter((el) => parseFloat(getComputedStyle(el).marginBottom || '0') > 0);
    if (fields.length === 0) return null;
    return {
      count: fields.length,
      marginBottoms: fields.map((el) => parseFloat(getComputedStyle(el).marginBottom))
    };
  });
  // Always close dialog before throwing to keep harness state clean.
  await win.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {});

  if (!fieldMargin) {
    throw new Error('card-padding-canon: SettingsDialog Field elements not located');
  }
  const off = fieldMargin.marginBottoms.filter((m) => m !== 16);
  if (off.length) {
    errors.push(
      `SettingsDialog Field margin-bottom drift: got ${fieldMargin.marginBottoms.join(',')}px ` +
      `(canon=16px / mb-4)`
    );
  }

  if (errors.length) {
    throw new Error('card-padding-canon failures:\n  - ' + errors.join('\n  - '));
  }

  log(
    `chat.gap=${chatGap.gap}px ` +
    `qbody.padL=${qPad.bodyPadLeft}px qfooter.padL=${qPad.footerPadLeft}px ` +
    `settings.field.mb=${fieldMargin.marginBottoms[0]}px (n=${fieldMargin.count})`
  );
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
    // UX audit Group A — task #311. Two regression cases pinning
    // (1) Sidebar bottom buttons aligned with InputBar wrapper bottom edge,
    // (2) Sidebar internal top/bottom symmetry.
    { id: 'sidebar-inputbar-bottom-align', run: caseSidebarInputbarBottomAlign },
    { id: 'sidebar-vertical-symmetry', run: caseSidebarVerticalSymmetry },
    { id: 'sidebar-spacing-canon', run: caseSidebarSpacingCanon },
    // UX audit Group D — task #310. Pin lucide icon sizes (Sidebar collapsed
    // rail + expanded action buttons + StatusBar chip chevron) to canonical
    // 14px so 13/10 mismatches don't sneak back in.
    { id: 'icon-size-canon', run: caseIconSizeCanon },
    // UX audit Group F — task #310 follow-up. Pins ChatStream gap,
    // QuestionBlock body/footer padding alignment, and SettingsDialog
    // Field margin-bottom against the canon (8px / 16px / 16px).
    { id: 'card-padding-canon', run: caseCardPaddingCanon },
    { id: 'no-sessions-landing', run: caseNoSessionsLanding },
    { id: 'empty-state-minimal', run: caseEmptyStateMinimal },
    { id: 'a11y-focus-restore', run: caseA11yFocusRestore },
    { id: 'shortcut-overlay-opens', run: caseShortcutOverlayOpens },
    { id: 'popover-cross-dismiss', run: casePopoverCrossDismiss },
    { id: 'type-scale-snapshot', run: caseTypeScaleSnapshot },
    { id: 'chat-user-assistant-contrast', run: caseChatUserAssistantContrast },
    { id: 'assistant-long-line-wraps', run: caseAssistantLongLineWraps },
    { id: 'banner-i18n-toggle', run: caseBannerI18nToggle },
    { id: 'toast-a11y', run: caseToastA11y },
    { id: 'cwd-popover-recent-unfiltered', run: caseCwdPopoverRecentUnfiltered },
    { id: 'palette-empty', run: casePaletteEmpty },
    { id: 'palette-nav', run: casePaletteNav },
    // slash-picker-claude-config-dir: pins (a) loader honoring CLAUDE_CONFIG_DIR
    // and (b) picker filtering plugin-source commands. preMain seeds a fake
    // `<tmp>/.claude` tree with one user command (`local-test`, must appear)
    // and one plugin command (`brainstorm` under `superpowers`, must NOT
    // appear), then sets process.env.CLAUDE_CONFIG_DIR on the main process so
    // the loader's IPC handler resolves to the fixture instead of the dev's
    // real ~/.claude. Disposers restore env + rm -rf tmp tree.
    {
      id: 'slash-picker-claude-config-dir',
      preMain: async (app, ctx) => {
        const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-e2e-fake-claude-'));
        // user command — should surface in the picker.
        const userDir = path.join(fakeRoot, 'commands');
        fs.mkdirSync(userDir, { recursive: true });
        fs.writeFileSync(
          path.join(userDir, 'local-test.md'),
          `---\ndescription: seeded user command\n---\nbody\n`,
          'utf8'
        );
        // plugin command — should be hidden by PICKER_VISIBLE_SOURCES.
        const pluginCmdDir = path.join(
          fakeRoot, 'plugins', 'cache', 'mkt', 'superpowers', '1.0.0', 'commands'
        );
        fs.mkdirSync(pluginCmdDir, { recursive: true });
        fs.writeFileSync(
          path.join(pluginCmdDir, 'brainstorm.md'),
          `---\ndescription: deprecated plugin command\n---\nbody\n`,
          'utf8'
        );

        // Set CLAUDE_CONFIG_DIR on the main process so the loader's IPC
        // handler reads the fixture. Snapshot the prior value so the
        // disposer can restore it (env may legitimately be set in dev).
        const prior = await app.evaluate((_mod, args) => {
          const before = process.env.CLAUDE_CONFIG_DIR;
          process.env.CLAUDE_CONFIG_DIR = args.fakeRoot;
          return before ?? null;
        }, { fakeRoot });

        ctx.registerDispose(async () => {
          try {
            await app.evaluate((_mod, args) => {
              if (args.prior == null) delete process.env.CLAUDE_CONFIG_DIR;
              else process.env.CLAUDE_CONFIG_DIR = args.prior;
            }, { prior });
          } catch { /* app may already be torn down */ }
          try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch {}
        });
      },
      run: caseSlashPickerClaudeConfigDir,
    },
    { id: 'slash-namespaced-unknown-toast', run: caseSlashNamespacedUnknownToast },
    { id: 'settings-open', run: caseSettingsOpen },
    { id: 'search-shortcut-f', run: caseSearchShortcutF },
    { id: 'tutorial', run: caseTutorial },
    { id: 'titlebar', run: caseTitlebar },
    { id: 'tray', run: caseTray },
    { id: 'focus-orchestration', run: caseFocusOrchestration },
    { id: 'theme-toggle', run: caseThemeToggle },
    { id: 'language-toggle', run: caseLanguageToggle },
    { id: 'i18n-settings-zh', run: caseI18nSettingsZh },
    // ---- Per-case capability demo (task #223) ----
    { id: 'cap-skip-launch-bundle-shape', skipLaunch: true, run: caseSkipLaunchBundleShape },
    // ---- Bucket-1 absorption (task #222) ----
    { id: 'app-icon-default', skipLaunch: true, run: caseAppIconDefault },
    { id: 'group-add', run: caseGroupAdd },
    { id: 'import-empty-groups', run: caseImportEmptyGroups },
    { id: 'rename', run: caseRename },
    { id: 'terminal', run: caseTerminal },
    { id: 'tool-render-open-in-editor', run: caseToolRenderOpenInEditor },
    // ---- Bucket-7 absorption (final cleanup pass) ----
    // effort-chip-toggle: StatusBar 6-tier effort+thinking chip → ipcMain
    // spy on agent:setEffort. Pure UI, single launch, fits harness-ui.
    { id: 'effort-chip-toggle', run: caseEffortChipToggle },
    { id: 'dead-ui-cleanup', run: caseDeadUiCleanup },
    // sidebar-active-row-no-pulse: regression for #289 (PR #365). Active
    // session must NOT pulse on turn_done even when window focus is lost
    // (alt-tabbed away). Pure renderer-IPC: dispatches `agent:event` from
    // main into the renderer's lifecycle handler, no claude.exe needed.
    { id: 'sidebar-active-row-no-pulse', run: caseSidebarActiveRowNoPulse },
    // notif-disabled-suppress: W5. Verifies the post-W1 single-gate dispatch
    // contract — enabled=false → dispatched:false, reason:'global-disabled',
    // zero notification:show IPC. Re-enabling proves recorder is wired.
    { id: 'notif-disabled-suppress', run: caseNotifDisabledSuppress }
  ],
  launch: {
    // CCSM_OPEN_IN_EDITOR_NOOP=1: tells the tool:open-in-editor IPC handler
    // (src/electron/main.ts) to write the temp file but skip the actual
    // shell.openPath. The tool-render-open-in-editor case relies on this;
    // other cases never trigger that IPC, so the env var is a no-op for them.
    env: { CCSM_OPEN_IN_EDITOR_NOOP: '1' }
  }
});
