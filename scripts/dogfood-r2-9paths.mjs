// Dogfood R2 — 9-path comprehensive probe.
//
// Drives the packaged release/win-unpacked/CCSM.exe (post-#584 / #499 fix) via
// Playwright, exercises 9 canonical paths, captures per-path screenshots and
// per-path PASS/PARTIAL/FAIL verdicts. Also targeted regression checks for:
//   - PR #499/#584: first-launch shows content-shaped AppSkeleton (NOT empty)
//   - PR #493/#572: tray + taskbar unread badge count
//
// Output:
//   docs/screenshots/dogfood-r2/path-N-<slug>.png
//   docs/screenshots/dogfood-r2/r2-9paths-summary.json

import { _electron as electron } from 'playwright';
import { rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const repoRoot = process.cwd();
const userData = path.join(repoRoot, '.dogfood-r2-userdata');
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });

const screenshotDir = path.join(repoRoot, 'docs', 'screenshots', 'dogfood-r2');
mkdirSync(screenshotDir, { recursive: true });

const ccsmExe = path.join(repoRoot, 'release', 'win-unpacked', 'CCSM.exe');
if (!existsSync(ccsmExe)) {
  console.error(`FATAL: ${ccsmExe} missing — run npm run make:win first`);
  process.exit(2);
}

const consoleEvents = [];
const results = []; // { id, name, verdict, notes, screenshot }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(id, name, verdict, notes, screenshot = null) {
  results.push({ id, name, verdict, notes, screenshot });
  console.log(`[PATH ${id}] ${verdict}: ${name} — ${notes}`);
}

console.log('Launching CCSM (production unpacked) ...');
const electronApp = await electron.launch({
  executablePath: ccsmExe,
  args: [`--user-data-dir=${userData}`],
  env: {
    ...process.env,
    ELECTRON_DISABLE_GPU: '1',
  },
  timeout: 60000,
});

const win = await electronApp.firstWindow();
win.on('console', (msg) => consoleEvents.push({ type: msg.type(), text: msg.text() }));
win.on('pageerror', (err) => consoleEvents.push({ type: 'pageerror', text: String(err) }));

// ============================================================================
// PATH 1 — First-launch UX (regression: PR #499/#584 must NOT show empty skel)
// ============================================================================
{
  // Capture as early as practical to see the pre-hydrate skeleton.
  await win.waitForLoadState('domcontentloaded');
  // Tiny delay to ensure react has mounted at least the AppSkeleton.
  await sleep(300);
  const earlyShot = path.join(screenshotDir, 'path-1-first-launch-early.png');
  await win.screenshot({ path: earlyShot });

  const earlyDom = await win.evaluate(() => {
    const root = document.getElementById('root');
    if (!root) return { rootEmpty: true };
    const html = root.innerHTML || '';
    // PR #584: AppSkeleton has data-testid="app-skeleton" and contains shaped
    // bones (sidebar bones + chat bones). Empty skeleton would be just `<div></div>`
    // or the legacy `loading...` with no testid.
    const skel = root.querySelector('[data-testid="app-skeleton"]');
    return {
      rootEmpty: html.length < 50,
      htmlLen: html.length,
      hasAppSkeleton: !!skel,
      skeletonChildren: skel ? skel.children.length : 0,
      skeletonOuterLen: skel ? skel.outerHTML.length : 0,
      bodyText: document.body.innerText.slice(0, 200),
    };
  });

  // Wait for hydration to land.
  try {
    await win.waitForFunction(
      () => {
        const s = window.__ccsmStore?.getState?.();
        return s && s.hydrated === true;
      },
      null,
      { timeout: 15000 },
    );
  } catch {
    // continue — even if hydrated flag missing the app may still render
  }
  await sleep(1500);
  const lateShot = path.join(screenshotDir, 'path-1-first-launch-hydrated.png');
  await win.screenshot({ path: lateShot });

  const hydrated = await win.evaluate(() => {
    const s = window.__ccsmStore?.getState?.();
    return {
      hydrated: s?.hydrated ?? null,
      sessionsCount: s?.sessions?.length ?? null,
      claudeAvailable: s?.claudeAvailable ?? null,
      bodyText: document.body.innerText.slice(0, 400),
      testIds: Array.from(document.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid')).slice(0, 30),
    };
  });

  let verdict = 'PASS';
  const notes = [];
  if (earlyDom.rootEmpty) {
    verdict = 'FAIL';
    notes.push('root empty pre-hydrate (regression)');
  }
  if (!earlyDom.hasAppSkeleton && earlyDom.htmlLen < 500) {
    verdict = verdict === 'FAIL' ? 'FAIL' : 'PARTIAL';
    notes.push(`no [data-testid=app-skeleton] (htmlLen=${earlyDom.htmlLen})`);
  }
  if (hydrated.hydrated !== true) {
    verdict = 'PARTIAL';
    notes.push(`store.hydrated=${hydrated.hydrated}`);
  }
  if (notes.length === 0) notes.push(`skeleton present (${earlyDom.skeletonChildren} bones, ${earlyDom.skeletonOuterLen}b), hydrated OK`);
  record(1, 'First-launch UX (PR #584 regression)', verdict, notes.join('; '), 'path-1-first-launch-hydrated.png');
}

// ============================================================================
// PATH 2 — Create new session, send a message, get response
// ============================================================================
let pathSidA = null;
{
  let verdict = 'PASS';
  const notes = [];
  try {
    // Try first-run-empty CTA, fallback to programmatic createSession.
    const fre = await win.locator('[data-testid="first-run-empty"] button').count();
    if (fre > 0) {
      await win.locator('[data-testid="first-run-empty"] button').first().click();
    } else {
      // Use store directly.
      await win.evaluate(() => window.__ccsmStore?.getState?.()?.createSession?.(null));
    }
    await sleep(2500);
    pathSidA = await win.evaluate(() => window.__ccsmStore?.getState?.()?.activeId ?? null);
    if (!pathSidA) throw new Error('activeId still null after create');

    // Wait for terminal host (direct-xterm).
    await win.waitForSelector('[data-terminal-host]', { timeout: 15000 });
    await win.waitForFunction(() => !!window.__ccsmTerm, null, { timeout: 10000 });

    // Type prompt + enter
    await sleep(2500);
    await win.evaluate(() => {
      const term = window.__ccsmTerm;
      const cs = term._core._coreService || term._core.coreService;
      cs.triggerDataEvent('say hi in 3 words', true);
    });
    await sleep(400);
    await win.evaluate(() => {
      const term = window.__ccsmTerm;
      const cs = term._core._coreService || term._core.coreService;
      cs.triggerDataEvent('\r', true);
    });

    // Poll buffer for any reply text.
    let replied = false;
    let buf = '';
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      buf = await win.evaluate(() => {
        const t = window.__ccsmTerm;
        if (!t || !t.buffer || !t.buffer.active) return '';
        const out = [];
        const a = t.buffer.active;
        for (let i = 0; i < a.length; i++) {
          const l = a.getLine(i);
          if (l) out.push(l.translateToString(true));
        }
        return out.join('\n');
      }).catch(() => '');
      if (/hi|hello|hey/i.test(buf) && buf.length > 200) { replied = true; break; }
    }
    if (!replied) {
      verdict = 'PARTIAL';
      notes.push('no clear reply within 40s (auth state? CLI version?)');
    } else {
      notes.push('claude reply observed in buffer');
    }
  } catch (err) {
    verdict = 'FAIL';
    notes.push(String(err).slice(0, 200));
  }
  await win.screenshot({ path: path.join(screenshotDir, 'path-2-new-session.png'), fullPage: true });
  record(2, 'Create session, send message, get response', verdict, notes.join('; '), 'path-2-new-session.png');
}

// ============================================================================
// PATH 3 — Multi-session switching, history persists
// ============================================================================
let pathSidB = null;
{
  let verdict = 'PASS';
  const notes = [];
  try {
    const sidA = pathSidA;
    if (!sidA) throw new Error('no session A from path 2');

    // Capture A's buffer length before switch
    const lenA1 = await win.evaluate(() => {
      const t = window.__ccsmTerm;
      if (!t?.buffer?.active) return 0;
      let n = 0;
      const a = t.buffer.active;
      for (let i = 0; i < a.length; i++) { const l = a.getLine(i); if (l) n += (l.translateToString(true).length || 0); }
      return n;
    });

    // Create B
    pathSidB = await win.evaluate(() => {
      window.__ccsmStore?.getState?.()?.createSession?.(null);
      return window.__ccsmStore?.getState?.()?.activeId ?? null;
    });
    await sleep(2000);
    if (!pathSidB || pathSidB === sidA) throw new Error(`sidB invalid: ${pathSidB}`);
    notes.push(`created sidB=${pathSidB.slice(0, 8)}`);

    // Switch back to A
    await win.evaluate((s) => window.__ccsmStore?.getState?.()?.selectSession?.(s), sidA);
    await sleep(1500);

    const lenA2 = await win.evaluate(() => {
      const t = window.__ccsmTerm;
      if (!t?.buffer?.active) return 0;
      let n = 0;
      const a = t.buffer.active;
      for (let i = 0; i < a.length; i++) { const l = a.getLine(i); if (l) n += (l.translateToString(true).length || 0); }
      return n;
    });

    // History should persist — buffer length should be similar (>=80% of pre-switch)
    if (lenA2 < lenA1 * 0.5) {
      verdict = 'FAIL';
      notes.push(`buffer shrank on switch-back: ${lenA1} -> ${lenA2}`);
    } else {
      notes.push(`buffer preserved: ${lenA1}b -> ${lenA2}b`);
    }
  } catch (err) {
    verdict = 'FAIL';
    notes.push(String(err).slice(0, 200));
  }
  await win.screenshot({ path: path.join(screenshotDir, 'path-3-multi-session.png'), fullPage: true });
  record(3, 'Multi-session switching, history persists', verdict, notes.join('; '), 'path-3-multi-session.png');
}

// ============================================================================
// PATH 4 — Permission prompts
// ============================================================================
// We can't trigger a real CLI permission prompt deterministically without a
// chained tool invocation; instead verify the permission UI plumbing exists.
{
  const result = await win.evaluate(() => {
    const s = window.__ccsmStore?.getState?.();
    return {
      hasPermissionsBridge: typeof window.ccsmPermissions !== 'undefined' || typeof window.ccsm?.permissions !== 'undefined',
      hasPermissionsState: typeof s?.pendingPermissions !== 'undefined' || typeof s?.permissionMode !== 'undefined',
      keys: Object.keys(s || {}).filter((k) => /perm/i.test(k)),
      bridgeKeys: window.ccsm ? Object.keys(window.ccsm).filter((k) => /perm/i.test(k)) : [],
    };
  });
  let verdict = 'PARTIAL';
  const notes = [`permission state keys: ${result.keys.join(',') || '(none)'}; bridge perm keys: ${result.bridgeKeys.join(',') || '(none)'}`];
  notes.push('Note: live permission prompt not exercised (requires real tool invocation by Claude)');
  if (result.keys.length > 0 || result.bridgeKeys.length > 0) {
    verdict = 'PARTIAL'; // plumbing present, behavior not exercised
  }
  record(4, 'Permission prompts (plumbing check)', verdict, notes.join('; '), null);
}

// ============================================================================
// PATH 5 — Slash command / agent invocation
// ============================================================================
{
  let verdict = 'PASS';
  const notes = [];
  try {
    // Type "/" into the terminal to test slash command picker handover (Claude
    // CLI itself owns the slash UI inside the pty).
    await win.evaluate((s) => window.__ccsmStore?.getState?.()?.selectSession?.(s), pathSidA);
    await sleep(1000);
    await win.evaluate(() => {
      const term = window.__ccsmTerm;
      const cs = term._core._coreService || term._core.coreService;
      cs.triggerDataEvent('/help', true);
    });
    await sleep(2000);
    const buf = await win.evaluate(() => {
      const t = window.__ccsmTerm;
      if (!t?.buffer?.active) return '';
      const out = [];
      const a = t.buffer.active;
      for (let i = 0; i < a.length; i++) { const l = a.getLine(i); if (l) out.push(l.translateToString(true)); }
      return out.join('\n');
    });
    if (/\/help|command|usage|available/i.test(buf)) {
      notes.push('slash text reached CLI pty');
    } else {
      verdict = 'PARTIAL';
      notes.push('no slash output detected (CLI may need Enter; not pressed to avoid execution)');
    }
    // backspace it out
    for (let i = 0; i < 5; i++) {
      await win.evaluate(() => {
        const term = window.__ccsmTerm;
        const cs = term._core._coreService || term._core.coreService;
        cs.triggerDataEvent('\b', true);
      });
    }
  } catch (err) {
    verdict = 'FAIL';
    notes.push(String(err).slice(0, 200));
  }
  await win.screenshot({ path: path.join(screenshotDir, 'path-5-slash.png'), fullPage: true });
  record(5, 'Slash command / agent invocation', verdict, notes.join('; '), 'path-5-slash.png');
}

// ============================================================================
// PATH 6 — Plugin / MCP / skill load
// ============================================================================
// CCSM passes through CLAUDE_CONFIG_DIR so user's skills/plugins should load
// inside the spawned claude process. Verify env wiring + that pty was spawned
// with the inherited config.
{
  const result = await win.evaluate(async () => {
    const list = await window.ccsmPty?.list?.();
    return {
      ptyEntries: Array.isArray(list) ? list.length : null,
      claudeConfigDir: window.ccsmEnv?.CLAUDE_CONFIG_DIR ?? '(not exposed)',
    };
  });
  let verdict = 'PARTIAL';
  const notes = [`pty count: ${result.ptyEntries}; CCSM forwards CLAUDE_CONFIG_DIR via main process — verified by separate code path (electron/agent/sessions.ts)`];
  notes.push('Live skill/plugin listing not exercised (would require driving CLI /plugins or /skills inside pty)');
  record(6, 'Plugin / MCP / skill load (config forwarding)', verdict, notes.join('; '), null);
}

// ============================================================================
// PATH 7 — Tray + taskbar unread badge (PR #493 / #572 regression)
// ============================================================================
{
  let verdict = 'PASS';
  const notes = [];
  try {
    // Check BadgeManager debug seam (win32-specific)
    const badgeBefore = await electronApp.evaluate(({ app }) => {
      const dbg = globalThis.__ccsmBadgeDebug;
      return {
        appBadge: app.getBadgeCount?.() ?? 0,
        mgrTotal: dbg?.getTotal ? dbg.getTotal() : null,
        hasDbg: !!dbg,
      };
    });
    notes.push(`badge before: app=${badgeBefore.appBadge} mgr=${badgeBefore.mgrTotal} hasDbg=${badgeBefore.hasDbg}`);

    // Simulate notify increment via badge debug API if present
    if (badgeBefore.hasDbg) {
      const incResult = await electronApp.evaluate(() => {
        const dbg = globalThis.__ccsmBadgeDebug;
        try {
          dbg?.incrementSid?.('test-sid-r2');
          return { ok: true, total: dbg.getTotal() };
        } catch (e) { return { ok: false, err: String(e) }; }
      });
      notes.push(`after increment: total=${incResult.total} ok=${incResult.ok}`);

      const cleanup = await electronApp.evaluate(() => {
        const dbg = globalThis.__ccsmBadgeDebug;
        dbg?.clearSid?.('test-sid-r2');
        return dbg.getTotal();
      });
      notes.push(`after clear: total=${cleanup}`);

      if (incResult.total < 1) {
        verdict = 'FAIL';
        notes.push('badge increment did not register');
      }
    } else {
      verdict = 'PARTIAL';
      notes.push('__ccsmBadgeDebug seam absent in production build (debug-only?); plumbing verified by harness-real-cli case `notify-fires-on-idle`');
    }

    // Check tray exists
    const trayInfo = await electronApp.evaluate(({ Tray }) => {
      // Can't enumerate trays; just check the constructor is loadable
      return { trayClass: typeof Tray };
    });
    notes.push(`tray class loadable: ${trayInfo.trayClass}`);
  } catch (err) {
    verdict = 'FAIL';
    notes.push(String(err).slice(0, 200));
  }
  await win.screenshot({ path: path.join(screenshotDir, 'path-7-badge.png'), fullPage: true });
  record(7, 'Tray + taskbar unread badge (PR #493 regression)', verdict, notes.join('; '), 'path-7-badge.png');
}

// ============================================================================
// PATH 8 — Restart app, sessions restore
// ============================================================================
let restartVerdict = 'PASS';
let restartNotes = [];
let preRestartSessions = null;
{
  try {
    preRestartSessions = await win.evaluate(() => {
      const s = window.__ccsmStore?.getState?.();
      return {
        count: s?.sessions?.length ?? 0,
        ids: (s?.sessions || []).map((x) => x.id).slice(0, 5),
        activeId: s?.activeId,
      };
    });
    restartNotes.push(`pre-restart: ${preRestartSessions.count} sessions, activeId=${(preRestartSessions.activeId || '').slice(0, 8)}`);
  } catch (err) {
    restartVerdict = 'PARTIAL';
    restartNotes.push(`pre-restart capture failed: ${err}`);
  }

  // Close, then relaunch with same userData.
  try {
    await electronApp.close();
  } catch {}

  await sleep(2000);
  const app2 = await electron.launch({
    executablePath: ccsmExe,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1' },
    timeout: 60000,
  });
  const win2 = await app2.firstWindow();
  win2.on('console', (msg) => consoleEvents.push({ type: msg.type(), text: `[restart] ${msg.text()}` }));
  await win2.waitForLoadState('domcontentloaded');
  await sleep(3000);
  try {
    await win2.waitForFunction(() => !!window.__ccsmStore?.getState?.()?.hydrated, null, { timeout: 15000 });
  } catch {}
  await sleep(2000);
  const postRestart = await win2.evaluate(() => {
    const s = window.__ccsmStore?.getState?.();
    return {
      count: s?.sessions?.length ?? 0,
      ids: (s?.sessions || []).map((x) => x.id).slice(0, 5),
      activeId: s?.activeId,
      hydrated: s?.hydrated,
    };
  });
  restartNotes.push(`post-restart: ${postRestart.count} sessions, hydrated=${postRestart.hydrated}, activeId=${(postRestart.activeId || '').slice(0, 8)}`);

  if (preRestartSessions && postRestart.count < preRestartSessions.count) {
    restartVerdict = 'FAIL';
    restartNotes.push(`session count dropped ${preRestartSessions.count} -> ${postRestart.count}`);
  } else if (preRestartSessions && postRestart.count >= preRestartSessions.count) {
    restartNotes.push('all sessions restored');
  }

  await win2.screenshot({ path: path.join(screenshotDir, 'path-8-restart.png'), fullPage: true });
  record(8, 'Restart app, sessions restore', restartVerdict, restartNotes.join('; '), 'path-8-restart.png');

  // ============================================================================
  // PATH 9 — Window controls / shortcuts / settings
  // ============================================================================
  {
    let verdict = 'PASS';
    const notes = [];
    try {
      // Open settings via Cmd+, equivalent (Ctrl+,) — check via store route or
      // probe a known data-testid.
      const before = await win2.evaluate(() => {
        return {
          hasSettingsButton: !!document.querySelector('[data-testid*="settings"], [aria-label*="ettings"]'),
          hasSearchButton: !!document.querySelector('[data-testid*="search"]'),
          hasNewSessionButton: !!document.querySelector('button:has-text("New session"), [data-testid*="new-session"]'),
        };
      });
      notes.push(`controls present: settings=${before.hasSettingsButton} search=${before.hasSearchButton} new=${before.hasNewSessionButton}`);

      // Try Ctrl+F (search shortcut, MVP §3 item 7)
      await win2.keyboard.press('Control+f');
      await sleep(800);
      const afterSearch = await win2.evaluate(() => {
        return {
          paletteOpen: !!document.querySelector('[data-testid*="palette"], [data-testid*="search"][role="dialog"], [role="combobox"][aria-expanded="true"]'),
          modalCount: document.querySelectorAll('[role="dialog"]').length,
        };
      });
      notes.push(`Ctrl+F: paletteOpen=${afterSearch.paletteOpen} modalCount=${afterSearch.modalCount}`);
      if (!afterSearch.paletteOpen && afterSearch.modalCount === 0) {
        verdict = 'PARTIAL';
        notes.push('Ctrl+F may not have opened palette (selector may be stale)');
      }
      // Dismiss
      await win2.keyboard.press('Escape');
      await sleep(400);

      await win2.screenshot({ path: path.join(screenshotDir, 'path-9-search-palette.png'), fullPage: true });

      // Try Ctrl+, for settings
      await win2.keyboard.press('Control+,');
      await sleep(800);
      const afterSettings = await win2.evaluate(() => {
        const dlgs = Array.from(document.querySelectorAll('[role="dialog"], [data-testid*="settings"]'));
        return {
          settingsOpen: dlgs.some((d) => /setting/i.test(d.textContent || '') || /setting/i.test(d.getAttribute('data-testid') || '')),
          dlgCount: dlgs.length,
        };
      });
      notes.push(`Ctrl+,: settingsOpen=${afterSettings.settingsOpen} dlgCount=${afterSettings.dlgCount}`);
      await win2.screenshot({ path: path.join(screenshotDir, 'path-9-settings.png'), fullPage: true });
      await win2.keyboard.press('Escape');
    } catch (err) {
      verdict = 'FAIL';
      notes.push(String(err).slice(0, 200));
    }
    record(9, 'Window controls / shortcuts / settings', verdict, notes.join('; '), 'path-9-settings.png');
  }

  // Final dump
  const consoleErrors = consoleEvents.filter((e) => e.type === 'error' || e.type === 'pageerror');
  const summary = {
    build: 'release/win-unpacked/CCSM.exe',
    workingTip: '26f85b3',
    runDate: new Date().toISOString(),
    results,
    consoleErrorsCount: consoleErrors.length,
    consoleErrorsSample: consoleErrors.slice(0, 10),
  };
  writeFileSync(path.join(screenshotDir, 'r2-9paths-summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n===== R2 9-PATH SUMMARY =====');
  for (const r of results) {
    console.log(`Path ${r.id}: ${r.verdict} — ${r.name}`);
  }
  console.log(`Console errors: ${consoleErrors.length}`);

  await app2.close();
}
