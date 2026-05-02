# ch03 — pnpm pinning via Corepack

## Decision

CCSM pins **pnpm** through the `packageManager` field in root `package.json`,
activated by **Corepack**. No standalone pnpm install is supported, locally
or in CI. PR #848 already added the field; this chapter formalizes the policy
around it.

Root `package.json`:

```json
{
  "packageManager": "pnpm@10.33.2"
}
```

Why exact minor + patch: Corepack reads this string verbatim and downloads
EXACTLY that pnpm. Two contributors with different `packageManager` values
would produce two different lockfiles. Pinning to a patch eliminates that
class of bug entirely; bumping is a single one-line PR when we want a new
version.

## Onboarding flow

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
`ch05 §onboarding`.

## CI consumption

The `lint-typecheck-test` job in `.github/workflows/ci.yml` does NOT add a
separate "Setup pnpm" step. Why: `actions/setup-node@v4` invokes Corepack
internally when `cache: 'pnpm'` is requested — it reads `packageManager` and
provisions the matching pnpm before the cache step runs.

The relevant CI block (full diff in `ch05 §ci.yml`):

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

## Cross-version application

- **v0.2 root** (currently npm): the `packageManager` field is present (PR
  #848). However, until v0.2 root itself migrates from `npm ci` to
  `pnpm install` in scripts and in `ci.yml`, the field is informational only
  for v0.2. The migration is a separate high-risk task tracked in
  `ch06 §v0.2 rollout`. Why high-risk: `npm`'s and `pnpm`'s lockfile formats
  are not interchangeable; `electron-builder`'s postinstall hooks have
  documented friction with pnpm's symlink-style `node_modules` layout
  (`node-linker=hoisted` is a workaround, see ch04). We sequence carefully.
- **v0.3 packages/***: born pnpm-native. The workspace is defined in
  `pnpm-workspace.yaml`; every package inherits `packageManager` from root.
  No per-package `packageManager` field — that would re-introduce drift.
- **v0.4**: same. Renovate (deferred to v0.4) will keep `packageManager`
  bumped to the latest pnpm 10.x patch automatically.

## Workspace configuration

`pnpm-workspace.yaml` is already in place at root (landed alongside
daemon-split spec ch11 monorepo scaffold; `packages/{electron,daemon,proto}`
exist as skeletons). Current contents:

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
```

For toolchain-lock purposes, the relevant pnpm setting on top of this
workspace file is `node-linker`. In root `.npmrc`:

```ini
node-linker=hoisted
```

Why `node-linker=hoisted`: native modules (`better-sqlite3`, `node-pty`)
plus Electron's `app.asar` packing both assume a flat `node_modules` tree.
pnpm's default `isolated` linker uses symlinks, which break Electron-builder
on Windows (junctions don't survive ASAR packing). `hoisted` makes pnpm
behave like npm for layout purposes while still using its content-addressable
store for speed.

This is an architectural decision, not a workaround: Electron + native
modules will keep needing flat layout for the foreseeable future. We commit
to `hoisted` for the lifetime of CCSM's Electron client.

## Why not alternatives

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

## Verification

- `pnpm --version` after `corepack enable` shows `10.33.2` (exact).
- `which pnpm` resolves to a Corepack shim, not `/opt/homebrew/bin/pnpm` or
  similar global install.
- CI log shows `Setup pnpm version: 10.33.2` from setup-node's Corepack
  invocation.
- `pnpm install --frozen-lockfile` exits 0 with no lockfile modification.

See `ch05 §reverse-verify matrix` for the integrated check.
