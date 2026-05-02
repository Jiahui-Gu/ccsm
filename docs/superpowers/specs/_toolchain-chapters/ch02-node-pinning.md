# ch02 — Node version pinning

## Decision

CCSM pins to **Node 22 LTS** through a single `.nvmrc` file at repository
root. Every tool — local version managers (nvm, fnm, Volta), CI
(`actions/setup-node@v4`), release scripts — reads from that one file.

Why one file: the recurrent drift bug is "two places say two different
things." `.nvmrc` is the lowest-common-denominator format (a plain text file
containing a version specifier), supported natively by every Node version
manager since 2014. Choosing it as the source of truth means we never have
to keep two files in sync.

## File contents

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

## Local consumption

### nvm

`cd ccsm && nvm use` reads `.nvmrc` and switches. If the major isn't
installed, `nvm install` (no arg) reads `.nvmrc` and installs the latest 22.x.
No CCSM-specific config required.

### fnm

`fnm` reads `.nvmrc` automatically when shell hooks are installed
(`fnm env --use-on-cd`). Documented in CONTRIBUTING (see `ch05 §onboarding`).

### Volta

Volta reads `.nvmrc` only with the `VOLTA_FEATURE_PNPM=1` and explicit
`volta pin node@22` in `package.json#volta.node`. Why we do NOT pin via
`package.json#volta`: it duplicates the source of truth and Volta-only users
would override what `.nvmrc` says. CCSM's policy: Volta users either run
`volta pin node@22` once locally (it writes to `package.json` but we
gitignore that diff via a `.gitignore` rule on the `volta` block, OR we
document the manual pin as a one-time onboarding step). Recommended: the
manual one-time step. Why: keeping `volta` out of `package.json` avoids a
fourth-tool source of truth.

### Corepack interaction

Node 22 ships Corepack 0.31+ in the box. Once `nvm use` selects 22, `pnpm`
becomes available via `corepack enable` (ch03 covers this). No standalone
pnpm install is needed.

## CI consumption

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

Why cache changes from `npm` to `pnpm`: covered in `ch03 §CI`. The change is
coupled because v0.3 root migrates to pnpm; v0.2 root migration timing is in
`ch06`.

## Cross-version application

- **v0.2 root** (npm + Electron-builder publish): `.nvmrc` lands at root in
  v0.2 main as a low-risk change. `cache: 'npm'` stays until v0.2 itself
  migrates to pnpm (which is a SEPARATE high-risk change tracked in
  `ch04 §v0.2 root`). Pinning Node alone in v0.2 is safe — we go from
  Node 20 (current `ci.yml`) to Node 22, which is 2 LTS jumps. Why safe: we
  control the Node version on every CI runner, and every dependency in
  current `package.json` already supports Node 22 (Electron 33+, all
  `@electron/*`, vitest 2.x, webpack 5.x). The migration cost is one CI
  cycle to confirm.
- **v0.3 packages/*** (pnpm workspace; scaffold already on `working`):
  `.nvmrc` is inherited from root. Each `packages/*/package.json` MAY also
  list `engines.node` for clarity (ch04 covers this), but the `.nvmrc` file
  is not duplicated.
- **v0.4 and beyond**: same `.nvmrc`, same mechanism. Renovate (deferred to
  v0.4) bumps the file when Node 22.x hits a new LTS minor IF we decide to
  tighten the pin later. Until then, the file stays at `22`.

## Why not alternatives

- **`.node-version`** (used by some asdf / nodenv users) — additionally
  parsed by setup-node@v4, but `.nvmrc` has wider tool support. Pick one;
  picking the one with the larger install base. We explicitly do NOT add
  both files — that re-introduces the dual source of truth.
- **`engines.node`-only** (no `.nvmrc`) — `engines` is a constraint, not an
  installer. nvm doesn't read it; CI's setup-node doesn't read it. We use
  BOTH (`.nvmrc` for installation, `engines.node` for enforcement) — see
  ch04.
- **`package.json#volta`-only** — Volta-specific; alienates nvm/fnm users
  who outnumber Volta users in CCSM's contributor pool today.

## Verification

- `node --version` after `cd ccsm` (with shell hook) shows `v22.x.y`.
- `cat .nvmrc` shows `22` (one line, no whitespace).
- `actions/setup-node@v4` log line in CI shows
  `Resolved node version 22.x.y from .nvmrc`.

See `ch05 §reverse-verify matrix` for the full local + CI smoke test.
