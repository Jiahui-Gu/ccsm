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
//   - sidebar-vertical-symmetry            (UX audit Group A internal symmetry)
//   - sidebar-long-name-truncates          (fp13-A, long name truncation + tooltip)
//   - no-sessions-landing                  (probe-e2e-no-sessions-landing)
//   - shortcut-overlay-opens               (UI-1 / #188)
//   - toast-a11y                           (#298 follow-up)
//   - palette-empty                        (probe-e2e-palette-empty, #117 / #258)
//   - palette-nav                          (probe-e2e-palette-nav)
//   - settings-open                        (probe-e2e-settings-open, sidebar + Cmd+,)
//   - settings-updates-pane                (Settings → Updates pane render contract)
//   - search-shortcut-f                    (probe-e2e-search-shortcut-f)
//   - tutorial                             (probe-e2e-tutorial)
//   - titlebar                             (probe-e2e-titlebar)
//   - tray                                 (probe-e2e-tray)
//   - theme-toggle                         (probe-e2e-theme-toggle)
//   - language-toggle                      (probe-e2e-language-toggle)
//   - i18n-settings-zh                     (probe-e2e-i18n-settings-zh)
//   - notif-disabled-suppress              (REMOVED in PR-D alongside the Notifications pane)
//   - app-icon-default                     (probe-e2e-app-icon-default, skipLaunch)
//   - cap-skip-launch-bundle-shape         (capability demo, skipLaunch)
//   - group-add                            (probe-e2e-group-add)
//   - import-empty-groups                  (probe-e2e-import-empty-groups)
//   - rename                               (sidebar session/group rename)
//   - startup-paints-before-hydrate        (perf/startup-render-gate)
//   - ttyd-pane-webview-mounted            (W2c App→TtydPane wiring contract)
//
// W3.5e cleanup: cases that exercised the SDK chat pane (composer/InputBar,
// EffortChip, ContextPieChip, slash picker, ToolBlock, QuestionBlock,
// AssistantBlock, UserBlock, ChatStream, popover-cross-dismiss on cwd-chip,
// type-scale-snapshot on assistant/tool blocks, dead-ui-cleanup composer
// hint, sidebar-spacing/inputbar-bottom alignment, icon-size-canon's
// effort-chip chevron, card-padding-canon's QuestionBlock measurements,
// chatstream-footer-stable, terminal/tool-render-open-in-editor,
// empty-state-minimal composer hint, banner-i18n-toggle agent banners,
// focus-orchestration composer textarea, sidebar-active-row-no-pulse
// runningSessions store field) were deleted wholesale: the right pane is
// now a ttyd webview with no React chat surface to assert against.
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

import { runHarness, mod } from './probe-helpers/harness-runner.mjs';
import { seedStore } from './probe-utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
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
      messagesBySession: { s1: [] },
      tutorialSeen: true
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

  // Modifier labels must match the current platform: macOS renders ⌘/⇧,
  // Windows/Linux renders Ctrl/Shift. Assert the correct set for each OS.
  const labelDump = await overlay.evaluate((el) => {
    const text = el.textContent || '';
    const kbds = Array.from(el.querySelectorAll('kbd')).map((k) => k.textContent || '');
    return { text, kbds };
  });
  if (process.platform === 'darwin') {
    // macOS: expect ⌘ glyph, must NOT render "Ctrl".
    if (!labelDump.kbds.some((k) => /[⌘]/.test(k))) {
      throw new Error('expected at least one "⌘" kbd chip on macOS; got=' + JSON.stringify(labelDump.kbds));
    }
  } else {
    // Windows/Linux: must NOT render mac glyphs.
    if (/[⌘⇧]/.test(labelDump.text)) {
      throw new Error('shortcut overlay still renders mac glyphs (⌘/⇧); kbds=' + JSON.stringify(labelDump.kbds));
    }
    if (/\bCmd\b/i.test(labelDump.text)) {
      throw new Error('shortcut overlay still renders "Cmd"; text=' + labelDump.text.slice(0, 200));
    }
    if (!labelDump.kbds.includes('Ctrl')) {
      throw new Error('expected at least one "Ctrl" kbd chip; got=' + JSON.stringify(labelDump.kbds));
    }
  }

  // Escape dismisses. Focus the overlay first — Radix Dialog's Esc handler
  // routes through DismissableLayer's document keydown listener, which only
  // fires when the dispatched key has the focused layer in scope. After
  // chained `win.evaluate()` calls during the open/assert path, focus may
  // have drifted back to body in the harness sequence; an explicit focus
  // shift makes the close behavior deterministic on win32.
  await win.locator('[data-shortcut-overlay]').first().focus().catch(() => {});
  await win.keyboard.press('Escape');
  const closed = await win.waitForFunction(
    () => !document.querySelector('[data-shortcut-overlay]'),
    null,
    { timeout: 5000 }
  ).then(() => true).catch(() => false);
  if (!closed) throw new Error('overlay still present after Escape');

  // Cmd/Ctrl+/ as the alternative trigger — Control on all harness hosts.
  await win.keyboard.press(`${mod}+/`);
  try {
    await overlay.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    throw new Error(`shortcut overlay did not appear after ${mod}+/`);
  }
  await win.keyboard.press('Escape');

  // SidebarHeader tooltip + CommandPalette hints must match the platform.
  // Open the palette and assert its hint chips use the correct modifier.
  // Note: per-row `Ctrl+N` style hint chips only render once results are
  // visible, which requires a non-empty query (CommandPalette renders
  // an emptyHint placeholder while `q` is empty). So we must type a query
  // before asserting on hint text.
  const paletteOpenedAfterShortcut = await win.evaluate((isMac) => {
    const ev = new KeyboardEvent('keydown', {
      key: 'f',
      code: 'KeyF',
      ctrlKey: !isMac,
      metaKey: isMac,
      bubbles: true
    });
    window.dispatchEvent(ev);
    return new Promise((resolve) =>
      setTimeout(() => resolve(!!document.querySelector('[role="dialog"]')), 250)
    );
  }, process.platform === 'darwin');
  if (!paletteOpenedAfterShortcut) {
    log(`skipped palette hint check: palette did not open via ${mod}+F`);
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
    // Navigator is spoofed to MacIntel above, so the renderer's MOD constant
    // resolves to '⌘' regardless of the host OS.  Assert mac-style hints.
    if (/\bCtrl\b/.test(paletteText)) {
      throw new Error('command palette renders "Ctrl" despite navigator spoof to MacIntel; text=' + paletteText.slice(0, 200));
    }
    await win.keyboard.press('Escape');
  }

  log(`overlay opened via ? and ${mod}+/, ${kbdCount} kbd chips, platform-correct labels verified`);
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

  // Open palette via synthetic keydown. On macOS the handler checks metaKey,
  // on Windows/Linux it checks ctrlKey. If the synthetic event doesn't work
  // (Electron may intercept Cmd+F on macOS), fall back to a direct store call.
  await win.evaluate((isMac) => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'f', code: 'KeyF',
        ctrlKey: !isMac, metaKey: isMac,
        bubbles: true
      })
    );
  }, process.platform === 'darwin');

  const searchInput = win.locator('input[placeholder*="Search"]');
  let paletteOpened = await searchInput.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
  if (!paletteOpened) {
    // Fallback: directly toggle the palette via store/React state.
    await win.evaluate(() => {
      const ev = new KeyboardEvent('keydown', {
        key: 'f', code: 'KeyF', ctrlKey: true, metaKey: true, bubbles: true
      });
      window.dispatchEvent(ev);
    });
    paletteOpened = await searchInput.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
  }
  if (!paletteOpened) {
    throw new Error(`palette did not open via ${mod}+F — search input never appeared`);
  }

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

  // Open palette — use correct modifier key per platform; fall back if
  // Electron intercepts the accelerator before the React handler.
  await win.evaluate((isMac) => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'f', code: 'KeyF',
        ctrlKey: !isMac, metaKey: isMac,
        bubbles: true
      })
    );
  }, process.platform === 'darwin');

  const searchInput = win.locator('input[placeholder*="Search"]');
  let paletteOpened = await searchInput.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
  if (!paletteOpened) {
    await win.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f', code: 'KeyF', ctrlKey: true, metaKey: true, bubbles: true
        })
      );
    });
    paletteOpened = await searchInput.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
  }
  if (!paletteOpened) {
    throw new Error(`palette did not open via ${mod}+F`);
  }

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

  log(`${mod}+F opens; ↓/↑ moves active row; Enter selects s-nav-B`);
}

// ---------- settings-open ----------
// Settings dialog open/close — three entry points reach ONE dialog.
async function caseSettingsOpen({ win, log }) {
  // Seed a session so the right pane mounts (Sidebar Settings button always
  // shows, but parity with other cases keeps the harness state consistent).
  // Post-ttyd refactor: the in-chat /config slash entry-point is gone with
  // the composer; only sidebar button + Cmd/Ctrl+, remain as entry points.
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

  // Use the Settings tablist as the unique tell — there are other role=dialog
  // surfaces (Tutorial, CommandPalette) that may linger across cases; we only
  // care that the Settings dialog specifically opens / closes.
  const settingsTab = win.getByRole('tab', { name: /^connection$/i });

  async function expectSettingsClosed(label) {
    // Win32 dialog unmount under heavy harness load can lag past the prior
    // 1.5s budget; allow more headroom before declaring the dialog stuck.
    await settingsTab.first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    if ((await settingsTab.count()) > 0) throw new Error(`${label}: Settings dialog still mounted after expected close`);
  }
  async function expectSettingsDialogOpen(label) {
    await settingsTab.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
      throw new Error(`${label}: Settings dialog never became visible`);
    });
  }
  async function pressEscAndExpectClosed(label) {
    // Sidebar/button trigger leaves focus on the originating element; the
    // Radix DismissableLayer Esc handler runs reliably only when the focused
    // layer is the dialog itself. Force focus to the dialog before pressing
    // Escape so the close path is deterministic across platforms.
    await win.getByRole('dialog').first().focus().catch(() => {});
    await win.keyboard.press('Escape');
    await expectSettingsClosed(label);
  }

  // 1. Sidebar Settings button.
  const sidebarBtn = win.getByRole('button', { name: /^settings$/i }).first();
  await sidebarBtn.waitFor({ state: 'visible', timeout: 5000 });
  await sidebarBtn.click();
  await expectSettingsDialogOpen('sidebar button');
  await pressEscAndExpectClosed('sidebar button');

  // 2. Keyboard shortcut Cmd/Ctrl+,.
  await win.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await win.keyboard.press(`${mod}+,`);
  await expectSettingsDialogOpen('keyboard shortcut');
  await pressEscAndExpectClosed('keyboard shortcut');

  log('sidebar / Cmd+, both open Settings; Esc closes');
}

// ---------- settings-updates-pane ----------
// Settings → Updates tab renders the current version + status line driven
// by `electron/updater.ts` over the `updates:status` IPC channel. Today
// `updates:status` returns `{ kind: 'idle' }` in dev (autoUpdater short-
// circuits when !app.isPackaged) so the displayed status line should
// match the i18n `updates.statusIdle` copy. This case guards the contract
// the UpdateBanner / dogfood toast both depend on: that the pane mounts,
// reads the IPC bridge, and surfaces a sane status string instead of an
// empty placeholder.
//
// We DO NOT exercise the install button here — quitAndInstall would tear
// down the app mid-test. The download path is also gated behind
// `app.isPackaged`, so there's no value in clicking those CTAs.
async function caseSettingsUpdatesPane({ win, log }) {
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      messagesBySession: { s1: [] },
      tutorialSeen: true,
    });
  });
  await win.waitForTimeout(150);

  // Open Settings via the keyboard shortcut so this case doesn't depend on
  // the sidebar button position. (Custom 'ccsm:open-settings' window event
  // wiring was removed with the SDK pane; Cmd/Ctrl+, is the canonical
  // entry point now.)
  await win.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await win.keyboard.press(`${mod}+,`);
  const dialog = win.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 3000 });

  // Switch to the Updates tab. Tab labels are i18n strings; the case
  // runs in default English so the regex is fine. Multilingual variants
  // are covered by `i18n-settings-zh`.
  const updatesTab = dialog.getByRole('tab', { name: /^updates$/i });
  await updatesTab.waitFor({ state: 'visible', timeout: 1500 });
  await updatesTab.click();

  // The pane's tabpanel is `settings-panel-updates`.
  const panel = dialog.locator('#settings-panel-updates');
  await panel.waitFor({ state: 'visible', timeout: 1500 });

  // Version + Status field labels are sentence-case ("Version", "Status")
  // — assert they're visible inside the panel.
  const text = (await panel.textContent()) || '';
  if (!/Version/i.test(text)) {
    throw new Error('updates pane missing "Version" label');
  }
  if (!/Status/i.test(text)) {
    throw new Error('updates pane missing "Status" label');
  }
  // Dev runs hit the `not-packaged` short-circuit so `safeCheck` broadcasts
  // `{ kind: 'not-available' }` on boot — the i18n `statusNotAvailable`
  // copy ("You are on the latest version.") should render. We accept
  // either the not-available or the idle line so this case stays resilient
  // to future startup-broadcast changes (e.g. delaying the boot check).
  const statusOk = await Promise.race([
    panel.getByText('You are on the latest version.').waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false),
    panel.getByText('No update check performed yet.').waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false),
  ]);
  if (!statusOk) {
    const dump = (await panel.textContent()) || '';
    throw new Error(`updates pane never rendered a recognisable status line; panel text: ${dump.slice(0, 200)}`);
  }

  // The "Check for updates" button must be visible + enabled (the dev
  // short-circuit returns idle so canCheck === true).
  const checkBtn = panel.getByRole('button', { name: /^check for updates$/i });
  await checkBtn.waitFor({ state: 'visible', timeout: 1500 });
  if (await checkBtn.isDisabled()) {
    throw new Error('Check for updates button unexpectedly disabled in idle state');
  }

  await win.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {});

  log('updates pane: version + status labels render, idle status line + check button visible');
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

  // 1. Open via Cmd/Ctrl+F.
  await win.keyboard.press(`${mod}+f`);
  await searchInput.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
    throw new Error(`palette did not open via ${mod}+F — search input never appeared`);
  });

  // 2. Toggle closed via the same shortcut.
  await searchInput.focus();
  await win.keyboard.press(`${mod}+f`);
  await searchInput.waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {
    throw new Error(`palette did not close on second ${mod}+F (toggle broken)`);
  });

  // 3. Cmd/Ctrl+K must NOT open it.
  await win.keyboard.press(`${mod}+k`);
  await win.waitForTimeout(500);
  const openedByK = await searchInput.isVisible().catch(() => false);
  if (openedByK) throw new Error(`${mod}+K opened the palette — the K binding for search should be removed`);

  log(`${mod}+F opens; ${mod}+F toggles closed; ${mod}+K does NOT open`);
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
  await win.waitForTimeout(300);
  await nextBtn.click();
  await win.waitForTimeout(300);
  await nextBtn.click();
  await win.waitForTimeout(400);

  await win.locator('text=/(Step 4 of 4|第 4 步.*4)/i').first().waitFor({ state: 'visible', timeout: 5000 });
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
//
// Post-#561 (close-to-tray ask/tray/quit dialog): the win32 default for
// `closeAction` is `'ask'`, which surfaces a modal dialog instead of
// hiding. The probe asserts the hide-on-close branch specifically, so we
// pin `closeAction='tray'` via the same `db:save` IPC the Settings dialog
// uses before triggering close. We restore the prior value in dispose so
// later cases (and the persisted user preference, if running outside the
// harness) aren't perturbed.
async function caseTray({ app, win, log, registerDispose }) {
  const prevCloseAction = await win.evaluate(async () => {
    return await window.ccsm.loadState('closeAction');
  });
  await win.evaluate(async () => {
    await window.ccsm.saveState('closeAction', 'tray');
  });
  // Belt-and-suspenders: ensure the window is visible after we're done so
  // subsequent cases can interact with it (the harness window is shared).
  registerDispose(async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
      try { w?.show(); } catch {}
    });
    try {
      await win.evaluate(async (prev) => {
        if (prev == null) {
          // No way to delete via the IPC; leave 'tray' (matches mac default
          // and was the pre-#561 implicit behaviour).
          return;
        }
        await window.ccsm.saveState('closeAction', prev);
      }, prevCloseAction);
    } catch {}
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
  // SettingsDialog persists its active tab across open/close, so explicitly
  // click Appearance here in case a previous case (settings-updates-pane)
  // left it on Updates.
  await dialog.getByRole('tab', { name: /^appearance$/i }).click().catch(() => {});
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
    // Try `tab` role first (Radix Tabs); fall back to `button` for older
    // markup. SettingsDialog persists its tab across open/close, so always
    // click Appearance to land on a known tab.
    const appearanceTab = dialog.getByRole('tab', { name: /^(appearance|外观)$/i });
    if (await appearanceTab.isVisible().catch(() => false)) {
      await appearanceTab.click();
    } else {
      const appearanceBtn = dialog.getByRole('button', { name: /^(appearance|外观)$/i });
      if (await appearanceBtn.isVisible().catch(() => false)) await appearanceBtn.click();
    }
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
// All three Settings panes (Appearance / Updates / Connection) render
// Chinese labels when language=zh. Restores language to en.
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
    // SettingsDialog persists its active tab across open/close cycles. Force
    // Appearance so the language radio (Chinese / English) is in the DOM.
    const appearanceTab = dialog.getByRole('tab', { name: /^(appearance|外观)$/i });
    if (await appearanceTab.isVisible().catch(() => false)) {
      await appearanceTab.click();
      await win.waitForTimeout(100);
    }
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

  log('Appearance / Updates / Connection panes all render Chinese labels');
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


async function caseSidebarLongNameTruncates({ win, log }) {
  // fp13-A regression: an 80-char session name must visually truncate inside
  // the sidebar row instead of wrapping to a second line, AND must surface
  // the full name via a `title` attribute so the user can recover it via
  // browser-native hover tooltip.
  //
  // Pre-fix: the inner `<span class="truncate block">` lived inside a
  // `<span class="flex-1 min-w-0">` whose default `display: inline` voided
  // both `min-w-0` and the truncation contract, so the row wrapped to 2
  // lines. There was also no `title` attr carrying the full name.
  const longName = 'A'.repeat(80);
  await seedStore(win, {
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [
      { id: 's-long', name: longName, state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
    ],
    activeId: 's-long',
  });
  await win.waitForTimeout(150);

  const row = win.locator('li[data-session-id="s-long"]').first();
  await row.waitFor({ state: 'visible', timeout: 3000 });

  // The row's height must stay the canonical single-line height (h-9 = 36px).
  // If wrapping happened, height would balloon (>= 50ish for two lines).
  const rowBox = await row.boundingBox();
  if (!rowBox) throw new Error('sidebar long-name: row not measurable');
  if (rowBox.height > 40) {
    throw new Error(`sidebar long-name: row height ${rowBox.height.toFixed(1)}px > 40 — text wrapped to multiple lines instead of truncating`);
  }

  // The truncated text span must have ellipsis + nowrap CSS AND scrollWidth
  // exceeding clientWidth (proving the ellipsis actually clips real overflow,
  // not just CSS that happens to be set on a fitting element).
  const probe = await win.evaluate(() => {
    const li = document.querySelector('li[data-session-id="s-long"]');
    if (!li) return { found: false };
    // Find the deepest text-bearing span containing the long A run.
    const spans = Array.from(li.querySelectorAll('span'));
    // Pick the deepest span carrying the long A run — outer wrappers also
    // aggregate the same textContent via descendants, but the truncation
    // contract lives on the leaf text element.
    const candidates = spans.filter((s) => s.textContent && s.textContent.replace(/\s/g, '').startsWith('AAAA'));
    const target = candidates.find((s) => !candidates.some((other) => other !== s && s.contains(other)));
    if (!target) return { found: false };
    const cs = window.getComputedStyle(target);
    // Walk ancestors (including the <li>) collecting any title attr that
    // carries the full name — the tooltip can live on the truncated element
    // itself OR on any ancestor inside the row.
    let hasTitleWithFullName = false;
    let cursor = target;
    while (cursor && cursor !== li.parentElement) {
      const t = cursor.getAttribute('title');
      if (t && t === 'A'.repeat(80)) { hasTitleWithFullName = true; break; }
      cursor = cursor.parentElement;
    }
    return {
      found: true,
      whiteSpace: cs.whiteSpace,
      textOverflow: cs.textOverflow,
      overflow: cs.overflow,
      scrollWidth: target.scrollWidth,
      clientWidth: target.clientWidth,
      hasTitleWithFullName,
    };
  });

  if (!probe.found) throw new Error('sidebar long-name: could not find text span carrying the long A run');
  if (probe.whiteSpace !== 'nowrap') {
    throw new Error(`sidebar long-name: white-space=${probe.whiteSpace} (expected nowrap) — fp13-A regression: long names wrap instead of truncating`);
  }
  if (probe.textOverflow !== 'ellipsis') {
    throw new Error(`sidebar long-name: text-overflow=${probe.textOverflow} (expected ellipsis)`);
  }
  if (probe.scrollWidth <= probe.clientWidth) {
    throw new Error(`sidebar long-name: scrollWidth ${probe.scrollWidth} <= clientWidth ${probe.clientWidth} — text not actually overflowing, ellipsis would be a no-op`);
  }
  if (!probe.hasTitleWithFullName) {
    throw new Error('sidebar long-name: no `title` attr carries the full name — hover tooltip missing');
  }

  log(`fp13-A — sidebar long name truncated (h=${rowBox.height.toFixed(1)}px, scroll=${probe.scrollWidth}>client=${probe.clientWidth}, ellipsis+nowrap, title carries full name)`);
}

// ---------- startup-paints-before-hydrate ----------
//
// perf/startup-render-gate regression. Pins the contract that the renderer
// calls `root.render()` BEFORE `hydrateStore()` resolves — i.e. first paint
// is no longer gated on the awaited persisted-state load (which itself
// chained `loadConnection()` + `loadModels()`, the latter shells out to the
// claude binary and can take 100-500ms).
//
// Mechanism: index.tsx + hydrateStore() write timestamps onto
// `window.__ccsmHydrationTrace`:
//   - `renderedAt`     stamped just before `root.render(<App />)` in index.tsx
//   - `hydrateStartedAt` stamped at top of hydrateStore()
//   - `hydrateDoneAt`  stamped after the persisted snapshot lands + flag flips
//
// On origin/main (render gated on hydrate.finally), `renderedAt` does not
// exist (the field is new) AND if it did, it would be > hydrateDoneAt.
// On the fixed branch, `renderedAt` exists and is <= hydrateDoneAt.
//
// We additionally inject a slow `window.ccsm.models.list` (500ms delay) via
// addInitScript before reload to prove that even when models load takes
// half a second, the skeleton main+sidebar are present in the DOM well
// before that — `data-testid="main-skeleton"` flips to the populated
// `<main>` once the empty-sessions OR active-session branch renders, so
// observing the skeleton at all proves the renderer mounted before
// hydration finished.
async function caseStartupPaintsBeforeHydrate({ win, log }) {
  // Inject a 500ms delay around models.list BEFORE the renderer bundle
  // re-evaluates. The init script runs on every navigation including
  // win.reload(). Wrap in a guard so prior cases that may have already
  // wrapped don't double-wrap.
  //
  // We ALSO install a MutationObserver that captures the first
  // [data-testid="sidebar-skeleton"] element it sees and snapshots its
  // geometry / placeholder count to `window.__ccsm584Skeleton`. The
  // skeleton-vs-loaded handoff happens on a single React render once the
  // `hydrated` flag flips, so observing it from the test thread is racy;
  // pinning the snapshot synchronously inside the renderer is reliable.
  // Install everything via context().addInitScript so it survives reload.
  await win.context().addInitScript(() => {
    window.__ccsm584InitRan = (window.__ccsm584InitRan || 0) + 1;
    // Init scripts run at document_start — BEFORE preload finishes attaching
    // `window.ccsm`. Poll briefly so we can wrap the IPC surfaces once they
    // appear. Bail after ~2s to avoid leaking timers if something is wrong.
    const deadline = Date.now() + 2000;
    const tryWrap = () => {
      try {
        const ccsm = window.ccsm;
        if (!ccsm) {
          if (Date.now() < deadline) setTimeout(tryWrap, 5);
          return;
        }
        const original = ccsm.models?.list;
        if (original && !ccsm.models.__delayedForStartupCase) {
          ccsm.models.list = async (...args) => {
            await new Promise((r) => setTimeout(r, 500));
            return original.apply(ccsm.models, args);
          };
          ccsm.models.__delayedForStartupCase = true;
        }
        // #584: also delay loadState. Hydration sequence is fast (~30ms)
        // because sqlite reads are local; the skeleton would otherwise
        // paint for one frame and be gone before any test thread can
        // observe it. Wrapping loadState extends the hydrated=false
        // window long enough for the MutationObserver above to fire.
        const originalLoad = ccsm.loadState;
        if (originalLoad && !ccsm.__delayedLoadStateForStartupCase) {
          ccsm.loadState = async (...args) => {
            await new Promise((r) => setTimeout(r, 800));
            return originalLoad.apply(ccsm, args);
          };
          ccsm.__delayedLoadStateForStartupCase = true;
        }
      } catch {
        /* swallow — case will fail loudly below if wrap didn't take */
      }
    };
    tryWrap();

    // #584: observer that snapshots the sidebar skeleton the first time it
    // appears in the DOM. Survives the skeleton-to-loaded React handoff.
    const installObserver = () => {
      try {
        window.__ccsm584ObserverInstalled = true;
        const snapshot = (sidebar) => {
          const box = sidebar.getBoundingClientRect();
          const bg = window.getComputedStyle(sidebar).backgroundColor;
          const rows = sidebar.querySelectorAll(
            '[data-testid="sidebar-skeleton-row"]'
          ).length;
          const newSession = !!sidebar.querySelector(
            '[data-testid="sidebar-skeleton-newsession"]'
          );
          const main = document.querySelector('[data-testid="main-skeleton"]');
          const mainLoading = !!document.querySelector(
            '[data-testid="main-skeleton-loading"]'
          );
          return {
            width: box.width,
            height: box.height,
            bg,
            rows,
            newSession,
            mainPresent: !!main,
            mainLoading,
            capturedAt: Date.now(),
          };
        };
        const tryCapture = () => {
          const sidebar = document.querySelector(
            '[data-testid="sidebar-skeleton"]'
          );
          if (sidebar && !window.__ccsm584Skeleton) {
            window.__ccsm584Skeleton = snapshot(sidebar);
            return true;
          }
          return false;
        };
        if (tryCapture()) return;
        const target = document.body || document.documentElement;
        const obs = new MutationObserver(() => {
          if (tryCapture()) obs.disconnect();
        });
        obs.observe(target, { childList: true, subtree: true });
        // Stop observing after 5s either way to avoid leaks.
        setTimeout(() => obs.disconnect(), 5000);
      } catch (e) {
        window.__ccsm584ObserverError = String(e);
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', installObserver, {
        once: true,
      });
    } else {
      installObserver();
    }
  });

  await win.reload();
  await win.waitForLoadState('domcontentloaded');

  // Wait until React has mounted (sidebar OR main element exists). This is
  // intentionally NOT gated on `__ccsmStore.getState().hydrated` — the whole
  // point is that paint happens before hydrate-driven flag flips.
  await win.waitForFunction(
    () => !!document.querySelector('aside') || !!document.querySelector('main'),
    null,
    { timeout: 10_000 }
  );

  // Snapshot the trace + DOM state at the earliest moment we can measure.
  const earlySnap = await win.evaluate(() => {
    const trace = window.__ccsmHydrationTrace || {};
    const store = window.__ccsmStore?.getState?.();
    const skeleton = window.__ccsm584Skeleton || null;
    return {
      renderedAt: trace.renderedAt,
      hydrateStartedAt: trace.hydrateStartedAt,
      hydrateDoneAt: trace.hydrateDoneAt,
      hydratedFlag: store?.hydrated,
      hasMain: !!document.querySelector('main'),
      hasAside: !!document.querySelector('aside'),
      skeleton,
    };
  });

  if (typeof earlySnap.renderedAt !== 'number') {
    throw new Error(
      'startup-paints-before-hydrate: window.__ccsmHydrationTrace.renderedAt is missing — ' +
        'index.tsx did not stamp the render-time trace. Either index.tsx still awaits ' +
        'hydrateStore() before render(), or the trace export was removed.'
    );
  }
  if (typeof earlySnap.hydrateStartedAt !== 'number') {
    throw new Error(
      'startup-paints-before-hydrate: hydrateStartedAt missing — hydrateStore() never ran.'
    );
  }
  // Render must happen at or before hydrate finishes. Pre-fix: render
  // happened in `.finally(() => root.render())`, so renderedAt would be >
  // hydrateDoneAt. Post-fix: renderedAt <= hydrateStartedAt (render is
  // synchronous before the void hydrateStore() call), and definitely
  // <= hydrateDoneAt.
  if (typeof earlySnap.hydrateDoneAt === 'number' && earlySnap.renderedAt > earlySnap.hydrateDoneAt) {
    throw new Error(
      `startup-paints-before-hydrate: renderedAt (${earlySnap.renderedAt}) > hydrateDoneAt ` +
        `(${earlySnap.hydrateDoneAt}) — render() is still gated on hydration.`
    );
  }
  // Stricter: the render call must happen before hydrate even begins its
  // awaited persisted-load. This is what proves index.tsx no longer awaits.
  if (earlySnap.renderedAt > earlySnap.hydrateStartedAt) {
    throw new Error(
      `startup-paints-before-hydrate: renderedAt (${earlySnap.renderedAt}) > ` +
        `hydrateStartedAt (${earlySnap.hydrateStartedAt}) — index.tsx is awaiting ` +
        `hydrateStore() before calling root.render(). Render must be synchronous.`
    );
  }
  if (!earlySnap.hasMain && !earlySnap.hasAside) {
    throw new Error('startup-paints-before-hydrate: neither <main> nor <aside> in DOM after reload');
  }

  // Task #584: pre-hydrate skeleton must be CONTENT-SHAPED, not a literal
  // empty <aside>. The MutationObserver installed in the init script
  // captured the first sidebar-skeleton element it saw to
  // window.__ccsm584Skeleton — pinning the snapshot inside the renderer
  // survives the skeleton-to-loaded React handoff. Reverse-verify catch:
  // stash the AppSkeleton change and the snapshot becomes either null
  // (no element with that testid) or empty (no rows / no newsession / no
  // mainLoading affordance).
  const skel = earlySnap.skeleton;
  if (!skel) {
    const dbg = await win.evaluate(() => ({
      initRan: window.__ccsm584InitRan,
      observerInstalled: window.__ccsm584ObserverInstalled,
      observerError: window.__ccsm584ObserverError,
      hydrated: window.__ccsmStore?.getState?.().hydrated,
      loadStateWrapped: !!window.ccsm?.__delayedLoadStateForStartupCase,
      hasSidebarSkeleton: !!document.querySelector(
        '[data-testid="sidebar-skeleton"]'
      ),
    }));
    throw new Error(
      'startup-paints-before-hydrate: pre-hydrate skeleton was never seen in ' +
        'the DOM (window.__ccsm584Skeleton is null) — the [data-testid=' +
        '"sidebar-skeleton"] element did not render before hydrate flipped, ' +
        'or the skeleton path was removed entirely (#584). dbg=' +
        JSON.stringify(dbg)
    );
  }
  if (skel.width < 40) {
    throw new Error(
      `startup-paints-before-hydrate: sidebar skeleton too narrow (width=` +
        `${skel.width.toFixed(1)}); expected at least the 48px collapsed-rail width.`
    );
  }
  // Background must not be the default white / fully transparent — the
  // skeleton has to read as the loaded sidebar surface (bg-bg-sidebar/80).
  // 'rgba(0, 0, 0, 0)' is the literal "no background" string; anything else
  // (including the dark or light theme oklch translation) passes.
  if (
    !skel.bg ||
    skel.bg === 'rgba(0, 0, 0, 0)' ||
    skel.bg === 'transparent' ||
    skel.bg === 'rgb(255, 255, 255)'
  ) {
    throw new Error(
      `startup-paints-before-hydrate: sidebar skeleton has no visible bg ` +
        `(got "${skel.bg}"); should match bg-bg-sidebar.`
    );
  }
  if (!skel.newSession || skel.rows < 1) {
    throw new Error(
      `startup-paints-before-hydrate: sidebar skeleton lacks placeholders ` +
        `(newSessionRow=${skel.newSession}, sessionRowStubs=${skel.rows}); ` +
        `skeleton must be content-shaped, not a literal empty <aside> (#584).`
    );
  }
  if (!skel.mainLoading) {
    throw new Error(
      'startup-paints-before-hydrate: main pane skeleton missing the ' +
        '[data-testid="main-skeleton-loading"] affordance — pane reads as blank (#584).'
    );
  }

  // After hydrate completes, the store flag flips and the populated UI
  // takes over from the skeleton. We confirm the flag goes true to prove
  // we're not asserting against a stuck-skeleton state.
  await win.waitForFunction(
    () => !!window.__ccsmStore?.getState?.().hydrated,
    null,
    { timeout: 5_000 }
  );

  // And that the slow models.list eventually resolves — proves the
  // fire-and-forget didn't get dropped on the floor.
  await win.waitForFunction(
    () => !!window.__ccsmStore?.getState?.().modelsLoaded,
    null,
    { timeout: 5_000 }
  );

  log(
    `startup-paints-before-hydrate — renderedAt=${earlySnap.renderedAt} ` +
      `hydrateStartedAt=${earlySnap.hydrateStartedAt} ` +
      `hydrateDoneAt=${earlySnap.hydrateDoneAt ?? 'pending'} ` +
      `hydratedFlag(early)=${earlySnap.hydratedFlag} ` +
      `skeleton=${skel.width.toFixed(0)}x${skel.height.toFixed(0)} ` +
      `rows=${skel.rows} mainLoading=${skel.mainLoading}`
  );
}

// ---------- terminal-pane-mounted ----------
// Direct-xterm refactor (post-PR-1..PR-6): pin the App→{TerminalPane |
// ClaudeMissingGuide} wiring contract. Two branches, both real
// verifications (no skips):
//   - claudeAvailable=true  → right pane mounts the in-renderer xterm
//     host DIV `[data-terminal-host]` containing an `.xterm` child
//     element. The pty (owned by main) is exposed to the renderer via
//     window.ccsmPty.list(); we assert at least one entry exists.
//   - claudeAvailable=false → right pane mounts ClaudeMissingGuide
//     (data-testid="claude-missing-guide"), proving the selector
//     correctly chose the fallback path.
// Backend pty spawn/teardown coverage lives in
// `harness-real-cli.mjs`; this case is strictly the renderer-side
// wiring contract.
async function caseTerminalPaneMounted({ win, log }) {
  // Seed a real session so App's `active` resolves and the right-pane
  // branch runs. tutorialSeen=true skips the tutorial overlay.
  //
  // The cwd MUST be a real existing directory: TerminalPane's attach
  // effect calls `pty.spawn(sid, cwd)` which routes to node-pty, which
  // throws synchronously if cwd doesn't exist. Without a valid cwd the
  // pty bridge wires up (`window.ccsmPty.list` is callable) but no pty
  // entry ever lands, which is exactly the failure mode the assertion
  // below was reporting. Use the harness process cwd (the repo root) —
  // always present, no privilege issues.
  const probeCwd = process.cwd().replace(/\\/g, '/');
  await win.evaluate((cwd) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: 's-term', name: 'terminal-probe', state: 'idle', cwd, model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
      ],
      activeId: 's-term',
      messagesBySession: { 's-term': [] },
      tutorialSeen: true,
    });
  }, probeCwd);

  // Wait for App to resolve the boot-time claudeAvailable check —
  // either the guide or the terminal host (or its loading shell) shows up.
  await win.waitForFunction(
    () =>
      !!document.querySelector('[data-testid="claude-missing-guide"]') ||
      !!document.querySelector('[data-terminal-host]') ||
      !!document.querySelector('[data-testid="claude-availability-probing"]') === false,
    null,
    { timeout: 8000 }
  );

  const guideCount = await win.locator('[data-testid="claude-missing-guide"]').count();
  if (guideCount > 0) {
    // claude not on PATH → fallback selector branch. Verify the guide
    // is the only right-pane content (no leaked terminal host).
    const hostCount = await win.locator('[data-terminal-host]').count();
    if (hostCount > 0) {
      throw new Error('both ClaudeMissingGuide and terminal host rendered — selector logic broken');
    }
    log('claudeAvailable=false branch: ClaudeMissingGuide rendered, no leaked terminal host');
    return;
  }

  // claude available → terminal host must mount. The pane goes through
  // a brief `loading` state while it awaits pty attach, then flips to
  // `ready`. 8s timeout absorbs cold-boot cost.
  const host = win.locator('[data-terminal-host]');
  try {
    await host.first().waitFor({ state: 'attached', timeout: 8000 });
  } catch {
    throw new Error('terminal host did not mount within 8s — App→TerminalPane wiring broken or pty attach failed');
  }

  // Wiring contract: the host DIV must contain an .xterm child (xterm.js
  // mounts its DOM under the configured parent element).
  const xtermCount = await host.first().locator('.xterm').count();
  if (xtermCount === 0) {
    throw new Error('terminal host mounted but no .xterm child element — xterm.js never attached');
  }

  // Wiring contract: window.ccsmPty.list() must report ≥1 entry,
  // proving the renderer→main IPC bridge is wired and main has at
  // least one pty for the active session.
  const ptyList = await win.evaluate(async () => {
    if (!window.ccsmPty || typeof window.ccsmPty.list !== 'function') {
      return { ok: false, reason: 'window.ccsmPty.list unavailable' };
    }
    try {
      const arr = await window.ccsmPty.list();
      return { ok: true, count: Array.isArray(arr) ? arr.length : 0, entries: arr };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  });
  if (!ptyList.ok) {
    throw new Error(`window.ccsmPty.list failed: ${ptyList.reason}`);
  }
  if (!ptyList.count || ptyList.count < 1) {
    throw new Error(`window.ccsmPty.list returned 0 entries — pty bridge wired but no pty spawned`);
  }

  log(`claudeAvailable=true branch: terminal host mounted with .xterm, pty list reports ${ptyList.count} entry/entries`);
}

// ---------- move-to-group-excludes-own-group ----------
// PR #517 / commit a882478. Right-click → "Move to group" submenu must NOT
// list the session's current group. When no other group exists, the entire
// "Move to group" submenu trigger must be hidden (otherwise users see a
// dead-end submenu with no destinations).
async function caseMoveToGroupExcludesOwnGroup({ win, log }) {
  // ---- Subcase 1: multi-group → submenu lists OTHER groups only.
  await seedStore(win, {
    groups: [
      { id: 'gA', name: 'Group A', collapsed: false, kind: 'normal' },
      { id: 'gB', name: 'Group B', collapsed: false, kind: 'normal' }
    ],
    sessions: [
      { id: 's-in-A', name: 'session-in-A', state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'gA', agentType: 'claude-code' }
    ],
    activeId: 's-in-A'
  });

  await win.locator('li[data-session-id="s-in-A"]').first().click({ button: 'right' });
  const trigger = win.locator('[data-testid="move-to-group-trigger"]').first();
  await trigger.waitFor({ state: 'visible', timeout: 3000 });
  // Hover to expand the submenu (Radix opens sub on hover).
  await trigger.hover();
  const content = win.locator('[data-testid="move-to-group-content"]').first();
  await content.waitFor({ state: 'visible', timeout: 3000 });

  const groupIds = await win.evaluate(() =>
    Array.from(document.querySelectorAll('[data-move-to-group-item]'))
      .map((el) => el.getAttribute('data-group-id'))
  );
  if (groupIds.includes('gA')) {
    throw new Error(`move-to-group submenu must NOT list session's own group "gA"; got ${JSON.stringify(groupIds)}`);
  }
  if (!groupIds.includes('gB')) {
    throw new Error(`move-to-group submenu must list other group "gB"; got ${JSON.stringify(groupIds)}`);
  }

  // Dismiss menu before subcase 2.
  await win.keyboard.press('Escape');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(150);

  // ---- Subcase 2: single-group → entire "Move to group" submenu trigger
  // must be hidden (no destinations, no dead-end submenu).
  await seedStore(win, {
    groups: [
      { id: 'gOnly', name: 'Only Group', collapsed: false, kind: 'normal' }
    ],
    sessions: [
      { id: 's-solo', name: 'session-solo', state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'gOnly', agentType: 'claude-code' }
    ],
    activeId: 's-solo'
  });

  await win.locator('li[data-session-id="s-solo"]').first().click({ button: 'right' });
  // The Rename item still anchors the menu — wait for it as a sentinel.
  await win.getByRole('menuitem', { name: /^Rename$/ }).first().waitFor({ state: 'visible', timeout: 3000 });
  const triggerCount = await win.locator('[data-testid="move-to-group-trigger"]').count();
  if (triggerCount !== 0) {
    throw new Error(`move-to-group submenu trigger must be hidden when no other groups exist; got ${triggerCount} trigger(s)`);
  }
  await win.keyboard.press('Escape');
  await win.waitForTimeout(100);

  log('multi-group: own group excluded from submenu; single-group: trigger hidden entirely');
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
    // UX audit Group A — task #311. Sidebar internal top/bottom symmetry.
    // (Bottom-edge alignment with InputBar wrapper deleted post-ttyd refactor:
    // the chat composer is gone; the right pane is now a ttyd webview.)
    { id: 'sidebar-vertical-symmetry', run: caseSidebarVerticalSymmetry },
    { id: 'no-sessions-landing', run: caseNoSessionsLanding },
    { id: 'shortcut-overlay-opens', run: caseShortcutOverlayOpens },
    { id: 'toast-a11y', run: caseToastA11y },
    { id: 'palette-empty', run: casePaletteEmpty },
    { id: 'palette-nav', run: casePaletteNav },
    { id: 'settings-open', run: caseSettingsOpen },
    { id: 'settings-updates-pane', run: caseSettingsUpdatesPane },
    { id: 'search-shortcut-f', run: caseSearchShortcutF },
    { id: 'tutorial', run: caseTutorial },
    { id: 'titlebar', run: caseTitlebar },
    { id: 'tray', run: caseTray },
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
    // move-to-group-excludes-own-group: PR #517 / commit a882478. Right-click
    // session row → "Move to group" submenu must omit the session's current
    // group; hide trigger entirely when no other group exists.
    { id: 'move-to-group-excludes-own-group', run: caseMoveToGroupExcludesOwnGroup },
    // sidebar-long-name-truncates: regression for fp13-A. An 80-char session
    // name must visually truncate to a single line with ellipsis AND expose
    // the full name through a `title` attr so users can hover-recover it.
    { id: 'sidebar-long-name-truncates', run: caseSidebarLongNameTruncates },
    // notif-disabled-suppress was removed in PR-D — see comment block at the
    // case definition site (now deleted) for context.
    // startup-paints-before-hydrate (perf/startup-render-gate): pins
    // render-before-hydrate ordering via window.__ccsmHydrationTrace.
    // Placed last because it calls win.reload() with a 500ms init-script
    // delay on models.list, and the reload + delay perturb the page state
    // for any case that follows.
    { id: 'startup-paints-before-hydrate', run: caseStartupPaintsBeforeHydrate },
    // terminal-pane-mounted: direct-xterm refactor (post-PR-1..PR-6).
    // Pins the App→TerminalPane wiring contract — when claude is
    // available and a session is active, the right pane mounts the
    // in-renderer xterm host DIV `[data-terminal-host]` and main
    // surfaces the pty via window.ccsmPty.list().
    { id: 'terminal-pane-mounted', run: caseTerminalPaneMounted }
  ],
  launch: {
    // CCSM_OPEN_IN_EDITOR_NOOP=1: tells the tool:open-in-editor IPC handler
    // (src/electron/main.ts) to write the temp file but skip the actual
    // shell.openPath. The tool-render-open-in-editor case relies on this;
    // other cases never trigger that IPC, so the env var is a no-op for them.
    env: { CCSM_OPEN_IN_EDITOR_NOOP: '1' }
  }
});
