# CI matrix direction audit — Task #17 stall

> Research-only. No code changes. Data + tradeoff matrix only. User picks direction.
>
> Scope: Task #17 (T0.8 CI matrix), PR #906 (`dev/t0.8-ci-matrix`), `.github/workflows/ci.yml`
> Generated: 2026-05-03
> Author agent: Task #200 research (pool-3)

---

## §1 PR #906 failure history

PR: [#906](https://github.com/Jiahui-Gu/ccsm/pull/906) `feat(ci): T0.8 — proto-gen-and-lint + 3-OS test matrix` — currently DRAFT, 21 commits, branch `dev/t0.8-ci-matrix`.
Branch ran **23 GitHub Actions runs** between `2026-04-29T15:36Z` and `2026-05-03T08:14Z` (~3.7 days wallclock). Conclusion mix: **9 failure / 7 success / 4 cancelled / 3 in_progress-or-other**.

### §1.1 Run-by-run table (failed runs only — top 10 most informative)

OS column = which OS leg failed in that run. "Failure class" buckets: `env` (toolchain / image / install / rebuild), `code` (real source bug), `flake` (intermittent / retry-passes), `timeout` (hard step timeout / hang), `infra` (runner outage, disk, fsync).

| # | Run ID | Created (UTC) | Commit | OS leg(s) failed | Failed step | Failure class | How fixed (per task / commit log) |
|---|--------|---------------|--------|-------------------|-------------|---------------|----------------------------------|
| 1 | 19014... (early) | 2026-04-29 ~15:40 | 1st push | ubuntu+mac+win | `pnpm install` / proto-gen | env (CRLF + .gitattributes) | Task #176 — added `.gitattributes` LF normalisation, `core.autocrlf=false` step |
| 2 | (mid Apr 30) | 2026-04-30 | post-#176 | windows | `electron-rebuild` | env (winpty / native-module ABI) | Task #176 follow-up — `npm_config_node_gyp` pin + msvs_version |
| 3 | (Apr 30 late) | 2026-04-30 | post-rebuild fix | macos | `pnpm run sign:mac` | code (platform guard missing) | Task #197 — wrapped sign-scripts in `if: runner.os == 'macOS'` |
| 4 | (May 1 AM) | 2026-05-01 | post-#197 | windows | `test (windows-latest)` → `crash-raw.spec` | timeout (step-level >10min, fsync cost) | Task #198 — bumped vitest timeout, marked `crash-raw` as `.skipIf(win)` for PR-CI |
| 5 | (May 1 PM) | 2026-05-01 | post-#198 | ubuntu | `proto-gen-and-lint` | env (buf binary cache miss) | inline fix — pinned `bufbuild/buf-setup-action@v1` SHA |
| 6 | (May 2 AM) | 2026-05-02 | rebase onto working | all 3 OS | merge conflict in `pnpm-lock.yaml` | code (rebase) | Task #199 dispatched, rebased + regenerated lock |
| 7 | (May 2 mid) | 2026-05-02 | post-rebase | windows | `electron-rebuild` | env (re-emerged after lock regen) | re-applied #176 fix on top of rebase |
| 8 | (May 2 PM) | 2026-05-02 | retry | macos | flake — `notarize` smoke step (network) | flake | retry, no code change |
| 9 | (May 3 early) | 2026-05-03 04–05 | green-eligible | windows | flake — disk I/O timeout in `tsc -b` | infra (GH Win runner fsync) | retry — eventually passed at run 19084xxx |

> **Final green run** (3-OS all green) reached on 2026-05-03 around 06:00 UTC. PR then transitioned to draft (parked) at user direction.

### §1.2 Aggregates

- **Branch wallclock CI minutes (sum of all runs, all OS legs combined):** ~ **840 wallclock-min** across the branch lifetime. Per run avg ≈ 36 min when all 3 OS legs run. macOS leg dominates per-run cost (≈14–18 min); Windows leg next (≈10–14 min); Ubuntu leg cheapest (≈4–6 min).
- **Time-to-first-green:** **~3 days, 14 hours** from first push to first all-OS-green. >70% of that wallclock was waiting on OS-specific re-runs.
- **Distinct failure classes hit:** env (4×), timeout (1×), flake (2×), code (2×, both rebase-induced).
- **Failure ownership (which OS host caused at least one fix-cycle):** windows ×4, macos ×2, ubuntu ×1.

> *Caveat:* exact run IDs / commit SHAs are present in `.tmp_runs.json` and `.tmp_failures.txt` artifacts the agent collected; the table above clusters them into the 9 distinct fix-cycles for readability. Raw per-run data is in branch artifacts — not committed (transient).

---

## §2 Per-OS pain breakdown

| OS | Distinct fix-cycles attributable to this OS | Dominant failure class | Representative bugs (Task / commit) | Approx CI-min burned on this OS leg across PR #906 |
|----|---------------------------------------------|------------------------|--------------------------------------|----------------------------------------------------|
| **windows-latest** | 4 | env (native-module / electron-rebuild) + infra (fsync) | #176 CRLF + ABI; #198 crash-raw timeout; winpty; GH Windows VM disk slow | ≈ 280 wallclock-min |
| **macos-latest** | 2 | code (platform-guard) + flake (notarize/network) | #197 sign-scripts platform guard; notarize-smoke flake | ≈ 230 wallclock-min |
| **ubuntu-latest** | 1 | env (buf cache miss) — single inline fix | proto-gen-and-lint buf-setup pin | ≈ 100 wallclock-min |
| (cross-OS, not OS-specific) | 2 | code (rebase) | #199 rebase / lock regen | n/a |

Cross-references:
- **Task #176** ("CI: pnpm install + electron-rebuild + CRLF on Windows") → fixed Windows-only ABI / CRLF.
- **Task #197** ("CI: macOS sign-scripts platform guard") → fixed macOS-only run.
- **Task #198** ("CI: windows crash-raw timeout") → Windows-only flake.
- **Task #199** (now deleted) — rebase-only, unblocked merge.
- **Task #944** — earlier ci.yml refactor (referenced in MEMORY but not in current branch HEAD log).
- **Task #16 / PR #872** — self-hosted Windows runner (T0.10) — see §5d.

**Headline:** Windows is the dominant cost center (4/7 fix-cycles, ~33% of wallclock minutes). macOS is the second cost center driven by signing/notarize platform-only paths. Ubuntu is essentially free.

---

## §3 Hot-step audit (current `.github/workflows/ci.yml`, post-#192 HEAD)

> Source: `.github/workflows/ci.yml` at `origin/working` (read-only).

Workflow exposes three jobs: `proto-gen-and-lint`, `lint-and-typecheck`, and `test (matrix os = ubuntu-latest, macos-latest, windows-latest)`. Branch-protection on `working` requires (per `.tmp_protection.json`): `required_status_checks` = strict, `contexts` includes the matrix legs as required.

| Step in `test (<os>)` | Coverage / purpose | Single-OS sufficient? | Could move to nightly? | Required by branch protection? |
|----------------------|---------------------|------------------------|-------------------------|--------------------------------|
| `actions/checkout` + `setup-node` + `pnpm/action-setup` | toolchain bootstrap | n/a (per-OS) | no | no (implicit) |
| `pnpm install --frozen-lockfile` | dep install — exercises native-module postinstall on each OS | **NO** — Windows/macOS native-module postinstall is the actual coverage value | partial — could keep ubuntu+mac PR, win nightly | yes (transitively) |
| `electron-rebuild` (Win/mac only) | rebuild native deps for Electron ABI | **NO** — only meaningful on Win/mac | win-only could go to nightly | not directly |
| `pnpm run proto-gen-and-lint` | proto + buf lint — pure deterministic | **YES** — ubuntu only | n/a (already cheap) | yes (ubuntu) |
| `pnpm -r run lint` | eslint — pure deterministic | **YES** — ubuntu only | n/a | yes (ubuntu) |
| `pnpm -r run typecheck` | tsc -b — deterministic but exercises path-sep / case-sensitivity | mostly — ubuntu+mac would catch case-sensitivity bugs missed by win | could keep ubuntu+mac PR, win nightly | yes |
| `pnpm -r run test:unit` | vitest unit | mostly — ubuntu catches >90%; mac/win catch fs/path edge cases | mac/win → nightly viable | currently yes |
| `pnpm -r run test:integration` (incl. `crash-raw.spec`, sign-scripts smoke) | OS-conditional behaviour (signing, fs, native-mod) | **NO** — this is the actual reason the matrix exists | partial: macOS sign-smoke + win crash-raw → nightly viable | currently yes |
| `pnpm run sign:mac --dry-run` (mac only) | sign-scripts smoke | mac-only by design | could go nightly + release | currently yes |
| Upload artifacts (logs, screenshots) | diagnostics | n/a | n/a | no |

**Reading:** the only steps that *genuinely require* multi-OS PR-CI are (a) `electron-rebuild` (Win+mac) and (b) the OS-conditional integration smokes (sign:mac, crash-raw on Win). The rest of the matrix burn is **the same lint/typecheck/unit work duplicated 3×**. Roughly **60–70% of windows+macos PR-CI minutes are duplicate work** that ubuntu already covers.

---

## §4 Runner economics

`gh api /repos/Jiahui-Gu/ccsm/actions/usage` → response saved at `.tmp_usage.json`. **Permission sufficient** (200 OK), payload reports billable minutes per OS for the org, but the *repo-scope* endpoint returns `total_minutes_used: 0` for non-billable accounts (this repo is on a personal Free/Pro plan where private-repo billing reports as `total_minutes_used` only when budget is exceeded). Result: **API gives no useful per-PR breakdown** — fall back to wallclock estimates from §1.

Estimated PR-CI cost per push (one full matrix run) using GH's standard cost multipliers (linux=1×, win=2×, mac=10×):

| Leg | Wallclock min/run | Cost multiplier | Billable-min/run |
|-----|-------------------|-----------------|-------------------|
| ubuntu-latest | ~5 | 1 | 5 |
| windows-latest | ~12 | 2 | 24 |
| macos-latest | ~16 | 10 | 160 |
| **total / push** | **~33** | — | **~189 billable-min** |

Per the §1 history (23 runs, ~9 of which fully ran 3-OS to completion before being superseded), PR #906 alone burned an estimated **~1,700 billable-min ≈ 28 billable-hours**, dominated almost entirely by the macOS leg's 10× multiplier.

For comparison, an ubuntu-only PR-CI would have cost **~115 billable-min** for the same 23 runs (~7% of the actual spend).

---

## §5 Alternative directions (5 options, no recommendation)

> Each option lists scope, pros, cons, blast-radius for v0.3 ship goal (Electron thin + daemon fat, Connect-RPC over loopback, single-tag release, dogfood metrics). v0.3 hard blocker remains minisign signing — every option below is compatible with that.

### §5a Status-quo: keep 3-OS PR-CI, push #906 to merge
- **Scope:** finish #906; reuse current ci.yml; no design change.
- **Pros:** all v0.3 dogfood metrics validated on the OS the user actually ships; no dependency on nightly cadence to catch regressions; compatible with #15 (T0.9 package job) which assumes mac/win artifacts gate-checked on PR.
- **Cons:** every future PR pays ~189 billable-min + macOS flake lottery; recurrence of #176/#197/#198-class bugs is statistically certain; user has empirically already burned 6+ hours on this single PR.
- **Blast radius for v0.3:** zero (already the assumed plan). Cost: ongoing dev-hours tax.

### §5b Drop windows from PR-CI; nightly-only Windows
- **Scope:** ci.yml `matrix.os: [ubuntu-latest, macos-latest]`; new `.github/workflows/nightly.yml` (already exists per glob) gains a windows leg; required-status-checks updated to drop `test (windows-latest)`.
- **Pros:** removes the dominant fix-cycle bucket (4/7 historical) and ~24 billable-min/PR; keeps macOS PR-coverage for sign-scripts and ABI; Windows still validated daily.
- **Cons:** Windows-only regressions ship to `working` and only caught next morning; revert pressure on whoever pushes daytime; T0.9 package job (#15) needs adjustment if it gates on PR-CI windows artifact.
- **Blast radius for v0.3:** small. v0.3 ships from `release/v0.3` tag with a release-gate run that re-includes windows; daily nightly catches Windows regression within 24h. Compatible with `bundles dogfood` metric on Windows (validated via nightly + release tag).

### §5c Lite PR-CI (lint+typecheck+unit, ubuntu only); e2e + integration → nightly + release
- **Scope:** PR-CI = single `lint-typecheck-unit (ubuntu-latest)` job + `proto-gen-and-lint`; integration / sign-smoke / crash-raw / electron-rebuild → nightly + release-tag workflow.
- **Pros:** cheapest possible PR-CI (~5 billable-min/push, ~38× cheaper); fast feedback loop; matches the §3 finding that 60–70% of matrix work is duplicate lint/tsc/unit.
- **Cons:** all OS-specific bug classes are nightly-detected, not PR-blocked; integration regressions live in `working` until next nightly + revert; needs disciplined nightly-failure triage (cron tick already in MEMORY); high risk that v0.3 ship gate finds late-stage regressions.
- **Blast radius for v0.3:** medium-high. Increases risk of late OS-specific regression discovery during v0.3 ship freeze; requires hardening release-tag CI to compensate. Compatible with `zero-rework` rule only if release-tag CI is treated as the real quality gate.

### §5d Self-hosted Windows runner (Task #16 / PR #872)
- **Scope:** revive PR #872 (currently per `.tmp_pr872_body.json`: state = `OPEN`, branch `dev/t0.10-self-hosted-windows`, last activity stale; provisions a single Win11 runner via `actions-runner` service on user's hardware). PR-CI windows leg moves from GH-hosted `windows-latest` to self-hosted; matrix unchanged otherwise.
- **Pros:** GH `windows-latest` fsync / disk-virt cost goes away (the §1.1 row 9 infra-class flake disappears); per-PR billable-min for windows drops to 0; warm pnpm/electron-rebuild caches make windows leg the *fastest*, not slowest, leg.
- **Cons:** single point of failure (one machine, user's box); security surface (untrusted PR code on user hardware — GH best practice is **don't run self-hosted on public repo PRs**, repo is private so OK); maintenance burden; Task #872 is stale and was not merged — provisioning state unverified; runner offline → all PRs blocked.
- **PR #872 reuse status:** body indicates installer scripts + systemd-equivalent unit committed; **not verified the runner currently registers**; would need fresh smoke-test before relying on it.
- **Blast radius for v0.3:** medium. Moves Windows risk from "rare but expensive flake" to "rare but total outage." Acceptable if user accepts owning the box; incompatible if user wants v0.3 ship to be machine-independent.

### §5e Single-OS PR-CI default + opt-in `run-full-matrix` label
- **Scope:** default PR-CI = ubuntu only; PR labelled `run-full-matrix` (or path-filter on Win/mac-relevant files: `apps/electron/**`, `scripts/sign*`, `**/*.gyp`) triggers full 3-OS matrix.
- **Pros:** day-to-day PRs (proto, daemon, docs, hooks) pay ubuntu-only cost (~5 billable-min); risky PRs explicitly opt in; zero infra change beyond ci.yml `if:` guards.
- **Cons:** label-discipline failures → Win/mac bugs ship; path-filter needs careful curation (false-negative if a transitive dep changes); branch protection must allow ubuntu-only as the gate (relaxes §1 protection contexts).
- **Blast radius for v0.3:** small-medium. v0.3 ship-gate workflow can hard-require full matrix on `release/v0.3` regardless of label. Compatible with current branch-protection model if `working` accepts ubuntu-only and `release/*` tightens. Aligns with `night-shift` philosophy in MEMORY (manual gating).

---

## §6 Downstream task impact

Which open tasks (and their assumed CI shape) survive each direction:

| Task / spec | Assumed PR-CI shape | Survives §5a (status-quo)? | Survives §5b (no win on PR)? | Survives §5c (lite PR-CI)? | Survives §5d (self-hosted win)? | Survives §5e (label opt-in)? |
|-------------|---------------------|---------------------------|-------------------------------|----------------------------|----------------------------------|------------------------------|
| **#15 T0.9 package job** (build mac+win+linux artifacts) | Needs *some* CI to produce win+mac artifacts | yes | yes (nightly produces) | yes (nightly produces) | yes (uses self-hosted win) | yes (full matrix on label/release) |
| **#89 T8.7 claude-sim** | ubuntu-only (TS test runner) | yes | yes | yes | yes | yes |
| **#90 T8.9 integration spec** | needs daemon spawn on at least one OS; today implicitly mac+linux | yes | yes | **degraded** — integration → nightly | yes | yes if labelled |
| **#96 T8.12 no-jwt bundle** | ubuntu-only (build/lint check) | yes | yes | yes | yes | yes |
| **#98 T8.14 coverage** | needs unit tests on >=1 OS, ideally all 3 for fs-coverage | yes | yes (mac PR + win nightly) | **degraded** — coverage from nightly-only Win/mac | yes | yes if labelled |
| **#128 T10.12 buf breaking** | ubuntu-only (`buf breaking`) | yes | yes | yes | yes | yes |
| **#16 T0.10 self-hosted runner** | n/a (is the infra) | parallel | parallel | parallel | **becomes critical path** | parallel |

**Summary:**
- §5a / §5b / §5d / §5e — **all 7 tracked downstream tasks survive** with no spec change.
- §5c — **#90 and #98 require spec amendment** (integration + coverage assumptions move from PR-blocking to nightly-blocking).

---

## §7 Appendix — raw artefacts (transient, not committed)

The agent wrote the following local artefacts during data collection (under `.tmp_*` in worktree root, gitignored — *not* part of this PR):

- `.tmp_runs.json` — full `gh run list --branch dev/t0.8-ci-matrix --limit 50` payload
- `.tmp_runs_parsed.txt` — per-run wallclock + conclusion table
- `.tmp_failures.txt`, `.tmp_jobs.txt`, `.tmp_logs.txt` — per-failed-run job/step/error excerpts
- `.tmp_pr906.json`, `.tmp_pr906_comments.json`, `.tmp_pr906_body.json` — PR #906 metadata
- `.tmp_pr872_body.json` — PR #872 (self-hosted Win runner) body
- `.tmp_issues.txt` — issues #15, #16, #17, #89, #90, #96, #98, #128, #176, #197, #198, #199, #944
- `.tmp_protection.json` — `working` branch protection rules
- `.tmp_usage.json` — actions usage API response (unhelpful, see §4)

Re-run the harness to refresh these — none are load-bearing for the report itself.

---

*End of report. No recommendation included by design (per Task #200 brief). User to pick from §5a–§5e.*
