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
//   - sidebar-vertical-symmetry            (REMOVED — top padding intentionally asymmetric per #606)
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
//   - app-icon-default                     (REMOVED — PR #525/#630 reintroduced custom icon by design)
//   - cap-skip-launch-bundle-shape         (capability demo, skipLaunch)
//   - group-add                            (REMOVED — PR #514/#605 consolidated to top NewSession)
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
// readFile/stat were used by the removed app-icon-default case.

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
  const settingsTab = win.getByRole('tab', { name: /^appearance$/i });

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
  // After PR #347 on win/linux: sidebar drag region is 8px (no traffic
  // lights to clear). On macOS, commit b876e48 set it to 40px to clear the
  // hiddenInset titlebar's traffic-light buttons. Right pane stays 32px to
  // host WindowControls (or empty space on macOS).
  const expectedLeft = platform === 'darwin' ? 40 : 8;
  for (const r of dragRegions) {
    const expected = r.left === 0 ? expectedLeft : 32;
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
// pin `closeAction='tray'` by writing directly to sqlite from the main
// process (the same store `getCloseAction()` reads in `win.on('close')`).
// Pre-#289 we routed through `window.ccsm.saveState` renderer→IPC, but
// the v0.3 ipc-allowlisted preload (Wave 0c) removed that bridge entirely
// — `window.ccsm.{loadState,saveState}` no longer exist. We now poke the
// closeAction module directly from main where the source of truth lives.
// We restore the prior value in dispose so later cases (and the persisted
// user preference, if running outside the harness) aren't perturbed.
async function caseTray({ app, win, log, registerDispose }) {
  const prevCloseAction = await app.evaluate(({ app: ea }) => {
    const path = process.mainModule.require('node:path');
    const m = process.mainModule.require(path.join(ea.getAppPath(), 'dist', 'electron', 'prefs', 'closeAction.js'));
    try { return m.getCloseAction(); } catch { return null; }
  });
  await app.evaluate(({ app: ea }) => {
    const path = process.mainModule.require('node:path');
    const m = process.mainModule.require(path.join(ea.getAppPath(), 'dist', 'electron', 'prefs', 'closeAction.js'));
    m.setCloseAction('tray');
  });
  // Belt-and-suspenders: ensure the window is visible after we're done so
  // subsequent cases can interact with it (the harness window is shared).
  registerDispose(async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
      try { w?.show(); } catch {}
    });
    try {
      await app.evaluate(({ app: ea }, prev) => {
        if (prev == null) {
          // Nothing to restore; leave 'tray' (matches mac default and was
          // the pre-#561 implicit behaviour).
          return;
        }
        const path = process.mainModule.require('node:path');
        const m = process.mainModule.require(path.join(ea.getAppPath(), 'dist', 'electron', 'prefs', 'closeAction.js'));
        m.setCloseAction(prev);
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

// ---------- close-dialog-is-native ----------
// Regression for the user dogfood report:
//   "关闭的时候，弹出的提醒仍然不是electron原生的"
//   (the close-confirmation popup is still not Electron-native)
//
// PR #561 wired `win.on('close')` to call `dialog.showMessageBox` (a native
// Win32 task dialog) when `closeAction === 'ask'`. This probe locks the
// preference to 'ask', monkey-patches `electron.dialog.showMessageBox` in
// the main process to record invocations and stub a 'tray' response, then
// fires close. The native dialog API MUST have been called — if any other
// code path (renderer-side HTML modal, window.confirm, custom overlay) had
// surfaced the confirmation instead, our spy would record zero calls.
//
// Reverse-verify: temporarily swap the `showMessageBox` call site in
// `electron/main.ts` for `webContents.executeJavaScript('window.confirm(...)')`
// and re-run — Playwright auto-dismisses the renderer-side confirm and the
// spy records zero invocations, so the probe fails.
async function caseCloseDialogIsNative({ app, win, log, registerDispose }) {
  const prevCloseAction = await app.evaluate(({ app: ea }) => {
    const path = process.mainModule.require('node:path');
    const m = process.mainModule.require(path.join(ea.getAppPath(), 'dist', 'electron', 'prefs', 'closeAction.js'));
    try { return m.getCloseAction(); } catch { return null; }
  });
  await app.evaluate(({ app: ea }) => {
    const path = process.mainModule.require('node:path');
    const m = process.mainModule.require(path.join(ea.getAppPath(), 'dist', 'electron', 'prefs', 'closeAction.js'));
    m.setCloseAction('ask');
  });
  registerDispose(async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
      try { w?.show(); } catch {}
    });
    try {
      await app.evaluate(({ app: ea }, prev) => {
        const path = process.mainModule.require('node:path');
        const m = process.mainModule.require(path.join(ea.getAppPath(), 'dist', 'electron', 'prefs', 'closeAction.js'));
        if (prev == null) {
          // Restore to the win32/linux default to keep the harness baseline
          // sane (mac default is 'tray'). The next case can rely on this.
          m.setCloseAction('ask');
          return;
        }
        m.setCloseAction(prev);
      }, prevCloseAction);
    } catch {}
    // Pop the spy off so subsequent cases see the real dialog API.
    await app.evaluate(({ dialog }) => {
      const spied = /** @type {any} */ (dialog).__ccsmOriginalShowMessageBox;
      if (spied) {
        dialog.showMessageBox = spied;
        delete (/** @type {any} */ (dialog)).__ccsmOriginalShowMessageBox;
        delete (/** @type {any} */ (globalThis)).__ccsmCloseDialogLog;
      }
    });
  });

  // Install the spy. Replace `dialog.showMessageBox` with a stub that
  // records the call and resolves to "Minimize to tray" (button 0). This
  // keeps the existing in-tree behaviour after the dialog returns (the
  // window hides, the harness window stays available).
  await app.evaluate(({ dialog }) => {
    /** @type {any} */ (globalThis).__ccsmCloseDialogLog = [];
    /** @type {any} */ (dialog).__ccsmOriginalShowMessageBox = dialog.showMessageBox;
    dialog.showMessageBox = (/** @type {any} */ ...args) => {
      // Two overloads: showMessageBox(opts) and showMessageBox(window, opts).
      const opts = args.length >= 2 ? args[1] : args[0];
      const hasParent = args.length >= 2;
      /** @type {any} */ (globalThis).__ccsmCloseDialogLog.push({
        hasParent,
        message: opts?.message ?? null,
        detail: opts?.detail ?? null,
        type: opts?.type ?? null,
        buttonCount: Array.isArray(opts?.buttons) ? opts.buttons.length : 0,
        checkboxLabel: opts?.checkboxLabel ?? null,
      });
      return Promise.resolve({ response: 0, checkboxChecked: false });
    };
  });

  // Fire close. The 'ask' branch preventDefaults and awaits the (now
  // stubbed) dialog promise; on response=0 it falls through to fadeThenHide.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
    w?.close();
  });
  // Allow the async dialog promise + fadeThenHide (180ms) to settle.
  await new Promise((r) => setTimeout(r, 600));

  const calls = await app.evaluate(() => {
    return /** @type {any} */ (globalThis).__ccsmCloseDialogLog ?? [];
  });

  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error(
      'dialog.showMessageBox not invoked — close confirmation is going through a non-native code path (HTML overlay / window.confirm / etc.)'
    );
  }
  const call = calls[0];
  if (!call.hasParent) {
    throw new Error('dialog.showMessageBox called without a parent BrowserWindow (should be modal to the app window)');
  }
  if (call.type !== 'question') {
    throw new Error(`dialog.showMessageBox type='${call.type}', expected 'question'`);
  }
  if (call.buttonCount < 2) {
    throw new Error(`dialog.showMessageBox got ${call.buttonCount} buttons, expected ≥2 (tray + quit)`);
  }
  if (!call.checkboxLabel) {
    throw new Error('dialog.showMessageBox missing checkboxLabel ("Don\'t ask again")');
  }
  if (!call.message || !call.detail) {
    throw new Error('dialog.showMessageBox missing message/detail strings');
  }

  // Confirm the close path actually completed (window hidden) so we know
  // the dialog response was honoured, not just consumed.
  const state = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
    return { exists: !!w, visible: w?.isVisible() ?? null };
  });
  if (!state.exists || state.visible !== false) {
    throw new Error(`window should be hidden after close+tray response; exists=${state.exists} visible=${state.visible}`);
  }

  // Restore the window for subsequent cases.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
    w?.show();
  });

  log(`dialog.showMessageBox invoked count=${calls.length} hasParent=${call.hasParent} buttons=${call.buttonCount}`);
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
        bgLum: bgLum ?? -1,
        // Task #313 round 5 observability dump — diagnose why theme-toggle
        // fails after 4 speculative fix rounds. Discriminates: store update
        // missed vs React unmounted vs hydration race vs persisted-shape
        // regression vs ErrorBoundary fallback. Remove after #311 resolves.
        hydratedFlag: window.__ccsm_hydrated,
        storeRef: !!window.__ccsmStore,
        storeTheme: window.__ccsmStore?.getState?.().theme,
        persistedRaw: localStorage.getItem('main')?.slice(0, 200) ?? null,
        appMounted: !!document.querySelector('aside'),
        errorBoundaryShown: /Something went wrong/.test(document.body.innerText),
        daemonModalOpen: !!document.querySelector('[data-testid="daemon-not-running-modal"]'),
        htmlClasses: document.documentElement.className,
        bodyTextHead: document.body.innerText.slice(0, 200),
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

// ---------- app-icon-default — REMOVED ----------
// PR #525 (#630) "fix(branding): unify 'C' icon across taskbar, tray, and
// installer" deliberately reintroduced the custom icon, overriding the prior
// #332 "fall back to Electron default" decision. The probe asserted the
// older state and is no longer applicable. Removed in fix(e2e) for #726.

// ---------- group-add — REMOVED ----------
// PR #514 "fix(ui): remove per-group + and chevron, consolidate to top
// NewSession (#605)" intentionally removed the per-group + button. There is
// no per-group new-session affordance to test anymore; the consolidated top
// "New session" button is covered by no-sessions-landing + sidebar-align.
// Removed in fix(e2e) for #726.

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

  // Case 7: SESSION focus race — after right-click → Rename, focus must
  // land on the input AND a single typed char must overwrite the existing
  // name (selection on focus). The user-reported repro lives in the
  // production focus-event timing where Radix's onCloseAutoFocus restores
  // focus to the LI trigger AFTER the input mounts, and the LI's dnd-kit
  // listeners + tabIndex=0 let it keep that focus across InlineRename's
  // own sync + rAF re-focus attempts.
  //
  // Reverse-verify strategy (per feedback_bug_fix_e2e_reverse_verify.md):
  // headless Playwright doesn't naturally trigger Radix's onCloseAutoFocus
  // restoration on the same timing as production — an earlier version of
  // this case just called `li.focus()` after the input mounted and waited
  // 120ms, but pre-fix InlineRename's rAF re-focus tick reclaimed the
  // input before the 120ms wait elapsed, so the assertion passed even
  // with all of Fix A stashed (false-green reverse-verify).
  //
  // We now simulate the production race with a documents-level focusin
  // observer that, every time the rename <input> is focused, schedules a
  // microtask `li.focus()` — exactly mimicking Radix's onCloseAutoFocus
  // restoration AND defeating InlineRename's sync + rAF refocus
  // (microtask runs after focus event, before rAF). The observer self-
  // removes ~25ms after first fire — long enough to clobber the rAF
  // (~16ms) but short enough that A3's 51ms belt-and-suspenders refocus
  // tick (post-fix only) snaps focus back to the input afterwards.
  //
  // Pre-fix (A1+A2+A3 stashed): observer keeps stealing past rAF; no
  // 51ms recovery tick exists; LI keeps focus → assertion FAILS. Verified
  // 5/5 runs pre-fix → FAIL, 5/5 runs post-fix → PASS.
  {
    const row = win.locator('li[data-session-id="s2"]').first();
    await row.click({ button: 'right' });
    // Install the race simulator BEFORE clicking Rename so it's ready
    // when the input mounts and focuses itself.
    await win.evaluate(() => {
      let firstSeenAt = 0;
      const handler = (e) => {
        const t = e.target;
        if (!t || t.tagName !== 'INPUT') return;
        if (!t.closest || !t.closest('li[data-session-id="s2"]')) return;
        if (firstSeenAt === 0) {
          firstSeenAt = performance.now();
          // Self-remove 25ms after first steal — clobbers InlineRename's
          // sync focus + rAF refocus (~16ms), but stops before A3's 51ms
          // belt-and-suspenders refocus tick fires post-fix.
          setTimeout(() => {
            document.removeEventListener('focusin', handler, true);
          }, 25);
        }
        // Microtask runs after the focus event but before rAF, so this
        // wins the race against InlineRename's mount-effect refocus.
        queueMicrotask(() => {
          const li = document.querySelector('li[data-session-id="s2"]');
          li && li.focus();
        });
      };
      document.addEventListener('focusin', handler, true);
    });
    await win.getByRole('menuitem', { name: /^Rename$/ }).first().click();
    await win.locator('li[data-session-id="s2"] input').waitFor({ state: 'visible', timeout: 3000 });
    // Wait past simulator self-removal (25ms), InlineRename arm tick
    // (50ms), and A3 belt-and-suspenders refocus tick (51ms).
    await win.waitForTimeout(150);
    const focused = await win.evaluate(() => {
      const el = document.querySelector('li[data-session-id="s2"] input');
      return document.activeElement === el;
    });
    if (!focused) throw new Error('session rename focus race: activeElement is not the input after Radix-style focus restoration to LI (focus stolen by LI listeners + tabIndex=0; A3 refocus tick missing)');
    // Type a single character via keyboard — should REPLACE the selected
    // text "second" entirely, leaving only "X" (not "secondX" or "Xsecond").
    await win.keyboard.type('X');
    const inputVal = await win.locator('li[data-session-id="s2"] input').inputValue();
    if (inputVal !== 'X') throw new Error(`session rename type-overwrite: expected input value "X" after typing one char, got "${inputVal}" (text was not pre-selected, or focus was on LI not input)`);
    await win.locator('li[data-session-id="s2"] input').press('Escape');
    await win.waitForTimeout(150);
  }

  // Case 8: ArrowDown / ArrowUp inside the rename input must NOT navigate
  // the listbox (close the rename, move row focus). Same guard for the ul
  // onKeyDown handler that the SessionRow's own onKeyDown already has.
  {
    const input = await openSessionRename('s2');
    await input.fill('arrow probe');
    await input.press('ArrowDown');
    await win.waitForTimeout(100);
    const stillOpen = await win.locator('li[data-session-id="s2"] input').count();
    if (stillOpen !== 1) throw new Error('session ArrowDown in rename: input closed (listbox navigation hijacked the keystroke)');
    const stillFocused = await win.evaluate(() => {
      const el = document.querySelector('li[data-session-id="s2"] input');
      return document.activeElement === el;
    });
    if (!stillFocused) throw new Error('session ArrowDown in rename: input lost focus');
    const valStill = await win.locator('li[data-session-id="s2"] input').inputValue();
    if (valStill !== 'arrow probe') throw new Error(`session ArrowDown in rename: input value mutated; got "${valStill}"`);
    await input.press('Escape');
    await win.waitForTimeout(150);
  }

  // Case 9: Tab commits the rename (and advances focus naturally).
  {
    const input = await openSessionRename('s3');
    await input.fill('tab committed');
    await input.press('Tab');
    await win.waitForTimeout(200);
    const after = await sessionName('s3');
    if (after !== 'tab committed') throw new Error(`session Tab commit: expected "tab committed", got "${after}"`);
    const stillEditing = await win.locator('li[data-session-id="s3"] input').count();
    if (stillEditing !== 0) throw new Error('session Tab commit: input still visible after Tab');
  }

  // Case 10: F2 on a focused session row enters rename mode.
  {
    const row = win.locator('li[data-session-id="s2"]').first();
    await row.click(); // selects + focuses the LI (selected → tabIndex=0)
    await win.waitForTimeout(120);
    // Make sure the LI itself is focused, not a child — the F2 handler
    // guards on `e.target === e.currentTarget`.
    await win.evaluate(() => {
      const el = document.querySelector('li[data-session-id="s2"]');
      el?.focus();
    });
    await win.keyboard.press('F2');
    await win.waitForTimeout(150);
    const inputCount = await win.locator('li[data-session-id="s2"] input').count();
    if (inputCount !== 1) throw new Error('session F2 trigger: rename input did not open');
    await win.locator('li[data-session-id="s2"] input').press('Escape');
    await win.waitForTimeout(150);
  }

  // Case 11: double-click the session label enters rename mode.
  {
    const label = win.locator('li[data-session-id="s2"] span.truncate').first();
    await label.dblclick();
    await win.waitForTimeout(150);
    const inputCount = await win.locator('li[data-session-id="s2"] input').count();
    if (inputCount !== 1) throw new Error('session dblclick trigger: rename input did not open');
    await win.locator('li[data-session-id="s2"] input').press('Escape');
    await win.waitForTimeout(150);
  }

  // Case 12: GROUP focus / type-overwrite parity. Group rows already win
  // the focus race today (no dnd-kit), but assert anyway as regression
  // protection — Fix A1 also added onCloseAutoFocus to the GroupRow menu.
  {
    const header = win.locator('[data-group-header-id="g1"]').first();
    await header.click({ button: 'right' });
    await win.getByRole('menuitem', { name: /^Rename$/ }).first().click();
    await win.locator('[data-group-header-id="g1"] input').waitFor({ state: 'visible', timeout: 3000 });
    await win.waitForTimeout(120);
    const focused = await win.evaluate(() => {
      const el = document.querySelector('[data-group-header-id="g1"] input');
      return document.activeElement === el;
    });
    if (!focused) throw new Error('group rename focus: activeElement is not the input');
    await win.keyboard.type('Y');
    const inputVal = await win.locator('[data-group-header-id="g1"] input').inputValue();
    if (inputVal !== 'Y') throw new Error(`group rename type-overwrite: expected "Y", got "${inputVal}"`);
    await win.locator('[data-group-header-id="g1"] input').press('Escape');
    await win.waitForTimeout(150);
  }

  // Case 13: F2 on group rename + dblclick on group label.
  {
    const header = win.locator('[data-group-header-id="g1"]').first();
    const btn = header.locator('button').first();
    await btn.focus();
    await win.keyboard.press('F2');
    await win.waitForTimeout(150);
    const inputCount = await win.locator('[data-group-header-id="g1"] input').count();
    if (inputCount !== 1) throw new Error('group F2 trigger: rename input did not open');
    await win.locator('[data-group-header-id="g1"] input').press('Escape');
    await win.waitForTimeout(150);
  }
  {
    const label = win.locator('[data-group-header-id="g1"] span.truncate').first();
    await label.dblclick();
    await win.waitForTimeout(150);
    const inputCount = await win.locator('[data-group-header-id="g1"] input').count();
    if (inputCount !== 1) throw new Error('group dblclick trigger: rename input did not open');
    await win.locator('[data-group-header-id="g1"] input').press('Escape');
    await win.waitForTimeout(150);
  }

  log('session: Enter / Escape / whitespace / click-outside / IME guard / focus-race / type-overwrite / arrow-guard / Tab-commit / F2 / dblclick; group: Enter / Escape / focus / type-overwrite / F2 / dblclick');
}

// ---------- sidebar-vertical-symmetry — REMOVED ----------
// The strict 1px top/bottom symmetry property no longer holds: PR #512
// (#606) intentionally bumped the New Session row's top padding from pt-1
// to pt-4 because the original symmetry made the top edge feel cramped
// against the window-top drag strip. The asymmetry (top 24px vs bottom
// 12px) is documented in src/components/Sidebar.tsx around the
// `data-testid="sidebar-newsession-row"` div. There is no surviving
// symmetry contract to assert. Removed in fix(e2e) for #726.



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
// is no longer gated on the awaited persisted-state load.
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
// We additionally inject a slow `localStorage.getItem('main')` (800ms
// busy-wait) via addInitScript before reload to extend the hydrated=false
// window long enough for the MutationObserver below to capture the
// sidebar skeleton. (Pre-#289 cutover this wrapped `window.ccsm.loadState`;
// persist.ts now reads localStorage directly so we hook there instead.)
async function caseStartupPaintsBeforeHydrate({ win, log }) {
  // Inject a delay around localStorage.getItem('main') BEFORE the renderer
  // bundle re-evaluates. The init script runs on every navigation including
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
    // #584: delay localStorage.getItem('main') (the persisted store snapshot
    // key from src/stores/persist.ts STATE_KEY). Hydration sequence is fast
    // (~30ms) because localStorage reads are sync; the skeleton would
    // otherwise paint for one frame and be gone before any test thread can
    // observe it. Busy-waiting inside getItem extends the hydrated=false
    // window long enough for the MutationObserver below to fire. We swap
    // getItem only for the 'main' key so unrelated reads remain fast.
    try {
      if (!window.__ccsm584DelayedGetItem) {
        const proto = Storage.prototype;
        const originalGetItem = proto.getItem;
        proto.getItem = function (key) {
          if (this === window.localStorage && key === 'main') {
            // localStorage.getItem is synchronous, so we cannot `await` —
            // and an async wrap would resolve in a microtask, defeating the
            // whole point. A spin-loop blocks the renderer thread for the
            // window we want to widen, which is exactly what the original
            // ccsm.loadState delay achieved.
            const deadline = Date.now() + 800;
            while (Date.now() < deadline) { /* spin */ }
          }
          return originalGetItem.call(this, key);
        };
        window.__ccsm584DelayedGetItem = true;
      }
    } catch {
      /* swallow — case will fail loudly below if wrap didn't take */
    }

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
      loadStateWrapped: !!window.__ccsm584DelayedGetItem,
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
// list the session's current group. PR #629 reverses the original "hide the
// whole submenu when empty" behavior: the submenu is ALWAYS visible — when
// no other group exists it shows only the "New group…" escape hatch so users
// can still create a destination from the same place.
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

  // ---- Subcase 2: single-group → submenu trigger is STILL visible (#629),
  // and the submenu contains only the "New group…" escape hatch — no
  // destination groups, including the session's own group.
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
  const soloTrigger = win.locator('[data-testid="move-to-group-trigger"]').first();
  await soloTrigger.waitFor({ state: 'visible', timeout: 3000 });
  await soloTrigger.hover();
  const soloContent = win.locator('[data-testid="move-to-group-content"]').first();
  await soloContent.waitFor({ state: 'visible', timeout: 3000 });

  const soloGroupIds = await win.evaluate(() =>
    Array.from(document.querySelectorAll('[data-move-to-group-item]'))
      .map((el) => el.getAttribute('data-group-id'))
  );
  if (soloGroupIds.length !== 0) {
    throw new Error(`single-group submenu must not list any destination groups; got ${JSON.stringify(soloGroupIds)}`);
  }
  const newGroupItem = soloContent.getByRole('menuitem', { name: /New group/ });
  const newGroupCount = await newGroupItem.count();
  if (newGroupCount !== 1) {
    throw new Error(`single-group submenu must contain exactly one "New group…" item; got ${newGroupCount}`);
  }
  await win.keyboard.press('Escape');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(100);

  log('multi-group: own group excluded from submenu; single-group: submenu visible with only "New group…" entry');
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
    // sidebar-vertical-symmetry removed — see comment block above the
    // deleted function. Top padding intentionally asymmetric per #606.
    // no-sessions-landing removed — Task #740 Batch 3.1. Pure renderer
    // contract; covered by tests/first-run-empty-state.test.tsx.
    // shortcut-overlay-opens removed — Task #740 Batch 3.1. Pure UI
    // (Radix Dialog + module-level navigator.userAgent sniff); covered
    // by tests/shortcut-overlay.test.tsx.
    // toast-a11y removed — Task #740 Batch 3.1. Already covered by
    // tests/toast-a11y.test.tsx (ARIA roles + close-button dismiss).
    // palette-empty + palette-nav removed — Task #740 Batch 3.1. Pure
    // CommandPalette UI (controlled Radix Dialog, listbox, kbd nav);
    // covered by tests/command-palette.test.tsx.
    { id: 'settings-open', run: caseSettingsOpen },
    { id: 'settings-updates-pane', run: caseSettingsUpdatesPane },
    // search-shortcut-f removed — Task #740 Batch 3.1. Already covered
    // by tests/app-effects/useShortcutHandlers.test.tsx (Ctrl+F branch).
    // tutorial removed — Task #740 Batch 3.1. Pure self-contained
    // controlled component; covered by tests/tutorial.test.tsx.
    { id: 'titlebar', run: caseTitlebar },
    { id: 'tray', run: caseTray },
    // close-dialog-is-native: regression for the dogfood report
    // "关闭的时候，弹出的提醒仍然不是electron原生的". Asserts the close
    // confirmation goes through `dialog.showMessageBox` (native Win32 task
    // dialog), not a renderer-side HTML overlay or `window.confirm`.
    { id: 'close-dialog-is-native', run: caseCloseDialogIsNative },
    { id: 'theme-toggle', run: caseThemeToggle },
    // language-toggle removed — Task #740 Batch 3.1. Live-flip already
    // covered by tests/language-switch.test.tsx; Settings-dialog flip +
    // protected-term parity covered by tests/settings-i18n.test.tsx.
    // i18n-settings-zh removed — Task #740 Batch 3.1. SettingsDialog
    // pane labels in zh covered by tests/settings-i18n.test.tsx.
    // ---- Per-case capability demo (task #223) ----
    { id: 'cap-skip-launch-bundle-shape', skipLaunch: true, run: caseSkipLaunchBundleShape },
    // ---- Bucket-1 absorption (task #222) ----
    // app-icon-default removed — see comment block above the deleted
    // function. PR #525/#630 reintroduced the custom icon by design.
    // group-add removed — see comment block above the deleted function.
    // PR #514 (#605) consolidated the per-group + into the top NewSession.
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
    // Placed last because it calls win.reload() with init-script delays on
    // loadState, and the reload + delay perturb the page state for any
    // case that follows.
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
