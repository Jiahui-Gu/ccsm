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
// Per-case capability extensions (task #223 — five-bucket migration prep):
//   See "Per-case capabilities" section below for the documented contract.
//   Each capability is opt-in; cases that omit the new fields run on the
//   pre-existing single-launch shared-electron path with no behavior change.
//
// Each harness file imports `runHarness` and provides:
//   - `name`: harness id used as artifact subdir + log tag.
//   - `setup({ app, win })`: optional one-time prep after Electron launches
//     and before the first case (e.g. seed an empty group).
//   - `cases`: array of `{ id, run({ app, win, log, registerDispose }) }`.
//
// The runner returns a non-zero exit if ANY case fails (after attempting to
// run the rest, so one regression doesn't mask another). Skipped cases (via
// `requiresClaudeBin` when no claude binary is on PATH) do NOT count as
// failures — they're listed separately in the summary so coverage gaps stay
// visible without breaking CI on dev machines that lack the CLI.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from '../probe-utils.mjs';
import { resetBetweenCases } from './reset-between-cases.mjs';

/**
 * Buffer stdout/stderr from the underlying electron child process so that
 * if `appWindow()` times out we have something to print besides "no
 * renderer window appeared in time". Without this the only signal on
 * Windows CI is the timeout itself — every main-process throw, native-
 * module load failure, or `app.quit()` between launch and window-create
 * is silently lost. (Task #919)
 *
 * Returns a cleanup() that detaches the listeners + a snapshot() that
 * returns the captured text (capped to MAX bytes per stream so a chatty
 * boot doesn't blow the runner heap).
 *
 * @param {import('playwright').ElectronApplication} app
 */
function captureChildIo(app) {
  const MAX = 16 * 1024;
  let out = '';
  let err = '';
  let proc = null;
  const onStdout = (chunk) => {
    if (out.length < MAX) out += chunk.toString('utf8');
  };
  const onStderr = (chunk) => {
    if (err.length < MAX) err += chunk.toString('utf8');
  };
  try {
    proc = app.process();
    proc?.stdout?.on('data', onStdout);
    proc?.stderr?.on('data', onStderr);
  } catch {
    /* best-effort */
  }
  return {
    snapshot() {
      return { stdout: out, stderr: err };
    },
    cleanup() {
      try {
        proc?.stdout?.off('data', onStdout);
        proc?.stderr?.off('data', onStderr);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Wrap `appWindow()` so its timeout error includes whatever the electron
 * child printed to stdout/stderr before the window-create deadline. This
 * is the only way to get visibility on Windows CI when the main process
 * crashes silently between launch and window-create. (Task #919)
 *
 * @param {import('playwright').ElectronApplication} app
 */
async function appWindowWithDiag(app) {
  const cap = captureChildIo(app);
  try {
    return await appWindow(app);
  } catch (err) {
    const { stdout, stderr } = cap.snapshot();
    const trimmedOut = stdout.trim();
    const trimmedErr = stderr.trim();
    const extra = [
      trimmedOut ? `--- electron stdout (truncated to 16KB) ---\n${trimmedOut}` : '',
      trimmedErr ? `--- electron stderr (truncated to 16KB) ---\n${trimmedErr}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (extra) {
      const wrapped = new Error(`${err.message}\n${extra}`);
      wrapped.stack = `${err.stack}\n${extra}`;
      throw wrapped;
    }
    throw err;
  } finally {
    cap.cleanup();
  }
}

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
 * Detect whether the upstream `claude` binary is reachable. Used to decide
 * whether `requiresClaudeBin: true` cases run or skip.
 *
 * Resolution order (matches what cases that exec the binary actually do):
 *   1. `CCSM_CLAUDE_BIN` env override — explicit absolute path.
 *   2. Walk `PATH` looking for `claude` / `claude.exe` / `claude.cmd`.
 *
 * Returns the resolved path on hit, null on miss. Result is memoized for the
 * lifetime of the harness process so we don't re-stat per case.
 *
 * @returns {string | null}
 */
let _claudeBinCache;
function resolveClaudeBin() {
  if (_claudeBinCache !== undefined) return _claudeBinCache;
  const override = process.env.CCSM_CLAUDE_BIN;
  if (override && fs.existsSync(override)) {
    _claudeBinCache = override;
    return _claudeBinCache;
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, `claude${ext}`);
      try {
        if (fs.statSync(p).isFile()) {
          _claudeBinCache = p;
          return _claudeBinCache;
        }
      } catch { /* miss */ }
    }
  }
  _claudeBinCache = null;
  return _claudeBinCache;
}

/**
 * Allocate a fresh electron user-data directory under tmpdir. Returns the
 * path plus a cleanup hook the runner invokes after the case (or after the
 * next relaunch consumes the dir, whichever comes first).
 *
 * @param {string} tag  Dir-name prefix for triage; usually `<harness>-<case>`.
 * @returns {{ dir: string, cleanup: () => void }}
 */
function freshUserDataDir(tag) {
  const safeTag = tag.replace(/[^a-zA-Z0-9._-]/g, '-');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ccsm-harness-${safeTag}-`));
  return {
    dir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  };
}

/**
 * @typedef {object} HarnessCaseCtx
 * @property {import('playwright').ElectronApplication | null} app
 *   Null only when the case set `skipLaunch: true`.
 * @property {import('playwright').Page | null} win
 *   Null only when the case set `skipLaunch: true`.
 * @property {(...args: unknown[]) => void} log  Emits `[case=<id>] ...` to
 *                                              stdout; use instead of console.log.
 * @property {(fn: () => void | Promise<void>) => void} registerDispose
 *           Push a cleanup; runner awaits all of these in reverse order
 *           inside resetBetweenCases (or directly for skipLaunch cases).
 * @property {string} harnessRoot  Absolute path to the repo root. Convenient
 *           for `skipLaunch` cases doing fs / json checks under `dist/`,
 *           `package.json`, etc.
 */

/**
 * Per-case capabilities (all optional; defaults preserve pre-existing
 * single-launch shared-electron semantics):
 *
 * @typedef {object} HarnessCase
 * @property {string} id
 *   Unique within the harness; goes into log prefix + artifact path.
 *
 * @property {(ctx: HarnessCaseCtx) => Promise<void>} run
 *   Throw to fail. Use `log()` not console.log.
 *
 * @property {'fresh' | 'shared'} [userDataDir]
 *   - 'shared' (default): reuse the long-lived electron user-data directory
 *     that the harness booted with. Cheap; no relaunch needed.
 *   - 'fresh': allocate a brand-new mktemp directory for this case, force
 *     a relaunch into it, and rm -rf the dir after the case finishes (or
 *     after the next relaunch consumes it).
 *   Setting `userDataDir: 'fresh'` implies `relaunch: true`.
 *
 *   Example (probe-e2e-installer-corrupt style — first-launch detection):
 *     {
 *       id: 'installer-corrupt-detection',
 *       userDataDir: 'fresh',
 *       run: async ({ win }) => { ... cold-launch assertions ... }
 *     }
 *
 * @property {boolean} [relaunch]
 *   Close the running electron app and launch a new one before the case.
 *   The new launch reuses the harness's `launch.args`/`launch.env` plus any
 *   per-case `userDataDir: 'fresh'`. Ignored when `skipLaunch: true`.
 *
 *   Example (window-close-aborts-sessions: needs a fresh process to assert
 *   a fresh exit code):
 *     { id: 'close-aborts-sessions', relaunch: true, run: async ({ app }) => { ... } }
 *
 * @property {boolean} [requiresClaudeBin]
 *   Mark the case skippable when no upstream `claude` binary is reachable
 *   (see `resolveClaudeBin` for resolution order). Skipped cases show up in
 *   the summary as `[--]` and do NOT count toward the failure exit code.
 *   Override via `CCSM_CLAUDE_BIN` env or by symlinking onto PATH.
 *
 * @property {boolean} [windowsOnly]
 *   Skip this case when `process.platform !== 'win32'`.
 *   Use for tests that exercise Windows-only features (e.g. Windows
 *   notification modules).
 *
 * @property {boolean} [darwinOnly]
 *   Skip this case when `process.platform !== 'darwin'`.
 *   Use for tests that exercise macOS-only features (e.g. native macOS
 *   notification modules).
 *
 *   Example (probe-e2e-permission-allow-bash style — needs real subprocess
 *   to verify the IPC frame round-trips through claude.exe):
 *     { id: 'permission-allow-bash', requiresClaudeBin: true, run: ... }
 *
 * @property {(app: import('playwright').ElectronApplication, ctx: HarnessCaseCtx) => Promise<void>} [preMain]
 *   Run BEFORE the case body, in the electron MAIN process via `app.evaluate`.
 *   Use for monkey-patching main-process modules (e.g. patching
 *   `Notification.prototype.show` to capture toast emissions, dialog stubs,
 *   fake transports).
 *
 *   Caller is responsible for restoring via `registerDispose` if the patch
 *   must not leak into subsequent cases. For `userDataDir: 'fresh'` cases
 *   the relaunch makes restore a no-op, so dispose is optional there.
 *
 *   Example (probe-e2e-notify-integration style):
 *     {
 *       id: 'notify-capture',
 *       preMain: async (app) => {
 *         await app.evaluate(async ({ Notification }) => {
 *           globalThis.__notifyCalls = [];
 *           const proto = Notification.prototype;
 *           const origShow = proto.show;
 *           proto.show = function () { globalThis.__notifyCalls.push({ title: this.title, body: this.body }); };
 *           void origShow;
 *         });
 *       },
 *       run: async ({ app, win }) => { ... assert globalThis.__notifyCalls ... }
 *     }
 *
 * @property {boolean} [skipLaunch]
 *   Don't launch electron at all. The case receives `{ app: null, win: null,
 *   harnessRoot, log, registerDispose }` and runs as a pure Node script.
 *   Useful for fs / package.json / dist bundle / config-loader checks that
 *   would otherwise pay 1-2s of electron boot for nothing.
 *
 *   Disposers registered by skipLaunch cases run inline AFTER the case body
 *   (no resetBetweenCases — there is no renderer to reset).
 *
 *   Example (probe-e2e-installer-bundle-shape style):
 *     {
 *       id: 'bundle-has-required-files',
 *       skipLaunch: true,
 *       run: async ({ harnessRoot }) => {
 *         const pkg = JSON.parse(fs.readFileSync(path.join(harnessRoot, 'package.json'), 'utf8'));
 *         if (!pkg.main) throw new Error('package.json missing "main"');
 *       }
 *     }
 *
 * @property {(ctx: HarnessCaseCtx) => Promise<void>} [setupBefore]
 *   Run BEFORE the case body, in the RENDERER context. Distinct from
 *   `preMain` (main-process). Use to reset language, theme, or any
 *   renderer-side global the case depends on but doesn't itself own.
 *
 *   Differs from harness-level `setup` in that `setupBefore` runs every
 *   case, not just on first launch. Differs from inlining the same code at
 *   the top of `run` in that it can't accidentally be skipped when a case
 *   is rewritten — the runner promise-chains it before each `run()`.
 *
 *   Example (any case that asserts on English-anchored i18n strings):
 *     {
 *       id: 'english-only-assertions',
 *       setupBefore: async ({ win }) => {
 *         await win.evaluate(async () => {
 *           if (window.__ccsmI18n?.changeLanguage) await window.__ccsmI18n.changeLanguage('en');
 *         });
 *       },
 *       run: async ({ win }) => { ... }
 *     }
 */

/**
 * @typedef {object} HarnessSpec
 * @property {string} name
 * @property {(ctx: { app: import('playwright').ElectronApplication, win: import('playwright').Page }) => Promise<void>} [setup]
 * @property {HarnessCase[]} cases
 * @property {{ args?: string[], env?: Record<string, string> }} [launch]
 */

/**
 * Build the launch options used for both the initial boot and any per-case
 * relaunch. Pulled out so `userDataDir` overrides can be applied uniformly.
 *
 * @param {HarnessSpec} spec
 * @param {string | null} userDataDirOverride
 */
function buildLaunchOpts(spec, userDataDirOverride) {
  const args = ['.', '--lang=en', ...(spec.launch?.args ?? [])];
  if (userDataDirOverride) {
    // Electron honors `--user-data-dir=<path>` as a CLI flag; this is the
    // same mechanism CCSM_USER_DATA_DIR-style overrides ultimately land on.
    args.push(`--user-data-dir=${userDataDirOverride}`);
  }
  // Default CCSM_E2E_HIDDEN=1 so direct `node scripts/harness-*.mjs` runs
  // (e.g. background workers, or a single-case iteration) don't pop a window
  // onto the user's desktop and steal focus. run-all-e2e.mjs already sets
  // this; this default makes the same behavior apply when a harness is
  // invoked standalone. Visible-mode harnesses (dnd, perm, restore's
  // sidebar-resize) explicitly opt out via `spec.launch.env.CCSM_E2E_HIDDEN
  // = '0'`, which still wins because `spec.launch.env` is spread last. Users
  // debugging can also opt out by exporting `CCSM_E2E_HIDDEN=0` before the
  // run — `process.env` is spread after the default, so an explicit env wins.
  const env = {
    CCSM_E2E_HIDDEN: '1',
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    NODE_ENV: 'production',
    CCSM_PROD_BUNDLE: '1',
    ...(spec.launch?.env ?? {})
  };
  return { args, env };
}

/**
 * Drive a themed harness. See file comment.
 *
 * @param {HarnessSpec} spec
 */
/** Platform-aware modifier key: 'Meta' on macOS (Cmd), 'Control' elsewhere. */
export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

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

  // Note totals: if every case is skipLaunch we never boot electron.
  const needsAnyLaunch = filtered.some((c) => !c.skipLaunch);
  console.log(`[harness=${spec.name}] ${needsAnyLaunch ? 'launching electron — ' : 'no electron required — '}${filtered.length}/${spec.cases.length} case(s)`);

  /** @type {import('playwright').ElectronApplication | null} */
  let app = null;
  /** @type {import('playwright').Page | null} */
  let win = null;
  /** @type {{ dir: string, cleanup: () => void } | null} */
  let activeUserDataDir = null;

  // Boot once up front IF any case needs the shared electron. Fresh-userData /
  // relaunch cases will tear this down and rebuild as they're encountered.
  if (needsAnyLaunch && filtered.some((c) => !c.skipLaunch && c.userDataDir !== 'fresh' && !c.relaunch)) {
    const opts = buildLaunchOpts(spec, null);
    app = await electron.launch({ args: opts.args, cwd: REPO_ROOT, env: opts.env });
    win = await appWindowWithDiag(app);
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });
    // Task #311: gate per-case work on hydrateStore() resolving. After
    // PR #976 (Wave 0e persist.ts cutover) hydration finishes far faster
    // than probes can race in, so cases that read persisted state (theme,
    // groups, sessions) immediately after launch saw stale values. The
    // `__ccsm_hydrated` flag is set by `src/index.tsx` after the boot-time
    // hydrateStore() promise settles.
    await win.waitForFunction(() => window.__ccsm_hydrated === true, null, { timeout: 5_000 });
    if (spec.setup) {
      await spec.setup({ app, win });
    }
  }

  /** @type {Array<{ id: string, status: 'passed'|'failed'|'skipped', ms: number, error?: string, reason?: string }>} */
  const results = [];

  const tStart = Date.now();
  try {
    for (const c of filtered) {
      const caseStart = Date.now();
      const log = (...args) => console.log(`[case=${c.id}]`, ...args);
      /** @type {Array<() => void | Promise<void>>} */
      const disposers = [];
      const registerDispose = (fn) => { disposers.push(fn); };
      const caseDir = path.join(harnessArtifactDir, c.id);

      console.log(`\n[harness=${spec.name}] >>> case ${c.id}`);

      // ---- Capability: requiresClaudeBin ----
      if (c.requiresClaudeBin && !resolveClaudeBin()) {
        const reason = 'no `claude` binary on PATH (set CCSM_CLAUDE_BIN or install the upstream CLI)';
        console.log(`[case=${c.id}] SKIPPED: ${reason}`);
        results.push({ id: c.id, status: 'skipped', ms: Date.now() - caseStart, reason });
        continue;
      }

      // ---- Capability: windowsOnly ----
      if (c.windowsOnly && process.platform !== 'win32') {
        const reason = `skipped: windowsOnly (current platform is ${process.platform})`;
        console.log(`[case=${c.id}] SKIPPED: ${reason}`);
        results.push({ id: c.id, status: 'skipped', ms: Date.now() - caseStart, reason });
        continue;
      }

      // ---- Capability: darwinOnly ----
      if (c.darwinOnly && process.platform !== 'darwin') {
        const reason = `skipped: darwinOnly (current platform is ${process.platform})`;
        console.log(`[case=${c.id}] SKIPPED: ${reason}`);
        results.push({ id: c.id, status: 'skipped', ms: Date.now() - caseStart, reason });
        continue;
      }

      // ---- Capability: skipLaunch ----
      if (c.skipLaunch) {
        const ctx = { app: null, win: null, log, registerDispose, harnessRoot: REPO_ROOT };
        let caseError = null;
        try {
          await c.run(ctx);
          log('OK');
        } catch (err) {
          caseError = err instanceof Error ? err : new Error(String(err));
          console.error(`[case=${c.id}] FAIL: ${caseError.message}`);
        }
        // Inline disposers — no renderer to drain through resetBetweenCases.
        for (const fn of disposers.splice(0).reverse()) {
          try { await fn(); } catch { /* swallow */ }
        }
        const ms = Date.now() - caseStart;
        if (caseError) {
          results.push({ id: c.id, status: 'failed', ms, error: caseError.stack ?? caseError.message });
        } else {
          results.push({ id: c.id, status: 'passed', ms });
        }
        continue;
      }

      // ---- Capabilities: userDataDir + relaunch ----
      const wantsFreshDir = c.userDataDir === 'fresh';
      const wantsRelaunch = wantsFreshDir || c.relaunch === true;

      if (wantsRelaunch) {
        // Tear down current app first so the next launch is genuinely fresh.
        if (app) {
          try { await app.close(); } catch { /* ignore */ }
          app = null;
          win = null;
        }
        // Drop the previous fresh dir if we owned one. Done AFTER close so
        // electron has released the lock files.
        if (activeUserDataDir) {
          activeUserDataDir.cleanup();
          activeUserDataDir = null;
        }
        if (wantsFreshDir) {
          activeUserDataDir = freshUserDataDir(`${spec.name}-${c.id}`);
        }
        const opts = buildLaunchOpts(spec, activeUserDataDir?.dir ?? null);
        app = await electron.launch({ args: opts.args, cwd: REPO_ROOT, env: opts.env });
        win = await appWindowWithDiag(app);
        await win.waitForLoadState('domcontentloaded');
        await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });
        // Task #311: see boot-time gate above for rationale.
        await win.waitForFunction(() => window.__ccsm_hydrated === true, null, { timeout: 5_000 });
        if (spec.setup) {
          await spec.setup({ app, win });
        }
      }

      // Defensive: if we got here and still don't have an app, the harness
      // spec mixes shared+relaunch in a way the boot logic above missed.
      // Lazy-launch once now so the case can run.
      if (!app || !win) {
        const opts = buildLaunchOpts(spec, activeUserDataDir?.dir ?? null);
        app = await electron.launch({ args: opts.args, cwd: REPO_ROOT, env: opts.env });
        win = await appWindowWithDiag(app);
        await win.waitForLoadState('domcontentloaded');
        await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });
        // Task #311: see boot-time gate above for rationale.
        await win.waitForFunction(() => window.__ccsm_hydrated === true, null, { timeout: 5_000 });
        if (spec.setup) {
          await spec.setup({ app, win });
        }
      }

      const ctx = { app, win, log, registerDispose, harnessRoot: REPO_ROOT };

      // ---- Capability: preMain (main-process setup) ----
      if (c.preMain) {
        try {
          await c.preMain(app, ctx);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          console.error(`[case=${c.id}] preMain FAIL: ${e.message}`);
          results.push({ id: c.id, status: 'failed', ms: Date.now() - caseStart, error: `preMain threw: ${e.stack ?? e.message}` });
          continue;
        }
      }

      // ---- Capability: setupBefore (renderer-side per-case setup) ----
      if (c.setupBefore) {
        try {
          await c.setupBefore(ctx);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          console.error(`[case=${c.id}] setupBefore FAIL: ${e.message}`);
          results.push({ id: c.id, status: 'failed', ms: Date.now() - caseStart, error: `setupBefore threw: ${e.stack ?? e.message}` });
          continue;
        }
      }

      // Per-case Playwright trace. Only persisted on failure (see catch below).
      const playwrightCtx = win.context();
      try {
        await playwrightCtx.tracing.start({ screenshots: true, snapshots: true, sources: false, title: c.id });
      } catch {
        // Tracing may already be active if a previous case crashed mid-stop;
        // ignore and continue without trace.
      }

      let caseError = null;
      try {
        await c.run(ctx);
        log('OK');
      } catch (err) {
        caseError = err instanceof Error ? err : new Error(String(err));
        console.error(`[case=${c.id}] FAIL: ${caseError.message}`);
      }

      // Stop tracing — keep zip only on failure.
      try {
        if (caseError) {
          fs.mkdirSync(caseDir, { recursive: true });
          await playwrightCtx.tracing.stop({ path: path.join(caseDir, 'trace.zip') });
          // Also dump page screenshot for fast triage without unzipping.
          try { await win.screenshot({ path: path.join(caseDir, 'failure.png'), fullPage: true }); } catch {}
        } else {
          await playwrightCtx.tracing.stop();
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
    if (app) { try { await app.close(); } catch {} }
    if (activeUserDataDir) activeUserDataDir.cleanup();
  }

  const wallMs = Date.now() - tStart;
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');

  console.log(`\n=== harness=${spec.name} summary (${wallMs}ms wall) ===`);
  for (const r of results) {
    let tag;
    if (r.status === 'passed') tag = '[OK]';
    else if (r.status === 'failed') tag = '[XX]';
    else tag = '[--]';
    console.log(`  ${tag} ${r.id.padEnd(40)} ${String(r.ms).padStart(6)}ms${r.reason ? `  (${r.reason})` : ''}`);
  }
  if (failed.length > 0) {
    console.log(`\n=== failures (${failed.length}) ===`);
    for (const r of failed) {
      console.log(`\n--- ${r.id} ---\n${r.error}`);
    }
  }
  console.log(`\n=== totals: ${passed} passed, ${failed.length} failed, ${skipped.length} skipped, ${results.length} total ===`);

  process.exit(failed.length === 0 ? 0 : 1);
}
