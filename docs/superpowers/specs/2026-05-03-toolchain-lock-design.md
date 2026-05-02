---
title: Cross-version toolchain lock (Node 22 / pnpm 10 / engines-strict)
date: 2026-05-03
status: frozen
---

# Cross-version toolchain lock

## Changelog

- 2026-05-03 — initial draft authored as 6 chapter files in
  `_toolchain-chapters/` (commits `0fb3fcd`..`544f16d`).
- 2026-05-03 — R0 / R2 / R5 reviews (commits `bc9a8dc`, `9694b73`,
  `4917ff7`).
- 2026-05-03 — fix-round-1 closes 3 P0 + 9 P1 from R0/R2/R5 (commit
  `e0e4a74`).
- 2026-05-03 — round-2 micro-fix aligns ch04 strategy table with canonical
  pnpm range (commit `0e67fb8`); R0 r3 spot-check verdict CLEAN (commit
  `77cefca`).
- 2026-05-03 — chapters consolidated into this single frozen spec; per-chapter
  files and review artifacts removed from `_toolchain-chapters/`.

## Table of contents

- [§1 — Overview](#1--overview-cross-version-toolchain-lock)
- [§2 — Node version pinning](#2--node-version-pinning)
- [§3 — pnpm pinning via Corepack](#3--pnpm-pinning-via-corepack)
- [§4 — engines + engine-strict enforcement](#4--engines--engine-strict-enforcement)
- [§5 — CI wiring, onboarding, release verify, reverse-verify matrix](#5--ci-wiring-onboarding-release-verify-reverse-verify-matrix)
- [§6 — Rollout across v0.2, v0.3, v0.4](#6--rollout-across-v02-v03-v04)

---

## §1 — Overview: cross-version toolchain lock

### Context

CCSM today has no enforced toolchain pin. Contributors install whatever Node and
package manager their machine happens to have; CI happens to use Node 20 (`.github/workflows/ci.yml`)
because that string was hard-coded into the workflow at some point, with no
single source of truth. This has produced repeated drift incidents:

- "Works on Win 11 / fails on Linux GHA runner" — usually a native module
  (`better-sqlite3`, `node-pty`) compiled against a different Node ABI than
  the one CI runs.
- "Works with my pnpm 8 / fails with your pnpm 10" — lockfile format diff,
  workspace protocol diff, hoisting diff.
- "Postinstall succeeds locally / fails on Linux" — implicit reliance on
  Python / build-essential / specific node-gyp behavior tied to a Node minor.
- "Engines field says nothing, so npm/pnpm let any version through" — a
  contributor on Node 18 silently produces a lockfile that breaks Node 22
  optional-chaining transforms in build tooling.

The fix is mechanical: pin the toolchain in version-controlled files and have
both local and CI read from those files. This spec writes down WHAT to pin,
WHERE to pin it, and HOW the pin is enforced — across all three of CCSM's
near-term release lines (v0.2, v0.3, v0.4).

### Scope

In scope for this spec:

1. Pinning **Node major** to a single source of truth (`.nvmrc`).
2. Pinning **pnpm** through `packageManager` field + Corepack.
3. Pinning **engines** with strict enforcement so `pnpm install` rejects a
   wrong-version host.
4. Wiring CI (`actions/setup-node@v4`) to consume the same pin files.
5. Onboarding doc updates (CONTRIBUTING / README) for fnm / nvm / Volta users.
6. Release-script verification step (refuse to cut a release-candidate from a
   wrong-version host).
7. **Cross-version application**: how the pin lands on v0.2 root (which is
   currently npm + Electron-builder), v0.3 (`packages/*` pnpm workspace), and
   forward-compatibly on v0.4.

Explicitly **out of scope** (deferred):

- **Renovate / lockfile-maintenance bot.** Deferred to v0.4. Why deferred: the
  pin must exist before automated bumping makes sense; landing both at once
  doubles review surface for no gain.
- **Native-module ABI matrix CI** (running tests against Node 20, 22, 24 in
  parallel). Out of scope. Why: we are pinning to ONE Node major; matrixing
  defeats the purpose. v0.4 may revisit when we want forward-compat signal.
- **OS pinning beyond what GitHub-hosted runners already give us.** We
  document the supported triple (`ubuntu-latest`, `macos-latest`,
  `windows-latest`) and the `windows-latest` Git Bash shell expectation.
  Self-hosted runners and pinned Ubuntu image SHAs are deferred.
- **Editor / IDE config** (`.vscode/`, `.editorconfig`). Independent concern.
  Not addressed here.

### Cross-version conventions

This spec writes ONE design that all three release lines adopt. The differences
between lines are about ROLLOUT ORDER and FILE LOCATION, not about the design
itself. The conventions:

- **Node major: 22 LTS.** Single value, single file (`.nvmrc`), read by every
  tool. Why 22: it is the active LTS through 2027-04, has stable native ABI
  (NODE_MODULE_VERSION 127), and matches what Electron 33+ ships internally
  (so v0.2's Electron stays in lockstep).
- **pnpm: 10.x, exact minor pinned via `packageManager` field.** Why pnpm 10:
  v0.3 and v0.4 already require workspace support; v0.2 will follow once the
  lockfile migration risk is accepted (see §4 for the v0.2 high-risk
  caveat). Why exact minor pin: Corepack downloads exactly what
  `packageManager` says, so every contributor and every CI job runs
  byte-identical pnpm.
- **Activation: Corepack.** `corepack enable` is the ONLY supported way to get
  pnpm. Why not `npm i -g pnpm` or the `pnpm/action-setup` GHA: both can
  install a DIFFERENT pnpm than `packageManager` says, producing two-tier
  drift. Corepack reads `packageManager` and downloads exactly that.
- **Enforcement: `engines` + `engine-strict=true`.** `package.json#engines`
  declares the supported range; root `.npmrc` sets `engine-strict=true` so
  pnpm install hard-fails on a wrong host. Why hard-fail: a warning is a
  warning; teams ignore warnings until CI breaks. The right place to fail is
  at install time on the contributor's laptop, not 8 minutes into a CI run.

### Forever-stable shape

Pinning the Node MAJOR + pnpm MAJOR is a v0.3 ship-gate prerequisite — once
shipped, the pin file format and the enforcement mechanism do not change. The
only knobs that move post-v0.3 are:

- Node minor / patch bumps (v0.4 decision; small, mechanical, automatable
  later via Renovate).
- pnpm minor / patch bumps (same — tracked by `packageManager` field bump).
- Major Node bump (Node 24 LTS in 2025-10) is a v0.5+ migration, not in
  scope here.

What this means in practice: the design described in §2-§5 is the **final
shape** of CCSM's toolchain lock. v0.4 work on top of it (Renovate, possible
matrix testing) layers on; it does not replace.

### Relation to other specs

- **daemon-split design** (the v0.3 architecture spec, currently being written
  in parallel; will land at `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md`).
  Its monorepo-scaffold chapter (ch11) introduces `packages/{electron,daemon,proto}`,
  which have ALREADY landed on `working` as skeletons alongside
  `pnpm-workspace.yaml` + `pnpm-lock.yaml`. This spec's §4 (root vs
  packages/*) and §5 (reverse-verify matrix) cover how the pin lives at
  workspace root and is inherited by every package. The two specs intersect
  ONLY at that scaffold boundary.
- **PR #848** (already merged or in-flight at time of writing) added
  `"packageManager": "pnpm@10.33.2"` to root `package.json`. This spec
  formalizes that change as one piece of a cross-version policy and adds the
  missing pieces (`.nvmrc`, `engine-strict`, CI wiring, onboarding doc,
  release-candidate verify).
- **final-architecture spec** (`docs/superpowers/specs/2026-05-02-final-architecture.md`)
  is v0.4 product topology. It assumes a working toolchain; it does not
  speak to how that toolchain is pinned. No conflict.
- **v0.4 daemon-binary packaging.** v0.4 will package `@ccsm/daemon` as a
  single binary (via `sea` / `pkg` / `@yao-pkg/pkg` — final tool TBD in
  daemon-split spec). That packager INHERITS this toolchain pin: it embeds
  whatever Node `.nvmrc` specifies, and the binary's runtime ABI matches
  what `pnpm-lock.yaml` resolved against. Bumping `.nvmrc` is the single
  coordinated change that bumps the daemon binary's embedded Node too.
  See §6 v0.4 forward-compat. No separate daemon-toolchain pin file is
  needed; this spec's pin IS the v0.4 daemon binary's pin. The
  Connect-Node server (`@connectrpc/connect-node`, pure JS) is also Node 22
  compatible — no adjustment needed at the toolchain layer.

### Reading order

- §2 — Node 22 in `.nvmrc`, fnm/nvm/Volta auto-switch, CI consumption.
- §3 — `packageManager` field, Corepack flow, why no `pnpm/action-setup`.
- §4 — `engines` + `engine-strict=true`, root vs `packages/*` strategy,
  v0.2 high-risk callout.
- §5 — `ci.yml` diff, CONTRIBUTING update, release-candidate verify step,
  reverse-verify matrix.
- §6 — landing order across v0.2 main / v0.3 / v0.4, contributor-environment
  fallback playbook.

---

## §2 — Node version pinning

### Decision

CCSM pins to **Node 22 LTS** through a single `.nvmrc` file at repository
root. Every tool — local version managers (nvm, fnm, Volta), CI
(`actions/setup-node@v4`), release scripts — reads from that one file.

Why one file: the recurrent drift bug is "two places say two different
things." `.nvmrc` is the lowest-common-denominator format (a plain text file
containing a version specifier), supported natively by every Node version
manager since 2014. Choosing it as the source of truth means we never have
to keep two files in sync.

### File contents

`.nvmrc` at repo root:

```text
22
```

That is the entire file: the major version, no minor or patch. Why major-only:

- We want the LATEST 22.x security patch on every install, not a frozen
  patch from when the file was committed. Pinning `22.11.0` would force
  contributors to manually bump on every CVE.
- Node 22.x is binary-compatible across minors (NODE_MODULE_VERSION 127 is
  stable through the LTS line); native modules built against 22.0 work on
  22.99.
- If a future Node 22 minor breaks something (rare but historically
  possible), we pin tighter at that point — cheap, reactive, no upfront tax.

### Local consumption

#### nvm

`cd ccsm && nvm use` reads `.nvmrc` and switches. If the major isn't
installed, `nvm install` (no arg) reads `.nvmrc` and installs the latest 22.x.
No CCSM-specific config required.

#### fnm

`fnm` reads `.nvmrc` automatically when shell hooks are installed
(`fnm env --use-on-cd`). Documented in CONTRIBUTING (see §5 onboarding).

#### Volta

Volta reads `.nvmrc` only with the `VOLTA_FEATURE_PNPM=1` and explicit
`volta pin node@22` in `package.json#volta.node`. Why we do NOT pin via
`package.json#volta`: it duplicates the source of truth and Volta-only users
would override what `.nvmrc` says. CCSM's policy: Volta users either run
`volta pin node@22` once locally (it writes to `package.json` but we
gitignore that diff via a `.gitignore` rule on the `volta` block, OR we
document the manual pin as a one-time onboarding step). Recommended: the
manual one-time step. Why: keeping `volta` out of `package.json` avoids a
fourth-tool source of truth.

#### Corepack interaction

Node 22 ships Corepack 0.31+ in the box. Once `nvm use` selects 22, `pnpm`
becomes available via `corepack enable` (§3 covers this). No standalone
pnpm install is needed.

### CI consumption

`.github/workflows/ci.yml` `Setup Node` step changes from:

```yaml
- name: Setup Node
  uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'
```

to:

```yaml
- name: Setup Node
  uses: actions/setup-node@v4
  with:
    node-version-file: '.nvmrc'
    cache: 'pnpm'
```

Why `node-version-file: '.nvmrc'`: setup-node@v4 supports it natively and
parses the bare-major form. This eliminates the second source of truth.

Why cache changes from `npm` to `pnpm`: covered in §3 CI. The change is
coupled because v0.3 root migrates to pnpm; v0.2 root migration timing is in
§6.

### Cross-version application

- **v0.2 root** (npm + Electron-builder publish): `.nvmrc` lands at root in
  v0.2 main as a low-risk change. `cache: 'npm'` stays until v0.2 itself
  migrates to pnpm (which is a SEPARATE high-risk change tracked in
  §4 v0.2 root). Pinning Node alone in v0.2 is safe — we go from
  Node 20 (current `ci.yml`) to Node 22, which is 2 LTS jumps. Why safe: we
  control the Node version on every CI runner, and every dependency in
  current `package.json` already supports Node 22 (Electron 33+, all
  `@electron/*`, vitest 2.x, webpack 5.x). The migration cost is one CI
  cycle to confirm.
- **v0.3 packages/*** (pnpm workspace; scaffold already on `working`):
  `.nvmrc` is inherited from root. Each `packages/*/package.json` MAY also
  list `engines.node` for clarity (§4 covers this), but the `.nvmrc` file
  is not duplicated.
- **v0.4 and beyond**: same `.nvmrc`, same mechanism. Renovate (deferred to
  v0.4) bumps the file when Node 22.x hits a new LTS minor IF we decide to
  tighten the pin later. Until then, the file stays at `22`.

### Why not alternatives

- **`.node-version`** (used by some asdf / nodenv users) — additionally
  parsed by setup-node@v4, but `.nvmrc` has wider tool support. Pick one;
  picking the one with the larger install base. We explicitly do NOT add
  both files — that re-introduces the dual source of truth.
- **`engines.node`-only** (no `.nvmrc`) — `engines` is a constraint, not an
  installer. nvm doesn't read it; CI's setup-node doesn't read it. We use
  BOTH (`.nvmrc` for installation, `engines.node` for enforcement) — see
  §4.
- **`package.json#volta`-only** — Volta-specific; alienates nvm/fnm users
  who outnumber Volta users in CCSM's contributor pool today.

### Verification

- `node --version` after `cd ccsm` (with shell hook) shows `v22.x.y`.
- `cat .nvmrc` shows `22` (one line, no whitespace).
- `actions/setup-node@v4` log line in CI shows
  `Resolved node version 22.x.y from .nvmrc`.

See §5 reverse-verify matrix for the full local + CI smoke test.

---

## §3 — pnpm pinning via Corepack

### Decision

CCSM pins **pnpm** through the `packageManager` field in root `package.json`,
activated by **Corepack**. No standalone pnpm install is supported, locally
or in CI. PR #848 already added the field; this chapter formalizes the policy
around it.

Root `package.json`:

```json
{
  "packageManager": "pnpm@10.33.2+sha512.<TODO-128-hex-hash>"
}
```

Why exact minor + patch: Corepack reads this string verbatim and downloads
EXACTLY that pnpm. Two contributors with different `packageManager` values
would produce two different lockfiles. Pinning to a patch eliminates that
class of bug entirely; bumping is a single one-line PR when we want a new
version.

Why the `+sha512.<hash>` integrity suffix: Corepack 0.31+ verifies the
downloaded pnpm tarball against this hash before activation. Without the
hash, Corepack trusts the npm registry response (TLS + registry signing —
no application-layer pin). The supply-chain attack this defeats: a
compromised npm registry account republishing `pnpm@10.33.2` with
malicious bytes. With the hash present, every contributor and every CI
job fails activation immediately. Cost: one line. The actual hash is
extracted during PR D preflight via:

```bash
npm view pnpm@10.33.2 dist.integrity
# OR pull from https://github.com/pnpm/pnpm/releases/tag/v10.33.2
```

The `<TODO-128-hex-hash>` placeholder is replaced with the real hash in
the same PR D commit that regenerates `pnpm-lock.yaml` (see §6 v0.2
main rollout PR D preflight). Renovate (deferred to v0.4) bumps both the
version AND the hash atomically when pnpm releases a new patch.

### Onboarding flow

The first command a new contributor runs after `git clone` is:

```bash
corepack enable
```

Then `pnpm install` Just Works — Corepack intercepts the `pnpm` shim,
reads `packageManager`, downloads pnpm 10.33.2 if not cached, and runs it.

No `npm i -g pnpm`. No `brew install pnpm`. No `pnpm/action-setup` in CI.
Why: each of those mechanisms installs SOME pnpm version, often not the one
`packageManager` says. Two-tier drift returns.

The single-command onboarding (`corepack enable`) is documented in
§5 onboarding.

> **Footnote — Corepack behind a corporate proxy:** Node 22 ships
> Corepack 0.31+, which enforces signature verification of downloaded
> package-manager tarballs against the npm registry's signing keys. If
> the contributor's network blocks `https://registry.npmjs.org` (common
> on corporate firewalls), `corepack enable` succeeds silently but
> `pnpm install` (which triggers Corepack to download pnpm@10.33.2
> lazily) fails with `Error: Cannot find matching keyid`. Workarounds:
> (a) point Corepack at an internal mirror via `COREPACK_NPM_REGISTRY`
> (preferred — keeps the integrity check on the mirror's bytes); or
> (b) as a last resort, set `COREPACK_INTEGRITY_KEYS=0` in the shell
> profile and re-run `corepack enable` (disables the signature check,
> falling back to TLS-only trust). See nodejs/corepack#612. The
> contributor-environment fallback playbook in §6 contributor-environment
> fallback covers this.

### CI consumption

The `lint-typecheck-test` job in `.github/workflows/ci.yml` does NOT add a
separate "Setup pnpm" step. Why: `actions/setup-node@v4` invokes Corepack
internally when `cache: 'pnpm'` is requested — it reads `packageManager` and
provisions the matching pnpm before the cache step runs.

The relevant CI block (full diff in §5 ci.yml):

```yaml
- name: Setup Node
  uses: actions/setup-node@v4
  with:
    node-version-file: '.nvmrc'
    cache: 'pnpm'

- name: Install deps
  run: pnpm install --frozen-lockfile
```

No `pnpm/action-setup@v3` step. We MUST NOT add one. Why this is a known
trap: `pnpm/action-setup` defaults to whatever version is in its own input
(or its action default), which can differ from `packageManager`. When both
are present, the order of evaluation determines which wins, and the loser
silently produces a divergent lockfile.

Why `--frozen-lockfile` in CI: any drift between `pnpm-lock.yaml` and
`package.json#dependencies` should fail the install, not silently rewrite
the lockfile. This is the pnpm equivalent of `npm ci`'s strict mode.

### Cross-version application

- **v0.2 root** (currently npm): the `packageManager` field is present (PR
  #848). However, until v0.2 root itself migrates from `npm ci` to
  `pnpm install` in scripts and in `ci.yml`, the field is informational only
  for v0.2. The migration is a separate high-risk task tracked in
  §6 v0.2 rollout. Why high-risk: `npm`'s and `pnpm`'s lockfile formats
  are not interchangeable; `electron-builder`'s postinstall hooks have
  documented friction with pnpm's symlink-style `node_modules` layout
  (`node-linker=hoisted` is a workaround, see §4). We sequence carefully.
- **v0.3 packages/***: born pnpm-native. The workspace is defined in
  `pnpm-workspace.yaml`; every package inherits `packageManager` from root.
  No per-package `packageManager` field — that would re-introduce drift.
- **v0.4**: same. Renovate (deferred to v0.4) will keep `packageManager`
  bumped to the latest pnpm 10.x patch automatically.

### Workspace configuration

The v0.3 monorepo scaffold landed via PR #848 (merged 2026-05-03 as
`81ddaca`). To avoid future provenance confusion, this section splits
"already on `working`" from "added by THIS spec":

**Already on `working` (PR #848 — do not re-add):**

- `pnpm-workspace.yaml` (root)
- `packages/{electron,daemon,proto}` skeletons
- `pnpm-lock.yaml` (will be regenerated under the pinned toolchain in
  PR D — see §6 v0.2 main rollout PR D preflight)
- `"packageManager": "pnpm@10.33.2"` in root `package.json`
  (PR D adds the `+sha512.<hash>` integrity suffix per the decision above)
- `.npmrc` containing only `clang=0`

**Added by this spec (PR D):**

- `.nvmrc` (Node 22, §2)
- `engines` field in root + per-package `package.json` (§4)
- `engine-strict=true` in root `.npmrc` (§4 root .npmrc — canonical)
- `node-linker=hoisted` in root `.npmrc` (§4 root .npmrc — canonical;
  see below for the WHY)

Current `pnpm-workspace.yaml` contents:

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
```

For toolchain-lock purposes, the relevant pnpm setting on top of this
workspace file is `node-linker=hoisted`, added to root `.npmrc` in PR D
(see §4 root .npmrc for the final `.npmrc` content and the precise
mechanism). Why `node-linker=hoisted`:

Native modules (`better-sqlite3`, `node-pty`) plus Electron's `app.asar`
packing both assume a flat `node_modules` tree. pnpm's default `isolated`
linker uses symlinks, which break Electron-builder on Windows (junctions
don't survive ASAR packing). `hoisted` makes pnpm behave like npm for
layout purposes while still using its content-addressable store for speed.

**Critical sequencing**: `node-linker=hoisted` MUST land BEFORE any
`packages/electron` build is attempted post-PR-D, otherwise Windows ASAR
packing breaks. Because PR D bundles the `.npmrc` change with the
pnpm-install flip in one atomic commit, this ordering is automatic — but
a fixer working from an earlier draft of this chapter might miss it. The
guarantee is: PR D adds `node-linker=hoisted` to `.npmrc` in the same
commit that flips `package.json#scripts` to `pnpm` and CI to
`pnpm install --frozen-lockfile`.

Trade-off: `hoisted` re-enables npm-style phantom dependencies; a package
can `require()` any hoisted sibling. We accept this for Electron compat;
auditing real first-party deps requires reading `package.json` not
`node_modules/`.

This is an architectural decision, not a workaround: Electron + native
modules will keep needing flat layout for the foreseeable future. We commit
to `hoisted` for the lifetime of CCSM's Electron client.

### Why not alternatives

- **`pnpm/action-setup` GHA + explicit version input** — two sources of
  truth (`action.with.version` and `packageManager`). One always wins
  silently. Eliminated.
- **Volta-managed pnpm** (`volta pin pnpm@10`) — Volta-only; doesn't help
  CI; duplicates source of truth. Eliminated.
- **`npm` for everything (don't migrate to pnpm)** — npm has no real
  workspace primitive that survives Electron + native modules well; v0.3's
  monorepo scaffold needs `pnpm-workspace.yaml`. Decision is upstream of
  this spec.
- **yarn berry** — not on the table; team has no yarn experience and yarn 4
  has its own Corepack story that doesn't simplify anything.

### Verification

- `pnpm --version` after `corepack enable` shows `10.33.2` (exact).
- `which pnpm` resolves to a Corepack shim, not `/opt/homebrew/bin/pnpm` or
  similar global install.
- CI log shows `Setup pnpm version: 10.33.2` from setup-node's Corepack
  invocation.
- **Frozen-lockfile drift gate** — explicit command sequence (NOT just
  "exits 0 with no lockfile modification"):
  ```bash
  pnpm install --frozen-lockfile
  git diff --exit-code pnpm-lock.yaml
  ```
  Both must succeed. The explicit `git diff --exit-code` makes drift
  visible even if `--frozen-lockfile` somehow accepted a mutation
  (defense-in-depth against future pnpm regressions, and against a
  contributor "fixing flaky CI" by dropping `--frozen-lockfile`).

See §5 reverse-verify matrix for the integrated check.

---

## §4 — engines + engine-strict enforcement

### Decision

CCSM declares `engines` in every `package.json` (root and `packages/*`) and
sets `engine-strict=true` in root `.npmrc`. Together these turn the soft
"Node version requirement" into a hard install-time failure.

Why hard-fail: a warning is a no-op. Contributors who skip `corepack enable`
or run an old Node still get to `pnpm install` and produce a half-broken
checkout that fails later in test or build with a confusing error. We want
the failure at the earliest, most diagnostic point: install.

### Root `package.json#engines`

```json
{
  "engines": {
    "node": "22.x",
    "pnpm": ">=10.33.2 <11"
  }
}
```

Why ranges (`22.x`, `>=10.33.2 <11`) and not bare exact pins:

- The exact patch pin is already enforced elsewhere — Node by `.nvmrc` + CI
  setup-node; pnpm by `packageManager: pnpm@10.33.2` + Corepack.
- The role of `engines` is the BACKSTOP: catch the case where someone
  bypassed `.nvmrc` (e.g. using a system Node 18 without nvm) OR bypassed
  Corepack (e.g. set `COREPACK_ENABLE_STRICT=0` and ran an older `pnpm`
  manually) and tried to `pnpm install` anyway.
- `engines.pnpm` is `>=10.33.2 <11` (NOT `10.x`) so the backstop is at
  least as tight as `packageManager`. A loose `10.x` range would accept
  pnpm 10.0.0, which can produce different peer-dep / optional-dep
  resolutions than 10.33.2, making the engine-strict gate weaker than the
  primary lock. When `packageManager` is bumped to a new pnpm patch, both
  `packageManager` and `engines.pnpm` lower bound bump together (single
  coordinated change; Renovate v0.4 will keep them in sync).
- `engines.node: "22.x"` stays a range (not `22.11.0`) because `.nvmrc`
  already pins the major and we want the latest 22.x security patch on
  every install (see §2 file contents).

### Root `.npmrc`

```ini
# Toolchain lock — see docs/superpowers/specs/2026-05-03-toolchain-lock-design.md
engine-strict=true
```

Why in `.npmrc` not `package.json`: pnpm reads `engine-strict` from
`.npmrc` only. Setting it in `package.json#pnpm.engineStrict` (the legacy
location) is partially honored but not by all pnpm versions. `.npmrc` is the
canonical, future-stable location.

`.npmrc` is committed to the repo (NOT user-level `~/.npmrc`). Why
committed: a per-machine setting cannot enforce a project-wide policy.

#### Existing `.npmrc` content interaction

The repo's current `.npmrc` (verified on `working` branch) contains ONLY:

```ini
clang=0
```

(present to keep `@electron/node-gyp` from selecting ClangCL on Windows
fresh checkouts). Neither `engine-strict` nor `node-linker` is present on
`working` today. PR D APPENDS both; it does NOT replace. **This chapter
(§4) is the canonical spec location for the `node-linker=hoisted`
addition** — §3 workspace configuration cross-references here for the
mechanism, and §6 PR D file list cites §4 for the exact final-file
content. The final file after PR D:

```ini
# Node 22+ defaults process.config.variables.clang=1 on Windows, which
# @electron/node-gyp's common.gypi translates to msbuild_toolset=ClangCL.
# ClangCL is not installed in standard VS 2022 BuildTools, so better-sqlite3's
# native build fails with MSB8020 on fresh checkouts. Pin to 0 to use the
# default MSVC toolset.
clang=0

# Toolchain lock: refuse to install on a wrong Node/pnpm version.
# See engines field in package.json.
engine-strict=true

# Electron + native modules need flat node_modules; pnpm's default symlink
# layout breaks app.asar packing on Windows.
node-linker=hoisted
```

`node-linker=hoisted` is added at the same time per §3 workspace
configuration. The three settings are independent but ship together.

### `packages/*` engines (v0.3+)

Each package in `packages/*/package.json` repeats `engines.node` for the
benefit of any tool that scans an individual package in isolation
(publish-time validation, downstream consumers if we ever publish, IDE
hints). They do NOT need to repeat `engines.pnpm` — pnpm enforcement happens
at workspace install, not per-package.

```json
{
  "name": "@ccsm/daemon",
  "engines": {
    "node": "22.x"
  }
}
```

Why repeat: the cost is two lines per package; the benefit is that
`pnpm publish --filter @ccsm/daemon` or any future tooling that consumes a
single package gets the same constraint. Single source of truth is preserved
because the value is identical to root.

### Root vs `packages/*` strategy summary

| Field | Root | packages/* |
|---|---|---|
| `.nvmrc` | yes | inherited (no file in package) |
| `packageManager` | yes (pnpm@10.33.2) | NO (would create drift) |
| `engines.node` | yes (`22.x`) | yes (`22.x`, identical) |
| `engines.pnpm` | yes (`>=10.33.2 <11`) | NO (root install enforces) |
| `.npmrc` engine-strict | yes | inherited (no file in package) |
| `node-linker` | yes (`hoisted`) | inherited |

Why this split: every setting that must be enforced exactly once goes at
root. Every setting that aids per-package introspection (just `engines.node`
today) is duplicated with the SAME value. Drift is impossible because root
is the only writable place during normal contributor work — `packages/*`
`engines.node` lines change only via the v0.4 Renovate config (deferred)
or a single coordinated PR if we ever bump major.

### v0.2 root: high-risk callout

Adding `engine-strict=true` to v0.2 root TODAY is a breaking change for any
existing contributor running Node 20 (current ci.yml default) or older. They
will get:

```text
ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)
Your Node version is incompatible with "ccsm@0.2.0".
Expected version: 22.x
Got: 20.18.0
```

This is the desired behavior — but it MUST be sequenced behind:

1. The v0.2 main branch CI already running Node 22 (so contributors who pull
   and rebase don't get a broken local + green CI mismatch).
2. CONTRIBUTING / README onboarding updated with the `nvm install`/`fnm install`/
   `corepack enable` instructions FIRST.
3. A pinned announcement in the project's contributor channel (issue or
   discussion) with a 1-week notice window.

The rollout sequence is in §6 v0.2 rollout. The v0.2 root change is
listed there as a **single high-risk task** (not bundled with the lower-risk
`.nvmrc` + CI Node 22 bump). The reason for splitting: rollback of
engine-strict is one-line revert; rollback of the bundled change costs more.

### v0.3 + v0.4

No high-risk callout. v0.3's `packages/*` is born with these settings; no
contributor has a working v0.3 checkout WITHOUT them, so engine-strict is a
day-one constraint, not a transition.

### Why not alternatives

- **`engine-strict=true` only, no `engines` field** — engine-strict needs
  something to check against. Eliminated by construction.
- **`engines.node: ">=22"`** — allows Node 24 LTS when it ships, which we
  haven't validated. We pin to the current major (`22.x`); a future major
  bump is an explicit PR.
- **JS-level `process.versions.node` assertion in a postinstall script** —
  brittle (postinstall runs AFTER deps install, so any deps that broke
  during install have already broken); eliminated by engine-strict which
  runs BEFORE deps install.

### Verification

- `pnpm install` on a Node 18 host fails with `ERR_PNPM_UNSUPPORTED_ENGINE`
  before downloading any dep.
- `pnpm install` on a Node 22 host with `pnpm@9` (forced via
  `COREPACK_ENABLE_STRICT=0 pnpm install`) fails with the pnpm-version
  variant of the same error.
- `pnpm install` on Node 22 + Corepack-resolved pnpm 10.33.2 succeeds.
- **Frozen-lockfile drift gate**: on a host where `package.json` has been
  hand-edited to add a phantom dep without re-running install,
  `pnpm install --frozen-lockfile` exits non-zero (NOT silently rewriting
  the lockfile). This is the supply-chain control that makes the engine
  pin meaningful — without it, a contributor with the wrong pnpm could
  still drift the lockfile silently.

---

## §5 — CI wiring, onboarding, release verify, reverse-verify matrix

### CI: `.github/workflows/ci.yml` diff

The `lint-typecheck-test` job is the only CI job that needs toolchain
changes (e2e.yml, release.yml inherit the same setup pattern; same diff
applies). Below is the relevant section before/after.

#### Before (current main)

```yaml
- name: Setup Node
  uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'

- uses: actions/setup-python@v5
  with:
    python-version: '3.11'

- name: Cache node_modules
  id: nm_cache
  uses: actions/cache@v4
  with:
    path: node_modules
    key: nm-${{ runner.os }}-${{ runner.arch }}-node20-${{ hashFiles('package-lock.json') }}

- name: Install deps
  if: steps.nm_cache.outputs.cache-hit != 'true'
  run: npm ci --legacy-peer-deps
  env:
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1'

- name: Rebuild better-sqlite3 for Node
  run: npm rebuild better-sqlite3
```

#### After (toolchain-lock applied; v0.2 root once migrated to pnpm)

```yaml
- name: Setup Node
  uses: actions/setup-node@v4
  with:
    node-version-file: '.nvmrc'
    cache: 'pnpm'

- uses: actions/setup-python@v5
  with:
    python-version: '3.11'

- name: Cache pnpm store
  uses: actions/cache@v4
  with:
    path: ~/.local/share/pnpm/store
    key: pnpm-store-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('pnpm-lock.yaml') }}

- name: Install deps
  run: pnpm install --frozen-lockfile
  env:
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1'

- name: Rebuild better-sqlite3 for Node
  run: pnpm rebuild better-sqlite3
```

Diff highlights:

- `node-version: '20'` → `node-version-file: '.nvmrc'`. Source of truth
  follows the file.
- `cache: 'npm'` → `cache: 'pnpm'`. setup-node@v4 invokes Corepack to
  provision pnpm before caching, so no separate pnpm setup step is needed.
- The bespoke `Cache node_modules` step is replaced with the standard
  `pnpm store` cache. Why the change: pnpm's content-addressable store is
  designed to be cached and shared across projects/branches; caching
  `node_modules` directly (the v0.2 npm-era trick) defeats pnpm's hardlink
  optimization. The `pnpm install --frozen-lockfile` step rebuilds the
  symlink/hoist tree from the cached store fast (~5-10s on warm cache).
- `npm ci --legacy-peer-deps` → `pnpm install --frozen-lockfile`.
  `--legacy-peer-deps` is npm-specific; pnpm's resolver handles peer deps
  correctly without that flag.
- `npm rebuild` → `pnpm rebuild`. Same semantics.

#### Cache key migration note

The cache key changes (from `nm-…-${hashFiles('package-lock.json')}` to
`pnpm-store-…-${hashFiles('pnpm-lock.yaml')}`). Old caches are not reused
and will be evicted by GitHub's 7-day LRU policy. Why this is fine: it's a
one-time migration cost; subsequent builds populate the new key.

**PR A cache-key sub-fix (must ship in PR A, not deferred to PR D):** the
current `Cache node_modules` step on `working` embeds the literal string
`node20` in its key (`nm-…-node20-${hashFiles('package-lock.json')}`). PR A
bumps the runtime to Node 22 but stays on `npm ci` (engine-strict not yet
on). If the `node20` literal is left unchanged, all PR A builds get a
cache HIT on a `node_modules/` rebuilt against Node 20 ABI; native modules
(`better-sqlite3`, `node-pty`) then load against Node 22 →
`NODE_MODULE_VERSION` mismatch → mysterious CI failure on the PR that's
supposed to be "low-risk". Fix: PR A renames the literal to `node22` (or
to `${{ steps.setup.outputs.node-version }}` to be self-updating). This is
part of the same low-risk PR because it's the same Node-version concern.

#### Why `pnpm install` is unconditional (no `if: cache-miss` guard)

`pnpm install --frozen-lockfile` against a populated store is fast (~5-10s)
and DETERMINISTIC. The npm-era `if: cache-hit != 'true'` skip was
necessary because `npm ci` was slow (~178s on Windows per existing CI
comments) AND would trigger native rebuilds. With pnpm + cached store +
explicit `pnpm rebuild better-sqlite3` step, installing every run is
cheaper than the conditional logic and removes a class of "stale node_modules"
bugs.

### Onboarding: CONTRIBUTING.md / README

Add a single section near the top of CONTRIBUTING.md (also linked from README
"Getting started"):

````markdown
## Toolchain setup

CCSM pins its Node and pnpm versions. Run these once after `git clone`:

1. Install a Node version manager if you don't have one:
   - macOS / Linux: [`fnm`](https://github.com/Schniz/fnm) (recommended) or
     [`nvm`](https://github.com/nvm-sh/nvm).
   - Windows: [`fnm`](https://github.com/Schniz/fnm) (works in Git Bash and
     PowerShell) or [`nvm-windows`](https://github.com/coreybutler/nvm-windows).

2. Switch to the project's Node:
   ```bash
   cd ccsm
   nvm use     # or `fnm use` — both read .nvmrc
   ```
   If the version isn't installed, `nvm install` / `fnm install` (no args)
   installs the version from `.nvmrc`.

3. Enable Corepack (ships with Node 22; activates the pinned pnpm):
   ```bash
   corepack enable
   ```

4. Install dependencies:
   ```bash
   pnpm install
   ```

If `pnpm install` fails with `ERR_PNPM_UNSUPPORTED_ENGINE`, your Node
version isn't 22.x. Re-run step 2.
````

Why prescriptive ordering (1 → 4): each step has a precise prerequisite.
fnm/nvm chooses Node; Node ships Corepack; Corepack provides pnpm; pnpm
installs deps. Skipping any step produces a confusing error later.

Volta users: a one-time `volta pin node@22` is documented as a footnote, not
the main path. Why: keeping the main path single-fork (nvm OR fnm) reduces
support surface.

### Release-candidate verify

`scripts/release-candidate.sh` (or wherever the v0.2 release is cut from)
gains a preflight block before any build/publish step:

```bash
#!/usr/bin/env bash
set -euo pipefail

# --- toolchain verify ---------------------------------------------------
# Precheck: ensure the tools we need are on PATH so we can produce a
# diagnostic error rather than 'command not found'. This matters most on
# Windows Git Bash freshly-cloned hosts where Node may not be on PATH at
# all (no nvm/fnm) and where Corepack hasn't yet prepared pnpm.
command -v node >/dev/null 2>&1 || {
  echo "FATAL: 'node' not on PATH. Install via fnm/nvm and run 'nvm use'."
  exit 1
}
command -v pnpm >/dev/null 2>&1 || {
  echo "FATAL: 'pnpm' not on PATH. Run 'corepack enable'."
  exit 1
}

expected_node=$(cat .nvmrc)
actual_node_major=$(node -p 'process.versions.node.split(".")[0]')
if [[ "${actual_node_major}" != "${expected_node}" ]]; then
  echo "FATAL: release host runs Node ${actual_node_major}, .nvmrc says ${expected_node}"
  echo "Run: nvm use     (or fnm use)"
  exit 1
fi

expected_pnpm=$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")
actual_pnpm=$(pnpm --version)
if [[ "${actual_pnpm}" != "${expected_pnpm}" ]]; then
  echo "FATAL: pnpm ${actual_pnpm}, package.json wants ${expected_pnpm}"
  echo "Run: corepack enable"
  exit 1
fi
# ------------------------------------------------------------------------
```

Why a release-script-level guard in addition to engine-strict: cutting a
release is the single highest-impact mistake surface. A wrong-version build
that ships to users is much costlier than a wrong-version dev install.
Engine-strict catches local-dev mistakes; the release-script preflight
catches the "release manager forgot to `nvm use` after a system update"
class of mistake. Belt and suspenders is justified for release.

The same block is suitable for inclusion in any future
`scripts/preflight.sh` invoked by other production-cutting workflows.

### Reverse-verify matrix

Before declaring the toolchain-lock work done, reproduce a full clean install
on the three primary contributor environments + CI runners. Reverse-verify
matrix:

| # | Environment | Manager | Command sequence |
|---|---|---|---|
| 1 | macOS arm64, fresh checkout | fnm | `fnm install` (auto from .nvmrc) → `corepack enable` → `pnpm install` → `pnpm test` |
| 2 | Linux x64, GHA `ubuntu-latest` runner | (CI) actions/setup-node@v4 | runs ci.yml as written; expected: green |
| 3 | Windows 11, Git Bash | fnm | same as macOS row |
| 4 | (Optional, v0.4) Linux ARM64 self-hosted | fnm | same |

Why these three (rows 1-3) as the baseline: row 1 is the dominant dev
environment (most maintainers on Apple Silicon); row 2 is the only CI
environment that gates merges; row 3 is the OS where every drift bug has
historically surfaced (better-sqlite3 native build, path separators, shell
quoting). If all three pass clean install + clean test, ship.

Row 4 is deferred — no current self-hosted runner. Listed for v0.4
visibility.

#### Per-row pass criteria

For each row, run the explicit command sequence (NOT just "no lockfile
diff" as a soft observation):

- `pnpm install --frozen-lockfile && git diff --exit-code pnpm-lock.yaml`
  exits 0 — frozen-lockfile is the supply-chain drift gate; explicit
  `git diff --exit-code` makes drift visible even if `--frozen-lockfile`
  somehow accepted a mutation.
- `pnpm test` (or `npm test` for v0.2 pre-migration) exits 0.
- `pnpm rebuild better-sqlite3` exits 0 (proves native ABI alignment).
- `node --version` matches `.nvmrc`.
- `pnpm --version` matches `packageManager` (strip the `+sha512.<hash>`
  suffix for the comparison).

Failures on any row block the rollout. Diagnostic playbook in
§6 contributor-environment fallback.

### Cross-references

- Node pin source of truth: §2 file contents.
- pnpm pin source of truth: §3 decision.
- engine-strict mechanism: §4 root .npmrc.
- v0.2-specific rollout sequencing: §6 v0.2 rollout.

---

## §6 — Rollout across v0.2, v0.3, v0.4

### Rollout principle

The toolchain lock is FIVE small pieces (Node `.nvmrc`, pnpm
`packageManager`, engines, engine-strict, `node-linker=hoisted`) plus CI
wiring. Different release lines absorb them at different times because they
have different risk profiles. The principle: each release line gets the
pieces in the order that minimizes contributor breakage, NOT the order that
finishes the rollout fastest.

### v0.2 main rollout

v0.2 main is the highest-risk surface because it has the largest live
contributor population AND uses npm + electron-builder publish, both of
which have historical friction with pnpm migration.

#### Sequence

1. **PR A (low-risk): add `.nvmrc`, bump CI to Node 22.**
   - Files: `.nvmrc` (new), `.github/workflows/ci.yml` (node-version → 22
     AND `Cache node_modules` key literal `node20` → `node22` per §5
     cache key migration note PR A sub-fix), `.github/workflows/e2e.yml`
     (same), `.github/workflows/release.yml` (same).
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
   - Files NEWLY created in PR D: `engines` field added to root + each
     `packages/*/package.json`; `engine-strict=true` and `node-linker=hoisted`
     APPENDED to existing root `.npmrc` (which today contains only `clang=0`
     — see §4 existing `.npmrc` content interaction); release-candidate
     verify block in `scripts/release-candidate.sh`.
   - Files MODIFIED: `package.json#scripts` (only the lines that shell out to
     a package manager — most `tsc`/`vitest`/`eslint` calls don't need
     changes); `.github/workflows/{ci,e2e,release}.yml` (`npm ci
     --legacy-peer-deps` → `pnpm install --frozen-lockfile`, cache step
     changes per §5).
   - Files REGENERATED: `pnpm-lock.yaml` (already exists on `working` from
     PR #848 / 81ddaca, but its provenance is unknown; PR D regenerates it
     under the pinned toolchain — see preflight below).
   - Files DELETED: `package-lock.json` (still present alongside
     `pnpm-lock.yaml` on `working` today; the dual-lockfile state is the
     synchronization gap PR D closes).
   - Files PRESERVED AS-IS: `pnpm-workspace.yaml`, `packages/*` skeletons
     (already correct from PR #848); `packageManager` field in root
     `package.json` (already `pnpm@10.33.2`; PR D may add the `+sha512.<hash>`
     integrity suffix per §3 decision).
   - **Synchronization invariant**: the moment CI flips to `pnpm install
     --frozen-lockfile`, `package-lock.json` MUST be removed in the same
     commit; otherwise `npm ci` continues to "work" locally and silently
     diverges from CI. This is the entire reason PR D exists as ONE atomic
     change.
   - **Lockfile-provenance preflight (run BEFORE pushing PR D)**: on a host
     where `node --version` matches `.nvmrc` (Node 22.x) and `pnpm --version`
     matches `packageManager` (10.33.2 from Corepack), execute:
     ```bash
     rm pnpm-lock.yaml package-lock.json
     pnpm install
     git add pnpm-lock.yaml
     ```
     Commit the regenerated `pnpm-lock.yaml` in PR D. This guarantees the
     shipped lockfile is provenance-pinned to the pinned toolchain so the
     first contributor's `pnpm install --frozen-lockfile` post-merge
     succeeds without checksum mismatch on native deps (`better-sqlite3`,
     `node-pty`).
   - Risk: HIGH. Lockfile format change, package manager change, install
     mechanism change, all in one atomic PR.
   - Why atomic: half-migrated state (e.g. pnpm-lock.yaml present but
     scripts still call npm) is worse than either pure state.
   - Mitigation: dedicated reviewer pass on release.yml (Electron-builder
     interactions); reverse-verify matrix from §5 reverse-verify matrix
     run by hand on 3 environments before merge; pinned rollback note in
     PR description with the exact commands to revert.
   - Rollback: revert PR D restores npm; `package-lock.json` comes back from
     git. PR A/B are independent and stay.

#### Why FOUR PRs, not one

A single mega-PR touches `.nvmrc`, `package.json`, `.npmrc`,
`pnpm-lock.yaml` (new ~5000-line file), every workflow YAML, every script,
and CONTRIBUTING simultaneously. Reviewer fatigue guarantees something
slips. Splitting:

- PR A is a 4-line workflow tweak + new 1-line file. Easy to review/revert.
- PR B is a doc PR. Trivial.
- PR C is process, not code.
- PR D is the unavoidable atomic change; everything that doesn't NEED to
  be in it has been pulled out.

### v0.3 packages/* rollout

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

The PRs in the v0.2 main rollout above land all of these. Per-package
`engines.node: "22.x"` is added to each `packages/*/package.json` in PR D
(same atomic change — they are 2-line additions and skipping them
re-introduces the inconsistency this spec exists to prevent).

No separate v0.3 PR is needed — the scaffold is already there to receive
the lock. This is a happy accident of timing; if PR #848 + the workspace
scaffold had landed AFTER toolchain-lock, the "v0.3" rollout would have
been bundled into PR D too.

### v0.4 follow-ups (deferred work, listed for completeness)

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
- **Self-hosted ARM64 runner.** Listed in §5 reverse-verify matrix
  row 4. Not a toolchain-lock concern per se; just inherits the same
  setup-node pattern when added.

### Contributor-environment fallback playbook

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
6. **Corepack signature error behind corporate proxy**: if `pnpm install`
   fails with `Error: Cannot find matching keyid` (Corepack 0.31+ verifies
   signatures of downloaded package-manager tarballs against npm registry
   keys), the contributor's network is likely blocking
   `https://registry.npmjs.org`. Fix: point Corepack at an internal mirror
   via `COREPACK_NPM_REGISTRY=<internal-mirror-url>` in the shell profile;
   as a last resort, set `COREPACK_INTEGRITY_KEYS=0` to fall back to
   TLS-only trust. See nodejs/corepack#612 and §3 onboarding flow
   footnote.

This playbook is referenced from CONTRIBUTING.md as "If install fails, see
TOOLCHAIN-DEBUG.md" — but the content lives ONLY in CONTRIBUTING.md (no
duplicate file). Why: a separate file would drift from CONTRIBUTING.md
over time.

### Done criteria for the rollout

The toolchain-lock initiative is "shipped" when:

- v0.2 PR A, B, D are all merged on `working` branch.
- PR C announcement was posted ≥7 days before PR D merged (PR C is
  process-only and not directly testable as a merged commit; this bullet
  lets a tester verify the 1-week grace window was honored by checking the
  pinned issue / discussion timestamp against PR D's merge timestamp).
- CI on `working` is green for 3 consecutive days.
- Reverse-verify matrix passes on rows 1-3.
- v0.3 monorepo scaffold (already on `working` since PR #848 / 81ddaca) is
  verified compatible with the pinned toolchain — i.e. PR D lands on top of
  the existing scaffold without requiring any change to
  `pnpm-workspace.yaml` or `packages/*` skeleton structure.
- Zero open issues mentioning "ERR_PNPM_UNSUPPORTED_ENGINE" or
  "wrong Node version" in the past 7 days (i.e. contributors have absorbed
  the change).

When all six conditions hold, declare done and close the parent task.

### v0.4 forward-compat: daemon binary packaging

The v0.4 daemon-split work will package `@ccsm/daemon` as a single binary
(via `sea` / `pkg` / `@yao-pkg/pkg` — final tool TBD in daemon-split spec).
That packager INHERITS this toolchain pin: it embeds whatever Node the
project's `.nvmrc` says, and the binary's runtime ABI matches what
`pnpm-lock.yaml` resolved against. **No separate toolchain pin is needed
for the daemon binary** — bumping `.nvmrc` is the single coordinated change
that bumps the daemon binary's embedded Node too. Verification step (added
in v0.4 daemon-split spec, not here): `./dist/ccsm_native --version` reports
a Node major matching `.nvmrc`. This forward-compat note exists so v0.4
work doesn't introduce a parallel "daemon toolchain pin" file.
