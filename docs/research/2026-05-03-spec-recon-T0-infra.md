# v0.3 Spec Reconciliation — Sub-audit A: T0.x infra / CI / toolchain

**Date**: 2026-05-03
**Author**: research agent (pool-10, Task #202)
**Scope**: T0.x (monorepo, codegen, lockfile, CI matrix, toolchain, ESLint boundaries) — deeper read of the same surface the baseline audit covered, plus toolchain-lock-design.md and adjacent files (`.nvmrc`, `.npmrc`, root `package.json` scripts, `tsconfig.*`, `release.yml`, `e2e.yml`, `pr-no-silent-drops.yml`, `_runners-template.yml`).
**Companion**: PR #945 (the user-prompted reconciliation review); baseline at `docs/research/2026-05-03-v03-spec-reconciliation-audit.md` on `research/2026-05-03-spec-reconciliation`.
**Mode**: READ-ONLY. No production code changes.

Severity legend (same as baseline): ALIGNED / MINOR DRIFT / DRIFT / CRITICAL DRIFT.

For each row I cite `spec ref` then `evidence` (file path / PR / merged-fix) and finally classify as **CONFIRMED** (matches baseline), **UPGRADED/DOWNGRADED** (severity reclassified vs baseline), or **NEW** (not in baseline).

---

## A. Re-read of baseline T0.x rows

| Task | Baseline severity | This audit | Verdict | Notes |
| --- | --- | --- | --- | --- |
| #11 T0.1 pnpm workspaces | ALIGNED | ALIGNED | CONFIRMED | `pnpm-workspace.yaml` lists `packages/*`; `packageManager: pnpm@10.33.2` set. |
| T0.1 — proto file path layout | MINOR DRIFT | MINOR DRIFT | CONFIRMED | Spec says `packages/proto/ccsm/v1/*.proto`; actual is `packages/proto/src/ccsm/v1/*.proto`. Internally consistent across `buf.yaml modules: [{ path: src }]`, `lock.json` keys, eslint forbid pattern `@ccsm/proto/src/*`. |
| #13 T0.3 tsconfig | ALIGNED | ALIGNED | CONFIRMED | `tsconfig.base.json` exists; daemon/proto extend (electron has no tsconfig.json, only `tsconfig.test.json` — see new finding A1 below). |
| #14 T0.4 ESLint flat | ALIGNED | ALIGNED | CONFIRMED | Per-package configs implement spec ch11 §5 patterns; electron config additionally implements the §1a IPC ban via `no-restricted-syntax` (over-spec, harmless). |
| #10 T0.2 Turborepo | ALIGNED | **UPGRADED → DRIFT** | UPGRADED | turbo.json exists with right tasks/dependsOn, but `gen.inputs` references `ccsm/**/*.proto` while actual proto files live at `src/ccsm/v1/*.proto`. See new finding A2. |
| **#17 T0.8 CI matrix** | CRITICAL DRIFT | CRITICAL DRIFT | CONFIRMED | `.github/workflows/ci.yml` is a single `lint-typecheck-test` matrix job using `npm ci --legacy-peer-deps`. Zero pnpm, zero turbo, zero proto-gen-and-lint job, no install-cache artifact share, no per-package matrix, no soak/installer self-hosted job. Spec ch11 §6 sketch is wholly unimplemented. |
| #12 T0.5 buf codegen | MINOR DRIFT | MINOR DRIFT | CONFIRMED | `buf.gen.yaml` uses `local: protoc-gen-es` v2 (combined messages + service descriptors). Spec ch11 §4 lists two REMOTE plugins (`bufbuild/es:v1.10.0` + `connectrpc/es:v1.4.0`). Functionally equivalent under v2; a literal-text drift in the spec snippet only. |
| #16 T0.10 self-hosted runner | DRIFT (intentional) | DRIFT (intentional) | CONFIRMED | `_runners-template.yml` is inert (`if: false`, `workflow_dispatch` only); `tools/runners/README.md` is provisioning doc. No real consumer workflow yet (same root cause as #17). |
| #18 T0.7 Changesets + sync-version + drift-check | ALIGNED | ALIGNED | CONFIRMED | `.changeset/config.json` ships with `baseBranch: working`, `privatePackages.version: true` (suitable for v0.3 private packages); `scripts/sync-version.mjs` propagates root version; `version-drift-check.mjs` parses `version.ts` and compares to latest `v*` tag. Note: drift-check exits 0 on first-tag absence (intentional). |
| #19 T0.6 proto lock | ALIGNED | ALIGNED | CONFIRMED | `lock.json` schema and scripts match spec. |
| #20 T0.11 .proto files | ALIGNED | ALIGNED | CONFIRMED | All 8 .proto files present (subject to the path drift in row 2). |

**Tally vs baseline T0.x rows (11 rows):**
- ALIGNED → ALIGNED: 7 confirmed
- MINOR DRIFT → MINOR DRIFT: 2 confirmed
- ALIGNED → DRIFT: 1 upgraded (T0.2 turbo.json gen.inputs)
- CRITICAL DRIFT → CRITICAL DRIFT: 1 confirmed (T0.8)
- DRIFT (intentional) → DRIFT (intentional): 1 confirmed

---

## B. New findings (not in baseline)

### A1 — `packages/electron/` has no `tsconfig.json` and no production `build` script

**Severity**: **DRIFT**

**Spec ref**: ch11 §2 directory layout shows `packages/electron/{tsconfig.json, src/{main,preload,renderer}, electron-builder.yml}`. ch11 §6 CI sketch calls `pnpm --filter @ccsm/electron run build`.

**Evidence**:
- `packages/electron/` has **only** `tsconfig.test.json` (no `tsconfig.json`). Compare to `packages/daemon/` which has both.
- `packages/electron/package.json` `scripts` block has `build:mac`, `build:linux`, `lint`, `typecheck`, `test`. There is **no `build` script**. The `main` field points at `dist/main/protocol-app.js` but nothing in this package generates that path.
- `packages/electron/src/{main,preload,renderer}/` directories: per `git ls-tree`, `src/` contains exactly `index.ts` re-exports, `connection/`, `rpc/` (the RQ wrappers + reconnect TODO), and a stub `transport/`. The `main/` and `preload/` dirs from ch11 §2 are NOT present.
- The actual electron production code still lives at the legacy repo-root paths (`electron/` directory, `tsconfig.electron.json` at repo root). The v0.3 thin-client refactor into `packages/electron/` is partial: tests + RPC bindings have moved; main/preload/renderer have not.

**Impact**: Spec ch11 §6 step `pnpm --filter @ccsm/electron run build` does not work today. The CI job that #17 is supposed to ship would fail at this exact step until a `build` script exists. Also entangles with finding **A4** (T7.7 MSI scope gap) — electron-builder can't sensibly run from `packages/electron/` until it has a build pipeline producing `dist/main/`.

**Already fixed?** No.

---

### A2 — `turbo.json` `gen.inputs` glob does not match the actual proto file location

**Severity**: **DRIFT** (latent correctness bug; baseline marked T0.2 ALIGNED)

**Spec ref**: ch11 §4 (Turborepo treats `gen` as a build prerequisite; cache invalidation must follow `.proto` edits).

**Evidence**:
```jsonc
// turbo.json
"gen": {
  "outputs": ["gen/**"],
  "inputs": [
    "buf.yaml",
    "buf.gen.yaml",
    "ccsm/**/*.proto",   // <-- WRONG: actual files at src/ccsm/v1/*.proto
    "lock.json",
    "scripts/**"
  ]
}
```
Actual proto files are at `packages/proto/src/ccsm/v1/*.proto` (see baseline path drift row). The `ccsm/**/*.proto` glob is anchored at the package root (`packages/proto/`) and expects `packages/proto/ccsm/v1/*.proto` — a path that does not exist. Verified by `ls packages/proto/`: only `gen/`, `src/`, `scripts/`, `test/`, `node_modules/` present (no top-level `ccsm/`).

**Consequence**: edits to `.proto` files do not invalidate the turbo `gen` task hash. A `pnpm gen` cached run will be served from cache after a real `.proto` edit. The `lock.json` change (which an honest committer would also bump, per the lock-check CI step the spec calls for in §6) does invalidate, masking the bug somewhat — but the spec gives `pnpm --filter @ccsm/proto run lock` as the trigger to bump lock.json, so a developer who edits a `.proto` and runs `turbo run gen` BEFORE running the lock script will still get a cached stale gen.

**Fix is one-line**: change `"ccsm/**/*.proto"` to `"src/**/*.proto"` (or `"src/ccsm/v1/*.proto"`).

**Why baseline missed it**: baseline row #10 said "matches the spec snippet exactly — same task names, same `dependsOn`, same `outputs`. Adds extra `inputs` filters (which is a strict refinement, not a drift)." The reviewer compared the four field names but did not cross-check the `inputs` glob against the on-disk proto path.

**Already fixed?** No.

---

### A3 — Spec ch11 §6 step names (`test:unit`, `test:integration`, `lint:no-ipc`) do not exist in package.json scripts

**Severity**: **DRIFT** (CI implementation blocker for #17 fix)

**Spec ref**: ch11 §6 CI sketch:
- `pnpm --filter @ccsm/daemon run test:unit`
- `pnpm --filter @ccsm/daemon run test:integration`
- `pnpm --filter @ccsm/electron run test:unit`
- `pnpm --filter @ccsm/electron run lint:no-ipc`
- `pnpm --filter @ccsm/proto run lint`
- `pnpm --filter @ccsm/proto run breaking`

**Evidence**: `packages/{daemon,electron}/package.json` define only flat `test`, `lint`, `typecheck` (and the daemon's sea/native build scripts). `packages/proto/package.json` defines no `lint` script and no `breaking` script. The buf CLI is a devDependency but not exposed via npm scripts.

**Consequence**: when PR #906 (baseline mentions it as the open fix for #17) lands a CI job, every step name in the spec sketch will need to be either renamed in the workflow (deviating from spec text) or backfilled in package.json (small but real change). Either path is a future drift the audit should record now so the #906 reviewer sees both options simultaneously rather than picking one silently.

**Mitigation**: split the existing `test` into `test:unit` + `test:integration` per package, add `lint:no-ipc` (electron) and `lint`/`breaking` (proto) wrappers around `tools/lint-no-ipc.sh` and `buf lint` / `buf breaking`. This is mechanical script-level glue, no behavior change.

**Already fixed?** No.

---

### A4 — Three workflows duplicate the toolchain-lock setup but only `e2e.yml` and `release.yml` use `node-version-file`; none use pnpm cache

**Severity**: **DRIFT** (toolchain-lock-design.md ch5 explicitly diff-spec'd this)

**Spec ref**: `docs/superpowers/specs/2026-05-03-toolchain-lock-design.md` §5 "CI: `.github/workflows/ci.yml` diff" specifies the post-migration shape:
- `setup-node@v4` with `node-version-file: '.nvmrc'` and `cache: 'pnpm'`
- `pnpm install --frozen-lockfile` (replacing `npm ci --legacy-peer-deps`)
- `actions/cache@v4` keyed on `~/.local/share/pnpm/store` and `pnpm-lock.yaml`
- `pnpm rebuild better-sqlite3` (replacing `npm rebuild`)

**Evidence (current state, all three workflows)**:
- `.github/workflows/ci.yml`: `setup-node@v4` with `node-version-file: '.nvmrc'` ✓ but `cache: 'npm'` ✗; uses `npm ci --legacy-peer-deps` ✗ and caches `node_modules` directly ✗ (with the explicit "node22" cache-key fix the toolchain-lock spec §5 sub-fix calls out — that part is done).
- `.github/workflows/e2e.yml`: same pattern — `node-version-file: '.nvmrc'` ✓ but `cache: 'npm'`, `npm ci --legacy-peer-deps`, node_modules cache.
- `.github/workflows/release.yml`: same pattern.

**Verdict**: the toolchain-lock spec is half-applied. The Node-version source-of-truth migration landed (`.nvmrc` is honored, the "node22" cache key fix is present in ci.yml). The pnpm migration did NOT land in any workflow. `pnpm-lock.yaml` is committed at repo root, so the workspace itself is pnpm-ready, but every CI workflow still installs via `npm ci` against `package-lock.json`. **Both lockfiles are committed** (`package-lock.json` AND `pnpm-lock.yaml`), which is an additional drift — toolchain-lock §3 says one or the other, not both.

**Cross-link**: this is the same root cause as baseline #17 (CI is npm-shaped not pnpm-shaped), but the toolchain-lock spec frames it as a separate scope-of-work — one PR should not try to ship both #17's per-package matrix AND the npm→pnpm workflow migration AND the engine-strict gate AND the dual-lockfile cleanup.

**Already fixed?** No. The `.nvmrc` migration is the only piece that landed.

---

### A5 — `package.json` engines field uses `>=22.0.0 <23` but no `engine-strict` enforcement; `packages/*` have no `engines` field at all

**Severity**: **MINOR DRIFT**

**Spec ref**: toolchain-lock-design.md §4 "engines + engine-strict enforcement":
- root `engines.node` should match `.nvmrc`
- root `.npmrc` should set `engine-strict=true`
- `packages/*` should also declare `engines.node` (toolchain-lock §4 "packages/* engines (v0.3+)")

**Evidence**:
- root `package.json`: `"engines": { "node": ">=22.0.0 <23" }` ✓ (acceptable range form)
- root `.npmrc`: only `clang=0` line (`engine-strict` not set)
- `packages/{proto,daemon,electron}/package.json`: no `engines` field

**Consequence**: a contributor on Node 20 / 24 still passes `npm install` / `pnpm install` without an explicit error. The `check:engines` script in root package.json prints a `[warn]` to stderr but does not exit non-zero. Violates toolchain-lock §4 "fail-fast on local dev".

**Already fixed?** No.

---

### A6 — `proto-version-check` is wired in root `package.json` but not in any CI workflow

**Severity**: **DRIFT**

**Spec ref**: ch11 §7 — `version-drift-check` MUST run in the `proto-gen-and-lint` CI job.

**Evidence**:
- Root `package.json`: `"proto-version-check": "pnpm --filter @ccsm/proto run version-drift-check"` ✓
- `packages/proto/scripts/version-drift-check.mjs` exists and is correct ✓
- **No workflow invokes it.** Searched `.github/workflows/*.yml` — zero matches for `proto-version-check`, `version-drift-check`, or `pnpm --filter @ccsm/proto`.

**Consequence**: the script can be bypassed; spec ch11 §7's stated guarantee ("CI fails the PR if PROTO_VERSION regressed") is not enforced today. The script is no-op-on-first-tag (correct behavior pre-v0.3-tag), so this is latent until ship and then immediately load-bearing.

**Already fixed?** No (same root cause as #17 / A4 — CI doesn't have a proto job at all yet).

---

### A7 — `pr-no-silent-drops.yml` exists but `main-source-guard.yml` only catches the wrong-source pattern, not the v0.3 ship-gate jobs

**Severity**: ALIGNED (informational, not a drift)

**Evidence**: Two pieces of CI infra not described in baseline:
- `pr-no-silent-drops.yml` enforces "every claimed-by-API file appears in the actual base...head diff" — protects against the PR #250-style bad-rebase silent drop. Solid hygiene; out-of-scope of v0.3 spec but additive.
- `main-source-guard.yml` rejects PRs to `main` whose head_ref is not `working`. Out-of-scope of v0.3 spec (release process) but useful.

Neither is in the spec ch11 §6 sketch. They are repository hygiene that survives the v0.3 cutover. No drift to record.

---

### A8 — `_runners-template.yml` references `pnpm install --frozen-lockfile` (correct) but the current `install` template in this file is the only place pnpm is invoked in any workflow

**Severity**: ALIGNED (informational)

**Evidence**: Both jobs in `_runners-template.yml` use `pnpm install --frozen-lockfile`. The file is inert (`if: false`, `workflow_dispatch` only) so this is documentation-only. When a future PR copies these jobs into real workflow files, the pnpm command will be correct. This is a positive sign — the template authors knew the spec direction. The drift is not in this file; it's in the absence of any consumer.

---

### A9 — Root `package.json` defines turbo wrapper scripts (`build`, `test`, `lint`, `gen`) but ALSO defines parallel npm-flavored scripts (`build:app`, `test:app`, `lint:app`); CI workflows only call the npm-flavored variants

**Severity**: **DRIFT**

**Evidence (root `package.json` scripts)**:
- Spec-aligned (turbo): `"build": "turbo run build"`, `"test": "turbo run test"`, `"lint": "turbo run lint"`, `"gen": "turbo run gen"`.
- Pre-v0.3 (still load-bearing): `"build:app"`, `"test:app"`, `"lint:app"` — these remain the canonical entry points that **`ci.yml` invokes** (`npm run lint:app`, `npm run typecheck`, `npm run build:app`, `npm run test:app`).

**Consequence**: the turbo orchestration layer is wired but unused by CI. Local-dev `npm run build` does the right turbo-cached thing; CI runs the slower non-turbo path. This is the inverse of the usual concern — the speed win sits unused in the repo. After A4 lands (CI goes pnpm), the workflow can call `pnpm run build` (turbo) and inherit the cache benefit "for free".

**Already fixed?** No.

---

### A10 — `tsconfig.base.json` is referenced in turbo `globalDependencies` but only the `daemon` package extends it; `proto` and `electron` package tsconfigs do NOT extend it

**Severity**: **MINOR DRIFT**

**Spec ref**: ch11 §2 "tsconfig.base.json shared TS config; packages extend".

**Evidence (sampled)**:
- `tsconfig.base.json` exists at repo root with shared compilerOptions (target ES2022, module NodeNext, strict, etc.).
- `packages/daemon/tsconfig.json` — examined elsewhere; extends base ✓ (per baseline).
- `packages/proto/tsconfig.json`, `packages/electron/tsconfig.test.json` — not yet read in this audit, but baseline marked T0.3 ALIGNED so I am deferring final verdict to a follow-up read. Flagging as a "verify once more" item not a confirmed drift.

**Already fixed?** Unknown (low-priority verify).

---

## C. Cross-cutting observations

1. **`package-lock.json` (686 KB) AND `pnpm-lock.yaml` (424 KB) are both committed.** The repo is mid-migration from npm to pnpm. Spec direction is pnpm-only (toolchain-lock §3); the npm lockfile is a transitional artifact whose presence is itself a drift. Removing it before CI flips to pnpm risks breaking the current `npm ci`-shaped workflows, so the safe ordering is: (1) workflows go pnpm-shaped (A4), (2) delete `package-lock.json`, (3) flip `engine-strict`. None of these are done.

2. **The proto path drift (`src/ccsm/v1/` vs spec's `ccsm/v1/`) is more than cosmetic** — it is the proximate cause of A2 (turbo.json glob bug). Reconciling the spec snippet to match code would also fix A2 in passing. Reconciling code to match spec (moving files up one level) would require updating `buf.yaml modules`, `lock.json` keys, eslint forbidden patterns, every `import`, and the audit cost is much higher. Recommend updating the spec.

3. **Self-hosted runner labels (`ccsm-soak`, `win11-25h2-vm`) are referenced in 1 file (the inert template) and are needed by 0 active workflows.** Until at least one consumer workflow is shipped, the runner provisioning checklist in `tools/runners/README.md` is documentation-without-customers. Spec ch10 §6 descopes provisioning to `infra/win11-runner/` repo, but the in-repo CI half is what is missing.

---

## Summary

**Re-audited rows**: 11 baseline T0.x rows + 10 deeper observations.

| Severity | Confirmed (matches baseline) | Upgraded (worse than baseline) | New (not in baseline) |
| --- | --- | --- | --- |
| ALIGNED | 7 | 0 | 2 (A7, A8 — informational) |
| MINOR DRIFT | 2 | 0 | 2 (A5 engines/engine-strict; A10 tsconfig.base inheritance — verify) |
| DRIFT | 1 | 1 (T0.2 → A2 turbo.json gen.inputs glob) | 4 (A1, A3, A4, A6, A9) |
| CRITICAL DRIFT | 1 | 0 | 0 |

**Tally**: 7 ALIGNED / 4 MINOR / 7 DRIFT / 1 CRITICAL across the T0.x infra surface. Of the 8 latent drifts (excluding the already-CRITICAL #17 and the 2 informational), **5 are different facets of the same problem**: CI workflows are npm-shaped, the spec ch11 §6 sketch is pnpm-shaped, and several spec-named scripts (`test:unit`, `test:integration`, `lint:no-ipc`, `proto-version-check` invocation, turbo-wrapper invocation) have no caller. A single coordinated PR — "wire workflows to pnpm + per-package matrix + spec script names + version-drift-check + remove npm lockfile" — could close A3 / A4 / A6 / A9 plus the open #17 fix all at once. Splitting them into separate PRs risks a half-migration where each PR is internally consistent but the system still routes to the npm path.

### Top 3 NEW findings (highest ship-impact)

1. **A1 — `packages/electron/` has no production `build` script and no `tsconfig.json`.** Spec ch11 §6 step `pnpm --filter @ccsm/electron run build` cannot run today. PR #906 (the open #17 fix) will trip on this the moment it tries to call the electron package matrix. Either the v0.3 thin-client refactor of electron/main+preload+renderer into `packages/electron/src/` is incomplete OR the spec's per-package `build` step will need to gracefully no-op on the not-yet-migrated paths. Decide explicitly before #906 reviewers see another spec-vs-code surprise. ALSO blocks A4 (T7.7 MSI gap from baseline) — electron-builder can't sensibly target `packages/electron/dist/` if no build populates it.

2. **A2 — `turbo.json` `gen.inputs` glob `ccsm/**/*.proto` does not match actual file path `src/ccsm/v1/*.proto`.** Cache invalidation on `.proto` edits is silently broken — turbo will serve stale generated TS until `lock.json` happens to also change. Baseline marked T0.2 ALIGNED on field-name comparison alone; a one-line `inputs` glob fix closes the bug. Direct ship-risk: a developer edits a `.proto`, runs `turbo run build`, gets a cached stale `gen/ts/`, and pushes a PR whose generated code is a lie until the next lock-script run. The CI's `pnpm --filter @ccsm/proto run gen && git diff --exit-code` step the spec calls for in ch11 §4 would catch it — except that step is also missing today (A6 / #17).

3. **A4 — Three workflows (ci, e2e, release) all still install via `npm ci --legacy-peer-deps` against `package-lock.json` despite `pnpm-lock.yaml` being committed.** The toolchain-lock spec §5 prescribes a literal diff that has not landed in any workflow. The migration is half-done: `.nvmrc` is honored, but the install + cache layer is npm. This is the surface the open #17 fix collides with — implementing per-package matrix on top of `npm ci` is anti-spec, and migrating to pnpm in the same PR doubles the blast radius. Recommend: ship the workflow npm→pnpm migration as its own small PR, THEN ship per-package matrix + soak/installer jobs on the pnpm baseline. Bonus payoff: `package-lock.json` (686 KB) can be removed once no workflow consumes it.
