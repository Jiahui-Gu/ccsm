// E2E standalone harness — workflow group ② persistence-resume.
//
// Single case: `reopen-resume`.
//
// Flow:
//   1. Launch ccsm with isolated tempDir (CLAUDE_CONFIG_DIR) + isolated
//      userDataDir (electron settings/db). Fake Anthropic API serves
//      /v1/messages so the real claude binary can stream a reply without
//      hitting the network.
//   2. Create a new session, send a recognizable PROBE_TOKEN_RESUME_* prompt,
//      wait for it to appear in the xterm buffer + state idle.
//   3. Snapshot the sid + buffer content.
//   4. Quit ccsm (app.quit + electronApp.close).
//   5. Relaunch ccsm with SAME tempDir + userDataDir.
//   6. Assert:
//      (a) same sid in sidebar
//      (b) opening it → xterm buffer replay contains the PROBE_TOKEN
//      (c) the new claude child argv contains `--resume <sid>` —
//          INDIRECT: claude only re-prints the prior transcript on the
//          `--resume <sid>` code path; `--session-id` opens a fresh
//          transcript and prints nothing. PROBE_TOKEN re-appearing in the
//          run-2 buffer therefore implies `--resume` was used. See
//          "argv seam blocker" note below.
//
// argv seam blocker (TDD red-blocker per spec):
//   `window.ccsmPty.list()` returns `{ sid, pid, cols, rows, cwd }` with no
//   `args`. A direct argv-string assertion on `pty.spawn` would require a
//   real ccsm-side seam — either extending `pty.list()` with `args` or a
//   test-only IPC. Playwright's `electronApp.evaluate` sandbox cannot
//   monkey-patch `require('node-pty').spawn` from outside (no `require` in
//   scope, `process.mainModule.children` not surfaced through the closure).
//   This harness uses the PROBE_TOKEN buffer-replay as the strongest
//   indirect proof; adding the seam upgrade is filed for follow-up.
//
// Boundary: we do NOT assert claude remembers the token across restart —
// that's the upstream binary's responsibility. ccsm only owns: sid
// persistence, xterm replay, and spawning claude with `--resume <sid>`.
//
// Run:
//   node scripts/harness-e2e-persistence-resume.mjs

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  dismissFirstRunModals,
  launchCcsmIsolated,
  seedSession,
  sendToClaudeTui,
  waitForTerminalReady,
  waitForXtermBuffer,
} from './probe-utils-real-cli.mjs';
import { startFakeAnthropicApi } from './fixtures/fake-anthropic-api.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed an isolated `.claude.json` with the onboarding-completed flag so the
// CLI doesn't intercept keystrokes with the trust / first-run modals. Trusts
// `trustedCwd` so claude's per-cwd trust dialog also stays out of the way.
function seedMinimalOnboarding(tempDir, trustedCwd) {
  const trustedEntry = {
    allowedTools: [], mcpContextUris: [], mcpServers: {},
    enabledMcpjsonServers: [], disabledMcpjsonServers: [],
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: 1,
  };
  const cfg = {
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    // Pre-approve the fake-ci-key so the CLI doesn't prompt "Do you want to
    // use this API key?" on cold start. Matches the local-e2e seed used
    // historically (see ~/.claude/file-history backups for the same shape).
    customApiKeyResponses: { approved: ['fake-ci-key'], rejected: [] },
    projects: {
      [trustedCwd]: trustedEntry,
      [trustedCwd.replace(/\\/g, '/')]: trustedEntry,
    },
  };
  writeFileSync(path.join(tempDir, '.claude.json'), JSON.stringify(cfg, null, 2));
  for (const name of ['settings.json', 'settings.local.json']) {
    writeFileSync(path.join(tempDir, name), JSON.stringify({}, null, 2));
  }
}

async function forceEnglish(win) {
  await win.evaluate(async () => {
    try { window.localStorage.removeItem('ccsm:preferences'); } catch { /* ignore */ }
    try { await window.ccsm?.i18n?.setLanguage?.('en'); } catch { /* ignore */ }
    try {
      const i18n = window.__ccsmI18n;
      if (i18n && typeof i18n.changeLanguage === 'function') await i18n.changeLanguage('en');
    } catch { /* ignore */ }
  });
}

async function caseReopenResume({ fakeApi }) {
  const PROBE_TOKEN = `PROBE_TOKEN_RESUME_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const isolated = await createIsolatedClaudeDir();
  const tempDir = isolated.tempDir;
  // The cwd we pass to claude. MUST satisfy three constraints (same as
  // harness-e2e-import-from-claude — see notes there): exists, no
  // `.`-segments, no `ccsm-` segment so the import scanner doesn't filter.
  // A sibling of tempDir under TMP_ROOT with a non-`ccsm-` prefix works.
  const seedCwd = mkdtempSync(path.join(tmpdir(), 'probe-cwd-'));
  seedMinimalOnboarding(tempDir, seedCwd);

  const userDataDir = mkdtempSync(path.join(tmpdir(), 'ccsm-e2e-persistence-userdata-'));

  let app1 = null;
  let app2 = null;
  let snapshotSid = null;

  const launchEnv = {
    ANTHROPIC_BASE_URL: fakeApi.url,
    ANTHROPIC_API_KEY: 'fake-ci-key',
    CCSM_E2E_HIDDEN: '1',
  };

  try {
    // -------------- run 1 --------------
    const launched1 = await launchCcsmIsolated({ tempDir, userDataDir, env: launchEnv });
    app1 = launched1.electronApp;
    const win1 = launched1.win;

    await sleep(2000);
    await forceEnglish(win1);
    await sleep(200);

    const { sid } = await seedSession(win1, { name: 'persistence-probe', cwd: seedCwd });
    if (!sid) throw new Error('seedSession returned no sid');
    snapshotSid = sid;

    await waitForTerminalReady(win1, sid, { timeout: 30000 });
    await waitForXtermBuffer(
      win1,
      /claude|welcome|│|╭|╰|\?\sfor\sshortcuts|trust|>/i,
      { timeout: 60000 },
    );
    await dismissFirstRunModals(win1);

    // Send the probe prompt + Enter.
    await sendToClaudeTui(win1, PROBE_TOKEN);
    await sleep(400);
    await sendToClaudeTui(win1, '\r');

    // Wait for token to land in the xterm buffer (claude echoes the user
    // line in its TUI input box even before any reply arrives).
    await waitForXtermBuffer(win1, new RegExp(PROBE_TOKEN), { timeout: 30000 });

    // Wait a beat so JSONL flush + ccsm persist debounce land before quit.
    await sleep(4000);

    // Quit ccsm (real quit, not just window close — drives the persistence
    // shutdown path).
    try {
      await app1.evaluate(({ app: a }) => a.quit());
    } catch { /* expected: context tears down mid-evaluate */ }
    try { await app1.close(); } catch { /* already closing */ }
    app1 = null;

    // -------------- run 2 --------------
    const launched2 = await launchCcsmIsolated({ tempDir, userDataDir, env: launchEnv });
    app2 = launched2.electronApp;
    const win2 = launched2.win;

    await sleep(1500);

    // Assertion (a): same sid in sidebar.
    const sessionRow = `[data-session-id="${snapshotSid}"]`;
    await win2.waitForSelector(sessionRow, { timeout: 15000 });

    // Click to open the persisted session.
    await win2.locator(sessionRow).first().click();
    await sleep(500);
    const activeId = await win2.evaluate(
      () => window.__ccsmStore?.getState?.()?.activeId ?? null,
    );
    if (activeId !== snapshotSid) {
      throw new Error(
        `run2: activeId did not follow click — expected ${snapshotSid}, got ${activeId}`,
      );
    }

    // Wait for the terminal to attach + replay.
    await waitForTerminalReady(win2, snapshotSid, { timeout: 30000 });

    // Assertion (b) + indirect (c): the xterm buffer must contain
    // PROBE_TOKEN after the resume completes. This proves both that the
    // session was reopened AND that ccsm spawned claude with `--resume
    // <sid>` (the only code path that re-prints prior JSONL content; see
    // top-of-file argv-seam note).
    await waitForXtermBuffer(win2, new RegExp(PROBE_TOKEN), { timeout: 60000 });

    // Pty bridge sanity: window.ccsmPty.list() must report an entry for the
    // sid — the strongest "spawn was for this sid" signal we can read
    // without the documented argv seam.
    const ptyEntry = await win2.evaluate(async (s) => {
      if (!window.ccsmPty || typeof window.ccsmPty.list !== 'function') return null;
      try {
        const arr = await window.ccsmPty.list();
        return (arr || []).find((x) => x.sid === s) ?? null;
      } catch { return null; }
    }, snapshotSid);
    if (!ptyEntry) {
      throw new Error(
        `run2: window.ccsmPty.list() has no entry for sid=${snapshotSid} — ` +
          `pty never spawned for the reopened session`,
      );
    }
    console.log(`[reopen-resume] run2 pty entry: ${JSON.stringify(ptyEntry)}`);
  } finally {
    if (app1) try { await app1.close(); } catch { /* ignore */ }
    if (app2) try { await app2.close(); } catch { /* ignore */ }
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(seedCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    isolated.cleanup?.();
  }
}

async function main() {
  if (!existsSync(path.resolve('dist/renderer/index.html'))) {
    console.error('dist/renderer/index.html missing — run `npm run build` first');
    process.exit(2);
  }
  const fakeApi = await startFakeAnthropicApi({ port: 0, verbose: false });
  console.log(`[harness-e2e-persistence-resume] fake API listening at ${fakeApi.url}`);

  let exitCode = 0;
  const t0 = Date.now();
  try {
    console.log('\n[harness-e2e-persistence-resume] >>> case: reopen-resume');
    await caseReopenResume({ fakeApi });
    console.log(`[harness-e2e-persistence-resume] <<< PASS reopen-resume (${Date.now() - t0}ms)`);
  } catch (err) {
    exitCode = 1;
    console.error(
      `[harness-e2e-persistence-resume] <<< FAIL reopen-resume (${Date.now() - t0}ms): ${err?.stack || err}`,
    );
  } finally {
    try { await fakeApi.stop(); } catch { /* ignore */ }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[harness-e2e-persistence-resume] unhandled top-level error:', err?.stack || err);
  process.exit(1);
});
