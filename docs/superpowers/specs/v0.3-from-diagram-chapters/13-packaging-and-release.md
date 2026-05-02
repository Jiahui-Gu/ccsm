# 13 — Packaging and release

> Authority: [final-architecture §2.1](../2026-05-02-final-architecture.md#2-locked-principles) (single binary, runs on user's local machine).

## Artifacts per release

| Artifact | Targets | Notes |
|---|---|---|
| `ccsm-daemon` standalone binary | darwin-arm64, darwin-x64, linux-x64, linux-arm64, win-x64, win-arm64 | bundled via `@yao-pkg/pkg` (or equivalent); embeds Node runtime + node-pty prebuilds + ccsm_native prebuild |
| `ccsm` Electron app | macOS universal `.dmg`, Linux `.AppImage` + `.deb` (x64 + arm64), Windows `.exe` (x64 + arm64) | bundles its arch-matched `ccsm-daemon` binary alongside |
| Connect protobuf descriptors | platform-independent | published as a release asset for downstream tooling |

## Single binary discipline

`ccsm-daemon` MUST run on a fresh OS install with no external runtime (no system Node, no Python). **Why:** §2.1 — single binary.

`node-pty` and `ccsm_native` prebuilds are vendored at six target tuples ([09-pty-host](./09-pty-host.md)); the build pipeline rejects any release artifact missing a prebuild for its target.

## Release tag = single tag

One git tag per release: `v0.3.<patch>`. The tag triggers the matrix CI build that produces all artifacts. **Why:** [project_v03_ship_intent](../../) — single tag is part of the ship intent.

## Signing (placeholder-safe)

- **macOS:** Developer ID signing + notarization required for distribution. v0.3 ships **either** with real Developer ID **or** with a documented unsigned dev path; the build pipeline accepts a placeholder identity in CI dry-runs and reports `signed:false` in `ServerInfo` so the dogfood gate can detect unsigned builds.
- **Windows:** Authenticode signing similarly placeholder-safe.
- **Linux:** No signing; minisign over release tarballs. **minisign is the only hard blocker** before tagging — the release pipeline MUST refuse to publish without a valid minisign signature.

**Why placeholder-safe:** the spec must let CI run end-to-end without secrets in PR builds; release tagging requires the real keys. Same code path in both modes.

## `.bak` rollback path

The installer MUST preserve the previously-installed `ccsm-daemon` as `${binary}.bak` before overwriting. The in-process supervisor's rollback ([ch.11](./11-crash-and-observability.md)) depends on this. Installer for each OS:
- macOS pkg: pre-install script copies existing binary to `.bak`.
- Linux deb/AppImage: post-extract step in our wrapper.
- Windows: NSIS / WiX `.bak` step.

## Uninstall hygiene

Uninstaller MUST remove `${dataRoot}/runtime/` (PID, port-tunnel, crashloop). It MUST NOT remove `${dataRoot}/db/` or `${dataRoot}/logs/` without explicit user opt-in. **Why:** session metadata + crash logs survive across reinstalls — that's the user's data.

## CI matrix

```
matrix:
  os: [macos-latest, ubuntu-latest, windows-latest]
  arch: [x64, arm64]
  exclude:
    - os: ubuntu-latest, arch: arm64    # cross-compile path used instead
```

Each cell:
1. Build `ccsm-daemon` standalone.
2. Build Electron app embedding daemon.
3. Run unit tests.
4. Run integration tests (IT-E1..E3 on each OS where Electron runs).
5. Upload artifacts.
6. (Tag builds only) sign + minisign + publish.

## §13.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。单 binary、六 target tuple、单 git tag、placeholder-safe 签名、minisign 硬阻塞、`.bak` 回滚约定、CI matrix — v0.4 全部沿用。v0.4 加 cloudflared 时**追加** sidecar 二进制到安装包 (新文件, 不修改打包脚本现有路径); v0.4 加 OS supervisor 时**追加** install/uninstall 脚本片段 (新增, 不替换)。**Why 不变:** final-architecture §2.1 (单 binary 永久原则) + §2.9 (in-process supervisor 仅做 .bak 回滚)。

## Cross-refs

- [09-pty-host](./09-pty-host.md) — prebuild requirements.
- [11-crash-and-observability](./11-crash-and-observability.md) — `.bak` consumer.
- [15-testing-strategy](./15-testing-strategy.md) — CI suites.
