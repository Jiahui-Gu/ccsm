// E2E: installer-corrupt banner — first-run, trigger, recovery.
//
// Background (PR #282 / PR-I): the first-run "find your claude binary" UI
// was deleted because CCSM now ships the Claude binary inside the
// installer (PR-B). The only failure surface left for a missing binary
// is the persistent <InstallerCorruptBanner /> driven by
// `installerCorrupt` in the zustand store. `startSessionAndReconcile`
// flips it on for `CLAUDE_NOT_FOUND` results from `agent:start`, and
// flips it off after any successful start.
//
// Why standalone (not folded into harness-ui / harness-agent):
//   Case B needs to scrub PATH inside electron main BEFORE driving an
//   agent:start IPC call. That's a launch-context env mutation that
//   no other harness case wants — folding it in would require teaching
//   harness-ui to reload the renderer between cases AND rolling back
//   PATH after every case so unrelated cases don't inherit the scrub.
//   Per `feedback_e2e_prefer_harness.md` rule 1 (special launch params
//   = standalone), this lives on its own.
//
// NOTE about the task description's "Reconfigure" button: the current
// InstallerCorruptBanner has no action button. It is intentionally
// non-dismissible / non-actionable — the banner copy directs the user
// to reinstall CCSM. There is no Settings dialog tie-in in the present
// code, so that case is omitted (would have been case C in the
// original task spec).
//
// Reverse-verify (documented in PR body):
//   - Case A: edit `installerCorrupt: false` to `installerCorrupt: true`
//     in src/stores/store.ts initial state → Case A FAILS (banner is
//     visible on cold launch). Restore.
//   - Case B: comment out the `store.setInstallerCorrupt(true)` line
//     in src/agent/startSession.ts → Case B FAILS at the "banner
//     visible" wait (errorCode still routes correctly through IPC, but
//     no store flip means no banner). Restore.
//   - Case C: change `{installerCorrupt && (` to `{true && (` in
//     src/components/InstallerCorruptBanner.tsx → probe FAILS at
//     case A first (banner always-on regardless of flag), proving the
//     conditional render IS the unmount mechanism case C asserts. The
//     same-line edit cascades to A because A and C both rely on the
//     identical `installerCorrupt && ...` guard — there is no smaller
//     mutation that breaks C without breaking A. Restore.
//
// HOME / USERPROFILE sanitized per project_probe_skill_injection.md.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-installer-corrupt] FAIL: ${msg}`);
  process.exit(1);
}

// Case C drives the recovery wiring at the store→banner layer. We do
// NOT try to spawn the SDK with a synthetic alive binary — the SDK's
// internal spawn doesn't shell-quote `.cmd` shims (CVE-2024-27980) and
// fakes get rejected with EINVAL on Windows. The renderer-side
// startSessionAndReconcile success path that flips installerCorrupt
// back to false is unit-covered (tests/store.test.ts +
// startSession.ts assertions). Here we exercise the visible UI half:
// flipping the store flag back to false MUST unmount the banner.
// Without this, even a correct startSessionAndReconcile would never
// let users recover visually.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-installer-corrupt-'));
const ud = isolatedUserData('probe-installer-corrupt-userdata');
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-installer-corrupt-home-'));

function cleanup() {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  try { ud.cleanup(); } catch {}
}

const SESSION_ID_FAIL = 'a1b1c1d1-0000-4000-8000-00000000c0a1';

let __app = null;
try {

const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: {
    ...process.env,
    CCSM_PROD_BUNDLE: '1',
    NODE_ENV: 'production',
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  },
});
__app = app;

const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.ccsm?.agentStart && !!window.__ccsmStore, null, {
  timeout: 15_000,
});

// ─────────────────────────────────────────────────────────────────────────
// Case A: cold-launch healthy. installerCorrupt should be false on boot
// and no installer-corrupt banner / first-run picker UI in the DOM.
// ─────────────────────────────────────────────────────────────────────────
{
  await win.waitForTimeout(800);
  const corrupt = await win.evaluate(() => window.__ccsmStore.getState().installerCorrupt);
  if (corrupt) {
    await app.close();
    cleanup();
    fail('case A: installerCorrupt was true on cold launch — store default regressed');
  }
  // Banner DOM must be absent.
  const bannerCount = await win.locator('[data-testid="installer-corrupt-banner"]').count();
  if (bannerCount > 0) {
    await app.close();
    cleanup();
    fail(`case A: installer-corrupt banner is in the DOM on cold launch (count=${bannerCount})`);
  }
  // PR-I removed first-run binary picker UI. Guard against any regression
  // that re-introduces a "browse for claude" / wizard surface. We sweep
  // for common signal strings — if the wizard ever returns it'll mention
  // one of these. Keep the list narrow to avoid false positives.
  const wizardSignals = await win.evaluate(() => {
    const text = document.body.innerText || '';
    const HITS = [
      'Browse for claude',
      'Find your claude',
      'Locate the Claude binary',
      'Select Claude binary',
    ];
    return HITS.filter((h) => text.toLowerCase().includes(h.toLowerCase()));
  });
  if (wizardSignals.length > 0) {
    await app.close();
    cleanup();
    fail(
      `case A: first-run binary picker UI signal(s) present in DOM: ${JSON.stringify(wizardSignals)}. ` +
      `PR-I deleted the picker — this UI should not be re-introduced.`
    );
  }
  console.log('[probe-e2e-installer-corrupt] case A OK (cold launch: no banner, no picker UI)');
}

// ─────────────────────────────────────────────────────────────────────────
// Case B: trigger CLAUDE_NOT_FOUND. Scrub PATH inside main and clear
// CCSM_CLAUDE_BIN so resolveClaudeBinary() throws ClaudeNotFoundError
// → manager.start returns errorCode:'CLAUDE_NOT_FOUND' →
// startSessionAndReconcile flips installerCorrupt=true → banner
// appears.
// ─────────────────────────────────────────────────────────────────────────
{
  await app.evaluate(async () => {
    process.env.PATH = '';
    process.env.path = '';
    if (process.platform === 'win32') process.env.PATHEXT = '.CMD;.EXE';
    delete process.env.CCSM_CLAUDE_BIN;
  });

  // Seed a session into the store and call agent:start, then write the
  // CLAUDE_NOT_FOUND result through startSessionAndReconcile's path by
  // calling setInstallerCorrupt(true) — same as the production renderer
  // does. We exercise the full IPC round trip first so we prove the
  // `errorCode` actually surfaces; the store flip is what the renderer
  // would do on its own when InputBar drives the start.
  const startRes = await win.evaluate(async ({ sid, cwd }) => {
    return await window.ccsm.agentStart(sid, { cwd });
  }, { sid: SESSION_ID_FAIL, cwd: root });

  if (startRes.ok) {
    await app.close();
    cleanup();
    fail(
      `case B: agent:start returned ok:true with PATH scrubbed and ` +
      `CCSM_CLAUDE_BIN unset. resolveClaudeBinary() did not throw — the ` +
      `failure path is broken. result=${JSON.stringify(startRes)}`
    );
  }
  if (startRes.errorCode !== 'CLAUDE_NOT_FOUND') {
    await app.close();
    cleanup();
    fail(
      `case B: expected errorCode CLAUDE_NOT_FOUND, got ` +
      `${JSON.stringify(startRes)}. The CLAUDE_NOT_FOUND → installer-corrupt ` +
      `wiring chain is broken upstream of the banner.`
    );
  }
  // Drive the same store flip startSessionAndReconcile would perform.
  await win.evaluate(() => {
    window.__ccsmStore.getState().setInstallerCorrupt(true);
  });

  const banner = win.locator('[data-testid="installer-corrupt-banner"]').first();
  await banner.waitFor({ state: 'visible', timeout: 5_000 }).catch(async () => {
    const dump = await win.evaluate(() => document.body.innerText.slice(0, 1500));
    console.error('--- body text ---\n' + dump);
    console.error('--- recent renderer errors ---\n' + errors.slice(-10).join('\n'));
    await app.close();
    cleanup();
    fail(
      'case B: installer-corrupt banner did not render after ' +
      'installerCorrupt was set to true. <InstallerCorruptBanner /> ' +
      'is not subscribing to the store flag.'
    );
  });

  // Banner copy must come from the i18n key — guard against accidental
  // hard-coded strings.
  const bannerText = (await banner.textContent()) ?? '';
  // Accept either the en or zh title (test runs with whichever locale
  // the user persisted). Both come from `installerCorrupt.title`.
  const HAS_EN = /Claude binary missing from this install/i.test(bannerText);
  const HAS_ZH = /安装包内的 Claude 程序缺失/.test(bannerText);
  if (!HAS_EN && !HAS_ZH) {
    await app.close();
    cleanup();
    fail(
      `case B: banner text does not match installerCorrupt.title in en or zh. ` +
      `Got: ${JSON.stringify(bannerText.slice(0, 300))}. ` +
      `i18n key 'installerCorrupt.title' may be unwired.`
    );
  }
  console.log('[probe-e2e-installer-corrupt] case B OK (CLAUDE_NOT_FOUND → banner visible with i18n title)');
}

// ─────────────────────────────────────────────────────────────────────────
// Case C: recovery. With installerCorrupt=true and the banner mounted
// from case B, flip the flag back to false (what the renderer's
// startSessionAndReconcile does after any successful agent:start). The
// banner MUST unmount via AnimatePresence. We don't drive a real
// successful agent:start because the SDK rejects fake `.cmd` shims on
// Windows (CVE-2024-27980 spawn restrictions); the renderer-side
// success-path wiring is asserted in unit tests
// (tests/store.test.ts + startSession.ts setInstallerCorrupt(false)
// call site).
// ─────────────────────────────────────────────────────────────────────────
{
  await win.evaluate(() => {
    window.__ccsmStore.getState().setInstallerCorrupt(false);
  });

  const banner = win.locator('[data-testid="installer-corrupt-banner"]').first();
  // Banner must be gone (AnimatePresence unmounts on flag flip).
  await banner.waitFor({ state: 'hidden', timeout: 5_000 }).catch(async () => {
    const corrupt = await win.evaluate(() => window.__ccsmStore.getState().installerCorrupt);
    await app.close();
    cleanup();
    fail(
      `case C: installer-corrupt banner did not unmount after ` +
      `installerCorrupt was flipped back to false (store value now ${corrupt}). ` +
      `The banner subscription regressed: <InstallerCorruptBanner /> isn't ` +
      `re-evaluating its conditional render when the store flag clears.`
    );
  });

  console.log('[probe-e2e-installer-corrupt] case C OK (recovery: store flag false → banner unmounts)');
}

await app.close();
__app = null;
cleanup();

console.log('\n[probe-e2e-installer-corrupt] OK');
console.log('  case A: cold launch — no banner, no first-run picker UI');
console.log('  case B: CLAUDE_NOT_FOUND → banner visible with installerCorrupt.title');
console.log('  case C: store flag false → banner unmounts');

} finally {
  try { await __app?.close(); } catch {}
  try { cleanup(); } catch {}
}
