# E2E runner

All end-to-end coverage runs through **themed harnesses**
(`scripts/harness-*.mjs`) — one Electron launch packs many cases. Cases
share the renderer + main process and rely on
`scripts/probe-helpers/reset-between-cases.mjs` to scrub state between
cases. Current harnesses: `harness-dnd.mjs`, `harness-ui.mjs`,
`harness-ime-overflow.mjs`, `harness-scrollbar-6-scenarios.mjs`, and the
`harness-e2e-*.mjs` family (`error-recovery`, `import-from-claude`,
`paste-fidelity`, `persistence-resume`, `session-lifecycle`,
`window-lifecycle-notify`, `voice-download`, `voice-input`, and
`mobile-remote-relay`).

`scripts/run-all-e2e.mjs` discovers harnesses by glob and runs them serially
(Electron can't share its singleton lock — parallel launches race on
user-data-dir and port allocation). It also still discovers a
`scripts/probe-e2e-*.mjs` per-file-probe naming convention from an earlier
iteration of this runner; all such probes have since been absorbed into
harnesses, so this glob currently matches zero files and is a harmless
no-op left in place pending the `@playwright/test` migration (which
replaces this runner outright).

## Adding a new case

1. Open the harness file that matches the feature area, write a named
   function `caseFoo({ app, win, log, registerDispose })`, and register it
   in the `cases:` array.
   - Use `log()` instead of `console.log` so output is prefixed
     `[case=<id>] …`.
   - Throw on failure — the runner records the message + per-case Playwright
     trace under `scripts/e2e-artifacts/<harness>/<case>/trace.zip`.
   - If the case mounts a monkey-patch on `dialog`/`shell` or sets a global
     side effect (i18n language, theme, …), pass a restore function to
     `registerDispose(...)`. The runner drains these inside
     `resetBetweenCases` before the next case.
2. If the case genuinely needs a fresh Electron launch (cold-start,
   app-icon/tray init, pre-seeded DB state, or asserting on app shutdown)
   and can't share a process with other cases in an existing harness,
   create a new `scripts/harness-<name>.mjs` file with its own `cases:`
   array rather than reviving the old per-file-probe convention.

## Harness-author gotchas

### `app.evaluate()` callbacks lose their closure scope

The function passed to `app.evaluate(async ({ ipcMain, ... }) => { ... })`
is `String(pageFunction)`-ed and shipped over IPC, then `eval`-ed in the
Electron main process (see `playwright-core/lib/client/electron.js:127`).
Native `require()` and dynamic `import()` work fine inside — they're plain
Node calls in the main process (e.g.
`scripts/probe-helpers/reset-between-cases.mjs` requires `node:path`,
`better-sqlite3`, and `electron` from inside `app.evaluate`; `harness-runner`
does `await import('./electron/notify.js')`). What does **not** survive is
the closure: any variable captured from the harness Node-side scope is
`undefined` after stringify. Symptom: `ReferenceError: foo is not defined`,
or silently `undefined` reads.

Pass closure data through the second arg — Playwright serializes it to the
main process and binds it as the second parameter:

```js
const token = computeAuthToken();

// Bad — `token` is captured from outer scope, gone after stringify.
await app.evaluate(async () => {
  return fetch("https://example/", { headers: { authorization: token } });
});

// Good — pass via second arg; `token` arrives serialized.
await app.evaluate(async (_ctx, { token }) => {
  return fetch("https://example/", { headers: { authorization: token } });
}, { token });
```

The second arg must be JSON-serializable (no functions, no class instances).
For node-module data, you can either compute it Node-side and pass it in,
or just `require()` inside the callback — both work.

### `os.homedir()` ignores `HOME` / `USERPROFILE`

`os.homedir()` calls `SHGetFolderPath` on Windows and `getpwuid_r` on POSIX
— it does **not** read environment variables. So swapping `process.env.HOME`
inside the harness will not redirect reads of `~/.claude` (e.g.
`commands-loader.ts` keeps resolving the real user home).

Either monkey-patch the IPC handler / loader to accept an injected
`homeDir`, or set `CLAUDE_CONFIG_DIR` (added in PR #346 specifically as the
env-overridable fallback for this case) before launching the app:

```js
const electronApp = await electron.launch({
  args: [appMain],
  env: { ...process.env, CLAUDE_CONFIG_DIR: tmpClaudeDir },
});
```

## Running locally

```bash
npm run probe:e2e            # build + every harness
node scripts/harness-ui.mjs                          # one harness, all cases
node scripts/harness-e2e-session-lifecycle.mjs       # another harness
node scripts/harness-e2e-mobile-remote-relay.mjs     # Wrangler + phone PWA relay proof
```

The Mobile Remote harness selects a free localhost port, launches and owns
Wrangler dev, simulates the encrypted desktop and PTY protocol, and opens the
built phone PWA in Playwright. It proves pairing, snapshot/list rendering,
input, live output, relay interruption recovery with sequence deduplication,
and old-secret rejection after rotation. Cleanup targets only the exact child
PIDs created by the harness.

`E2E_SKIP=harness-ime-overflow,harness-dnd` (or any comma list of full
harness filename stems — `probeName()` in `run-all-e2e.mjs` uses the whole
`harness-*` filename, not a suffix) skips entries from `run-all-e2e.mjs`
end-to-end.

## Claude CLI auto-updater isolation

Every path that launches the real `claude` binary sets
`DISABLE_AUTOUPDATER=1` in the child's environment, defaulting on unless the
caller (or the parent shell) explicitly opted out. This closes an incident
where a background `npm run probe:e2e` run raced Claude Code's own
auto-updater on Windows: the updater's atomic-replace step (rename the live
`claude.exe` to `claude.exe.old.<ts>`, write the new one) collided with
several already-running `claude` processes holding the old executable image
open, and the new binary never landed — leaving the global install with no
`claude.exe` at all until the `.old` copy was restored by hand. `DISABLE_AUTOUPDATER=1`
is Anthropic's documented opt-out for exactly this class of problem; the E2E
suite now sets it everywhere it can reach a real `claude` launch so automated
runs can never trigger or race that updater against the developer's own
global install.

The guard is centralized in a single pure, unit-tested helper —
`scripts/probe-helpers/autoUpdaterGuard.mjs` — `resolveAutoUpdaterEnv(env)`
returns `{ DISABLE_AUTOUPDATER: env.DISABLE_AUTOUPDATER ?? '1' }`. It's spread
into three seams, matching the existing `CCSM_E2E_HIDDEN` override
precedent (parent-shell env beats the hardcoded default; an explicit
caller-supplied `env` override at the call site beats both, since it's
spread last):

1. `scripts/probe-utils-real-cli.mjs` → `buildIsolatedLaunchEnv()`, used by
   `launchCcsmIsolated()` — the Electron launch path for most
   `harness-e2e-*.mjs`, `dogfood-*.mjs`, and `screenshot-*.mjs` scripts
   (including `harness-e2e-window-lifecycle-notify.mjs`).
2. `scripts/probe-helpers/harness-runner.mjs` → `buildLaunchOpts()`, used by
   `runHarness()` for `harness-dnd.mjs` and `harness-ui.mjs` — covers both the
   initial boot and any per-case relaunch.
3. `scripts/run-all-e2e.mjs` → `buildChildEnv()`, applied to every spawned
   harness/probe **node child** when running the full suite via
   `npm run probe:e2e`. This is defense-in-depth on top of (1) and (2): it
   guarantees the guard reaches a future harness's own process env even if
   that harness bypassed both shared launch helpers.

A few standalone `dogfood-*.mjs` scripts predate `launchCcsmIsolated()` and
call `electron.launch()` directly instead of going through either shared
helper: `dogfood-dev-process-distinguishable.mjs`,
`dogfood-probe-current-ui.mjs`, and `dogfood-scrollback-hot-reload.mjs`.
These import `resolveAutoUpdaterEnv()` directly and splice it into their own
inline `env` object rather than going through seam (1) or (2) — same
default/override contract, just wired by hand since these launches aren't
built on top of the shared helpers.

All three shared seams (plus the three standalone scripts above) are plain,
side-effect-free functions/call sites covered by
`scripts/**/__tests__/**/*.test.mjs` (run via `npx vitest run --project
scripts`), so the guard's default/override behavior is verified without ever
launching Electron or the real `claude` binary.

If a future probe needs to intentionally exercise updater behavior, it can
still opt out per-launch — pass `env: { DISABLE_AUTOUPDATER: '0' }` to
`launchCcsmIsolated()`/`runHarness()`'s spec, or export
`DISABLE_AUTOUPDATER=0` in the parent shell before invoking
`run-all-e2e.mjs` directly. Do this only with a real, disposable Claude
install — never against a developer's global one.

## Artifacts

On case failure, the harness runner persists:

- `scripts/e2e-artifacts/<harness>/<case>/trace.zip` — Playwright trace
  (open with `npx playwright show-trace …`).
- `scripts/e2e-artifacts/<harness>/<case>/failure.png` — full-page
  screenshot for fast triage without unzipping.

Successful runs leave nothing behind.

## Known coverage gaps (tracked, not yet closed)

These require a fresh Electron launch per case (cold-start, pre-seeded DB
state, or asserting on app shutdown) and have no harness today:

- Cold-start **DB-corruption recovery** (pre-seed a garbage DB file before
  launch, assert the recovery UI). Currently unit-covered only.
- **IME overflow** exists as `harness-ime-overflow.mjs` but is skipped in CI
  (`E2E_SKIP=harness-ime-overflow` in `e2e.yml`, tracked under #1324).

Closing these is scoped to the E2E-framework migration (`@playwright/test`),
not ad-hoc per-file probes — see the test-suite audit's Phase 2/3 plan.

## What the reset between cases actually does

`scripts/probe-helpers/reset-between-cases.mjs` runs in this order:

1. Drains caller-supplied disposers (monkey-patch restore, listener removal).
2. Calls `agentClose` for every session in the renderer store (kills the
   per-session claude.exe subprocess via the same IPC the user’s Delete
   Session button uses).
3. Resets the zustand store to an empty baseline (sessions, groups,
   activeId, queues, running flags, dialogs, focus nonce, recentProjects).
   Settings (theme/language/font) are NOT touched — cases that flip them
   must restore via `registerDispose`.
4. Wipes `messages` table and the `app_state.main` row in SQLite via
   `app.evaluate` against the shared DB handle.
5. Clears DOM selection, blurs `document.activeElement`, and removes any
   stray Radix portal containers (`[data-radix-popper-content-wrapper]`
   and `[role="dialog"]` direct children of `document.body`).

If a new global state surfaces (e.g. a fresh singleton `Map` in main.ts), add
the corresponding reset step here. Flake rate >5% on a converted harness is
the signal that this helper is missing something.
