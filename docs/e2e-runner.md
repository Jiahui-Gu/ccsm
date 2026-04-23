# E2E runner

Two test surfaces share one runner:

- **Per-file probes** (`scripts/probe-e2e-*.mjs`) — one Electron launch per
  file, ~10–30 s cold start, isolated by tmp `--user-data-dir`. Best for
  cases that need cold-start, custom DB seeding, or singleton main-process
  state (tray, titlebar, db-corruption recovery).
- **Themed harnesses** (`scripts/harness-*.mjs`) — one Electron launch packs
  many cases. Cases share the renderer + main process and rely on
  `scripts/probe-helpers/reset-between-cases.mjs` to scrub state between
  cases. Best for cases that are session-scoped and don't need a fresh
  process. Currently:
  - `harness-agent.mjs` — agent / streaming / inputbar UI (Phase-2 pilot).

`scripts/run-all-e2e.mjs` runs harnesses first, then the remaining per-file
probes. Probes whose case has been moved into a harness are skipped via the
in-file `MERGED_INTO_HARNESS` set; the source files stay as breadcrumbs with
a top-of-file `// MERGED INTO scripts/harness-…mjs` marker.

## Adding a new case

1. **Pick the right surface.**
   - If the case touches only renderer state + a session, add it as a case
     in an existing themed harness.
   - If the case needs cold-start, app-icon assets, tray init, db corruption,
     window-shutdown semantics, or other singleton main-process state, write
     a per-file probe (see “Cases that can’t be merged” below).
2. **For a harness case**: open the harness file, write a named function
   `caseFoo({ app, win, log, registerDispose })`, and register it in the
   `cases:` array.
   - Use `log()` instead of `console.log` so output is prefixed
     `[case=<id>] …`.
   - Throw on failure — the runner records the message + per-case Playwright
     trace under `scripts/e2e-artifacts/<harness>/<case>/trace.zip`.
   - If the case mounts a monkey-patch on `dialog`/`shell` or sets a global
     side effect (i18n language, theme, …), pass a restore function to
     `registerDispose(...)`. The runner drains these inside
     `resetBetweenCases` before the next case.
3. **Update the runner skip list.** Add the suffix of the original
   per-file probe (if any) to `MERGED_INTO_HARNESS` in
   `scripts/run-all-e2e.mjs`, and prepend the breadcrumb header to the
   source file.

## Running locally

```bash
npm run probe:e2e            # build + every harness + every non-merged probe
node scripts/harness-agent.mjs                       # one harness, all cases
node scripts/harness-agent.mjs --only=streaming      # one case
node scripts/harness-agent.mjs --only=streaming,chat-copy  # subset
```

`E2E_SKIP=streaming,tray` (or any comma list of probe / harness suffixes)
skips entries from `run-all-e2e.mjs` end-to-end.

## Artifacts

On case failure, the harness runner persists:

- `scripts/e2e-artifacts/<harness>/<case>/trace.zip` — Playwright trace
  (open with `npx playwright show-trace …`).
- `scripts/e2e-artifacts/<harness>/<case>/failure.png` — full-page
  screenshot for fast triage without unzipping.

Successful runs leave nothing behind.

## Cases that can’t be merged (keep one Electron per file)

Per `docs/e2e/single-harness-brainstorm.md` §9, the following exercise
singleton main-process state or first-launch UI and **must stay as
per-file probes** (one Electron launch per case):

- `probe-e2e-app-icon-present`
- `probe-e2e-tray`
- `probe-e2e-titlebar` (window chrome init)
- `probe-e2e-tutorial`, `probe-e2e-no-sessions-landing`,
  `probe-e2e-empty-state-minimal` (first-launch UI)
- `probe-e2e-db-corruption-recovery` (pre-seeds garbage DB before launch)
- `probe-e2e-import-session`, `probe-e2e-import-empty-groups`
  (depends on userData state at launch)
- `probe-e2e-close-window-aborts-sessions` (asserts on app shutdown)
- `probe-e2e-ipc-unc-rejection`, `probe-e2e-env-passthrough`
  (process-launch concerns)
- `probe-e2e-restore*` family (specifically test "what happens after
  restart" — they require a relaunch by definition)

If you’re tempted to merge one of these, re-read the brainstorm §3
(shared-state inventory) and §9 first.

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
