// E2E standalone harness — workflow group ③ import-from-claude.
//
// Single case: `import-resume`.
//
// Flow:
//   1. Pre-seed a JSONL under `tempDir/.claude/projects/<encoded-cwd>/<sid>.jsonl`
//      with a known user-input frame ("PROBE_IMPORT_<rand>") for an unknown sid.
//   2. Launch ccsm with this tempDir. Sidebar must NOT show this session yet —
//      it lives on disk under the upstream claude config path, not in ccsm.db.
//   3. Click the sidebar Import button (download icon).
//   4. Assert: the scan dialog lists the seeded session in its bucket.
//   5. Check the row's checkbox, click "Import N".
//   6. Assert: session row appears in Sidebar with `resumeSessionId === <sid>`.
//   7. Click the session row to open it.
//   8. Assert:
//      (a) claude child argv contains `--resume <sid>` (captured via main-
//          process monkey-patch on `node-pty`'s `spawn`).
//      (b) xterm buffer replay contains "PROBE_IMPORT_<rand>" — the prior
//          user line claude prints from its own JSONL on --resume.
//
// Run:
//   node scripts/harness-e2e-import-from-claude.mjs

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createIsolatedClaudeDir,
  dismissFirstRunModals,
  launchCcsmIsolated,
  waitForTerminalReady,
  waitForXtermBuffer,
} from './probe-utils-real-cli.mjs';
import { startFakeAnthropicApi } from './fixtures/fake-anthropic-api.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ccsm's `cwdToProjectKey` (electron/sessionWatcher/projectKey.ts) replaces
// `\`, `/`, `:` with `-`. The import-scanner uses this encoder, so the
// scanner-read path under `<HOME>/.claude/projects/` must be named with
// it.
function encodeCwdForCcsmScanner(cwd) {
  return cwd.replace(/[\\/:]/g, '-');
}

// The real claude binary uses a STRICTER encoder: every non-alphanumeric
// character collapses to `-`. Extracted from the upstream claude-agent-sdk
// (`sdk.mjs`):
//
//   function x1($) { let X = $.replace(/[^a-zA-Z0-9]/g, "-");
//                    if (X.length <= 200) return X;
//                    return `${X.slice(0,200)}-${hash($)}`; }
//
// Plus claude NFC-normalizes the cwd and resolves symlinks BEFORE encoding
// (`(await fs.promises.realpath($)).normalize("NFC")`). The harness must
// match this exactly when seeding `<HOME>/projects/<claude-encoded>/<sid>.jsonl`,
// otherwise `claude --resume` reports "No conversation found".
//
// Divergence from ccsm's encoder matters for any cwd containing `_`, `.`,
// `~`, or other non-alphanumeric characters — including macOS tmpdir
// (`/var/folders/p8/qyz0lmpd2mld64f_f4c66y4c0000gn/T/...`, underscores)
// and Windows tmpdir 8.3 short names (`C:\Users\RUNNER~1\...`, tilde).
function encodeCwdForClaudeBinary(cwd) {
  const normalized = cwd.normalize('NFC');
  const encoded = normalized.replace(/[^a-zA-Z0-9]/g, '-');
  // Path-length truncation: we never produce >200-char paths in this
  // harness (tmpdir paths are short), so omit the hash branch.
  return encoded.length <= 200 ? encoded : encoded.slice(0, 200);
}

function seedMinimalOnboarding(tempDir, trustedCwd) {
  const claudeJsonPath = path.join(tempDir, '.claude.json');
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
    // use this API key?" on cold start.
    customApiKeyResponses: { approved: ['fake-ci-key'], rejected: [] },
    projects: {
      [trustedCwd]: trustedEntry,
      [trustedCwd.replace(/\\/g, '/')]: trustedEntry,
    },
  };
  writeFileSync(claudeJsonPath, JSON.stringify(cfg, null, 2));
  for (const name of ['settings.json', 'settings.local.json']) {
    writeFileSync(path.join(tempDir, name), JSON.stringify({}, null, 2));
  }
}

// IMPORTANT — argv-inspection seam status (TDD red-blocker per spec):
//   The spec asks: "claude child argv contains `--resume <sid>`".
//   ccsm does not expose claude's argv to JS — `window.ccsmPty.list()`
//   returns `{ sid, pid, cols, rows, cwd }` with no `args`. A main-process
//   monkey-patch on `require('node-pty').spawn` was attempted but
//   playwright's `electronApp.evaluate` sandbox neither exposes `require`
//   nor surfaces the loaded node-pty record through `process.mainModule`
//   in a way the closure can reach. Adding a real seam (e.g. extending
//   `pty.list()` with `args`, or a test-only debug IPC) is the right
//   long-term fix; this harness instead INDIRECTLY proves --resume was
//   chosen via the JSONL-replay assertion below:
//
//     If `--resume <sid>` was NOT used, claude would never reach the JSONL
//     and the prior user line (PROBE_TOKEN) would never re-appear in the
//     xterm buffer. The buffer-replay assertion therefore acts as a strong
//     proxy: it passes only when ccsm in fact spawned claude with --resume.
//
//   Verification path → DOCUMENTED-GAP-ONLY for direct argv string check.

async function caseImportResume({ fakeApi }) {
  const PROBE_TOKEN = `PROBE_IMPORT_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const isolated = await createIsolatedClaudeDir();
  const tempDir = isolated.tempDir;
  // The session's recorded cwd. MUST satisfy three constraints:
  //   1. Exist on disk — otherwise `resolveSpawnCwd` falls back to homedir
  //      and the spawn-cwd projectKey diverges from our seed location.
  //   2. NOT contain any `.`-prefixed segment — the real claude binary's
  //      projectDir encoder collapses `.` to `-` while ccsm's
  //      `cwdToProjectKey` does not, so a `.claude` segment in cwd
  //      produces a path mismatch and `claude --resume` reports
  //      "No conversation found".
  //   3. NOT match `isCCSMTempCwd` (electron/import-scanner.ts) — that
  //      filter drops any path under `<TMP_ROOT>` containing a `ccsm-`
  //      segment, so the seeded JSONL would never surface in the
  //      scanner output and the ImportDialog row would be empty.
  // A sibling of tempDir under TMP_ROOT, with a non-`ccsm-` prefix,
  // satisfies all three.
  //
  // Additionally: the real claude binary canonicalizes the cwd before
  // encoding (resolves symlinks AND, on Windows, expands 8.3 short names
  // via `uv_fs_realpath`). `realpathSync.native` exposes the same OS-level
  // resolver — JS-level `realpathSync` does NOT expand `RUNNER~1` →
  // `runneradmin` on Windows. On macOS it also collapses
  // `/var/folders/...` → `/private/var/folders/...`. Both encoders
  // (claude + ccsm scanner) below operate on the canonical form so
  // their on-disk seed paths line up with what claude's own
  // `process.cwd()` will resolve to at spawn time.
  const rawSeedCwd = mkdtempSync(path.join(tmpdir(), 'probe-cwd-'));
  const seedCwd = realpathSync.native(rawSeedCwd);
  seedMinimalOnboarding(tempDir, seedCwd);

  // Seed the JSONL under BOTH the scanner-read path (ccsm's `cwdToProjectKey`
  // encoding under `<HOME>/.claude/projects/`) AND the claude-read path
  // (claude binary's stricter `replace(/[^a-zA-Z0-9]/g,'-')` + NFC
  // normalize encoding under `<CLAUDE_CONFIG_DIR>/projects/`). The two
  // encoders DIVERGE on any non-`[\\/:]` non-alphanumeric char (e.g. `_`,
  // `.`, `~`) — concrete cases observed in CI:
  //   macOS:   `/var/folders/p8/qyz0lmpd2mld64f_f4c66y4c0000gn/T/...`
  //            ccsm    → `-private-var-folders-p8-qyz0lmpd2mld64f_f4c66y4c0000gn-T-...`
  //            claude  → `-private-var-folders-p8-qyz0lmpd2mld64f-f4c66y4c0000gn-T-...`
  //                                                            ^ `_` → `-`
  //   Windows: `C:\Users\runneradmin\AppData\Local\Temp\probe-cwd-Xy7`
  //            ccsm    → `C--Users-runneradmin-AppData-Local-Temp-probe-cwd-Xy7`
  //            claude  → `C--Users-runneradmin-AppData-Local-Temp-probe-cwd-Xy7`
  //                       (post-realpath.native — identical here)
  // Seeding both paths lets each consumer find its expected directory
  // without depending on a downstream cross-encoder copy.
  const seedSid = randomUUID();
  const ccsmProjectDirName = encodeCwdForCcsmScanner(seedCwd);
  const claudeProjectDirName = encodeCwdForClaudeBinary(seedCwd);
  const scannerProjectDir = path.join(tempDir, '.claude', 'projects', ccsmProjectDirName);
  const claudeProjectDir = path.join(tempDir, 'projects', claudeProjectDirName);
  mkdirSync(scannerProjectDir, { recursive: true });
  mkdirSync(claudeProjectDir, { recursive: true });

  const userFrame = {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: `${PROBE_TOKEN} please remember this token` },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    userType: 'external',
    cwd: seedCwd,
    sessionId: seedSid,
    version: '2.1.119',
    gitBranch: 'HEAD',
  };
  // Pair with an assistant frame so claude treats the JSONL as a valid
  // resumable transcript (some claude builds reject single-frame logs).
  const assistantFrame = {
    parentUuid: userFrame.uuid,
    isSidechain: false,
    type: 'assistant',
    message: {
      id: 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24),
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'Acknowledged.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    userType: 'external',
    cwd: seedCwd,
    sessionId: seedSid,
    version: '2.1.119',
    gitBranch: 'HEAD',
  };
  const jsonl = [userFrame, assistantFrame].map((f) => JSON.stringify(f)).join('\n') + '\n';
  writeFileSync(path.join(scannerProjectDir, `${seedSid}.jsonl`), jsonl);
  writeFileSync(path.join(claudeProjectDir, `${seedSid}.jsonl`), jsonl);

  const userDataDir = mkdtempSync(path.join(tmpdir(), 'ccsm-e2e-import-userdata-'));

  let app = null;
  try {
    const launched = await launchCcsmIsolated({
      tempDir,
      userDataDir,
      env: {
        ANTHROPIC_BASE_URL: fakeApi.url,
        ANTHROPIC_API_KEY: 'fake-ci-key',
        CCSM_E2E_HIDDEN: '1',
      },
    });
    app = launched.electronApp;
    const win = launched.win;

    await sleep(2000);
    // Force English so role-name assertions are stable.
    await win.evaluate(async () => {
      try { window.localStorage.removeItem('ccsm:preferences'); } catch { /* ignore */ }
      try { await window.ccsm?.i18n?.setLanguage?.('en'); } catch { /* ignore */ }
      try {
        const i18n = window.__ccsmI18n;
        if (i18n && typeof i18n.changeLanguage === 'function') await i18n.changeLanguage('en');
      } catch { /* ignore */ }
    });
    await sleep(300);
    // Assert the seeded session is NOT yet in the Sidebar — it lives only
    // on disk under the upstream config path; ccsm.db is still empty.
    {
      const preCount = await win.locator(`[data-session-id="${seedSid}"]`).count();
      if (preCount !== 0) {
        throw new Error(
          `pre-import: sidebar already shows the seeded sid (${seedSid}) — ` +
            `scanner auto-imported? Found ${preCount} row(s).`,
        );
      }
    }

    // Drive the real ImportDialog. The trigger is the sidebar's bottom
    // IconButton with aria-label "Import session" (i18n: sidebar.importAriaShort).
    const importTrigger = win.getByRole('button', { name: /import session/i }).first();
    await importTrigger.waitFor({ state: 'visible', timeout: 15000 });
    await importTrigger.click();

    // Debug: dump the scanner result so a row-not-shown failure is
    // diagnosable.
    try {
      const scan = await win.evaluate(async () => {
        if (!window.ccsm?.scanImportable) return { ok: false, reason: 'scanImportable unavailable' };
        const rows = await window.ccsm.scanImportable();
        return { ok: true, rows: rows.map((r) => ({ sid: r.sessionId, cwd: r.cwd, pd: r.projectDir })) };
      });
      console.log('[import-resume] scanImportable:', JSON.stringify(scan));
    } catch (err) {
      console.log('[import-resume] scanImportable error:', String(err));
    }

    // Dialog opens; scanner kicks off + populates rows. The seeded sid must
    // appear as a checkbox inside the dialog. The Checkbox.Root has
    // aria-label set to the row title — but the easiest stable anchor is
    // `#import-row-<sid>` (ImportDialog.tsx assigns this id).
    const rowCheckbox = win.locator(`#import-row-${seedSid}`);
    await rowCheckbox.waitFor({ state: 'visible', timeout: 15000 });

    // Click to check the box. Radix Checkbox accepts a click on the root.
    await rowCheckbox.click();

    // Click "Import N" (English copy: "Import {{count}}" → "Import 1").
    const importNBtn = win.getByRole('button', { name: /^import\s+1$/i }).first();
    await importNBtn.waitFor({ state: 'visible', timeout: 5000 });
    await importNBtn.click();

    // Assertion: a sidebar row appears for the imported sid AND its
    // `resumeSessionId` equals the seeded sid (proves the store carries
    // the resume target, not just the row).
    const sidebarRow = `[data-session-id="${seedSid}"]`;
    await win.waitForSelector(sidebarRow, { timeout: 15000 });
    const resumeId = await win.evaluate((sid) => {
      const s = window.__ccsmStore?.getState?.();
      const sess = s?.sessions?.find?.((x) => x.id === sid);
      return sess ? sess.resumeSessionId : null;
    }, seedSid);
    if (resumeId !== seedSid) {
      throw new Error(
        `imported session.resumeSessionId mismatch — expected ${seedSid}, got ${resumeId}`,
      );
    }

    // Open the session.
    await win.locator(sidebarRow).first().click();
    await sleep(500);
    const activeId = await win.evaluate(
      () => window.__ccsmStore?.getState?.()?.activeId ?? null,
    );
    if (activeId !== seedSid) {
      throw new Error(`click did not activate session — expected ${seedSid}, got ${activeId}`);
    }

    await waitForTerminalReady(win, seedSid, { timeout: 30000 });

    // Dismiss any first-run / API-key approval modals claude might surface
    // before it replays the JSONL. The probe pre-seeded onboarding flags but
    // claude additionally prompts on unknown ANTHROPIC_API_KEY values; the
    // helper sends `1\r` to accept ("Yes, use this key").
    await dismissFirstRunModals(win);

    // Debug: dump on-disk state so a JSONL-not-found regression is
    // diagnosable without re-running.
    console.log(
      '[import-resume] disk state:',
      JSON.stringify({
        seedCwd,
        ccsmProjectDirName,
        claudeProjectDirName,
        scannerSeedExists: existsSync(path.join(scannerProjectDir, `${seedSid}.jsonl`)),
        claudeSeedExists: existsSync(path.join(claudeProjectDir, `${seedSid}.jsonl`)),
      }),
    );

    // Assertion (b): xterm buffer replay contains PROBE_TOKEN — the prior
    // user line claude re-prints from the JSONL on --resume. This
    // simultaneously stands in for assertion (a): claude only re-prints
    // the JSONL on the `--resume <sid>` code path (the alternative
    // `--session-id <sid>` path opens a fresh transcript, prints no
    // prior content). PROBE_TOKEN appearing therefore proves ccsm spawned
    // claude with --resume <sid>. See top-of-file note for the
    // documented seam blocker on direct argv string inspection.
    await waitForXtermBuffer(win, new RegExp(PROBE_TOKEN), { timeout: 60000 });

    // Pty bridge sanity: window.ccsmPty.list() must report an entry for the
    // resumed sid (proves the pty was spawned via ccsm's IPC, not e.g. an
    // unrelated child). This is the strongest "argv was for this sid"
    // signal we can read without the documented argv seam.
    const ptyEntry = await win.evaluate(async (sid) => {
      if (!window.ccsmPty || typeof window.ccsmPty.list !== 'function') return null;
      try {
        const arr = await window.ccsmPty.list();
        return (arr || []).find((x) => x.sid === sid) ?? null;
      } catch { return null; }
    }, seedSid);
    if (!ptyEntry) {
      throw new Error(
        `window.ccsmPty.list() has no entry for sid=${seedSid} — pty never spawned for the imported session`,
      );
    }
    console.log(`[import-resume] pty entry: ${JSON.stringify(ptyEntry)}`);
  } finally {
    if (app) try { await app.close(); } catch { /* ignore */ }
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(seedCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    if (rawSeedCwd !== seedCwd) {
      try { rmSync(rawSeedCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    isolated.cleanup?.();
  }
}

async function main() {
  if (!existsSync(path.resolve('dist/renderer/index.html'))) {
    console.error('dist/renderer/index.html missing — run `npm run build` first');
    process.exit(2);
  }
  const fakeApi = await startFakeAnthropicApi({ port: 0, verbose: false });
  console.log(`[harness-e2e-import-from-claude] fake API listening at ${fakeApi.url}`);

  let exitCode = 0;
  const t0 = Date.now();
  try {
    console.log('\n[harness-e2e-import-from-claude] >>> case: import-resume');
    await caseImportResume({ fakeApi });
    console.log(`[harness-e2e-import-from-claude] <<< PASS import-resume (${Date.now() - t0}ms)`);
  } catch (err) {
    exitCode = 1;
    console.error(
      `[harness-e2e-import-from-claude] <<< FAIL import-resume (${Date.now() - t0}ms): ${err?.stack || err}`,
    );
  } finally {
    try { await fakeApi.stop(); } catch { /* ignore */ }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[harness-e2e-import-from-claude] unhandled top-level error:', err?.stack || err);
  process.exit(1);
});
