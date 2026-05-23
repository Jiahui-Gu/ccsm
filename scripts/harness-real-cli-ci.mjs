// CI-runnable subset of `scripts/harness-real-cli.mjs`.
//
// Background:
//   The full `harness-real-cli.mjs` runs ~27 cases against a real `claude`
//   binary. About half of them depend on the LLM producing a real assistant
//   reply (the harness asserts on tokens like ALPHA / PONG / specific
//   counter signals from notify-pipeline waits of 180s+ etc.). Running
//   those in CI against any fake API is fragile, and the cumulative
//   wall-clock blows past `run-all-e2e.mjs`'s `HARNESS_TIMEOUT_MS = 5min`.
//
//   This file runs ONLY the cases that:
//     (a) never assert on LLM-generated content, AND
//     (b) finish within ~5min total against a stubbed Anthropic API.
//
//   The full harness stays unchanged and dogfood-only (still in
//   `E2E_SKIP=harness-real-cli` in `.github/workflows/e2e.yml`). Cases
//   excluded from CI keep running locally via the full harness — the
//   dev / dogfood loop does not change.
//
// What this file does:
//   1. Starts the fake Anthropic API server (`scripts/fixtures/fake-anthropic-api.mjs`).
//   2. Imports `CASE_REGISTRY` from the full harness — NO copy-paste of
//      case logic. Filters to the CI subset by name; standalone cases
//      (reopen-resume, pty-subtree-killed-on-quit) are NOT in the subset.
//   3. Calls `createIsolatedClaudeDir` + pre-seeds a minimal onboarding
//      `.claude.json` so claude does not block at the trust dialog.
//   4. Calls `launchCcsmIsolated` with `ANTHROPIC_BASE_URL` /
//      `ANTHROPIC_API_KEY` pointed at the fake server, so any stray API
//      probe (auth check, model list, accidentally-submitted prompt)
//      lands on our stub instead of a real outbound network call.
//   5. Runs each selected case against the shared launch, summarizes,
//      exits non-zero on any failure.
//
// Subset (11 cases):
//   - agent-icon-active-session-no-halo
//   - cwd-picker-no-shortcut
//   - sidebar-group-no-newsession-cluster
//   - notify-name-cleared-on-session-delete
//   - cwd-picker-top-default
//   - cwd-picker-top-chevron
//   - cwd-picker-browse
//   - caseSpacesInCwdSpawnsCorrectly
//   - pty-pid-stable-across-switch
//   - new-session-focus-cli
//   - attach-replay-from-headless-buffer
//
// Excluded cases (with reason):
//   - new-session-chat                : asserts on LLM reply content
//   - switch-session-keeps-chat       : asserts on "ALPHA" reply
//   - cwd-projects-claude             : asserts on "PONG" reply
//   - session-rename-writes-jsonl     : needs real chat → JSONL writeback
//   - session-title-syncs-from-jsonl  : 210s wait for SDK title derivation
//   - session-state-becomes-idle      : depends on real running→idle transition
//   - notify-fires-on-idle            : 180s notify wait
//   - notify-shows-session-name       : 180s notify wait
//   - notify-pipeline-foreground      : 180s notify wait
//   - notify-pipeline-background      : 180s notify wait
//   - caseBadgeFiresAndClearsOnFocus  : 180s notify wait
//   - import-resume                   : asserts on PROBE_FOLLOWUP reply
//   - import-lands-in-focused-group   : depends on `import-resume` running
//                                       first to warm the `scanImportable`
//                                       cache. Without that primer, the
//                                       10s in-case poll loop times out
//                                       on cold cache (verified locally
//                                       2026-05-23 — failed with "cache
//                                       never reflected seeded JSONLs").
//                                       Not a real regression; covered by
//                                       the full harness in dogfood.
//   - alt-screen-fits-visible-viewport: asserts on claude's Welcome /
//                                       trust panel rendering at the
//                                       resized viewport width; with
//                                       `hasCompletedOnboarding: true`
//                                       the welcome panel may not render
//                                       and the case fails the border
//                                       detection. Tied to onboarding
//                                       visual state, not a CCSM bug.
//   - reopen-resume                   : standalone, asserts on SECRET_TOKEN
//                                       cross-restart reply
//   - pty-subtree-killed-on-quit      : standalone (own Electron launch);
//                                       could fit time-wise but its
//                                       second Electron boot exceeds the
//                                       shared-launch budget structure
//
// Run locally:
//   node scripts/harness-real-cli-ci.mjs                # all CI subset
//   node scripts/harness-real-cli-ci.mjs --only=agent-icon-active-session-no-halo

import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { CASE_REGISTRY } from './harness-real-cli.mjs';
import { createIsolatedClaudeDir, launchCcsmIsolated } from './probe-utils-real-cli.mjs';
import { startFakeAnthropicApi } from './fixtures/fake-anthropic-api.mjs';

// ============================================================================
// Subset selection
// ============================================================================

const CI_SUBSET = new Set([
  'agent-icon-active-session-no-halo',
  'cwd-picker-no-shortcut',
  'sidebar-group-no-newsession-cluster',
  'notify-name-cleared-on-session-delete',
  'cwd-picker-top-default',
  'cwd-picker-top-chevron',
  'cwd-picker-browse',
  'caseSpacesInCwdSpawnsCorrectly',
  'pty-pid-stable-across-switch',
  'new-session-focus-cli',
  'attach-replay-from-headless-buffer',
]);

// ============================================================================
// Args
// ============================================================================

function parseArgs(argv) {
  const out = { only: null, skip: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--only=')) {
      out.only = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--skip=')) {
      out.skip = arg.slice('--skip='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/harness-real-cli-ci.mjs [--only=...] [--skip=...]');
      console.log('CI subset cases:');
      for (const n of CI_SUBSET) console.log('  -', n);
      process.exit(0);
    }
  }
  return out;
}

// ============================================================================
// Onboarding pre-seed
// ============================================================================

/**
 * Drop a minimal `.claude.json` into the isolated tempdir so claude does
 * NOT block at the first-run trust dialog when it spawns in CI.
 *
 * Empirically (claude v2.x), the keys that matter are:
 *   - `hasCompletedOnboarding` : skips the welcome / onboarding flow
 *   - `bypassPermissionsModeAccepted` : skips bypass-permissions notice
 *   - `projects[<cwd>].hasTrustDialogAccepted` : skips per-folder trust
 *
 * The per-folder trust list is dynamic — probes spawn sessions in various
 * tempdirs / project subdirs we cannot enumerate up-front. We therefore
 * pre-seed only the global flags here; cases that need to trust a specific
 * directory (e.g. `caseImportResume`, not in the CI subset) extend the
 * file themselves. The cases in the CI subset either:
 *   - never spawn a pty (pure UI/store cases), OR
 *   - spawn a pty but rely on `dismissFirstRunModals` (probe-utils:583) to
 *     handle whatever trust prompt is left. With the global flags set,
 *     claude's trust prompt for unknown folders appears once per cwd and
 *     `dismissFirstRunModals` clears it within its 12-iteration budget.
 */
function seedMinimalOnboarding(tempDir) {
  const claudeJsonPath = path.join(tempDir, '.claude.json');
  const cfg = {
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    // `projects` is keyed by cwd; cases that need a specific entry add
    // it themselves. Empty object is a safe default.
    projects: {},
  };
  writeFileSync(claudeJsonPath, JSON.stringify(cfg, null, 2));
  // ALWAYS overwrite `settings.json` with `{}` so any inherited `env` block
  // (e.g. the local dev's Agent Maestro proxy `ANTHROPIC_BASE_URL` that
  // `createIsolatedClaudeDir` helpfully copied from `~/.claude/settings.json`)
  // does not shadow the process-level env vars we set in `launchCcsmIsolated`.
  // CI runners don't have a settings.json so the copy step is a no-op there;
  // this matters only for local repros where the harness is run from a
  // developer machine.
  const settingsPath = path.join(tempDir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({}, null, 2));
  // Same story for `settings.local.json` — `createIsolatedClaudeDir`
  // copies it too, and it can contain its own `env` block.
  const localSettingsPath = path.join(tempDir, 'settings.local.json');
  writeFileSync(localSettingsPath, JSON.stringify({}, null, 2));
}

// ============================================================================
// Runner
// ============================================================================

async function main() {
  const { only, skip } = parseArgs(process.argv);

  // Sanity: every entry in CI_SUBSET must exist in the full registry.
  const registryByName = new Map(CASE_REGISTRY.map((c) => [c.name, c]));
  const missing = [...CI_SUBSET].filter((n) => !registryByName.has(n));
  if (missing.length > 0) {
    console.error(`[HARNESS-CI] CI subset references unknown cases: ${missing.join(', ')}`);
    console.error(`[HARNESS-CI] Known cases: ${[...registryByName.keys()].join(', ')}`);
    process.exit(2);
  }

  // Build the run list. Standalone cases are not in CI_SUBSET (yet), so we
  // only run shared cases.
  const selected = CASE_REGISTRY.filter((c) => {
    if (!CI_SUBSET.has(c.name)) return false;
    if (c.group !== 'shared') return false; // safety: subset is shared-only
    if (only && !only.includes(c.name)) return false;
    if (skip && skip.includes(c.name)) return false;
    return true;
  });
  if (selected.length === 0) {
    console.error('[HARNESS-CI] no cases selected after filters');
    process.exit(2);
  }

  // Verify the prod bundle exists. The harness needs `dist/renderer/index.html`.
  if (!existsSync(path.resolve('dist/renderer/index.html'))) {
    console.error('[HARNESS-CI] dist/renderer/index.html missing — run `npm run build` first');
    process.exit(2);
  }

  // ---- start fake API ----
  const fakeApi = await startFakeAnthropicApi({ port: 0, verbose: false });
  console.log(`[HARNESS-CI] fake Anthropic API listening at ${fakeApi.url}`);

  const results = [];
  let isolated = null;
  let launched = null;
  const harnessStart = Date.now();
  try {
    isolated = await createIsolatedClaudeDir();
    seedMinimalOnboarding(isolated.tempDir);
    console.log(`[HARNESS-CI] isolated tempDir + onboarding seed: ${isolated.tempDir}`);

    launched = await launchCcsmIsolated({
      tempDir: isolated.tempDir,
      env: {
        // Point claude (and any in-process Anthropic SDK calls from the main
        // process) at the fake server. Without these the binary either
        // refuses to start ("no auth") or makes real outbound calls.
        ANTHROPIC_BASE_URL: fakeApi.url,
        ANTHROPIC_API_KEY: 'fake-ci-key',
        // Enable the harness debug seams that several of the CI-subset cases
        // assert against (e.g. `notify-name-cleared-on-session-delete` reads
        // `__ccsmSessionNamesFromRenderer`).
        CCSM_NOTIFY_TEST_HOOK: '1',
        // Hidden mode: position the window offscreen (-32000,-32000) and
        // strip it from the taskbar. `run-all-e2e.mjs` defaults this to '1'
        // for child probes; when this harness is invoked directly (e.g.
        // `node scripts/harness-real-cli-ci.mjs` for local repro), the
        // parent env may not have it set. Forcing it here keeps the user's
        // desktop free of strobing windows during a local debug session
        // AND lets the CI Windows runner host the harness without rendering
        // to a real display. See electron/window/createWindow.ts:230-250.
        CCSM_E2E_HIDDEN: '1',
      },
    });
    const ctx = {
      electronApp: launched.electronApp,
      win: launched.win,
      tempDir: isolated.tempDir,
    };
    console.log(`[HARNESS-CI] shared launch ready, running ${selected.length} case(s)`);

    for (const c of selected) {
      const t0 = Date.now();
      console.log(`\n[HARNESS-CI] >>> ${c.name}`);
      try {
        await c.run(ctx);
        const ms = Date.now() - t0;
        results.push({ name: c.name, ok: true, ms });
        console.log(`[HARNESS-CI] <<< PASS ${c.name} (${ms}ms)`);
      } catch (err) {
        const ms = Date.now() - t0;
        results.push({ name: c.name, ok: false, ms, error: String(err?.stack || err) });
        console.error(`[HARNESS-CI] <<< FAIL ${c.name} (${ms}ms): ${err?.message || err}`);
      }
    }
  } finally {
    if (launched?.electronApp) {
      try { await launched.electronApp.close(); } catch (_) { /* ignore */ }
    }
    launched?.cleanup?.();
    isolated?.cleanup?.();
    try { await fakeApi.stop(); } catch (_) { /* ignore */ }
  }

  // ---- summary ----
  const totalMs = Date.now() - harnessStart;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('\n===== HARNESS-CI SUMMARY =====');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(40)} ${r.ms}ms`);
  }
  console.log(`  total: ${passed}/${results.length} passed, ${(totalMs / 1000).toFixed(1)}s wall`);
  if (failed > 0) {
    console.log('\n--- failures ---');
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`\n[${r.name}]\n${r.error}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[HARNESS-CI] unhandled top-level error:', err?.stack || err);
  process.exit(1);
});
