# Changelog

All notable changes to ccsm are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-05-06

### Summary

v0.3 is the **e2e cutover** release. Spec
[#592](https://github.com/Jiahui-Gu/ccsm/pull/1107) split the previously
monolithic main process across a `daemon` (HTTP / IPC source-of-truth)
and an `electron` shell, then re-wired the renderer onto that contract
through a sequence of 8 PRs (PR-1 .. PR-8) plus 3 supporting work
items (T-doc, T-G1, T-9). The release-gate witness is the per-case
verdict in [`docs/e2e/04b-case-set-assignment.md`](docs/e2e/04b-case-set-assignment.md):
**42 Set A** cases gate CI on three platforms; **3 Set B** cases run
locally on the developer host as informational.

The terminal merge gate (T-9, PR-9, this PR) locks the e2e matrix into
`required` posture: every subsequent PR into `working` must show
`e2e (ubuntu-latest)`, `e2e (macos-latest)`, `e2e (windows-latest)`
all green before merge.

### Added — v0.3 spec PRs (#592)

- **PR-1** (#1114, Task #602) — `window.ccsm` shim now points at the
  actual daemon HTTP routes; renderer no longer carries an in-process
  fallback for what is a daemon responsibility.
- **PR-2** (#1116, Task #601, T-2) — `__ccsmStore` pinned at module
  eval and a `ccsm:app-shell-ready` event emitted; e2e probes can
  `waitForEvent` deterministically instead of polling.
- **PR-3** (#1112, Task #597, T-3) — `daemon-spawner` awaits a
  ready-signal with a 10 s timeout and a typed error code;
  unit-tested end-to-end.
- **PR-4** (#1118, Task #603, T-4) — `TerminalPane` now hosts xterm
  unconditionally with a pinned init order; the `[data-terminal-host]`
  contract is wired regardless of session state.
- **PR-5** (#1113, Task #598, HP-9) — three real RPCs
  `SendInput` / `Resize` / `CheckClaudeAvailable` plus a closed
  `Error`-token enum, replacing the stub interfaces from the
  bridge era.
- **PR-6** (#1115, Task #604, T-6) — SSE multi-subscriber gates
  G-1..G-4 plus the v0.2 sigkill baseline UTs that PR-9 inherits as
  the "no-regression" floor.
- **PR-7** (#1117, Task #606, T-7) — tri-state
  `resolveEffectiveTheme` library with all 6 system × user-pref
  combinations covered by UTs.
- **PR-8** (#1119, Task #605, T-8) — probe-utils + harness-runner
  `waitForEvent` integration on `ccsm:app-shell-ready`; replaces
  the prior poll-with-timeout pattern.
- **T-doc** (#1109, Task #599) — per-case Set A / Set B / DELETE
  assignment ([`docs/e2e/04b-case-set-assignment.md`](docs/e2e/04b-case-set-assignment.md))
  authored as the canonical merge-gate witness.
- **T-G1** (#1111, Task #600) — daemon enforces a
  loopback-only bind invariant; verified via UT.

### Changed — v0.3 release-gate plumbing

- **PR-9 / T-9** (this PR, Task #607) — e2e workflow gate lock.
  - `ci.yml` and `e2e.yml` now also trigger on `push` to `working`,
    so the merge-gate signal stays continuously fresh on the
    integration branch and supplies the flakiness baseline required
    by spec §5.3.9.
  - All 42 Set A cases (per
    [`docs/e2e/04b-case-set-assignment.md`](docs/e2e/04b-case-set-assignment.md))
    must be green on `e2e (ubuntu-latest)`, `e2e (macos-latest)`, and
    `e2e (windows-latest)` for any subsequent PR into `working`.
  - The 3 Set B cases (`reopen-resume`,
    `pty-subtree-killed-on-quit`, `sigkill-reattach`) remain
    informational: they live in `harness-real-cli`, which CI skips
    via `E2E_SKIP=harness-real-cli` (no `claude` binary on hosted
    runners — see comment in `e2e.yml`); they are runnable on
    the developer's primary box for dogfood.

### Closing PRs (post-PR-8 cleanup, all merged before T-9 lock)

- **#627 → PR #1123** — single-source `window.ccsm` via
  `contextBridge`; renderer-side shim deleted.
- **#624 → PR #1124** — preload wires
  `onMaximizedChanged` / `onBeforeHide` / `onAfterShow` into the
  `window.ccsm` surface, completing PR-1's contract.
- **#636 → PR #1125** — e2e baseline-red fix (`tray` and
  `close-dialog-is-native`); without this the gate lock would have
  shipped on a 12/14 baseline rather than 14/14.

### Deferred to v0.4 (DEFER F-1 .. F-7, per spec §3.7)

These items were carved out of v0.3 scope to keep the cutover
release shippable; trackers below remain open against the v0.4
milestone:

- **F-1** — Two-window / multi-electron lifecycle (covered by
  Set B `reopen-resume` informational case in v0.3; promotion
  to Set A is a v0.4 PR per spec §3.7 F-1).
- **F-2** — Daemon HTTP auth (loopback-only is the v0.3 floor;
  auth tokens are v0.4).
- **F-3** — Renderer cold-launch budget tightening below the
  current 5 s ceiling (PR-9 locks the ceiling; v0.4 squeezes it).
- **F-4** — `sigkill-reattach` Set B → Set A promotion with a
  pinned wall-clock budget; explicitly **not** flipped in v0.3
  per [`docs/e2e/04b-case-set-assignment.md`](docs/e2e/04b-case-set-assignment.md) §7.
- **F-5** — Daemon split for the remaining single-process leftovers
  (notify producers, badge IPC) that v0.3 deliberately left in the
  electron shell.
- **F-6** — Cross-version session-replay migration runner (v0.3
  pins the on-disk JSONL contract; v0.4 carries the migrator).
- **F-7** — Coverage threshold enforcement
  (`ci.yml` ships coverage with `continue-on-error: true` since
  Task #802; v0.4 turns the threshold check on).

### Acceptance witness — v0.3 release gate

Per spec §5.3.9, the v0.3 release closes when:

- 42 Set A cases green on the e2e matrix (3 platforms) — pinned by
  this PR.
- 3 Set B cases run informationally (no CI gate) — pinned by this
  PR via the existing `E2E_SKIP=harness-real-cli` configuration.
- 2 consecutive `working`-branch CI runs are all-green — verified
  by the `push: branches: [working]` triggers introduced here.
- T-9 merge = v0.3 spec closed.

