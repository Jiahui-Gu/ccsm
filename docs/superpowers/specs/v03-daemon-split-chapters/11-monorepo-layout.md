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
    └── lint-no-ipc.sh               # chapter 08 §5h
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
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", "gen/**"] },
    "gen":   { "outputs": ["gen/**"] },
    "test":  { "dependsOn": ["build"] },
    "lint":  {}
  }
}
```

A `buf breaking` job runs in CI on every PR after v0.3 ships, comparing against the v0.3 release tag (see [04](./04-proto-and-rpc-surface.md) §8).

### 5. Per-package responsibilities

| Package | Owns | Forbidden |
| --- | --- | --- |
| `@ccsm/proto` | `.proto` files, `buf.gen.yaml`, generated code as build output | importing from any other package; ANY runtime logic |
| `@ccsm/daemon` | every line of daemon code; native module bundling | importing from `@ccsm/electron`; rendering UI |
| `@ccsm/electron` | every line of UI code; transport construction; React Query hooks | importing from `@ccsm/daemon`; spawning subprocesses; opening SQLite; native modules other than what Electron itself loads |

The "forbidden" column is enforced by ESLint's `no-restricted-imports` rule wired into each package's eslint config; CI lint catches violations.

### 6. CI matrix (GitHub Actions)

```yaml
# .github/workflows/ci.yml (sketch)
jobs:
  install:
    runs-on: ubuntu-22.04
    steps:
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - uses: actions/cache@v4  # Turborepo cache key

  proto-gen-and-lint:
    needs: install
    steps:
      - run: pnpm --filter @ccsm/proto run gen
      - run: pnpm --filter @ccsm/proto run lint   # buf lint
      - run: pnpm --filter @ccsm/proto run breaking  # only on PRs after v0.3 tag

  daemon-test:
    needs: proto-gen-and-lint
    strategy:
      matrix: { os: [ubuntu-22.04, macos-14, windows-latest] }
    steps:
      - run: pnpm --filter @ccsm/daemon run build
      - run: pnpm --filter @ccsm/daemon run test:unit
      - run: pnpm --filter @ccsm/daemon run test:integration

  electron-test:
    needs: proto-gen-and-lint
    strategy:
      matrix: { os: [ubuntu-22.04, macos-14, windows-latest] }
    steps:
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
    steps:
      - run: pnpm run package:${{ matrix.target }}

  e2e-soak-1h:
    needs: package
    runs-on: self-hosted   # 1 hour budget
    if: github.event_name == 'schedule' || contains(github.event.head_commit.message, '[soak]')
    steps:
      - run: pnpm run test:pty-soak   # ship-gate (c)

  e2e-installer-win:
    needs: package
    runs-on: self-hosted-win11-25h2-vm
    if: github.event_name == 'schedule' || contains(github.event.head_commit.message, '[installer]')
    steps:
      - run: pwsh test/installer-roundtrip.ps1   # ship-gate (d)
```

### 7. Versioning

- Single repo-wide version in `package.json` of the root and synced to each package via Changesets OR a tiny `scripts/sync-version.ts`. We pick **Changesets** because it integrates with PRs and produces the changelog.
- Daemon ↔ Electron version compatibility expressed in `Hello.proto_version` (see [04](./04-proto-and-rpc-surface.md) §3); independent of npm version.

### 8. v0.4 delta

- **Add** `packages/web/` (Vite + React + connect-web) and `packages/ios/` (Swift Package + connect-swift); both depend on `@ccsm/proto`.
- **Add** `gen/go/` and `gen/swift/` outputs to `buf.gen.yaml`; v0.3 `gen/ts/` continues unchanged.
- **Add** new CI jobs `web-test`, `ios-test`; matrix grows; existing jobs unchanged.
- **Add** `packages/cloudflared-config/` (or fold into `packages/daemon/` — decision deferred to v0.4) for tunnel config + lifecycle.
- **Unchanged**: pnpm + Turborepo choice, root layout, dep graph shape (just adds two leaves), proto codegen pipeline, ESLint forbidden-imports rule, per-package responsibility split, the v0.3 ship-gate jobs.
