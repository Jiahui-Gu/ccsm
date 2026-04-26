// Shared runner for themed harnesses (harness-agent.mjs, harness-permission.mjs,
// ...). Implements the Phase-1 deliverables from
// docs/e2e/single-harness-brainstorm.md §8:
//
//   1. case-id logging — every console line a case emits is wrapped in
//      `[case=<id>] ...` so a tail of mixed output is bisectable.
//   2. `--only=<id>[,<id>]` flag — caller can filter cases when iterating
//      locally on a single regression.
//   3. per-case trace artifact — Playwright tracing is started before each
//      case and only persisted to `scripts/e2e-artifacts/<harness>/<case>/`
//      when the case throws (success path discards to keep CI green-runs
//      light).
//   4. caseScope — gives each case (a) a `log()` that adds the prefix,
//      (b) a `dispose()` registry the runner drains in `resetBetweenCases`.
//
// Each harness file imports `runHarness` and provides:
//   - `name`: harness id used as artifact subdir + log tag.
//   - `setup({ app, win })`: optional one-time prep after Electron launches
//     and before the first case (e.g. seed an empty group).
//   - `cases`: array of `{ id, run({ app, win, log, registerDispose }) }`.
//
// The runner returns a non-zero exit if ANY case fails (after attempting to
// run the rest, so one regression doesn't mask another).

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appWindow } from '../probe-utils.mjs';
import { resetBetweenCases } from './reset-between-cases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const ARTIFACTS_ROOT = path.join(REPO_ROOT, 'scripts/e2e-artifacts');

const STALE_CHECK_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css']);

/**
 * Walk `src/` and return the newest mtimeMs across files matching
 * STALE_CHECK_EXTS. Dep-free (no glob). Returns 0 if `src/` is missing.
 *
 * @param {string} dir
 * @returns {number}
 */
function newestSrcMtime(dir) {
  let newest = 0;
  let stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name);
        if (STALE_CHECK_EXTS.has(ext)) {
          try {
            const m = fs.statSync(full).mtimeMs;
            if (m > newest) newest = m;
          } catch {
            // ignore stat errors
          }
        }
      }
    }
  }
  return newest;
}

/**
 * Fail fast if `dist/renderer/bundle.js` is older than the newest file under
 * `src/`. Harness runs use CCSM_PROD_BUNDLE=1 which loads the prebuilt bundle;
 * a stale bundle silently masks src changes (PR #322 incident, 2026-04-26).
 *
 * Opt out via CCSM_HARNESS_SKIP_STALE_CHECK=1.
 */
function assertBundleFresh() {
  if (process.env.CCSM_HARNESS_SKIP_STALE_CHECK === '1') return;
  const bundlePath = path.join(REPO_ROOT, 'dist/renderer/bundle.js');
  let bundleMtime;
  try {
    bundleMtime = fs.statSync(bundlePath).mtimeMs;
  } catch {
    throw new Error(`[harness] dist/renderer/bundle.js is missing — run \`npm run build\` first (harness loads the prebuilt bundle, not the dev server)`);
  }
  const srcMtime = newestSrcMtime(path.join(REPO_ROOT, 'src'));
  if (srcMtime > bundleMtime) {
    throw new Error(`[harness] dist/renderer/bundle.js is older than src/ — run \`npm run build\` first (current bundle would mask src changes)`);
  }
}

/**
 * Parse `--only=a,b,c` from argv. Returns null when absent (= run all).
 *
 * @returns {Set<string> | null}
 */
function parseOnly(argv) {
  for (const a of argv) {
    if (a.startsWith('--only=')) {
      const parts = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
      return new Set(parts);
    }
  }
  return null;
}

/**
 * @typedef {object} HarnessCase
 * @property {string} id  Unique within the harness; goes into log prefix +
 *                        artifact path.
 * @property {(ctx: HarnessCaseCtx) => Promise<void>} run
 */

/**
 * @typedef {object} HarnessCaseCtx
 * @property {import('playwright').ElectronApplication} app
 * @property {import('playwright').Page} win
 * @property {(...args: unknown[]) => void} log  Emits `[case=<id>] ...` to
 *                                              stdout; use instead of console.log.
 * @property {(fn: () => void | Promise<void>) => void} registerDispose
 *           Push a cleanup; runner awaits all of these in reverse order
 *           inside resetBetweenCases.
 */

/**
 * @typedef {object} HarnessSpec
 * @property {string} name
 * @property {(ctx: { app: import('playwright').ElectronApplication, win: import('playwright').Page }) => Promise<void>} [setup]
 * @property {HarnessCase[]} cases
 * @property {{ args?: string[], env?: Record<string, string> }} [launch]
 */

/**
 * Drive a themed harness. See file comment.
 *
 * @param {HarnessSpec} spec
 */
export async function runHarness(spec) {
  // Fail-fast BEFORE launching electron: a stale dist/renderer/bundle.js
  // would silently run the harness against old src code (see PR #322 post-mortem).
  assertBundleFresh();

  const only = parseOnly(process.argv.slice(2));
  const filtered = spec.cases.filter((c) => !only || only.has(c.id));

  if (only && filtered.length === 0) {
    console.error(`[harness=${spec.name}] --only matched no cases. Available: ${spec.cases.map((c) => c.id).join(', ')}`);
    process.exit(2);
  }

  const harnessArtifactDir = path.join(ARTIFACTS_ROOT, spec.name);
  fs.mkdirSync(harnessArtifactDir, { recursive: true });

  console.log(`[harness=${spec.name}] launching electron — ${filtered.length}/${spec.cases.length} case(s)`);

  const launchArgs = ['.', ...(spec.launch?.args ?? [])];
  // CCSM_PROD_BUNDLE=1 forces electron/main.ts to loadFile from
  // dist/renderer instead of expecting a dev server on localhost:4100.
  // Harness runs are CI-like by definition — no dev server is up.
  const launchEnv = {
    ...process.env,
    NODE_ENV: 'production',
    CCSM_PROD_BUNDLE: '1',
    ...(spec.launch?.env ?? {})
  };

  const tStart = Date.now();
  const app = await electron.launch({ args: launchArgs, cwd: REPO_ROOT, env: launchEnv });

  /** @type {Array<{ id: string, status: 'passed'|'failed', ms: number, error?: string }>} */
  const results = [];

  let win;
  try {
    win = await appWindow(app);
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });

    if (spec.setup) {
      await spec.setup({ app, win });
    }

    for (const c of filtered) {
      /** @type {Array<() => void | Promise<void>>} */
      const disposers = [];
      const log = (...args) => console.log(`[case=${c.id}]`, ...args);
      const registerDispose = (fn) => { disposers.push(fn); };

      const caseDir = path.join(harnessArtifactDir, c.id);
      const caseStart = Date.now();
      console.log(`\n[harness=${spec.name}] >>> case ${c.id}`);

      // Per-case Playwright trace. Only persisted on failure (see catch below).
      const ctx = win.context();
      try {
        await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false, title: c.id });
      } catch {
        // Tracing may already be active if a previous case crashed mid-stop;
        // ignore and continue without trace.
      }

      let caseError = null;
      try {
        await c.run({ app, win, log, registerDispose });
        log('OK');
      } catch (err) {
        caseError = err instanceof Error ? err : new Error(String(err));
        console.error(`[case=${c.id}] FAIL: ${caseError.message}`);
      }

      // Stop tracing — keep zip only on failure.
      try {
        if (caseError) {
          fs.mkdirSync(caseDir, { recursive: true });
          await ctx.tracing.stop({ path: path.join(caseDir, 'trace.zip') });
          // Also dump page screenshot for fast triage without unzipping.
          try { await win.screenshot({ path: path.join(caseDir, 'failure.png'), fullPage: true }); } catch {}
        } else {
          await ctx.tracing.stop();
        }
      } catch {
        // Ignore tracing teardown errors — they shouldn't mask the case status.
      }

      // Reset BEFORE recording the next case start, so reset cost is attributed
      // to the case that produced the mess. Do it even if the case failed:
      // we still want subsequent cases to start clean.
      try {
        await resetBetweenCases(app, win, { disposers });
      } catch (err) {
        console.error(`[harness=${spec.name}] reset after ${c.id} threw:`, err);
      }

      const ms = Date.now() - caseStart;
      if (caseError) {
        results.push({ id: c.id, status: 'failed', ms, error: caseError.stack ?? caseError.message });
      } else {
        results.push({ id: c.id, status: 'passed', ms });
      }
    }
  } finally {
    try { await app.close(); } catch {}
  }

  const wallMs = Date.now() - tStart;
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed');

  console.log(`\n=== harness=${spec.name} summary (${wallMs}ms wall) ===`);
  for (const r of results) {
    const tag = r.status === 'passed' ? '[OK]' : '[XX]';
    console.log(`  ${tag} ${r.id.padEnd(40)} ${String(r.ms).padStart(6)}ms`);
  }
  if (failed.length > 0) {
    console.log(`\n=== failures (${failed.length}) ===`);
    for (const r of failed) {
      console.log(`\n--- ${r.id} ---\n${r.error}`);
    }
  }
  console.log(`\n=== totals: ${passed} passed, ${failed.length} failed, ${results.length} total ===`);

  process.exit(failed.length === 0 ? 0 : 1);
}
