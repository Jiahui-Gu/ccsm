# ch05 — CI wiring, onboarding, release verify, reverse-verify matrix

## CI: `.github/workflows/ci.yml` diff

The `lint-typecheck-test` job is the only CI job that needs toolchain
changes (e2e.yml, release.yml inherit the same setup pattern; same diff
applies). Below is the relevant section before/after.

### Before (current main)

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

### After (toolchain-lock applied; v0.2 root once migrated to pnpm)

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

### Cache key migration note

The cache key changes (from `nm-…-${hashFiles('package-lock.json')}` to
`pnpm-store-…-${hashFiles('pnpm-lock.yaml')}`). Old caches are not reused
and will be evicted by GitHub's 7-day LRU policy. Why this is fine: it's a
one-time migration cost; subsequent builds populate the new key.

### Why `pnpm install` is unconditional (no `if: cache-miss` guard)

`pnpm install --frozen-lockfile` against a populated store is fast (~5-10s)
and DETERMINISTIC. The npm-era `if: cache-hit != 'true'` skip was
necessary because `npm ci` was slow (~178s on Windows per existing CI
comments) AND would trigger native rebuilds. With pnpm + cached store +
explicit `pnpm rebuild better-sqlite3` step, installing every run is
cheaper than the conditional logic and removes a class of "stale node_modules"
bugs.

## Onboarding: CONTRIBUTING.md / README

Add a single section near the top of CONTRIBUTING.md (also linked from README
"Getting started"):

```markdown
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
```

Why prescriptive ordering (1 → 4): each step has a precise prerequisite.
fnm/nvm chooses Node; Node ships Corepack; Corepack provides pnpm; pnpm
installs deps. Skipping any step produces a confusing error later.

Volta users: a one-time `volta pin node@22` is documented as a footnote, not
the main path. Why: keeping the main path single-fork (nvm OR fnm) reduces
support surface.

## Release-candidate verify

`scripts/release-candidate.sh` (or wherever the v0.2 release is cut from)
gains a preflight block before any build/publish step:

```bash
#!/usr/bin/env bash
set -euo pipefail

# --- toolchain verify ---------------------------------------------------
expected_node=$(cat .nvmrc)
actual_node_major=$(node -p 'process.versions.node.split(".")[0]')
if [[ "${actual_node_major}" != "${expected_node}" ]]; then
  echo "FATAL: release host runs Node ${actual_node_major}, .nvmrc says ${expected_node}"
  echo "Run: nvm use     (or fnm use)"
  exit 1
fi

expected_pnpm=$(node -p "require('./package.json').packageManager.split('@')[1]")
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

## Reverse-verify matrix

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

### Per-row pass criteria

For each row:

- `pnpm install --frozen-lockfile` exits 0 with no lockfile diff.
- `pnpm test` (or `npm test` for v0.2 pre-migration) exits 0.
- `pnpm rebuild better-sqlite3` exits 0 (proves native ABI alignment).
- `node --version` matches `.nvmrc`.
- `pnpm --version` matches `packageManager`.

Failures on any row block the rollout. Diagnostic playbook in
`ch06 §contributor-environment fallback`.

## Cross-references

- Node pin source of truth: `ch02 §file contents`.
- pnpm pin source of truth: `ch03 §decision`.
- engine-strict mechanism: `ch04 §root .npmrc`.
- v0.2-specific rollout sequencing: `ch06 §v0.2 rollout`.
