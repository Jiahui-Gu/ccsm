# CI / PR pipeline speedup audit (Task #502, v0.3 P0)

**Date**: 2026-05-05
**Author**: Task #502 (audit only — no behavior changes)
**Scope**: 4 PR-triggered workflows + 3 non-PR workflows enumerated for context
**Source data**: `gh run list / view` over the most recent ~30 PR runs on `working` (post-Task #489 split, 2026-05-05). Per-job step timestamps via `gh api repos/:owner/:repo/actions/runs/<id>/jobs`.

---

## 1. Workflow inventory

| Workflow | Trigger | OS matrix | PR-blocking? | Status |
|---|---|---|---|---|
| `ci.yml` | `pull_request` (main, working) + `workflow_dispatch` | mixed (see jobs below) | yes — required checks | **in scope** |
| `e2e.yml` | `pull_request` (paths-filter on `electron/**` `src/**` `scripts/**` `package*.json`) | windows-latest | yes (when paths match) | **in scope** |
| `main-source-guard.yml` | `pull_request` (main only) | ubuntu-latest | yes for main PRs | **in scope** (trivial) |
| `pr-no-silent-drops.yml` | `pull_request` (opened/reopened/synchronize) | ubuntu-latest | yes | **in scope** (trivial) |
| `installer-roundtrip.yml` | `workflow_dispatch` only | win/mac/linux | no | out of scope |
| `pty-soak.yml` | `workflow_dispatch` + nightly schedule | self-hosted | no | out of scope |
| `release.yml` | tag push | n/a | no | out of scope |

The 4 PR-blocking workflows fan out into ~13 independent jobs. Wall-clock = max of slowest job (because all jobs run in parallel after `detect changes` gate).

---

## 2. Per-workflow + per-job durations (P50 / P95)

Sample window: 10 most recent successful runs as of 2026-05-05 07:50 UTC. Cache state for these runs is **mostly hit** — only a couple of cold-cache cases. Numbers in seconds, rounded to 5s.

### 2.1 `ci.yml` — total wall-clock

| Run id | wall (s) | event | notes |
|---|---|---|---|
| 25364366583 | 343 | PR (post-#489 split) | warm cache |
| 25364217869 | **1125** | PR | cold cache + ch15 enforcement queueing 15min later (outlier — ch15 enforcement re-queued by GitHub) |
| 25364153942 | 332 | PR | warm cache |
| 25364110472 | 498 | PR (pre-#489 monolithic job in this run) | warm cache, monolithic 488s |
| 25363574494 | 518 | PR (pre-#489) | warm |
| 25363010530 | 510 | PR (post-#489 first run) | warm |
| 25362773224 | 514 | PR (pre-#489) | warm |
| 25361198699 | 484 | PR (pre-#489) | warm |
| 25360485097 | 458 | PR (pre-#489) | warm |
| 25359810085 | 515 | PR (pre-#489) | warm |

**ci.yml wall — post-Task #489 split (n=3 representative)**: P50 ≈ **335s** (5m35s), P95 ≈ **510s** (8m30s) when cold-cache.
**ci.yml wall — pre-#489 monolithic (n=6, baseline)**: P50 ≈ **510s** (8m30s), P95 ≈ **520s**.

Task #489 already saved roughly **3 minutes** off P50 by parallelizing lint/typecheck/test on 3 windows runners. The audit takes that as the new baseline.

### 2.2 `ci.yml` — per-job durations (post-#489, warm cache, n=3)

| Job | OS | P50 (s) | P95 (s) | Cache state |
|---|---|---|---|---|
| `detect changes` | ubuntu-latest | 5 | 8 | n/a |
| `lint (windows-latest)` | windows-latest | **118** | 143 | nm-cache hit |
| `typecheck (windows-latest)` | windows-latest | **89** | 121 | nm-cache hit |
| `test (windows-latest)` | windows-latest | **326** | 510 (cold install) | nm-cache hit; 162s install on cold |
| `ch15 §3 enforcement` | windows-latest | 220 | 393 (re-queue outlier) | pnpm cold install ~30s every run |
| `sea-smoke (ubuntu-22.04)` | ubuntu-22.04 | 90 | 95 | pnpm cold install |
| `sea-smoke (macos-14)` | macos-14 | 50 | 80 | pnpm cold install |
| `sea-smoke (windows-latest)` | windows-latest | 220 | 235 | pnpm cold install |
| `package (linux-deb-rpm)` | ubuntu-22.04 | 95 | 100 | pnpm cold install + apt install fpm/rpm |
| `package (mac-pkg)` | macos-14 | 50 | 80 | pnpm cold install |
| `package (win-msi)` | windows-latest | 195 | 220 | pnpm cold install + `dotnet tool install wix` ~25s |

**Critical path (PR wall)** = max(`test`, `ch15`, `sea-smoke (windows)`, `package (win-msi)`) ≈ **325-340s** warm, **500-520s** cold-install on the test job. Everything else finishes inside the test job's window.

### 2.3 `ci.yml` — `test` job step breakdown (warm-cache, run 25364366583)

| Step | duration (s) |
|---|---|
| Set up job + checkout | 9 |
| Check v0.2 shrinking | 11 |
| Setup Node | 10 |
| Check spec-code lock | 1 |
| Setup Python | 1 |
| **Cache node_modules (restore)** | **23** |
| Install deps (skipped — cache hit) | 0 |
| Rebuild better-sqlite3 + verify ABI | 4 |
| **Build (`npm run build:app`)** | **73** |
| **Test (with coverage)** | **119** |
| Test (tools/**/*.spec.ts) | 16 |
| Upload coverage artifact | 1 |
| Install daemon devDeps (`@connectrpc/connect-node`) | 4 |
| Generate inlined migrations payload | 0 |
| **Coverage (daemon, vitest+coverage rerun)** | **32** |
| Install electron devDeps (`happy-dom`) | 7 |
| **Coverage (electron renderer, vitest+coverage rerun)** | **9** |
| Post-cache + cleanup | 3 |
| **Total** | **326** |

Hot spots inside the test job, in order: **test+coverage 119s → build 73s → daemon coverage 32s → cache restore 23s → tools spec 16s → electron coverage 9s**.

### 2.4 `e2e.yml` — wall + step breakdown

10 most recent successful e2e runs:

| Run id | wall (s) |
|---|---|
| 25364366587 | 174 |
| 25364153941 | 359 (cold cache — install ran) |
| 25364024303 | 425 (cold) |
| 25363994302 | 286 (cold) |
| 25359358338 | 159 |
| 25357105788 | 333 (cold) |
| 25334589011 | 398 (cold) |
| 25331855980 | 373 (cold) |

**P50 ≈ 333s, P95 ≈ 425s.** `nm-e2e-` cache hit far less reliably than ci.yml's `nm-` cache (different key prefix, see §4 critical finding).

Step breakdown for warm-cache e2e (run 25364366587, total 171s):

| Step | duration (s) |
|---|---|
| Set up job + checkout | 5 |
| setup-python | 1 |
| setup-node | 9 |
| Cache node_modules (restore, 350MB+) | 21 |
| Cache Electron binary | 1 |
| Install deps (skipped) | 0 |
| Ensure Electron binary | 28 |
| Ensure native modules built for Electron ABI (`npx electron-rebuild`) | 6 |
| **Build (`npm run build:app`)** | **28** |
| **Run e2e (`npm run probe:e2e`)** | **66** |
| Post-cache | 4 |
| **Total** | **171** |

The e2e probe itself only takes 66s — 60% of e2e wall is overhead (cache, electron binary, native rebuild, build).

### 2.5 `main-source-guard.yml` and `pr-no-silent-drops.yml`

| Workflow | P50 wall | P95 wall | Notes |
|---|---|---|---|
| `main-source-guard` | ~5s | ~8s | one bash check, runs only on main PRs |
| `pr-no-silent-drops` | ~12s | ~17s | checkout `fetch-depth:0` + 2 `gh pr view` calls + `comm` |

Both are negligible. No optimization warranted.

---

## 3. Cache hit-rate analysis

**ci.yml `nm-` cache** (sampled 10 runs): hit on 9 of 10 (~90%), missing only on 25364217869 which had a fresh lockfile change. The 9 hits restored a 350MB `node_modules` in ~22s, saving ~140s vs cold `npm ci`. Effective speedup: ~120s × 90% = **108s/PR average saved by cache** today.

**e2e.yml `nm-e2e-` cache** (sampled 8 runs): hit on **only 3 of 8 (~38%)** — much worse than ci.yml because the e2e workflow runs FAR less often (only when `electron/**` `src/**` `scripts/**` `package*.json` paths change). Cache eviction (GitHub keeps repo caches under 10GB total; busy windows cache evicts the e2e variant first) is the most likely cause.

**Electron binary cache** (`~/.cache/electron`): always restored in <1s — this is healthy and not in any hot path.

**Turbo cache** (`.turbo/`): repo uses turbo + pnpm-workspace at the source-of-truth level (per `ci.yml` line 380 comment), but neither ci.yml nor e2e.yml caches `.turbo/` to actions/cache. Build is invoked via `npm run build:app` (root) and `pnpm --filter` (per-package jobs); the local turbo cache is never persisted across runs. **Turbo cache is OFF in CI today.**

---

## 4. Critical findings — possibly-redundant work

### 4.1 `nm-` vs `nm-e2e-` cache split — duplicates ~350MB twice

ci.yml caches `node_modules` under `nm-${runner.os}-${runner.arch}-node22-${hashFiles('package-lock.json')}`. e2e.yml caches the SAME `node_modules` tree under `nm-e2e-…` because of a documented historical bug (PR #913 / Task #919): ci.yml's tree was poisoned with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and Node-ABI native bindings, while e2e needs Electron-ABI bindings + the binary. The two caches now coexist, eating 2× the per-runner-os 10GB budget.

But: e2e.yml today **runs `npx electron-rebuild` on every job** (heals stale bindings), and **runs `node node_modules/electron/install.js`** (heals missing binary). Both steps are no-ops on healthy caches. **The two healing steps mean the `nm-` and `nm-e2e-` caches could share a key today** — the e2e job's healing steps cover the original poisoning. Unifying the key would let e2e ride ci.yml's much higher hit rate.

### 4.2 sea-smoke runs on 3 OSes per PR — but does not exercise platform-specific code paths

`sea-smoke` (`ci.yml` line 467) runs typecheck + dry-run on windows + macos + linux, justified by spec ch10 §6 ("the harness uses platform-locked paths"). But the actual test step in dry-run mode (`skipStart=true skipStop=true`) never invokes the platform-specific service-manager commands; it only typechecks the harness and asserts `/healthz` times out. **A pure typecheck does not need 3 OSes** — `tsc` is platform-independent. The platform-locked path string differences are caught by the `@ccsm/proto run test` step inside ch15-enforcement, which runs only on windows-latest.

Today's sea-smoke matrix burns ~360 runner-minutes/day (10 PRs × 3 OSes × 2 min) for a typecheck pass that windows-latest alone could handle. Real platform divergence will only matter once Task #82 + #81 land the real installer flow; until then the 3-OS matrix is theatre.

### 4.3 `package` runs on 3 OSes per PR — placeholder-safe mode produces no signal

`package` (`ci.yml` line 564) runs `pnpm run package:<target>` on each OS in **placeholder-safe mode** — missing EV cert / wix.exe / pkgbuild / fpm logs WARN and exits 0 (per `project_v03_ship_intent`). Today's CI signal from this job is "the placeholder-safe scripts still parse" + "verify-signing.{sh,ps1} still parses". On macos and linux this completes in 50-95s; on windows the dotnet `wix` install adds 25s. **Three OS PR-blocking matrix for a parse check is a heavy hammer**.

The real signal value of cross-OS package builds only kicks in at v0.4 release jobs (`CCSM_VERIFY_SIGNING_STRICT=1`). For PR feedback, windows-only (the gate the windows-msi target actually validates) covers regressions in shared scripts; mac+linux can move to nightly schedule.

### 4.4 `ch15 §3 enforcement` runs on `pnpm install --frozen-lockfile` cold every time

The job has **no `actions/cache` step at all**. Every PR pays a full pnpm cold install (~30s) even when the lockfile didn't change. Mirroring ci.yml's `nm-` cache (or pnpm's `~/.local/share/pnpm/store` cache) would save ~25s/PR.

### 4.5 `Test (with coverage)` 119s + `Coverage (daemon)` 32s + `Coverage (electron)` 9s = 3 vitest passes

Task #364 already merged the root-level test+coverage into a single vitest pass, but the per-package coverage gates (`packages/daemon` 50%, `packages/electron` 60%) **each spawn a second vitest** with a separate config. That's 2 extra vitest start costs (~3-5s each cold) plus running narrower spec subsets twice. For tight feedback, the daemon+electron coverage steps could be folded into the root vitest run via a single multi-config invocation (vitest projects mode), saving ~10-15s/PR.

### 4.6 `Build (npm run build:app)` runs in both ci.yml `test` AND e2e.yml — twice per PR

ci.yml `test` job runs `npm run build` (line 314) — required because the load-smoke harness requires `dist/electron/*.js`. e2e.yml runs `npm run build:app` again on its own runner (line 122). Both are ~30-75s. **Total build cost per PR: 2× = 100-150s wall** (different runners, but same compute spend; no artifact handoff between jobs today).

If ci.yml uploaded `dist/` as an artifact and e2e downloaded it, we'd save one build pass — but only when the e2e runner's electron-ABI bindings line up with the build (which they should, since `tsc` output is platform-independent). Build artifact reuse needs a small wiring change but is a clear win.

### 4.7 `Coverage (daemon)` re-runs the install-missing-devDeps trick twice

ci.yml installs `@connectrpc/connect-node` (line 402) and `happy-dom` (line 437) via `npm install --no-save` because the root `npm ci` doesn't pick up workspace devDeps (the repo uses `pnpm-workspace.yaml` as source of truth, not `npm workspaces`). Each side install takes ~4-7s. **The cleanest fix is to teach the root `npm ci` to install workspace devDeps once** — see follow-up task below.

---

## 5. Top 5 bottlenecks (by save × PR-frequency)

PR frequency: assume ~30 PRs/day touching code (current observed cadence). All times below are wall-clock saves on the critical path.

| # | Bottleneck | Save (s/PR) | Risk | Fix sketch |
|---|---|---|---|---|
| **1** | sea-smoke 3-OS matrix on every PR (parse-only signal) | ~30s wall (windows is 220s, the slowest of the 3, never on critical path; **moving to windows-only saves ~360 runner-min/day** even if PR wall doesn't shrink) | low — typecheck is platform-independent; restore mac+linux gate at v0.4 when real installers land | Cut `sea-smoke` matrix to `[windows-latest]` for PR runs; add nightly schedule entry for the 3-OS matrix as regression catch |
| **2** | package 3-OS matrix on every PR (placeholder-safe parse) | ~20s wall (windows is on critical path at 195s; mac+linux finish way ahead) — **also ~280 runner-min/day** | medium — must keep some signal that mac/linux scripts still parse; nightly catch acceptable since real signing not yet live | Cut `package` PR matrix to `[windows-latest]`; nightly cron runs full 3-OS matrix |
| **3** | Build runs twice (ci.yml `test` + e2e.yml separately) | ~30-50s wall on e2e job (smaller of the two builds — e2e only needs `build:app` not full `build`) | medium — artifact handoff adds upload+download steps; ABI mismatch on bindings if build runner != e2e runner OS, but both are windows-latest today | Add `actions/upload-artifact` for `dist/` in ci.yml `test`; e2e.yml downloads if available, falls back to local build if not. Keeps e2e self-sufficient. |
| **4** | ch15 §3 enforcement has no node_modules cache | ~25s/PR on the ch15 job (rarely critical path but burns runner-min) | low — same key shape as ci.yml; pnpm install is idempotent with frozen-lockfile | Add `actions/cache@v4` for `~/.local/share/pnpm/store` keyed by `pnpm-lock.yaml` hash, or for `node_modules` |
| **5** | Per-package coverage runs as 2 extra vitest passes | ~10-15s/PR on test job (on critical path) | low — vitest "projects" mode is stable; coverage gates remain honored | Migrate `packages/{daemon,electron}` per-package coverage to a single root vitest invocation using projects/workspace config; drops 2 vitest cold starts and the missing-devDeps `npm install` workarounds |

**Total potential PR wall savings (top 5)**: ~80-130s, taking ci.yml P50 from ~335s to **~210s** (3m30s) and freeing ~640 runner-min/day.

Honorable mention not in the top 5 (because save is small but the principle matters):
- **e2e cache key unification** (§4.1): would lift e2e cache hit rate from 38% to ~90%, saving ~140s × 50% delta = ~70s on cold-miss PRs (which are ~half the e2e runs). Higher P95 reduction than P50.

---

## 6. Suspicious points checklist

| Q | Finding |
|---|---|
| sea-smoke 3 platform PR mandatory? | **No** — dry-run skipStart+skipStop is platform-independent. See §4.2, bottleneck #1. |
| package 3 platform PR mandatory? | **No, in placeholder-safe mode** — windows-only PR matrix + nightly 3-OS catches real regressions. See §4.3, bottleneck #2. |
| ci + e2e duplicate build? | **Yes**, both run `npm run build:app` on separate windows runners. See §4.6, bottleneck #3. |
| nm cache hit rate < 80%? | ci.yml: 90%. e2e.yml: **38%** (problem). See §3 + §4.1. |
| turbo cache enabled in CI? | **No** — turbo runs locally only; `.turbo/` is never persisted to actions/cache. Could save another 30-60s on warm builds. Tracked as a follow-up but not a top-5 bottleneck since turbo's cache wins are mostly on incremental local rebuilds, less so on the cold-checkout CI scenario. |

---

## 7. Recommended follow-up tasks

All forward-safe. Subject lines + estimates + risk:

### #FOLLOWUP-A: `ci: cut sea-smoke + package PR matrix to windows-only, add nightly 3-OS schedule`
- **Save**: ~30s + ~20s = 50s/PR wall; ~640 runner-min/day
- **Risk**: low — windows is the ship-gate (d) target per spec ch12 §4.4; mac+linux are non-gating drafts. Nightly cron keeps regression coverage.
- **Files**: `.github/workflows/ci.yml` (matrix shrink) + add `nightly-cross-os.yml` with the same matrix shape on cron `0 7 * * *`
- **Branch protection**: existing required checks `sea-smoke (windows-latest)` + `package (win-msi)` stay; remove `sea-smoke (ubuntu-22.04)` + `sea-smoke (macos-14)` + `package (linux-deb-rpm)` + `package (mac-pkg)` from required if currently listed

### #FOLLOWUP-B: `ci: hand off dist/ build artifact from ci.yml test job to e2e.yml`
- **Save**: ~30-50s/PR wall (e2e job only)
- **Risk**: medium — adds upload/download wiring (~5-8s of artifact roundtrip), needs e2e job dependency or fallback path. Avoid making e2e wait on ci.yml; instead have e2e attempt download with `continue-on-error: true`, fall back to local `npm run build:app`
- **Files**: `.github/workflows/ci.yml` + `.github/workflows/e2e.yml`
- **Edge case**: if ci.yml fails before producing `dist/`, e2e.yml falls back to local build — same behavior as today

### #FOLLOWUP-C: `ci: add node_modules / pnpm-store cache to ch15-enforcement job`
- **Save**: ~25s/PR (off critical path but runner-min)
- **Risk**: low — mirrors ci.yml `nm-` cache pattern; pnpm-store is a content-addressed store so safe to share
- **Files**: `.github/workflows/ci.yml` (add cache step in `ch15-enforcement` job)

### #FOLLOWUP-D: `ci: unify nm-e2e- and nm- cache keys (rely on healing steps)`
- **Save**: ~70s on cache-miss PR (P95-bucket); ~5GB cache budget freed for older caches to survive longer
- **Risk**: medium-high — historical bug PR #913 / Task #919; the healing steps (`node install.js` + `npx electron-rebuild`) MUST stay. Risk mitigation: run e2e once with unified key in a draft PR before flipping the live workflow
- **Files**: `.github/workflows/e2e.yml` (cache-key prefix change) + extra comment block documenting the heal-on-restore pattern

### #FOLLOWUP-E: `tests: migrate per-package coverage to root vitest projects mode`
- **Save**: ~10-15s/PR on critical path (test job)
- **Risk**: low — vitest projects/workspace is stable in v1+; coverage thresholds remain enforced as per-project gates; eliminates the `npm install --no-save` workarounds
- **Files**: `vitest.config.ts` + `vitest.workspace.ts` (new) + ci.yml `test` job (collapse the 2 coverage steps + 2 install-missing-devDeps steps into a single vitest run)

### #FOLLOWUP-F (optional, lower priority): `ci: enable turbo remote cache via actions/cache`
- **Save**: 20-40s/PR on warm `npm run build` when source unchanged; nothing on first-touch
- **Risk**: low — turbo cache is content-addressed by package + dependencies; cache poisoning self-heals on input change
- **Files**: ci.yml + e2e.yml (add `.turbo/` to existing `actions/cache@v4` step)

---

## 8. Out-of-scope notes (not for v0.3)

- `installer-roundtrip.yml` (workflow_dispatch only) — only relevant once Task #82 / #81 ship real artifacts
- `pty-soak.yml` (nightly + manual) — not on PR critical path; runner is self-hosted
- `release.yml` (tag push only) — not exercised by PR flow

These three workflows could each warrant their own audit at the v0.4 ship boundary when real artifacts begin to flow through them, but they consume zero PR-blocking minutes today.

---

## 9. Methodology notes

- **Sample size**: 10 most recent PR-success runs per workflow as of 2026-05-05 07:50 UTC. Pre/post Task #489 split is called out where relevant.
- **P50 / P95 method**: rough percentile by ordering. Sample is small (n=10) — these are illustrative, not statistically rigorous.
- **Cache state attribution**: from `gh run view <id> --log | grep -i "cache hit"` exit lines. "Cache hit" = primary key restored; "Cache restored from key: nm-…-…" without "Cache hit" = restore-keys fallback (treated as miss for delta-install cost).
- **Critical path attribution**: jobs depend on `detect changes` only (5-10s); after that everything fans out. Wall = max(job durations).
- **Runner-minutes calculations**: `(daily PR rate) × (job count) × (job duration)`. PR rate estimate is observational from `gh pr list --limit 100 --search created:>2026-05-04`.
