# 00 — Overview: v0.3 e2e cutover repair (Set B skip-first)

**Spec ID**: `2026-05-06-v0.3-e2e-cutover`
**Base HEAD**: `35b08d15` (origin/working, includes #1106)
**Author stage**: stage-1 / spec-pipeline (this commit)
**Driver task**: Task #592

## 1. Why this spec exists

The v0.3 wave-2 cutover (PRs #1100–#1105) physically moved `db / import /
prefs / sessionTitles / sentry / ptyHost / sessionWatcher / notify / badge`
out of Electron main and into a standalone daemon process, and replaced
the previous `ipcRenderer.invoke(...)` channels with loopback HTTP +
SSE through `electron/preload/bridges/*.ts`. After that landed:

- `lint / typecheck / build / unit` are green on `35b08d15` (PR #1106
  repaired the only unit-side dead import — `daemon/sessionWatcher/__tests__/titleChanged.test.ts`).
- All three e2e harnesses (`harness-real-cli`, `harness-ui`, `harness-dnd`)
  are red. dev-574 captured a full local CI baseline in `/tmp/t574-e2e.log`.

Concretely the e2e red stems from at least four hot-path regressions
that wave-2 cutover left half-wired (full audit in
[01-cutover-audit](./01-cutover-audit.md)):

1. `window.__ccsmStore` exposure / hydration ordering — `seedStore` waitForFunction
   timeouts in 5+ harness-ui cases, the dnd case, and several real-cli paths.
2. `window.ccsm.loadState` no longer present on the new preload surface
   for `tray` / `close-dialog-is-native` (`window.ccsm.loadState is not a function`).
3. ptyHost SSE wiring incomplete — `waitForTerminalReady` reports
   `{host:false,term:false,buffer:false}` for >60s on cold sessions, and
   `attach-replay-from-headless-buffer` hits
   `ccsmPty: daemon port unavailable after 5s` (preload bridge code at
   `electron/preload/bridges/ccsmPty.ts:49`).
4. Theme application on first paint — `theme-toggle` reads
   `themeClassDark:false themeClassLight:false` (root <html> classes never
   applied), `titlebar` and `startup-paints-before-hydrate` time out
   waiting on store-driven hydration.

Beyond those, a non-trivial slice of the harness probe utilities
(`scripts/probe-utils.mjs`, `scripts/probe-utils-real-cli.mjs`,
`scripts/probe-helpers/*.mjs`) was not refreshed during wave-2-D
cleanup. They still assume the pre-cutover renderer surface in places.

This spec defines the **minimum-blast-radius** repair plan to take all
three e2e harnesses back to green WITHOUT regressing the green
lint/typecheck/build/unit baseline and WITHOUT introducing any new
`.skip` directives.

## 2. Scope

**In scope**:

- Re-establishing the renderer surface contract used by the harnesses
  (`window.__ccsmStore`, `window.ccsm.loadState`, `window.__ccsmTerm`,
  hydration-trace) on top of the new preload bridges.
- Completing the `daemon-port → preload bridge` boot sequence so cold
  e2e launches don't time out at 5s.
- Auditing every wave-2 hot path against the failing harness symptoms,
  emitting a per-path FIX/KEEP/REVERT verdict.
- Refreshing probe-utils so harnesses can drive the post-cutover
  surface without local hacks.
- Producing a per-harness-case verdict policy (KEEP / DELETE / FIX /
  MARK) for any future case marked with a runner gate flag
  (`requiresClaudeBin / windowsOnly / darwinOnly / linuxOnly /
  skipLaunch`). Ground-truth at `35b08d15` / `5d0c5375`: **0 Vitest
  `.skip` directives, 1 `skipLaunch:true` case**
  (`cap-skip-launch-bundle-shape`, capability demo of the runner
  itself; KEEP). The dev-574 "~88" figure was a count of runner
  gate-evaluations across the case×flag matrix in
  `scripts/probe-helpers/harness-runner.mjs`, NOT actual skipped
  tests; v0.3 treats §3.1 ("zero e2e skip") as a forward guard against
  introducing new skips during repair, not a triage backlog. Canonical
  baseline lives in [04-probe-and-harness-update](./04-probe-and-harness-update.md)
  §1.1.
- A release-slicing plan plus DAG so manager can dispatch fixers
  in parallel without merge collisions.

**Out of scope** (deferred to v0.4 unless the audit promotes them):

- The web frontend (v0.4 — there is no renderer surface there yet).
- Replacing loopback HTTP+SSE with a different transport (we keep the
  wave-2 daemon transport — the v0.3 iron rule per
  [release-slicing](./05-release-slicing-and-dag.md) §1).
- Any change to product features. v0.3 is a refactor; if the audit
  surfaces an apparent feature change as a side-effect of cutover, it
  is treated as a bug to fix back to pre-cutover behaviour.

**Why deferred**: v0.3 ships when the daemon split is provably
non-feature-impacting. New transports / surfaces / features compound
risk and are scheduled for v0.4+ design once v0.3 is locked
(`spec/2026-04-30-v0.4-web-frontend-design.md`).

## 3. Iron rules (carried from manager dispatch)

These constrain every fix proposed in chapters 02–05.

1. **Zero e2e skip**. Adding `it.skip / xtest / harness skip flags` to
   silence a red case is a P0 finding regardless of test difficulty.
2. **Skip-first repair path (option b)**. The known-green baseline
   (lint/typecheck/build/unit) MUST stay green for the entire repair.
   No fixer is allowed to "drive-by refactor" non-e2e code.
3. **Dogfood discipline** — `Set A` (CI gate, must be green to merge)
   and `Set B` (informational bench). The repair targets Set A
   absolute-green; Set B regressions that surface during repair are
   logged in [05-release-slicing-and-dag](./05-release-slicing-and-dag.md)
   §4 but do not block.
4. **sigkill-reattach is a v0.3 must-fix — scope = v0.2 baseline restoration only**.
   The reattach-from-snapshot path is currently exercised only via
   `attach-replay-from-headless-buffer` which is broken at the daemon-port
   boundary; once the boundary is fixed, the v0.2 daemon-port already-shipping
   attach-replay path MUST be restored to green. v0.3 scope = "restore the
   attach-replay code path that v0.2 already shipped on the daemon-port
   substrate; buffer replay is served by daemon's existing v0.2 snapshot
   behaviour (unchanged)." v0.3 does NOT introduce new product semantics on
   this path. Explicit **v0.4 defer list** for sigkill-reattach (NOT v0.3
   work; see [03-ptyhost-wiring](./03-ptyhost-wiring.md) §7):
   - 60s snapshot TTL pin + buffer-cap (1MB/sid) + ring-buffer eviction.
   - cwd-mismatch → discard snapshot policy.
   - NEW `sigkill-reattach` harness case in Set A (v0.3 keeps it Set B
     informational; promotion to Set A is a v0.4 candidate).
   - Release gate `G10` lock on sigkill-reattach being green.
   Why this split: v0.3 is a refactor (per §3.2 / §3 rule "no product
   feature change"); pinning new TTL / cwd / cap semantics or making
   sigkill-reattach a release-blocker = NEW product rules and would inflate
   v0.3 scope. R1 strict-preservation派 (manager decision, round 1)
   prevails — v0.3 ships when the v0.2 attach-replay path is green again,
   not when new reliability semantics are pinned.
5. **Three RPCs (`SendInput / Resize / CheckClaudeAvailable`) must be
   real implementations + UT + Connect-roundtrip** — no stubs, no
   "always-ok" returns. They are the smallest set the renderer cannot
   live without.
6. **No transport regression**. Every fix is implemented on the
   wave-2 daemon HTTP/SSE pipe. Reverting any single bridge to IPC is
   a P0 finding.
7. **Daemon liveness contract**. The daemon process is a hard
   dependency of the renderer; v0.3 pins the failure semantics so
   every fixer codes against the same contract:
   - On `spawnDaemon` rejection in `electron/main.ts` (boot path),
     electron MUST hard-exit with a non-zero code AND emit a
     structured stderr line in the format owned by
     [03-ptyhost-wiring](./03-ptyhost-wiring.md) §6 (CF-6 stderr
     contract). No silent fallback, no IPC retry.
   - On daemon process exit AFTER window creation (mid-session),
     electron MUST surface a renderer toast via the existing zustand
     error slice AND disable the pty / data RPC surfaces until the
     user restarts the app. The renderer MUST NOT auto-retry the
     daemon connection.
   - **Auto-restart on crash is deferred to v0.4** (see
     [03-ptyhost-wiring](./03-ptyhost-wiring.md) §7); v0.3 ships with
     fail-loud + restart-by-user semantics only.
   Why: chapter 03 §3 makes `spawnDaemon` awaited and chapter 03 §6
   pins the stderr format; without this iron rule the boot-failure
   and mid-session-exit code paths would be implemented inconsistently
   across PR-3 / PR-6 fixers.

## 4. Relationship to v0.3 wave-2

This spec is "wave-2 cutover follow-on". It does NOT redo wave-2; it
finishes the seam wave-2 left half-cut.

Concretely it inherits these wave-2 commits as the substrate to repair on:

| commit     | wave-2 sub-PR | what it landed                                                  |
|------------|---------------|------------------------------------------------------------------|
| `badbf48d` | wave1-A #1097 | daemon http server skeleton                                     |
| `7588192a` | wave1-C #1098 | renderer fetch shim (`window.ccsm` over HTTP)                   |
| `f0738856` | wave1-B #1099 | electron spawns daemon + delete business ipc registers          |
| `f9c99ab5` | wave2-prep    | auto-registry daemon/api + 5-bridge preload skeleton            |
| `5e132743` | wave2-prep-v2 | startup auto-registry for `daemon/main.ts`                      |
| `4ff7c00d` | wave2-A #1104 | db / import / prefs / sessionTitles / sentry mv to daemon       |
| `b2300c28` | wave2-B #1103 | ptyHost mv to daemon + SSE pty events + real `ccsmPty` shim     |
| `e263ddd7` | wave2-C #1102 | sessionWatcher / notify-producer / badge mv + SSE bridges       |
| `2d8a193d` | wave2-D #1105 | delete `__legacy_to_delete__` + ipcGuards cleanup               |
| `35b08d15` | post-wave2    | repair dead import in `titleChanged.test.ts` (#1106)            |

Reverting any of these is OUT OF SCOPE; this spec stacks on top.

## 5. Non-goals

| Non-goal                                                          | Why deferred                                          | Target version |
|-------------------------------------------------------------------|-------------------------------------------------------|----------------|
| Rewriting harness-runner to a Vitest-managed runner               | Orthogonal infrastructure work; harness-runner has no known defect blocking repair | v0.4+ |
| Replacing harness `requiresClaudeBin / skipLaunch` directives with a single mechanism | Same — refactor opportunity, not a v0.3 release blocker | v0.4+ |
| Bench parity with Set A on Set B (full Linux/macOS coverage)      | CI cost; Set A defines release gate                   | v0.4+ |
| Migrating preload bridges off `contextBridge.exposeInMainWorld`   | Wave-2 substrate; out of scope per §3 rule 6          | post-v0.3 |
| Renaming `__ccsmStore` to a non-debug-affordance                  | Production-side renderer-test affordance; touched by harnesses, can rename in v0.4 hardening | v0.4 |

**Why deferred**: each item is either pure improvement (no failing
case attached) or would expand wave-2 substrate edits; either way it
delays v0.3 release for non-blocking reasons.

## 6. Quality bar / acceptance criteria

The spec is "done" when:

1. [01-cutover-audit](./01-cutover-audit.md) lists every wave-2 hot
   path and assigns FIX / KEEP / REVERT (REVERT only with
   manager-explicit override).
2. [02-store-and-preload-surface](./02-store-and-preload-surface.md)
   defines the post-cutover renderer surface used by the harnesses,
   including hydration ordering, and the migration policy from
   `window.ccsm.loadState` legacy callers.
3. [03-ptyhost-wiring](./03-ptyhost-wiring.md) defines when each of
   `host / term / buffer` flips true and the daemon-port readiness
   contract that prevents the 5s timeout.
4. [04-probe-and-harness-update](./04-probe-and-harness-update.md)
   classifies every harness case (KEEP / DELETE / FIX / MARK) and
   defines the probe-utils refresh.
5. [05-release-slicing-and-dag](./05-release-slicing-and-dag.md)
   provides the PR DAG, blockers, and the gate criteria
   (`e2e 3 harness all green` ∧ `lint/typecheck/build/unit still green`).
6. **Daemon stderr is structured and captured.** Daemon-side and
   electron-main-side error output MUST follow the structured-stderr
   format pinned in [03-ptyhost-wiring](./03-ptyhost-wiring.md) §6
   (CF-6: `[ccsmd] <ISO-8601> <level> <category>: ...`), and the
   harness runner MUST capture both electron-main and daemon streams
   to per-case files so any v0.3 CI flake (Risk-1 in
   [05-release-slicing-and-dag](./05-release-slicing-and-dag.md) §4)
   is post-mortem-debuggable without re-running. Why: a single
   un-attributable flake otherwise costs hours of bisection.

The downstream **implementation** is "done" only when the e2e CI gate
hits absolute-green for two consecutive runs on a fresh worktree. That
gate lives in `.github/workflows/e2e.yml` and is not modified here.

## 7. Document conventions

- All chapters use ATX (`#`) headings, max depth `####`.
- Code-fence language tag mandatory (`ts`, `tsx`, `bash`, `mermaid`).
- Cross-chapter links are relative: `./NN-name.md`.
- "MUST / SHOULD / MAY" used per RFC 2119 — every architectural
  decision is followed by a one-line `Why:` justification.
- Every `Non-goal:` / `Deferred:` carries a `Why deferred:` and a
  target version.
- File / symbol references use absolute repo-root paths (e.g.
  `electron/preload/bridges/ccsmPty.ts:49`).

## 8. Reader map

If you're a reviewer:

- **Feature-preservation** angle → chapters 01, 02, 03 (any silent
  feature drift gets caught here).
- **Reliability / observability** → chapters 03, 04 (ptyhost wiring,
  probe-utils — all the failure surfaces).
- **Testability** → chapters 04, 05 (case-by-case verdict + slicing).
- **Naming / consistency** → chapter 02 (preload surface naming) and
  chapter 04 (probe / harness naming convergence).
