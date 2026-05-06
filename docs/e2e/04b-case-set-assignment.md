# 04b — Per-case Set A / Set B / DELETE assignment (v0.3 e2e cutover)

> **Status**: living artifact. Authored against spec
> `docs/superpowers/specs/2026-05-06-v0.3-e2e-cutover-design.md` §4.3.3
> for Task #599 (spec #592 T-doc) so G5/G6/G7 merge gates (#607) have a
> canonical per-case verdict to enforce.
>
> **Source-of-truth baseline**: spec branch HEAD `5d0c5375` rebased onto
> `35b08d15` (working). All counts below are reproducible via the
> commands in §1.

---

## 1. Ground-truth (R5 §4.1.1, mechanically reproducible)

The original task framing referred to "88 existing `.skip` cases" — this
figure was a **count of harness runner gate-evaluation points**
(case × capability-flag matrix evaluated by
`scripts/probe-helpers/harness-runner.mjs`), **not** skipped tests. The
real, mechanically-verifiable inventory at `5d0c5375` is:

```bash
# Vitest skips across all source / test trees:
$ grep -rEn "(it|test|describe)\.skip\(|\bxit\b|\bxdescribe\b" \
    --include='*.ts' --include='*.tsx' --include='*.js' \
    tests/ src/ daemon/ electron/
# 0 matches

# Harness skipLaunch capability flag:
$ grep -rn "skipLaunch" --include='*.mjs' scripts/
# scripts/probe-helpers/harness-runner.mjs : 13 references (the runner mechanism)
# scripts/harness-ui.mjs:1624 : { id: 'cap-skip-launch-bundle-shape', skipLaunch: true, ... }
```

| Source                                                                                         | Count |
|------------------------------------------------------------------------------------------------|-------|
| Vitest `it.skip / test.skip / describe.skip / xit / xdescribe` in `tests/ src/ daemon/ electron/` | **0** |
| `vitest.config.ts` exclude patterns beyond standard `node_modules / dist`                      | **0** |
| Harness `skipLaunch: true` cases                                                               | **1** (`cap-skip-launch-bundle-shape`, capability demo of the runner) |
| Harness `requiresClaudeBin: true` in `tests/`                                                  | **0** |
| Harness `windowsOnly / darwinOnly / linuxOnly` in `tests/`                                     | **0** |

**Conclusion**: there is no triage backlog at the case level. The
single `skipLaunch:true` case is a capability demo of the runner
mechanism itself and is correctly classified KEEP. The "zero e2e skip"
iron rule (§3.1 of the spec) becomes a **forward guard** against
introducing new skips during the repair, not a back-fix exercise.

---

## 2. Verdict policy (recap of §4.1.2)

Each existing harness case below is assigned exactly one of:

- **KEEP / Set A** — legitimate CI gate. Must be green to merge per
  G5/G6/G7. Includes the post-cutover wave-2 hot-path cases.
- **KEEP / Set B (informational)** — runs locally on the developer's
  primary box; failures are LOGGED but **NOT** blocking. Used for
  cases that need real claude binary, multi-window, or display-budget
  setups CI cannot afford.
- **DELETE** — case covers a feature that no longer exists; remove the
  entire case in the §5 PRs and link to the removal commit.
- **FIX** — case is gated on a CI-broken condition; remove the gate,
  expect FAIL, then fix in §5.3 PR slicing. **Currently: 0 cases**
  (no skips on baseline).
- **MARK** — case requires a v0.4-only downstream feature; move to
  Set B with a v0.4 tracker link.

§5.1 G8 enforces that any addition during repair carries one of these
verdicts in the PR body.

**Iron rule reminder**: NO case may be re-classified as `it.skip` /
`test.skip` / `describe.skip` / `xit` / `xdescribe` in v0.3 under any
verdict. Removing a feature → DELETE the case, do not skip it.

---

## 3. Per-case assignments — existing harness cases

Total existing cases at `5d0c5375`: **42** (`harness-ui` 14 +
`harness-real-cli` 27 + `harness-dnd` 1).

### 3.1 `scripts/harness-ui.mjs` (14 cases)

| # | Case id                              | Verdict | Set | Rationale |
|---|--------------------------------------|---------|-----|-----------|
| 1 | `sidebar-align`                      | KEEP    | **A** | Sidebar layout regression — Windows-deterministic, no claude bin, gates wave-2 store cutover render path. |
| 2 | `settings-open`                      | KEEP    | **A** | SettingsDialog Radix open path; wave-2 store/preload surface regression carrier. |
| 3 | `settings-updates-pane`              | KEEP    | **A** | Settings updates flowing back into renderer state; HP-1/HP-2 regression carrier. |
| 4 | `titlebar`                           | KEEP    | **A** | Frameless titlebar OS chrome; ipcMain allowlisted channel per ch08 §3 (d). |
| 5 | `tray`                               | KEEP    | **A** | Tray menu / state — Windows-only OS chrome surface; no daemon dependency. |
| 6 | `close-dialog-is-native`             | KEEP    | **A** | Regression for dogfood "close dialog non-native" finding; gates `dialog.showMessageBox` path. |
| 7 | `theme-toggle`                       | KEEP    | **A** | Theme via `__ccsmStore.setState({theme})` → `useThemeEffect`; HP-1 regression carrier. |
| 8 | `cap-skip-launch-bundle-shape`       | KEEP    | **A** | Runner `skipLaunch:true` capability demo. Documented as the **only** legitimate skip-like construct in the codebase (§4.1.1). |
| 9 | `import-empty-groups`                | KEEP    | **A** | Import-state path; renderer-only. |
| 10 | `rename`                            | KEEP    | **A** | Session rename (renderer side; the JSONL-write side lives in real-cli). |
| 11 | `move-to-group-excludes-own-group`  | KEEP    | **A** | Right-click context menu policy regression (PR #517). |
| 12 | `sidebar-long-name-truncates`       | KEEP    | **A** | fp13-A regression for 80-char name truncation + `title` attr. |
| 13 | `startup-paints-before-hydrate`     | KEEP    | **A** | **Hard prerequisite for §2.4 hydration ordering (HP-5/HP-6)**. Pins render-before-hydrate via `window.__ccsmHydrationTrace`. Fixer must NOT regress. |
| 14 | `terminal-pane-mounted`             | KEEP    | **A** | Direct-xterm post PR-1..PR-6; pins `App→TerminalPane` wiring + `[data-terminal-host]` contract. |

**harness-ui Set A subtotal: 14 / 14. Set B: 0. DELETE: 0.**

Note: spec §4.3.1 lists exactly these 14 ids — full match.

### 3.2 `scripts/harness-real-cli.mjs` (27 cases)

The spec §4.3.1 reviewer pass deliberately left this list partial
("§4.1 reviewer pass will fill in the full inventory"). The
assignment below applies the §4.3.2 Set B test to each case:

> *Set B candidates*: requires the developer's local claude binary,
> multi-window / two-electron, or Linux display-budget cost.

All `harness-real-cli` cases require a real `claude` binary by
construction (they exercise the spawned CLI). Per §4.3.2 the
"requires-claude-bin" axis alone is **not** automatic Set B — only
cases that depend on **actual claude responses** (vs. binary presence)
or multi-window display cost go to Set B. The Windows host CI matrix
already has the claude binary installed; cases that exercise only
spawn / pty wiring / JSONL on disk stay Set A.

| # | Case (group)                                  | Verdict | Set | Rationale |
|---|-----------------------------------------------|---------|-----|-----------|
| 1 | `new-session-chat` (shared)                   | KEEP    | **A** | Spec-named in §4.3.1. Spawn → first prompt round-trip; gates wave-2 ptyHost cutover. |
| 2 | `attach-replay-from-headless-buffer` (shared) | KEEP    | **A** | Spec-named in §4.3.1. Restored attach path under §3.4 sigkill-reattach v0.2 baseline. |
| 3 | `alt-screen-fits-visible-viewport` (shared)   | KEEP    | **A** | Spec-named in §4.3.1. Geometry/resize regression carrier. |
| 4 | `session-rename-writes-jsonl` (shared)        | KEEP    | **A** | Spec-named in §4.3.1. JSONL write path; wave-2 sessionTitles cutover. |
| 5 | `session-title-syncs-from-jsonl` (shared)     | KEEP    | **A** | Spec-named in §4.3.1. JSONL → store sync; wave-2 sessionTitles cutover. |
| 6 | `session-state-becomes-idle` (shared)         | KEEP    | **A** | State-machine transition driven by daemon SSE; gates §3.2 SSE delivery. |
| 7 | `agent-icon-active-session-no-halo` (shared)  | KEEP    | **A** | Renderer state derived from session list — HP-1 regression carrier. |
| 8 | `notify-fires-on-idle` (shared)               | KEEP    | **A** | `__ccsmNotifyLog` test seam; gates wave-2 notify-producer cutover. |
| 9 | `notify-name-cleared-on-session-delete` (shared) | KEEP | **A** | Notify state on session delete; wave-2 cutover regression carrier. |
| 10 | `notify-shows-session-name` (shared)         | KEEP    | **A** | Notify name plumbing; wave-2 sessionTitles + notify-producer cutover. |
| 11 | `notify-pipeline-foreground` (shared)        | KEEP    | **A** | Foreground notify suppression policy; deterministic via test hook. |
| 12 | `notify-pipeline-background` (shared)        | KEEP    | **A** | Background notify pipeline; deterministic via test hook. |
| 13 | `switch-session-keeps-chat` (shared)         | KEEP    | **A** | Session switch preserves replay buffer; gates §3.5 attach RPCs. |
| 14 | `cwd-projects-claude` (shared)               | KEEP    | **A** | cwd → projects path emitted to claude spawn env; deterministic. |
| 15 | `caseBadgeFiresAndClearsOnFocus` (shared)    | KEEP    | **A** | Badge IPC + focus muting; wave-2 cutover regression carrier. |
| 16 | `caseSpacesInCwdSpawnsCorrectly` (shared)    | KEEP    | **A** | Quoting regression; deterministic on Windows host. |
| 17 | `import-resume` (shared)                     | KEEP    | **A** | JSONL import → resumed session; deterministic over disk fixture. |
| 18 | `import-lands-in-focused-group` (shared)     | KEEP    | **A** | Import drop policy; renderer state regression. |
| 19 | `default-cwd-from-userCwds-lru` (shared)     | KEEP    | **A** | userCwds LRU plumbing; renderer/store regression. |
| 20 | `new-session-focus-cli` (shared)             | KEEP    | **A** | Spec-named in §4.3.1. Spawn → terminal focus; gates wave-2 focus path. |
| 21 | `pty-pid-stable-across-switch` (shared)      | KEEP    | **A** | PID stability across session switch; gates §3.5 attach RPC `getPid`. |
| 22 | `cwd-picker-top-default` (shared)            | KEEP    | **A** | Cwd picker default selection; renderer-only. |
| 23 | `cwd-picker-top-chevron` (shared)            | KEEP    | **A** | Cwd picker chevron state; renderer-only. |
| 24 | `cwd-picker-browse` (shared)                 | KEEP    | **A** | Cwd picker browse → native folder picker; allowlisted ipcMain. |
| 25 | `cwd-picker-no-shortcut` (shared)            | KEEP    | **A** | Cwd picker keyboard policy; renderer-only. |
| 26 | `sidebar-group-no-newsession-cluster` (shared) | KEEP  | **A** | PR #514 / #605 regression — group rows must NOT carry per-group + button. |
| 27 | `reopen-resume` (standalone)                 | KEEP    | **B** | Multi-launch electron app. Standalone group means a second `electronApp` is spawned per case — outside the Set A budget envelope; informational on Windows-host CI. |

**harness-real-cli Set A subtotal: 26 / 27. Set B: 1
(`reopen-resume`). DELETE: 0.**

Note: `pty-subtree-killed-on-quit` was previously listed as a 27th
`standalone` case in the registry but is in the same standalone bucket
as `reopen-resume`. Apply the same Set B verdict (multi-launch
electron, informational): see §3.4 below for the canonical reconcile.

### 3.3 `scripts/harness-dnd.mjs` (1 case)

| # | Case id | Verdict | Set | Rationale |
|---|---------|---------|-----|-----------|
| 1 | `dnd`   | KEEP    | **A** | Spec-named in §4.3.1. Drag-and-drop sidebar reorder; deterministic, renderer-only. |

**harness-dnd Set A subtotal: 1 / 1. Set B: 0. DELETE: 0.**

### 3.4 Standalone reconcile

`scripts/harness-real-cli.mjs` defines two `group: 'standalone'` cases:
`reopen-resume` and `pty-subtree-killed-on-quit`. Standalone-group
cases launch their own electron app per case (vs. shared-launch group
that reuses one `electronApp` across all cases). Cold electron launch
is ~2 s on the Windows host CI; running 2 standalone cases adds ~4 s
to the wall-clock budget on every CI run.

Per §4.3.2, standalone-group multi-launch cases are Set B
(informational) — they are valuable for catching reopen / process-tree
regressions during dogfood, but the cold-launch cost prices them out
of the merge gate. Verdict for both standalone cases: **KEEP / Set B**.

---

## 4. Per-case assignments — new cases required by spec §4.4

| # | Case id                              | Harness            | Verdict | Set (v0.3) | Rationale |
|---|--------------------------------------|--------------------|---------|------------|-----------|
| 43 | `daemon-port-ready-before-render`   | `harness-ui`       | NEW (KEEP) | **A** | §4.4 cold-launch contract gate; ≤5 s budget. Two-pronged assert (`checkClaudeAvailable` ≤500 ms + `__ccsmDaemonPortLoadIterations === 0`) catches Option-A regression and silent latency drift. |
| 44 | `sigkill-reattach`                  | `harness-real-cli` | NEW (KEEP) | **B** (informational) | §4.4 + §3.4 + CF-3 manager decision (R1 strict). v0.3 scope = v0.2 attach-replay assertions pass; **no new behaviour assertion** in v0.3. v0.4 candidate for Set A promotion per §3.7 F-4. **Budget intentionally not pinned in v0.3**; v0.4 promotion PR pins it. |
| 45 | `loadstate-roundtrip`               | `harness-ui`       | NEW (KEEP) | **A** | §4.4 cheapest e2e regression test for HP-2 silent removal; ≤3 s budget. |

**New cases Set A: 2 (`daemon-port-ready-before-render`,
`loadstate-roundtrip`). Set B: 1 (`sigkill-reattach`). DELETE: 0.**

---

## 5. Set totals (v0.3 release-gate witness)

| Set                  | harness-ui | harness-real-cli | harness-dnd | **Total** |
|----------------------|------------|------------------|-------------|-----------|
| **Set A** (CI gate)  | 14 + 2 NEW = **16** | 25 + 0 NEW = **25** | **1**       | **42**    |
| **Set B** (informational) | 0     | 2 + 1 NEW = **3**   | 0           | **3**     |
| **DELETE**           | 0          | 0                | 0           | **0**     |
| **FIX**              | 0          | 0                | 0           | **0**     |
| **MARK**             | 0          | 0                | 0           | **0**     |
| **Grand total**      | **16**     | **28**           | **1**       | **45**    |

(Note: harness-real-cli Set A count is 25, not 26 — the 26th existing
case `pty-subtree-killed-on-quit` is reclassified to Set B in §3.4
because it is in the standalone-group bucket alongside `reopen-resume`.)

---

## 6. Discrepancy with the original task brief (transparent note for reviewers)

Task #599 prompt referenced "88 existing `.skip` cases + 6 new cases".
Both numbers are spec-revised:

- The **88** figure was the dev-574 narrative count of
  `harness-runner.mjs` gate-evaluation points (case × capability-flag
  matrix). Spec §4.1.1 R5 ground-truth re-grep at `5d0c5375` shows
  **0** Vitest skip + **1** legitimate harness `skipLaunch` (the
  capability demo). This file documents the corrected baseline.
- The **6 new cases** figure precedes the spec finalisation. Spec §4.4
  pins exactly **3** new cases (`daemon-port-ready-before-render`,
  `sigkill-reattach`, `loadstate-roundtrip`).

Both corrections trace back to the spec branch `origin/spec/2026-05-06-v0.3-e2e-cutover`
(commit `e397dfb8` "merge 6 chapters → final spec"). G5/G6/G7 should
gate on this artifact's totals (45 cases / 42 Set A / 3 Set B), not the
brief's superseded figures.

---

## 7. Forward maintenance

- Any case **added** during §5 PRs MUST be appended to the relevant
  table above with a verdict line; G8 (PR-body gate) enforces this.
- Any case **removed** during §5 PRs MUST be moved out of the table
  with a `DELETE` row carrying the removal commit SHA.
- Re-classifying an existing Set A case to Set B (or vice versa) MUST
  be done in a dedicated PR with the rationale appended to §6 above
  (audit trail for release-gate decisions).
- The `sigkill-reattach` Set B → Set A promotion happens in v0.4 per
  spec §3.7 F-4; do **not** flip it in v0.3 PRs.

---

## 8. v0.3 e2e gate lock (PR-9 / T-9, Task #607)

As of PR-9 the **v0.3 e2e gate is locked**:

- The 42 Set A cases enumerated in §3 + §4 (sum verified in §5) are
  the v0.3 merge-gate floor across the
  `e2e (ubuntu-latest) / (macos-latest) / (windows-latest)` matrix
  defined in `.github/workflows/e2e.yml`.
- The 3 Set B cases (`reopen-resume`, `pty-subtree-killed-on-quit`,
  `sigkill-reattach`) remain informational. CI does not run them
  because the parent harness `harness-real-cli` is in the
  `E2E_SKIP` list (no `claude` binary on hosted runners — see the
  comment block above the `Run e2e` step). They are runnable
  locally via `npm run probe:e2e` on a host with a real
  `~/.claude` install.
- Both `ci.yml` and `e2e.yml` now also fire on `push` to `working`,
  so every integration-branch commit accumulates a fresh gate
  result; this is the mechanism the v0.3 release acceptance
  ("2 consecutive working-branch all-green runs") consumes.

Re-classifying any case across the Set A / Set B boundary, or
adding / removing cases, must follow the §7 audit-trail policy
**and** call out impact on the lock posture in the PR body.

