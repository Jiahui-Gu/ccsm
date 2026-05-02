# ch06 — Rollout across v0.2, v0.3, v0.4

## Rollout principle

The toolchain lock is FIVE small pieces (Node `.nvmrc`, pnpm
`packageManager`, engines, engine-strict, `node-linker=hoisted`) plus CI
wiring. Different release lines absorb them at different times because they
have different risk profiles. The principle: each release line gets the
pieces in the order that minimizes contributor breakage, NOT the order that
finishes the rollout fastest.

## v0.2 main rollout

v0.2 main is the highest-risk surface because it has the largest live
contributor population AND uses npm + electron-builder publish, both of
which have historical friction with pnpm migration.

### Sequence

1. **PR A (low-risk): add `.nvmrc`, bump CI to Node 22.**
   - Files: `.nvmrc` (new), `.github/workflows/ci.yml` (node-version → 22),
     `.github/workflows/e2e.yml` (same), `.github/workflows/release.yml`
     (same).
   - Risk: Node 20 → 22 jump. Mitigation: full CI matrix (Linux/macOS/Windows)
     must pass before merge. If a dep breaks on Node 22, fix that dep first
     (separate PR).
   - Rollback: revert is single-commit.
   - **Engine-strict NOT yet on**, so contributors still on Node 20 can
     continue working — they just see CI fail on their PRs until they upgrade.

2. **PR B (onboarding doc): CONTRIBUTING + README.**
   - Files: `CONTRIBUTING.md`, `README.md`.
   - Risk: zero (doc only).
   - Land BEFORE PR C so contributors who hit engine-strict have docs to
     follow.

3. **PR C (announce + grace period): pinned issue + Discord/discussion post.**
   - Not a code change. 1-week notice that engine-strict lands at end of
     window. Provides upgrade instructions (link to PR B doc).

4. **PR D (high-risk): pnpm migration + engine-strict.**
   - Files: `package.json` (`packageManager` field — already present from
     PR #848; `engines` field — new), root `.npmrc` (add `engine-strict=true`,
     `node-linker=hoisted`), all `package.json#scripts` (npm → pnpm),
     `pnpm-lock.yaml` (new, replaces `package-lock.json`),
     `package-lock.json` (deleted), `.github/workflows/*.yml`
     (`npm ci` → `pnpm install --frozen-lockfile`, cache step changes),
     release-candidate verify added.
   - Risk: HIGH. Lockfile format change, package manager change, install
     mechanism change, all in one atomic PR.
   - Why atomic: half-migrated state (e.g. pnpm-lock.yaml present but
     scripts still call npm) is worse than either pure state.
   - Mitigation: dedicated reviewer pass on release.yml (Electron-builder
     interactions); reverse-verify matrix from `ch05 §reverse-verify matrix`
     run by hand on 3 environments before merge; pinned rollback note in
     PR description with the exact commands to revert.
   - Rollback: revert PR D restores npm; package-lock.json comes back from
     git. PR A/B are independent and stay.

### Why FOUR PRs, not one

A single mega-PR touches `.nvmrc`, `package.json`, `.npmrc`,
`pnpm-lock.yaml` (new ~5000-line file), every workflow YAML, every script,
and CONTRIBUTING simultaneously. Reviewer fatigue guarantees something
slips. Splitting:

- PR A is a 4-line workflow tweak + new 1-line file. Easy to review/revert.
- PR B is a doc PR. Trivial.
- PR C is process, not code.
- PR D is the unavoidable atomic change; everything that doesn't NEED to
  be in it has been pulled out.

## v0.3 packages/* rollout

The v0.3 monorepo scaffold (daemon-split spec ch11) has already landed:
`pnpm-workspace.yaml` + `packages/{electron,daemon,proto}` skeletons +
`pnpm-lock.yaml` are present on `working`. Root `package.json` already has
`"packageManager": "pnpm@10.33.2"` (PR #848). What's MISSING from the
toolchain lock as of this spec:

- `.nvmrc` (no Node pin yet).
- `engines` field in root and per-package `package.json`.
- `engine-strict=true` and `node-linker=hoisted` in root `.npmrc`.
- CI workflows still on `node-version: '20'` + `npm ci`.
- CONTRIBUTING / README onboarding section.
- Release-candidate verify block.

The PRs in `§v0.2 main rollout` above land all of these. Per-package
`engines.node: "22.x"` is added to each `packages/*/package.json` in PR D
(same atomic change — they are 2-line additions and skipping them
re-introduces the inconsistency this spec exists to prevent).

No separate v0.3 PR is needed — the scaffold is already there to receive
the lock. This is a happy accident of timing; if PR #848 + the workspace
scaffold had landed AFTER toolchain-lock, the "v0.3" rollout would have
been bundled into PR D too.

## v0.4 follow-ups (deferred work, listed for completeness)

These are explicitly OUT OF SCOPE for this spec. Listed here so reviewers
see the trajectory:

- **Renovate / lockfile-maintenance bot.** Configure `renovate.json` to:
  - Bump `.nvmrc` when a new Node 22.x patch ships (low priority, weekly).
  - Bump `packageManager` when a new pnpm 10.x patch ships (low priority,
    weekly).
  - Bump `pnpm-lock.yaml` deps on a regular cadence (separate config).
  - Why deferred to v0.4: requires the pin to exist first. No value in
    automating bumps to a non-existent pin.
- **Lockfile drift CI check.** A `pre-merge` job that runs
  `pnpm install --frozen-lockfile` and fails if lockfile changes —
  catches contributors who edited `package.json` without re-running install.
  Easy add post-rollout; defer to keep this spec scoped.
- **Native-ABI matrix CI.** Run tests against Node 22.x AND a release
  candidate of Node 24 to surface upcoming-version breakage early.
  Considered v0.4+; useful only once we're considering the major bump.
- **Self-hosted ARM64 runner.** Listed in `ch05 §reverse-verify matrix`
  row 4. Not a toolchain-lock concern per se; just inherits the same
  setup-node pattern when added.

## Contributor-environment fallback playbook

When a contributor reports "I followed the steps and `pnpm install` still
fails," the diagnostic order is:

1. **Verify Node version**: `node --version` should match `.nvmrc`. If not,
   the version manager hook isn't firing. Common causes:
   - fnm shell hook not installed: `eval "$(fnm env --use-on-cd)"` missing
     from `.bashrc`/`.zshrc`.
   - nvm: not running `nvm use` after `cd`.
   - Volta: `volta pin node@22` not run.
2. **Verify Corepack active**: `which pnpm` should resolve to a Corepack
   shim (path contains `corepack` or Node's bin dir). If it resolves to a
   global brew/npm install, run `corepack enable` and re-test.
3. **Verify pnpm version**: `pnpm --version` should match `packageManager`
   exactly. If not, Corepack didn't override the global pnpm — usually a
   PATH precedence issue. Workaround: `corepack prepare pnpm@10.33.2 --activate`.
4. **Native build failures (`better-sqlite3`)**: separate from toolchain
   lock. Existing `clang=0` in `.npmrc` covers Windows; macOS needs
   `xcode-select --install`; Linux needs `apt-get install build-essential
   python3`.
5. **Last resort: `rm -rf node_modules pnpm-lock.yaml && pnpm install`**.
   Nuclear, but recoverable because lockfile regenerates from `package.json`.
   Only safe in a clean checkout (no local `package.json` edits).

This playbook is referenced from CONTRIBUTING.md as "If install fails, see
TOOLCHAIN-DEBUG.md" — but the content lives ONLY in CONTRIBUTING.md (no
duplicate file). Why: a separate file would drift from CONTRIBUTING.md
over time.

## Done criteria for the rollout

The toolchain-lock initiative is "shipped" when:

- v0.2 PR A, B, D are all merged on `working` branch.
- CI on `working` is green for 3 consecutive days.
- Reverse-verify matrix passes on rows 1-3.
- v0.3 monorepo scaffold (separate spec, daemon-split ch11) lands on top
  of the locked toolchain without modifying any toolchain file.
- Zero open issues mentioning "ERR_PNPM_UNSUPPORTED_ENGINE" or
  "wrong Node version" in the past 7 days (i.e. contributors have absorbed
  the change).

When all five conditions hold, declare done and close the parent task.
