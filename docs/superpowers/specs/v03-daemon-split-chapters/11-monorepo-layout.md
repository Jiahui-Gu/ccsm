# 11 — Monorepo Layout

v0.3 ships a monorepo with three packages: `packages/daemon`, `packages/electron`, `packages/proto`. v0.4 will add `packages/web` and `packages/ios` as additive packages (brief §8). Tooling must support shared proto codegen, independent build/test per package, and cross-package CI orchestration. This chapter pins the workspace tool choice (with justification), the directory layout, the codegen pipeline, the per-package CI matrix, and the additive-package contract for v0.4.

### 1. Workspace tool: pnpm workspaces + Turborepo

**Decision**: pnpm workspaces for dependency management; Turborepo for task orchestration / caching.

| Candidate | Verdict | Why |
| --- | --- | --- |
| npm workspaces (alone) | rejected | no built-in task graph / caching; CI would re-run everything per PR |
| yarn workspaces | rejected | yarn is in flux (berry split); not worth the migration risk |
| pnpm workspaces (alone) | partial | great deps; we still need a task runner |
| Turborepo | accepted as task layer | mature, simple `turbo.json`, free for OSS, content-addressable cache works locally and in CI |
| Nx | rejected | overkill (heavy plugin ecosystem we don't need); harder to onboard; we are not building 50 packages |
| **pnpm workspaces + Turborepo** | **accepted** | pnpm: strict dep isolation, fast install, CI-cache-friendly `pnpm-lock.yaml`. Turborepo: per-task hash-based caching → only changed packages rebuild. |

**Why not just one tool**: pnpm doesn't do task graphs; Turborepo doesn't do dep resolution. The two are designed to coexist (Turborepo's docs first-class pnpm).

### 2. Directory layout

```
ccsm/                                # repo root
├── package.json                     # private; "workspaces": [...] handled by pnpm-workspace.yaml
├── pnpm-workspace.yaml
├── pnpm-lock.yaml                   # committed
├── turbo.json
├── tsconfig.base.json               # shared TS config; packages extend
├── .github/workflows/               # CI — see §6
├── docs/superpowers/specs/...       # this spec; not a package
├── packages/
│   ├── proto/
│   │   ├── package.json             # name: "@ccsm/proto"
│   │   ├── ccsm/v1/*.proto
│   │   ├── buf.yaml
│   │   ├── buf.gen.yaml
│   │   ├── gen/                     # generated code; gitignored; built by `pnpm run gen`
│   │   │   ├── ts/                  # connect-es output
│   │   │   ├── go/                  # for v0.4 (placeholder dir; empty in v0.3)
│   │   │   └── swift/               # for v0.4
│   │   └── scripts/lock-buf-image.sh
│   ├── daemon/
│   │   ├── package.json             # name: "@ccsm/daemon"
│   │   ├── tsconfig.json            # extends ../../tsconfig.base.json
│   │   ├── src/
│   │   │   ├── index.ts             # entrypoint -> bundle.js -> sea
│   │   │   ├── listeners/           # chapter 03
│   │   │   ├── rpc/                 # handlers; consumes @ccsm/proto/gen/ts
│   │   │   ├── pty/                 # chapter 06
│   │   │   ├── db/                  # chapter 07
│   │   │   ├── crash/               # chapter 09
│   │   │   ├── service/             # OS service entrypoint glue
│   │   │   └── native-loader.ts     # chapter 10 §2
│   │   ├── scripts/build-sea.{sh,ps1}
│   │   ├── test/{unit,integration,e2e}/
│   │   └── dist/                    # gitignored
│   └── electron/
│       ├── package.json             # name: "@ccsm/electron"
│       ├── tsconfig.json
│       ├── src/
│       │   ├── main/                # minimal; chapter 08 §4
│       │   ├── preload/             # 5 lines; chapter 08 §4
│       │   └── renderer/            # React app; consumes @ccsm/proto/gen/ts
│       ├── electron-builder.yml
│       ├── test/{unit,e2e}/
│       └── dist/
└── tools/
    ├── lint-no-ipc.sh               # chapter 08 §5h
    ├── sea-smoke/                   # chapter 10 §7 — per-OS installed-daemon smoke
    │   ├── run.sh
    │   └── run.ps1
    ├── verify-signing.sh            # chapter 10 §7 — mac + linux signing verifier
    ├── verify-signing.ps1           # chapter 10 §7 — Windows Authenticode verifier
    ├── installer-roundtrip.sh       # chapter 10 §5.2 / §5.3 mac+linux install→uninstall
    ├── installer-roundtrip.ps1      # chapter 10 §5.1 Win MSI install→uninstall (ship-gate (d))
    └── update-flow.spec.sh          # chapter 10 §8 update-flow smoke (mac/linux; .ps1 sibling for win)
```

**Why `gen/` per package and gitignored**: generated proto code re-deriving from `.proto` is fast and deterministic; committing it would invite drift. CI runs `pnpm run gen` before any other task.

**Why empty `gen/go/` and `gen/swift/` directories now**: nothing — the v0.3 `buf.gen.yaml` simply does not list go/swift outputs. v0.4 adds the outputs to `buf.gen.yaml`; no directory restructure. The directory comment block in the README explains the v0.4 plan to readers.

### 3. Workspace dep graph (v0.3)

```
@ccsm/proto    (no internal deps)
   ▲
   │
   ├── @ccsm/daemon
   └── @ccsm/electron
```

`@ccsm/daemon` and `@ccsm/electron` both depend on `@ccsm/proto`'s generated TS code via a workspace-protocol dep:

```jsonc
// packages/daemon/package.json
"dependencies": {
  "@ccsm/proto": "workspace:*"
}
```

pnpm symlinks `node_modules/@ccsm/proto` to `packages/proto`, which exposes its `gen/ts` output via its `package.json` `"exports"` field.

### 4. Proto codegen pipeline

```
packages/proto/buf.gen.yaml
---
version: v2
plugins:
  - remote: buf.build/bufbuild/es:v1.10.0
    out: gen/ts
    opt: target=ts,import_extension=js
  - remote: buf.build/connectrpc/es:v1.4.0
    out: gen/ts
    opt: target=ts,import_extension=js
# v0.4 will append:
#  - remote: buf.build/connectrpc/go:v1.x
#    out: gen/go
#  - remote: buf.build/connectrpc/swift:v1.x
#    out: gen/swift
```

Codegen is invoked via `pnpm --filter @ccsm/proto run gen` which Turborepo treats as a prerequisite of `build` for all consumers (declared in `turbo.json`):

```json
{
  "tasks": {
    "build": { "dependsOn": ["^build", "@ccsm/proto#gen"], "outputs": ["dist/**", "gen/**"] },
    "gen":   { "outputs": ["gen/**"] },
    "test":  { "dependsOn": ["build"] },
    "lint":  {}
  }
}
```

Declaring `@ccsm/proto#gen` as a `build` dep (in addition to `^build`) ensures local-dev bootstrap works without manual `pnpm --filter @ccsm/proto run gen` — a fresh clone + `pnpm install && pnpm build` produces working generated code before any consumer compiles. `gen` is included in `outputs` of `build` so Turborepo cache-restores generated code along with `dist/`.

A `buf breaking` job runs in CI on every PR **from phase 1 onward** (not deferred until v0.3 ships). Pre-tag, the comparison target is the PR's merge-base SHA on the working branch (any in-flight `.proto` shift MUST be intentional and reviewed); post-tag, the comparison target is the v0.3 release tag (see [04](./04-proto-and-rpc-surface.md) §7 / §8 and [13](./13-release-slicing.md) §2 phase 1). In addition, every `.proto` file's SHA256 is recorded in `packages/proto/lock.json` (committed). CI runs a `proto-lock-check` step that recomputes SHA256 over each `.proto` file and rejects any PR that touches a `.proto` file without bumping the matching SHA in `lock.json`. The bump is mechanical: `pnpm --filter @ccsm/proto run lock` regenerates `lock.json` and the PR author commits the result.

### 5. Per-package responsibilities

| Package | Owns | Forbidden |
| --- | --- | --- |
| `@ccsm/proto` | `.proto` files, `buf.gen.yaml`, generated code as build output | importing from any other package; ANY runtime logic |
| `@ccsm/daemon` | every line of daemon code; native module bundling | importing from `@ccsm/electron`; rendering UI |
| `@ccsm/electron` | every line of UI code; transport construction; React Query hooks | importing from `@ccsm/daemon`; spawning subprocesses; opening SQLite; native modules other than what Electron itself loads |

The "forbidden" column is enforced by ESLint's `no-restricted-imports` rule wired into each package's eslint config; CI lint catches violations.

The rule body, inline (each `packages/*/eslint.config.js` extends the root and adds package-specific patterns):

```js
// packages/electron/eslint.config.js (forbid daemon imports)
export default [
  {
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@ccsm/daemon", "@ccsm/daemon/*"], message: "@ccsm/electron MUST NOT import from @ccsm/daemon (chapter 11 §5)." },
          { group: ["node-pty", "better-sqlite3"], message: "Native modules belong in @ccsm/daemon, not the renderer/main (chapter 11 §5)." }
        ],
        paths: [
          { name: "electron", importNames: ["ipcMain", "ipcRenderer", "contextBridge"], message: "Forbidden by ship-gate (a) — see chapter 12 §1 / chapter 08 §5h. The lone exception is the descriptor preload, allow-listed via tools/lint-no-ipc.sh." }
        ]
      }]
    }
  }
];

// packages/daemon/eslint.config.js (forbid electron imports + UI)
export default [
  {
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@ccsm/electron", "@ccsm/electron/*"], message: "@ccsm/daemon MUST NOT import from @ccsm/electron (chapter 11 §5)." },
          { group: ["electron", "electron/*", "react", "react-dom"], message: "@ccsm/daemon is headless — UI deps forbidden (chapter 11 §5)." }
        ]
      }]
    }
  }
];

// packages/proto/eslint.config.js (forbid all internal imports + runtime)
export default [
  {
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@ccsm/*"], message: "@ccsm/proto MUST NOT import from any other package (chapter 11 §5)." }
        ]
      }]
    }
  }
];
```

### 6. CI matrix (GitHub Actions)

```yaml
# .github/workflows/ci.yml (sketch)
on:
  pull_request:
  push:
    branches: [main, working]
    tags: ['v*']
  schedule:
    - cron: '0 7 * * *'   # 07:00 UTC daily — drives [soak] + [installer] nightly variants below

jobs:
  install:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - uses: actions/cache@v4
        with:
          # Turborepo cache key: lockfile + turbo config + every .proto file (codegen affects every consumer)
          path: .turbo
          key: turbo-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml','turbo.json','packages/proto/**/*.proto','packages/proto/lock.json') }}
          restore-keys: |
            turbo-${{ runner.os }}-
      - uses: actions/upload-artifact@v4
        with:
          # share node_modules + .turbo with downstream jobs to avoid re-installing
          name: install-cache
          path: |
            node_modules
            packages/*/node_modules
            .turbo
          retention-days: 1

  proto-gen-and-lint:
    needs: install
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: install-cache }
      - run: pnpm --filter @ccsm/proto run gen
      - run: pnpm --filter @ccsm/proto run lint   # buf lint
      - run: pnpm --filter @ccsm/proto run lock-check   # SHA256 per .proto MUST match lock.json (rejects .proto touch without lock bump)
      - run: pnpm --filter @ccsm/proto run breaking     # buf breaking; pre-tag: against merge-base SHA; post-tag: against v0.3 tag (active from phase 1)
      - run: pnpm --filter @ccsm/proto run version-drift-check   # daemon's PROTO_VERSION constant >= last release's PROTO_VERSION (see §7)

  daemon-test:
    needs: proto-gen-and-lint
    strategy:
      matrix: { os: [ubuntu-22.04, macos-14, windows-latest] }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: install-cache }
      - run: pnpm --filter @ccsm/daemon run build
      - run: pnpm --filter @ccsm/daemon run test:unit
      - run: pnpm --filter @ccsm/daemon run test:integration

  electron-test:
    needs: proto-gen-and-lint
    strategy:
      matrix: { os: [ubuntu-22.04, macos-14, windows-latest] }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: install-cache }
      - run: pnpm --filter @ccsm/electron run build
      - run: pnpm --filter @ccsm/electron run test:unit
      - run: pnpm --filter @ccsm/electron run lint:no-ipc   # ship-gate (a)

  package:
    needs: [daemon-test, electron-test]
    strategy:
      matrix:
        include:
          - { os: windows-latest, target: win-msi }
          - { os: macos-14, target: mac-pkg }
          - { os: ubuntu-22.04, target: linux-deb-rpm }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: install-cache }
      - run: pnpm run package:${{ matrix.target }}
      - run: bash tools/verify-signing.sh    # chapter 10 §7 (mac/linux); pwsh tools/verify-signing.ps1 on win
        if: matrix.os != 'windows-latest'
      - run: pwsh tools/verify-signing.ps1
        if: matrix.os == 'windows-latest'

  e2e-soak-1h:
    needs: package
    runs-on: [self-hosted, ccsm-soak]   # label provisioned in infra repo; 1 hour budget
    if: github.event_name == 'schedule' || contains(github.event.head_commit.message, '[soak]')
    steps:
      - run: pnpm run test:pty-soak   # ship-gate (c)

  e2e-installer-win:
    needs: package
    runs-on: [self-hosted, win11-25h2-vm]   # label = self-hosted-win11-25h2-vm; provisioning in infra/win11-runner/ (chapter 10 §6)
    if: github.event_name == 'schedule' || contains(github.event.head_commit.message, '[installer]')
    steps:
      - run: pwsh tools/installer-roundtrip.ps1   # ship-gate (d); invokes tools/sea-smoke/run.ps1 internally
```

Notes on the sketch:

- `install-cache` artifact share: every downstream job downloads the `node_modules` + `.turbo` artifact rather than re-running `pnpm install` per matrix cell — saves ~2 min per leaf job at the cost of one upload. Retention is 1 day because it is cheap to regenerate.
- Turborepo cache key uses `pnpm-lock.yaml` + `turbo.json` + every `.proto` file + `packages/proto/lock.json`. `.proto` changes invalidate codegen which transitively invalidates every consumer build; including the lock file ensures cache invalidates atomically with the bump.
- The `cron:` block at the top drives nightly soak + installer variants. Per-PR runs use `[soak]` / `[installer]` commit-message opt-in to keep PR feedback fast.
- Self-hosted runner labels: `[self-hosted, ccsm-soak]` for the 1 h soak runner; `[self-hosted, win11-25h2-vm]` for the ship-gate (d) runner. Both labels are provisioned out-of-band in the `infra/win11-runner/` repo (see chapter 10 §6).

### 7. Versioning

- Single repo-wide version in `package.json` of the root and synced to each package via Changesets OR a tiny `scripts/sync-version.ts`. We pick **Changesets** because it integrates with PRs and produces the changelog.
- Daemon ↔ Electron version compatibility expressed in `Hello.proto_version` (see [04](./04-proto-and-rpc-surface.md) §3); independent of npm version.
- **PROTO_VERSION drift check (CI)**: Changesets-driven version bumps are independent of `proto_version` (the latter is bumped only when `.proto` files change in a way that affects the wire). To prevent drift, `pnpm --filter @ccsm/proto run version-drift-check` (run in the `proto-gen-and-lint` CI job — see §6) asserts: the `PROTO_VERSION` constant exported by `@ccsm/proto` (read from `packages/proto/src/version.ts`) is `>=` the `PROTO_VERSION` recorded in the most recent git tag matching `v*` (read by `git show <tag>:packages/proto/src/version.ts`). The check fails the PR with an error message instructing the author to bump `PROTO_VERSION` IF AND ONLY IF a `.proto` file changed (the `proto-lock-check` step from §4 / §6 makes the `.proto` change visible). The check is a no-op on the very first release (no prior tag exists).

### 8. v0.4 delta

- **Add** `packages/web/` (Vite + React + connect-web) and `packages/ios/` (Swift Package + connect-swift); both depend on `@ccsm/proto`.
- **Add** `gen/go/` and `gen/swift/` outputs to `buf.gen.yaml`; v0.3 `gen/ts/` continues unchanged.
- **Add** new CI jobs `web-test`, `ios-test`; matrix grows; existing jobs unchanged.
- **Add** `packages/cloudflared-config/` (or fold into `packages/daemon/` — decision deferred to v0.4) for tunnel config + lifecycle.
- **Unchanged**: pnpm + Turborepo choice, root layout, dep graph shape (just adds two leaves), proto codegen pipeline, ESLint forbidden-imports rule, per-package responsibility split, the v0.3 ship-gate jobs.
