// Dogfood probe — capture actual UI + run end-to-end happy path.
//
// 1. Boot packaged dist via electron+playwright with isolated user-data.
// 2. Capture rootHTML / store snapshot / bridge keys / console events.
// 3. Click "New session" CTA, wait for the in-renderer terminal to mount.
// 4. Verify a pty exists for the active session via window.ccsmPty.list()
//    and confirm the claude pid is alive via process.kill(pid, 0).
// 5. Inside the terminal, type a prompt to claude, wait for reply.
// 6. Screenshot populated session.
//
// ARCHITECTURE NOTE — direct-xterm (post-PR-1..PR-6):
//   The renderer hosts xterm.js directly (no <webview>, no ttyd HTTP
//   server). The pty is owned by main and exposed to the renderer via
//   `window.ccsmPty.{list,attach,detach,input,resize,kill,spawn,onData,
//   onExit}`. Probes drive the terminal via
//   `win.evaluate(() => window.__ccsmTerm....)` and assert pty health
//   via `window.ccsmPty.list()` + `process.kill(pid, 0)`.

import { _electron as electron } from 'playwright';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

const userData = path.resolve('.dogfood-userdata');
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });
const screenshotDir = path.resolve('docs/screenshots/dogfood-current-ui');
mkdirSync(screenshotDir, { recursive: true });

const consoleEvents = [];
const steps = [];
const log = (step, ok, detail) => {
  steps.push({ step, ok, detail });
  console.log(`[${ok ? 'OK' : 'FAIL'}] ${step}${detail ? ': ' + JSON.stringify(detail).slice(0, 200) : ''}`);
};

const electronApp = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`],
  env: {
    ...process.env,
    ELECTRON_DISABLE_GPU: '1',
    NODE_ENV: 'production',
    CCSM_PROD_BUNDLE: '1',
  },
  timeout: 60000,
});

const win = await electronApp.firstWindow();
win.on('console', (msg) => consoleEvents.push({ type: msg.type(), text: msg.text() }));
win.on('pageerror', (err) => consoleEvents.push({ type: 'pageerror', text: String(err) }));

await win.waitForLoadState('domcontentloaded');
await new Promise((r) => setTimeout(r, 4500));
log('boot', true, null);

// ---------- STEP A: capture initial state ----------
const initial = await win.evaluate(async () => {
  const root = document.getElementById('root');
  let claudeProbe = null;
  try {
    if (window.ccsmPty?.checkClaudeAvailable) {
      claudeProbe = await window.ccsmPty.checkClaudeAvailable();
    }
  } catch (e) { claudeProbe = { error: String(e) }; }
  const s = window.__ccsmStore?.getState?.();
  return {
    rootHTML: root?.outerHTML?.slice(0, 4000) ?? '<no #root>',
    bridgePresent: typeof window.ccsmPty !== 'undefined',
    bridgeKeys: window.ccsmPty ? Object.keys(window.ccsmPty) : null,
    ptyBridgePresent: typeof window.ccsmPty !== 'undefined',
    ptyBridgeKeys: window.ccsmPty ? Object.keys(window.ccsmPty) : null,
    claudeProbe,
    storeSnapshot: s ? {
      sessionsCount: s.sessions?.length ?? null,
      activeId: s.activeId ?? null,
      hydrated: s.hydrated ?? null,
      claudeAvailable: s.claudeAvailable ?? null,
      tutorialSeen: s.tutorialSeen ?? null,
    } : null,
    bodyText: document.body.innerText.slice(0, 600),
    testIds: Array.from(document.querySelectorAll('[data-testid]'))
      .map((el) => el.getAttribute('data-testid')),
  };
});
log('initial-snapshot', true, { activeId: initial.storeSnapshot?.activeId, claudeAvailable: initial.storeSnapshot?.claudeAvailable, testIds: initial.testIds });
await win.screenshot({ path: path.join(screenshotDir, '01-initial.png') });

// ---------- STEP B: click "New session" ----------
let createOk = false;
try {
  // First-run-empty has the New session button. If user has dismissed
  // tutorial it may be the same; if not, the Tutorial component shows
  // its own CTA. Try both.
  const firstRun = await win.locator('[data-testid="first-run-empty"]').count();
  if (firstRun > 0) {
    await win.locator('[data-testid="first-run-empty"] button').first().click();
  } else {
    // Tutorial path — find a "New session" / "Start" / primary button.
    await win.locator('button:has-text("New session"), button:has-text("Start")').first().click();
  }
  createOk = true;
  log('click-new-session', true, null);
} catch (err) {
  log('click-new-session', false, String(err).slice(0, 200));
}

await new Promise((r) => setTimeout(r, 2500));

// ---------- STEP C: wait for terminal host to mount ----------
let terminalMounted = false;
let activeSidAfterCreate = null;
try {
  await win.waitForSelector('[data-terminal-host]', { timeout: 15000 });
  terminalMounted = true;
  activeSidAfterCreate = await win.evaluate(() => {
    const el = document.querySelector('[data-terminal-host]');
    return el ? el.getAttribute('data-active-sid') : null;
  });
  // Wait for window.__ccsmTerm singleton to exist too — proves xterm.js
  // initialised against the host DIV.
  await win.waitForFunction(() => !!window.__ccsmTerm, null, { timeout: 10000 });
  log('terminal-mounted', true, { activeSid: activeSidAfterCreate });
} catch (err) {
  log('terminal-mounted', false, String(err).slice(0, 200));
}

await win.screenshot({ path: path.join(screenshotDir, '02-after-create.png') });

// ---------- STEP D: pty health check ----------
// Direct-xterm: instead of `tasklist /FI "IMAGENAME eq ttyd.exe"`, query
// the renderer's window.ccsmPty.list() bridge for the pid main spawned,
// then verify it's alive via process.kill(pid, 0) (the canonical Unix /
// Node "is process alive" probe; works on Windows too via libuv).
let ptyAlive = false;
let ptyDetail = null;
try {
  const ptyList = await win.evaluate(async () => {
    if (!window.ccsmPty || typeof window.ccsmPty.list !== 'function') {
      return { ok: false, reason: 'window.ccsmPty.list unavailable' };
    }
    try {
      const arr = await window.ccsmPty.list();
      return { ok: true, entries: arr };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  });
  if (!ptyList.ok) {
    ptyDetail = { reason: ptyList.reason };
  } else if (!Array.isArray(ptyList.entries) || ptyList.entries.length === 0) {
    ptyDetail = { reason: 'pty list empty' };
  } else {
    // Pick the entry matching the active session if we have one;
    // otherwise the first.
    const targetSid = activeSidAfterCreate;
    const entry =
      (targetSid && ptyList.entries.find((x) => x.sid === targetSid)) ||
      ptyList.entries[0];
    const pid = entry && typeof entry.pid === 'number' ? entry.pid : null;
    if (!pid) {
      ptyDetail = { reason: 'no pid on pty entry', entry };
    } else {
      try {
        // process.kill(pid, 0) throws if the process is gone; succeeds (no-op
        // signal) if alive. Works on win32 + posix.
        process.kill(pid, 0);
        ptyAlive = true;
        ptyDetail = { sid: entry.sid, pid };
      } catch (err) {
        ptyDetail = { reason: `process.kill(pid, 0) threw: ${String(err)}`, sid: entry.sid, pid };
      }
    }
  }
  log('pty-process-alive', ptyAlive, ptyDetail);
} catch (err) {
  log('pty-process-alive', false, String(err).slice(0, 200));
}

// ---------- STEP E: type into the terminal ----------
// Direct-xterm: type via window.__ccsmTerm._core._coreService.triggerDataEvent
// (claude TUI swallows bracketed-paste, so .paste() doesn't work).
let typedOk = false;
let bufferText = null;
let claudeReplied = false;
if (terminalMounted) {
  try {
    // Wait for the host to be interactive before sending.
    await new Promise((r) => setTimeout(r, 3000));
    const sendOk = await win.evaluate((text) => {
      const term = window.__ccsmTerm;
      if (!term || !term._core) return false;
      const cs = term._core._coreService || term._core.coreService;
      if (!cs || typeof cs.triggerDataEvent !== 'function') return false;
      try {
        const ta = document.querySelector('.xterm-helper-textarea');
        if (ta) ta.focus();
        if (typeof term.focus === 'function') term.focus();
      } catch (_) { /* ignore */ }
      cs.triggerDataEvent(text, true);
      return true;
    }, 'say hello in 3 words');
    if (!sendOk) throw new Error('triggerDataEvent unavailable');
    await new Promise((r) => setTimeout(r, 500));
    await win.evaluate(() => {
      const term = window.__ccsmTerm;
      const cs = term._core._coreService || term._core.coreService;
      cs.triggerDataEvent('\r', true);
    });
    typedOk = true;
    log('terminal-type', true, null);

    // Wait up to 30s for "hello" to appear in the xterm buffer.
    const readBuffer = async () => await win.evaluate(() => {
      const term = window.__ccsmTerm;
      if (!term || !term.buffer || !term.buffer.active) return '';
      const buf = term.buffer.active;
      const out = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (!line) continue;
        out.push(line.translateToString(true));
      }
      return out.join('\n');
    });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      bufferText = await readBuffer().catch(() => null);
      if (bufferText && /hello/i.test(bufferText)) {
        claudeReplied = true;
        break;
      }
    }
    log('claude-replied', claudeReplied, bufferText ? bufferText.slice(-400) : null);
  } catch (err) {
    log('terminal-type', false, String(err).slice(0, 300));
  }
}

await win.screenshot({ path: path.join(screenshotDir, '03-after-prompt.png'), fullPage: true });

// ---------- STEP F: dump final state ----------
const final = await win.evaluate(() => {
  const s = window.__ccsmStore?.getState?.();
  return {
    sessionsCount: s?.sessions?.length ?? null,
    activeId: s?.activeId ?? null,
    bodyText: document.body.innerText.slice(0, 400),
  };
});
log('final-state', true, final);

// ===================================================================
// Lifecycle deferred-fixes coverage (P1-1, P1-2, P0-1, P0-3)
// ===================================================================

const ptyPidsForSid = async (sid) => {
  return await win.evaluate(async (s) => {
    if (!window.ccsmPty || typeof window.ccsmPty.list !== 'function') return [];
    try {
      const arr = await window.ccsmPty.list();
      return (arr || [])
        .filter((x) => !s || x.sid === s)
        .map((x) => x.pid)
        .filter((p) => typeof p === 'number');
    } catch {
      return [];
    }
  }, sid);
};

// ---------- Case A: JSONL filename matches ccsm sessionId ----------
let caseAOk = false;
let caseAdetail = null;
try {
  const sid = final.activeId;
  if (!sid) throw new Error('no activeId');
  // claude encodes the cwd dir into ~/.claude/projects/<encoded>/<sid>.jsonl.
  // The encoding replaces path separators + colons with `-` (Windows: `C:\foo\bar` → `C--foo-bar`).
  // We don't know the exact encoding here; fall back to scanning all project
  // dirs for a file named `<sid>.jsonl`.
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let matched = null;
  if (existsSync(projectsRoot)) {
    const dirs = execSync(`dir /b "${projectsRoot}"`, { encoding: 'utf8', shell: 'cmd.exe' })
      .split(/\r?\n/)
      .filter(Boolean);
    for (const d of dirs) {
      const candidate = path.join(projectsRoot, d, `${sid}.jsonl`);
      if (existsSync(candidate)) {
        matched = candidate;
        break;
      }
    }
  }
  caseAOk = !!matched;
  caseAdetail = { sid, matched };
  log('case-A jsonl-matches-ccsm-sid', caseAOk, caseAdetail);
} catch (err) {
  log('case-A jsonl-matches-ccsm-sid', false, String(err).slice(0, 200));
}

// ---------- Case B: switch sessions does not respawn pty ----------
// Capture A's pid via window.ccsmPty.list(); create session B; switch back;
// verify A's pid is unchanged AND still alive.
let caseBOk = false;
let caseBdetail = null;
try {
  const sidA = final.activeId;
  const beforePidsA = await ptyPidsForSid(sidA);
  if (beforePidsA.length === 0) throw new Error('no pty for sessionA pre-switch');
  const pidA1 = beforePidsA[0];
  // Create session B + switch
  const sidB = await win.evaluate(() => {
    const s = window.__ccsmStore?.getState?.();
    s?.createSession?.(null);
    return window.__ccsmStore?.getState?.()?.activeId ?? null;
  });
  await new Promise((r) => setTimeout(r, 1500));
  // Switch back to A
  await win.evaluate((sid) => {
    window.__ccsmStore?.getState?.()?.selectSession?.(sid);
  }, sidA);
  await new Promise((r) => setTimeout(r, 1500));
  const afterPidsA = await ptyPidsForSid(sidA);
  const pidA2 = afterPidsA[0];
  let stillAlive = false;
  if (typeof pidA2 === 'number') {
    try { process.kill(pidA2, 0); stillAlive = true; } catch { stillAlive = false; }
  }
  caseBOk = pidA2 === pidA1 && stillAlive;
  caseBdetail = { sidA, sidB, pidA1, pidA2, stillAlive };
  log('case-B switch-preserves-pty', caseBOk, caseBdetail);
} catch (err) {
  log('case-B switch-preserves-pty', false, String(err).slice(0, 200));
}

// ---------- Case C: deleteSession reaps pty ----------
let caseCOk = false;
let caseCdetail = null;
try {
  const targetSid = final.activeId;
  const beforePids = await ptyPidsForSid(targetSid);
  if (beforePids.length === 0) throw new Error('no pty to delete');
  const pidBefore = beforePids[0];
  await win.evaluate((sid) => {
    window.__ccsmStore?.getState?.()?.deleteSession?.(sid);
  }, targetSid);
  // Give the IPC + kill a moment.
  await new Promise((r) => setTimeout(r, 2500));
  const afterPids = await ptyPidsForSid(targetSid);
  let processGone = true;
  try { process.kill(pidBefore, 0); processGone = false; } catch { processGone = true; }
  caseCOk = afterPids.length === 0 && processGone;
  caseCdetail = { targetSid, pidBefore, afterPids, processGone };
  log('case-C delete-reaps-pty', caseCOk, caseCdetail);
} catch (err) {
  log('case-C delete-reaps-pty', false, String(err).slice(0, 200));
}

// ---------- Case D: resolveClaude force re-scan ----------
// Skipped: requires moving the claude.cmd binary off PATH on the live
// system, which would interfere with the user's own CLI install. The
// {force:true} flag is exercised by the renderer button via a unit-level
// path; e2e for this case is documented as deferred.
log('case-D claude-force-rescan', false, 'skipped: would mutate user PATH');

const summary = { initial, steps, final, consoleErrors: consoleEvents.filter((e) => e.type === 'error' || e.type === 'pageerror') };
writeFileSync(path.join(screenshotDir, 'probe-summary.json'), JSON.stringify(summary, null, 2));

console.log('\n===== SUMMARY =====');
console.log(JSON.stringify(summary, null, 2));

await electronApp.close();
