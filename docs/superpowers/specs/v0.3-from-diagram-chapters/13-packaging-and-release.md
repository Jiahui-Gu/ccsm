# 13 — Packaging + signing + release

## Scope

Single binary daemon + Electron app, packaged together by electron-builder, shipped on three OS × two arch under one `v*` tag.

This chapter consolidates the surviving packaging concerns from the v0.3 reconciliation (#23, #45, #62, #64, #65, #66, #78) and pins them against the final-architecture topology.

## Outputs (per release)

| Platform                | Artifact                                                  |
| ----------------------- | --------------------------------------------------------- |
| macOS (arm64 + x64)     | `.dmg` + notarized `.app`                                 |
| Windows (x64 + arm64)   | NSIS `.exe` (per-user install)                            |
| Linux (x64 + arm64)     | `.AppImage` + `.deb` + `.rpm` (minisign signed)           |

Each artifact contains the Electron app **plus** the bundled daemon binary as an extraResource.

## Daemon binary build pipeline (resolves #45)

1. Daemon source TS → `tsc` → JS bundle.
2. Native deps prebuilt for Node 22 ABI:
   - `node-pty` (Win prebuild — resolves #78; pin to a version with Win prebuilds).
   - `better-sqlite3` (or sqlite3, see [16](./16-risks-and-open-questions.md)).
   - `ccsm_native` — built in-tree, per-OS .node files (resolves #79).
3. Bundle daemon JS + Node 22 runtime into a single executable via `pkg` (or equivalent — `node-sea` is an option but pkg has more mature multi-arch story today; spec leaves the exact tool to implementer with the constraint "single binary, no node_modules at runtime").
4. Sentry sourcemap upload happens **before** step 3 — see [11 §symbol upload](./11-crash-and-observability.md).
5. Post-build size assertion against `installer/size-baseline.json` (resolves #65; baseline is re-generated after Connect lands; budget is "v0.2 size + 15%").

## Electron-builder integration

- `extraResources`: daemon binary + `ccsm_native.node` files + claude-agent-sdk staging blob (existing v0.3 frag-11 dual-staging dance).
- `asarUnpack`: same set, so they're real files at runtime, not inside the asar archive.
- `before-pack`: existing `REQUIRED_NATIVES` check (resolves #66) — refuses to ship if any native is missing or 0-byte.
- `after-pack`: existing content-sanity check (resolves #66 belt-and-suspenders).

## Codesigning (resolves #64)

- macOS: codesign the daemon binary AND every `.node` file with the Developer ID Application certificate (existing v0.3 per-`.node` codesign loop). Notarize the final `.app`.
- Windows: signtool the daemon `.exe` AND every `.node` file with the EV cert.
- Linux: minisign the AppImage / deb / rpm (no per-file signing required).

The daemon binary MUST be signed; an unsigned daemon would fail Gatekeeper on macOS when spawned by Electron.

## NSIS settings (Windows, frag-11 carried forward)

- `oneClick: false`, `allowElevation: true`, `allowToChangeInstallationDirectory: true`, `perMachine: false`.
- Install root: `%LOCALAPPDATA%\ccsm\` (no UAC, no Program Files).
- Auto-update writes in-place; `daemon.shutdownForUpgrade` + marker (see [05](./05-supervisor-control-plane.md)) orchestrates the daemon side.

## Release CI on `v*` tag (resolves #23)

- Single `v*` tag triggers full release (no `daemon-v*` separate channel — the daemon ships inside the Electron installer; placeholder-safe rule from project_v03_ship_intent).
- SLSA-3 provenance generation on every release (existing).
- After each release: dogfood smoke run (#14 modified) against the actual installer.

## Release verify steps

The existing `release.yml` verify job (already includes `npm run build` per commit e983c04) extends with:

- Verify daemon binary present in installer at expected path.
- Verify daemon `--version` runs (sanity).
- Verify discovery-file path policy by smoke-launching daemon and reading its discovery file.

## Single tag, no schema-tag separation

There is no `proto-v*` tag. proto schema versioning lives in the package (`ccsm.v1`) and is governed by `buf breaking` in CI (see [06](./06-proto-schema.md)). Schema and binary version are decoupled at the protocol level (additive proto changes are non-breaking) but coupled at the release level (one ship, one tag).

## Installer size budget

- Baseline: re-set after first post-Connect release.
- Hard ceiling: v0.2 + 15% (this is the reconciliation-baked guard; if Connect bundling overshoots, that's a build-task to optimize before ship, not an excuse to bump the baseline).

## Cross-refs

- [05 — Supervisor (`daemon.shutdownForUpgrade` consumer)](./05-supervisor-control-plane.md)
- [09 — PTY host (node-pty + ccsm_native deps)](./09-pty-host.md)
- [10 — SQLite (sqlite native dep)](./10-sqlite-and-db-rpc.md)
- [11 — Crash + observability (pre-pkg sourcemap upload)](./11-crash-and-observability.md)
- [12 — Electron thin client (daemon binary path discovery)](./12-electron-thin-client.md)
- [16 — Risks (sqlite library choice; pkg vs node-sea)](./16-risks-and-open-questions.md)
