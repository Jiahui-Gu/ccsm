# E2E runner

All end-to-end coverage runs through **themed harnesses**
(`scripts/harness-*.mjs`) — one Electron launch packs many cases. Cases
share the renderer + main process and rely on
`scripts/probe-helpers/reset-between-cases.mjs` to scrub state between
cases. Current harnesses: `harness-dnd.mjs`, `harness-ui.mjs`,
`harness-ime-overflow.mjs`, `harness-scrollbar-6-scenarios.mjs`, and the
`harness-e2e-*.mjs` family (`error-recovery`, `import-from-claude`,
`paste-fidelity`, `persistence-resume`, `session-lifecycle`,
`window-lifecycle-notify`, `voice-download`, `voice-input`,
`mobile-remote-relay`, `mobile-terminal-sync`, and `mobile-remote-visual`).
The three `mobile-*` harnesses are standalone Playwright scripts (not
Electron) that own their own local Wrangler dev server and encrypted
simulated desktop — see "Mobile Remote harnesses" below.

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
node scripts/harness-e2e-mobile-terminal-sync.mjs    # deterministic buffer-parity dogfood
node scripts/harness-e2e-mobile-remote-visual.mjs    # portrait/keyboard/landscape/drawer viewport proof
```

All three `mobile-*` harnesses require `npm run build` first (they load
`dist/electron/remote/*.js`, `dist/src/shared/**/*.js`, and the built
`dist/mobile` phone PWA — not the TypeScript sources directly).

`E2E_SKIP=harness-ime-overflow,harness-dnd` (or any comma list of full
harness filename stems — `probeName()` in `run-all-e2e.mjs` uses the whole
`harness-*` filename, not a suffix) skips entries from `run-all-e2e.mjs`
end-to-end.

## Mobile Remote harnesses

Three standalone Playwright scripts (not Electron, no `harness-runner.mjs`
case list) share `scripts/probe-helpers/mobileRemoteHarness.mjs` for local
Wrangler lifecycle and an encrypted "simulated desktop" peer that speaks the
same wire protocol as the real Electron desktop controller
(`electron/remote/mobileRemoteController.ts` /
`electron/remote/remoteMessages.ts`): it proactively sends both the legacy
`sessions.list` and the versioned `sessions.navigator` on every handshake,
answers `session.snapshot`/`session.resize`/`session.input`, and answers
`session.submit` with a correlated `session.submit.result`.

By default each harness reserves a free localhost port and starts/owns its
own local Wrangler dev server for `cloudflare/wrangler.jsonc`, cleaning up
the exact child PID and `cloudflare/.wrangler/` local state in its `finally`
block. Set `CCSM_RELAY_URL` (e.g. to a deployed public relay Worker URL) to
run the same proofs against that relay instead — local Wrangler is skipped
entirely and no local relay process is started or stopped.

```powershell
# Local Wrangler (default)
node scripts/harness-e2e-mobile-terminal-sync.mjs
node scripts/harness-e2e-mobile-remote-relay.mjs
node scripts/harness-e2e-mobile-remote-visual.mjs

# Public relay
$env:CCSM_RELAY_URL = 'https://your-deployed-relay.workers.dev'
node scripts/harness-e2e-mobile-terminal-sync.mjs
node scripts/harness-e2e-mobile-remote-relay.mjs
```

### `harness-e2e-mobile-terminal-sync.mjs` — deterministic buffer-parity dogfood

Feeds the deterministic ANSI fixture (`scripts/fixtures/
mobile-remote-pty-fixture.mjs`) through an authoritative `@xterm/headless` +
`@xterm/addon-serialize` terminal — sized from the *real* browser's own
negotiated `session.resize`, never hardcoded — while deliberately perturbing
what the phone actually receives over the encrypted wire: duplicate and
stale sequence numbers, a snapshot/live overlap (buffered chunks arriving
while a deliberately delayed snapshot response is withheld), a clean gap
recovery, a disconnect mid-burst with reconnect and drain, and an old-sid
tail arriving after a session switch. Each of the five independent cases
uses its own pairing identity, page, and state. Every case asserts exact
equality between the real browser's `SerializeAddon.serialize()` output and
the authoritative buffer — never a substring/plain-text comparison — plus
exactly-once marker counts, absent stale/erased/alt-screen markers, the
exact expected snapshot-request count, and zero browser console
errors/pageerrors. Prints `[mobile-terminal-sync] PASS exact buffer parity
across 5 fault cases` only once every case has passed.

### `harness-e2e-mobile-remote-relay.mjs` — composer, controls, Ask, recovery, re-pair

Proves the final production contract end-to-end against the real built
phone PWA: encrypted handshake and navigator-driven session selection; a
complete-draft composer submission (`/status`) acknowledged and cleared
exactly once; a CJK draft sent via real `CompositionEvent`/`InputEvent`
choreography as one complete submission; Return staying a local multiline
newline until Send; a rejected submission preserving the draft with a
visible `role="alert"` and succeeding on retry; a simulated
`AskUserQuestion` answered with discrete key clicks (exact control bytes)
plus composer free text; that clicking the terminal never focuses the
composer or the (hardened) xterm helper, and that a user-focused composer
survives terminal clicks and live output; a disconnect (closing the
encrypted desktop peer only, never restarting the relay process — the relay
Durable Object already proactively closes the phone's own socket once its
sole desktop peer disconnects) that disables Send/keys and preserves the
draft; that reconnecting never auto-submits and an explicit Send afterward
works; live output with sequence-duplicate deduplication; and old-secret
rejection after rotation. Prints `[mobile-remote-relay] PASS composer,
controls, Ask, recovery, re-pair` only on full success.

### `harness-e2e-mobile-remote-visual.mjs` — viewport and touch-target proof

Captures four screenshots under `artifacts/mobile-remote/` (regenerated
every run, gitignored — not committed evidence):

| File | Viewport | What it proves |
| --- | --- | --- |
| `portrait.png` | 390×844 | baseline layout, touch targets, terminal visible |
| `keyboard-open.png` | 390×520 visual viewport (844 layout viewport) | keybar/composer stay above the simulated keyboard |
| `landscape.png` | 844×390 (real Playwright viewport rotation) | layout adapts, resize reflects the oriented dimensions |
| `drawer.png` | 390×844, drawer open | drawer + underlying shell both within the visible viewport |

The "keyboard open" state is a deterministic `visualViewport` simulation
only — a fake `window.visualViewport` installed via `page.addInitScript`
before any app code runs, overridden on demand via
`window.__ccsmSetVisualViewportOverride({ height, width, offsetTop,
offsetLeft })`. It is never simulated by calling `focus()`/`blur()` on
anything. The override still drives the real production code path
(`mobileTerminalAdapter.ts`'s `visualViewport` listener, which sets the real
`--app-height`/`--app-offset-top` CSS custom properties `mobile.css`
consumes), so the actual CSS variables and terminal refit are genuinely
exercised. Before every screenshot, the harness asserts the top bar,
terminal, key bar, composer, Send button, and (when open) the drawer are
all within the visible viewport bounds; that the terminal has a real
non-zero visible area; that every touch target (menu button, every
discrete key, Send, and — when the drawer is open — its close button and
at least one navigator row) is at least 44 CSS px in both dimensions; and
that the key bar/composer specifically stay above the simulated keyboard
under the 520 px visual viewport. It also asserts a fresh `session.resize`
follows every viewport transition (shrink, restore, and rotation), with
cols/rows changing in the expected direction. Prints
`[mobile-remote-visual] PASS portrait, keyboard, landscape, drawer` only on
full success.

## Real CLI, public relay, and physical-phone acceptance

The three harnesses above remain deterministic simulated-desktop dogfood.
Public relay and real-browser acceptance were completed separately against
`https://ccsm-mobile-remote.jiahuigu.workers.dev` from commit
`85fcc0be715dc3b39a12d65299d0233fb5f30d1e`. Deployment workflow run
`29902412040` succeeded from that SHA, followed by:

- public terminal synchronization: 5/5 exact buffer-parity fault cases;
- public composer, controls, Ask, reconnect, and re-pair: 13/13 cases;
- public visual geometry and touch targets: 5/5 cases;
- real Electron + global Claude Code through the public relay: `/status`,
  `AskUserQuestion` option and free-text answers, Ctrl+C during active work,
  disconnect/reopen during active output, exact authoritative recovery, and
  empty console, page-error, and WebSocket-error arrays.

The long-output proof used repeated short real Claude responses because Claude
collapses large Bash tool cards and treats a bracketed-pasted leading `!` as a
normal prompt. PTY and relay sequences still converged with no transport loss.
At 52×42, 96 unique response markers exceeded the two-screen threshold of 84.
A fresh phone context then serialized exactly 19,521 bytes, matching the
desktop authoritative buffer byte-for-byte with SHA-256
`BEC1A8207E8E0D94D5BAEE6665437C4C5CC5080F94EDB77F9EA2C0F9DEB0BF15`;
all markers appeared exactly once.

An upstream Claude permission confirmation is N/A under the current desktop
policy: `electron/ptyHost/entryFactory.ts` unconditionally appends
`--dangerously-skip-permissions`. The acceptance run did not change that
longstanding policy.

Claude Code `2.1.141` and its global executable were healthy before and after
the real-flow acceptance. Every launch set `DISABLE_AUTOUPDATER=1`.

**Physical-device acceptance remains pending.** A real phone over the public
internet must still cover QR pairing, drawer open/close and session switching,
terminal selection/copy with the keyboard closed, composer-only keyboard
entry, CJK/IME/multiline/paste input, portrait/landscape rotation, native Ask
flows, disconnect/reconnect with an unsent draft, and re-pairing in the
existing browser tab, with the required screenshots or recording.

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

Successful runs leave nothing behind, **except** the three Mobile Remote
harnesses above, which always write their artifacts on success too:

- `scripts/harness-e2e-mobile-remote-visual.mjs` → `artifacts/mobile-remote/
  {portrait,keyboard-open,landscape,drawer}.png` (gitignored, regenerated
  every run).
- All three Mobile Remote harnesses also clean up `cloudflare/.wrangler/`
  (local Wrangler dev state) in their `finally` block when they started
  their own local Wrangler instance; that directory is gitignored as a
  backstop if a run is killed before cleanup.

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
