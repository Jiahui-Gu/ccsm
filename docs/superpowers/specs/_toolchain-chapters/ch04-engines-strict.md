# ch04 — engines + engine-strict enforcement

## Decision

CCSM declares `engines` in every `package.json` (root and `packages/*`) and
sets `engine-strict=true` in root `.npmrc`. Together these turn the soft
"Node version requirement" into a hard install-time failure.

Why hard-fail: a warning is a no-op. Contributors who skip `corepack enable`
or run an old Node still get to `pnpm install` and produce a half-broken
checkout that fails later in test or build with a confusing error. We want
the failure at the earliest, most diagnostic point: install.

## Root `package.json#engines`

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
  every install (see ch02 §file contents).

## Root `.npmrc`

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

### Existing `.npmrc` content interaction

The repo's current `.npmrc` (verified on `working` branch) contains ONLY:

```ini
clang=0
```

(present to keep `@electron/node-gyp` from selecting ClangCL on Windows
fresh checkouts). Neither `engine-strict` nor `node-linker` is present on
`working` today. PR D APPENDS both; it does NOT replace. **This chapter
(ch04) is the canonical spec location for the `node-linker=hoisted`
addition** — ch03 §workspace configuration cross-references here for the
mechanism, and ch06 PR D file list cites ch04 for the exact final-file
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

`node-linker=hoisted` is added at the same time per `ch03 §workspace
configuration`. The three settings are independent but ship together.

## `packages/*` engines (v0.3+)

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

## Root vs `packages/*` strategy summary

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

## v0.2 root: high-risk callout

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

The rollout sequence is in `ch06 §v0.2 rollout`. The v0.2 root change is
listed there as a **single high-risk task** (not bundled with the lower-risk
`.nvmrc` + CI Node 22 bump). The reason for splitting: rollback of
engine-strict is one-line revert; rollback of the bundled change costs more.

## v0.3 + v0.4

No high-risk callout. v0.3's `packages/*` is born with these settings; no
contributor has a working v0.3 checkout WITHOUT them, so engine-strict is a
day-one constraint, not a transition.

## Why not alternatives

- **`engine-strict=true` only, no `engines` field** — engine-strict needs
  something to check against. Eliminated by construction.
- **`engines.node: ">=22"`** — allows Node 24 LTS when it ships, which we
  haven't validated. We pin to the current major (`22.x`); a future major
  bump is an explicit PR.
- **JS-level `process.versions.node` assertion in a postinstall script** —
  brittle (postinstall runs AFTER deps install, so any deps that broke
  during install have already broken); eliminated by engine-strict which
  runs BEFORE deps install.

## Verification

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
