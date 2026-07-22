// Isolation guard: protects the user's global Claude Code CLI install from
// its own auto-updater firing during automated E2E runs.
//
// Bug context: on Windows, running the real-Claude E2E suite left
// `%ProgramData%\global-npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`
// deleted (replaced by `claude.exe.old.<timestamp>`) while several
// already-running `claude` processes retained the deleted executable image
// in memory. No npm install log explained the swap — the CLI's own
// background auto-updater did it mid-suite. This is entirely separate from
// CCSM's own app updater (`electron/updater.ts`, `electron-updater`), which
// already no-ops outside a packaged build.
//
// Anthropic documents `DISABLE_AUTOUPDATER=1` as the supported opt-out for
// the `claude` binary (checked at process startup). `electron/ptyHost/
// entryFactory.ts` spawns `claude` with `env: process.env` — i.e. whatever
// environment CCSM's Electron *main* process itself was launched with. So
// setting `DISABLE_AUTOUPDATER=1` on the Electron launch env (or, for a
// harness that shells out directly, on that process's own env) is
// sufficient to reach the real CLI child process; no production code needs
// to change.
//
// This module is the SINGLE shared seam every E2E entry point funnels
// through, so the guard can't be silently dropped by one caller forgetting
// to set the var: `scripts/probe-utils-real-cli.mjs` (`launchCcsmIsolated`,
// used by nearly every `harness-e2e-*.mjs` and `dogfood-*.mjs`),
// `scripts/probe-helpers/harness-runner.mjs` (`buildLaunchOpts`, used by
// `harness-dnd.mjs` / `harness-ui.mjs` via `runHarness`), and
// `scripts/run-all-e2e.mjs` (the full-suite child-process spawner, for
// defense in depth on top-level env inheritance).
//
// Precedence: an explicit `DISABLE_AUTOUPDATER` already present in the
// environment being extended WINS over our default of `'1'`. This lets a
// caller who genuinely wants to exercise the real autoupdater (e.g. a
// dedicated future updater-behavior probe) opt back in intentionally,
// mirroring the existing `CCSM_E2E_HIDDEN: process.env.CCSM_E2E_HIDDEN ?? '1'`
// precedent used elsewhere in these scripts.
//
// @param {NodeJS.ProcessEnv} [env] - environment to read the override from.
//   Defaults to `process.env`; callers may pass a plain object for tests.
// @returns {{ DISABLE_AUTOUPDATER: string }}
export function resolveAutoUpdaterEnv(env = process.env) {
  return { DISABLE_AUTOUPDATER: env.DISABLE_AUTOUPDATER ?? '1' };
}
