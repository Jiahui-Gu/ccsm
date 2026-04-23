// Themed harness — UI cluster, Phase-3.
//
// Per docs/e2e/single-harness-brainstorm.md §8 (option B + C). Each case
// below is the de-duplicated body of one of the per-file probes in
// scripts/probe-e2e-*.mjs. The original probe files have been left in
// place with a `// MERGED INTO harness-ui.mjs` marker on line 1 and are
// excluded from the per-file runner via scripts/run-all-e2e.mjs's
// MERGED_INTO_HARNESS skip list.
//
// Scope (5 cases — pure UI / store-driven, no real claude.exe required):
//   - sidebar-align             (probe-e2e-sidebar-align)
//   - no-sessions-landing       (probe-e2e-no-sessions-landing)
//   - empty-state-minimal       (probe-e2e-empty-state-minimal)
//   - a11y-focus-restore        (probe-e2e-a11y-focus-restore)
//   - shortcut-overlay-opens    (new — UI-1 / #188)
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
    window.__agentoryStore.setState({ sessions: [], activeId: undefined, tutorialSeen: true });
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
    window.__agentoryStore.setState({
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
    window.__agentoryStore.setState({
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
    window.__agentoryStore.setState({
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

// ---------- harness spec ----------
await runHarness({
  name: 'ui',
  setup: async ({ win }) => {
    // Suppress the "Claude CLI not found" first-launch dialog.
    await win.evaluate(() => {
      window.__agentoryStore?.setState({
        cliStatus: { state: 'found', binaryPath: '<harness>', version: null }
      });
    });
  },
  cases: [
    { id: 'sidebar-align', run: caseSidebarAlign },
    { id: 'no-sessions-landing', run: caseNoSessionsLanding },
    { id: 'empty-state-minimal', run: caseEmptyStateMinimal },
    { id: 'a11y-focus-restore', run: caseA11yFocusRestore },
    { id: 'shortcut-overlay-opens', run: caseShortcutOverlayOpens }
  ]
});
