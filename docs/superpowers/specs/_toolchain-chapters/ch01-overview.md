# ch01 — Overview: cross-version toolchain lock

## Context

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

## Scope

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

## Cross-version conventions

This spec writes ONE design that all three release lines adopt. The differences
between lines are about ROLLOUT ORDER and FILE LOCATION, not about the design
itself. The conventions:

- **Node major: 22 LTS.** Single value, single file (`.nvmrc`), read by every
  tool. Why 22: it is the active LTS through 2027-04, has stable native ABI
  (NODE_MODULE_VERSION 127), and matches what Electron 33+ ships internally
  (so v0.2's Electron stays in lockstep).
- **pnpm: 10.x, exact minor pinned via `packageManager` field.** Why pnpm 10:
  v0.3 and v0.4 already require workspace support; v0.2 will follow once the
  lockfile migration risk is accepted (see `ch04-engines-strict.md` for the
  v0.2 high-risk caveat). Why exact minor pin: Corepack downloads exactly
  what `packageManager` says, so every contributor and every CI job runs
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

## Forever-stable shape

Pinning the Node MAJOR + pnpm MAJOR is a v0.3 ship-gate prerequisite — once
shipped, the pin file format and the enforcement mechanism do not change. The
only knobs that move post-v0.3 are:

- Node minor / patch bumps (v0.4 decision; small, mechanical, automatable
  later via Renovate).
- pnpm minor / patch bumps (same — tracked by `packageManager` field bump).
- Major Node bump (Node 24 LTS in 2025-10) is a v0.5+ migration, not in
  scope here.

What this means in practice: the design described in ch02-ch05 is the **final
shape** of CCSM's toolchain lock. v0.4 work on top of it (Renovate, possible
matrix testing) layers on; it does not replace.

## Relation to other specs

- **daemon-split design** (the v0.3 architecture spec, currently being written
  in parallel; will land at `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md`).
  Its monorepo-scaffold chapter (ch11) introduces `packages/{electron,daemon,proto}`,
  which have ALREADY landed on `working` as skeletons alongside
  `pnpm-workspace.yaml` + `pnpm-lock.yaml`. This spec's `ch04 §root vs
  packages/*` and `ch05 §reverse-verify matrix` cover how the pin lives at
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

## Reading order

- `ch02-node-pinning.md` — Node 22 in `.nvmrc`, fnm/nvm/Volta auto-switch,
  CI consumption.
- `ch03-pnpm-pinning.md` — `packageManager` field, Corepack flow, why no
  `pnpm/action-setup`.
- `ch04-engines-strict.md` — `engines` + `engine-strict=true`, root vs
  `packages/*` strategy, v0.2 high-risk callout.
- `ch05-ci-and-onboarding.md` — `ci.yml` diff, CONTRIBUTING update,
  release-candidate verify step, reverse-verify matrix.
- `ch06-rollout.md` — landing order across v0.2 main / v0.3 / v0.4,
  contributor-environment fallback playbook.
