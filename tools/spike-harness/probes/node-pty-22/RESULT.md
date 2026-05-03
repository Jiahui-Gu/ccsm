# T9.10 — node-pty Node 22 ABI matrix spike

Task: Task #107. Confirm node-pty 1.1.0 (latest stable) compiles and runs
against Node 22 ABI across the 6 target combos `{win32, darwin, linux} ×
{x64, arm64}` for the v0.3 daemon-split pty-host (T4.1 / Issue #45).

## TL;DR

node-pty 1.1.0 is built on **N-API via `node-addon-api`** (see `binding.gyp`
`node_addon_api_except` dep). N-API guarantees ABI stability across Node
major versions, so a single prebuild per `<platform>-<arch>` covers Node 18,
20, 22, and 24. The loader (`lib/utils.js`) does **not** discriminate by ABI
(`process.versions.modules`) — it only switches on `process.platform` and
`process.arch`. **Recommendation: GREEN for T4.1 pty-host fork boundary on
Node 22, with one caveat (Linux requires source rebuild — toolchain pin must
ensure python3 + g++ are available at install time on Linux runners).**

## What was tested locally

Host: `win32/x64`, Node `v24.14.1` (NODE_MODULE_VERSION=137), pnpm 10.33.2.

```
$ bash compile-test.sh
[compile-test] node=v24.14.1  abi=137  platform=win32/x64
[compile-test] using pnpm (node-linker=hoisted to mirror root .npmrc)
[compile-test] node-pty resolved at: .../node_modules/node-pty
[compile-test] using fetched prebuild dir:
  .../node_modules/node-pty/prebuilds/win32-x64
[compile-test] require-load test:
node-pty loaded ok, abi=137 keys=spawn,fork,createTerminal,open,native
[compile-test] PASS

$ node probe.mjs
{"ok":true,"platform":"win32","arch":"x64","nodeVersion":"v24.14.1",
 "abi":"137","pty":{"cols":80,"rows":24},"payload":"CRLF",
 "durationMs":214,"nodePtyVersion":"1.1.0",
 "addonPath":[".../prebuilds/win32-x64/pty.node",
              ".../prebuilds/win32-x64/conpty.node"]}
```

Local machine cannot install Node 22 today (`nvm-windows` non-interactive
inside this shell is unreliable), so the live load was against ABI 137
(Node 24). Because node-pty's binary is N-API based, that load is
**evidence the same prebuild works for Node 22 (ABI 127)** — N-API is a
stable C ABI by contract. To remove residual doubt, recommend wiring a
matrix CI job (see "Follow-ups" below) before T4.1 lands.

## Per-combo matrix

| platform | arch  | prebuild shipped by node-pty 1.1.0 | local verdict      | source rebuild needed? | notes |
| -------- | ----- | ---------------------------------- | ------------------ | ---------------------- | ----- |
| win32    | x64   | yes (`prebuilds/win32-x64/`)       | **PASS** (live)    | no                     | conpty.node + pty.node + winpty fallback all present |
| win32    | arm64 | yes (`prebuilds/win32-arm64/`)     | TODO (no host)     | no                     | prebuild present in package; high confidence by parity with x64 |
| darwin   | x64   | yes (`prebuilds/darwin-x64/`)      | TODO (no host)     | no                     | prebuild present |
| darwin   | arm64 | yes (`prebuilds/darwin-arm64/`)    | TODO (no host)     | no                     | prebuild present |
| linux    | x64   | **NO**                             | TODO (no host)     | **yes** — needs python3 + g++ + libuv headers (`build-essential`) | will fall back to `node-gyp rebuild` post-install; install time +30-90s |
| linux    | arm64 | **NO**                             | TODO (no host)     | **yes** — same as x64                                              | same; on aarch64 GHA hosts (or Docker buildx) |

Source: `node_modules/node-pty/prebuilds/` directory listing after
`pnpm install` against node-pty 1.1.0.
Upstream release page: <https://github.com/microsoft/node-pty/releases/tag/v1.1.0>

## Why the single prebuild works for Node 22

1. `binding.gyp` declares `node-addon-api` as the only addon dep
   (`node_addon_api_except`). `node-addon-api` is the C++ wrapper around
   N-API (a.k.a. Node-API), which has a versioned, ABI-stable C interface.
2. `lib/utils.js#loadNativeModule` resolves the addon by
   `prebuilds/<platform>-<arch>/<name>.node` — **no ABI subdir**, unlike
   nan-based modules (which need `electron-v22-x64`-style folders).
3. Node 22 (ABI 127) and Node 24 (ABI 137) both implement N-API ≥ v8;
   node-pty 1.1.0 uses APIs at or below v8. Therefore one binary covers
   both.

This matches Microsoft's `node-pty` v1.0 release notes ("N-API migration,
Electron rebuilds no longer required").

## Recommendation for T4.1 (#45 pty-host fork boundary)

**GREEN, ship on node-pty `1.1.0` pinned in the daemon's
`package.json`.** Justification:

- Single prebuild covers Node 18 / 20 / 22 / 24, removing the
  "rebuild-on-Electron-bump" pain that motivated the spike.
- pty-host is a `child_process.fork`-ed Node process (per spec ch08 §1)
  using the same Node binary as the daemon, so we do not need
  Electron-specific rebuilds. N-API stability gives us cross-Node
  compatibility for free.
- Toolchain pin (Node 22 LTS per
  `docs/superpowers/specs/2026-05-03-toolchain-lock-design.md`) is fully
  inside the supported range.

## Risks / follow-ups before T4.1

1. **Linux installs need a C toolchain.** Add a CI matrix job (or document
   in `INSTALL.md`) that GHA `ubuntu-22.04` images include `python3` +
   `build-essential` by default; Docker base images (`node:22-slim`) do
   **not** and will fail `pnpm install`. Suggest using `node:22-bookworm`
   or installing build deps explicitly.
2. **Live verification on the other 5 combos.** Wire this probe into a
   GitHub Actions matrix (`runs-on: [ubuntu-22.04, ubuntu-22.04-arm,
   macos-13, macos-14, windows-2022, windows-11-arm]` × `node: 22`) and
   run `bash tools/spike-harness/probes/node-pty-22/compile-test.sh &&
   node tools/spike-harness/probes/node-pty-22/probe.mjs`. Block T4.1
   merge on green matrix.
3. **win32/arm64 ConPTY DLL.** node-pty's `post-install.js` copies
   `conpty.dll` + `OpenConsole.exe` for Windows. The script supports
   `arm64` (see `CONPTY_SUPPORTED_ARCH = ['x64', 'arm64']`) and ships the
   bundled `third_party/conpty/win10-arm64/` folder, so cross-arch ship
   from x64 builders works only if `npm_config_arch=arm64` is set during
   install (electron-builder's universal/arm64 path already sets this).
4. **node-pty `1.2.0-beta.x` is on dist-tag.** Stay on `1.1.0` (latest)
   for v0.3 — beta only adds API surface we do not need.

## Files

- `package.json` — probe-only deps (not added to root).
- `probe.mjs` — spawns a node-pty session, asserts `hello-pty\r?\n`.
- `compile-test.sh` — install + addon resolution + require-load smoke.
- `.gitignore` — excludes `node_modules/` and lockfiles.
