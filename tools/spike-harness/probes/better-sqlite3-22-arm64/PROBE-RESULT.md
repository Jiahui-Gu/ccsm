# T9.11 — better-sqlite3 arm64 prebuild availability (Node 22 ABI)

Task: Task #110. Resolve spec ch14 §1.12 — confirm `better-sqlite3` ships
prebuilt addons for `darwin-arm64` and `linux-arm64` against the Node 22
ABI (`NODE_MODULE_VERSION=127`), so the v0.3 phase-3 SQLite spike can run
on the arm64 matrix without a source-build pre-req.

## TL;DR

`better-sqlite3` ships first-class Node 22 (ABI 127) prebuilds for every
arm64 target we care about — `darwin-arm64`, `linux-arm64`,
`linuxmusl-arm64`, `win32-arm64` — at both the version we are pinning
(`12.9.0`) and the prior `11.10.0` line. `prebuild-install` resolves them
automatically during `pnpm install`; no compiler is invoked. **Verdict:
GREEN for ch14 §1.12; phase-3 SQLite arm64 matrix can proceed without a
toolchain pre-req on the runner.** Fallback (source build) cost is
documented below for the worst-case "prebuild fetch fails behind a
firewall" scenario.

## Method

`probe.mjs` (node: stdlib only, no deps) hits the GitHub Releases API for
`WiseLibs/better-sqlite3` at a given version and asserts that an asset
named `better-sqlite3-v<version>-node-v<abi>-<platform>-<arch>.tar.gz`
exists for each target. It also has a live `require('better-sqlite3') +
new Database(':memory:')` leg that is meaningful only when run on an
arm64 host with the package installed — on x64 hosts (or in pools without
`pnpm install`) that leg is skipped via `--no-load` and the verdict comes
purely from the remote manifest.

Why this is sufficient: the `prebuild-install` resolver inside
`better-sqlite3/install.js` builds the same filename and downloads it
from the matching GitHub release. If the asset is present in the release
manifest, `prebuild-install` succeeds with the bundled fetch logic, and
`require('better-sqlite3')` loads the `.node` without invoking
`node-gyp`. The arm64-specific risk we were asked to retire is exactly
"no prebuild for darwin-arm64 / linux-arm64 at our pinned ABI" — that
question is answered fully by the manifest.

The probe was run from `win32/x64` (this dev host) with `--no-load`. To
also exercise the live load on arm64, mount the probe into a daemon
checkout that has `better-sqlite3` installed and re-run without
`--no-load`; the output schema is forever-stable and machine-checkable
(see header of `probe.mjs`).

## Results

Host: `win32/x64`, Node `v24.14.1`. Querying release manifest only.

### v12.9.0 (the pinned version in `package.json` + `packages/daemon/package.json`)

```
$ node probe.mjs --version=12.9.0 --no-load
{
  "ok": true,
  "version": "12.9.0",
  "abi": "127",
  "remote": {
    "releaseTag": "v12.9.0",
    "prebuilds": {
      "darwin-arm64":    { "present": true, "asset": "better-sqlite3-v12.9.0-node-v127-darwin-arm64.tar.gz",    "sizeBytes":  973274 },
      "linux-arm64":     { "present": true, "asset": "better-sqlite3-v12.9.0-node-v127-linux-arm64.tar.gz",     "sizeBytes": 1064121 },
      "linuxmusl-arm64": { "present": true, "asset": "better-sqlite3-v12.9.0-node-v127-linuxmusl-arm64.tar.gz", "sizeBytes": 1224059 },
      "win32-arm64":     { "present": true, "asset": "better-sqlite3-v12.9.0-node-v127-win32-arm64.tar.gz",     "sizeBytes":  905718 }
    }
  },
  "local": null
}
exit=0
```

### v11.10.0 (prior LTS line — sanity check, used by the T9.8 SEA spike)

```
$ node probe.mjs --version=11.10.0 --no-load
{
  "ok": true,
  "version": "11.10.0",
  "abi": "127",
  "remote": {
    "releaseTag": "v11.10.0",
    "prebuilds": {
      "darwin-arm64":    { "present": true, "asset": "better-sqlite3-v11.10.0-node-v127-darwin-arm64.tar.gz",    "sizeBytes":  940948 },
      "linux-arm64":     { "present": true, "asset": "better-sqlite3-v11.10.0-node-v127-linux-arm64.tar.gz",     "sizeBytes": 1041023 },
      "linuxmusl-arm64": { "present": true, "asset": "better-sqlite3-v11.10.0-node-v127-linuxmusl-arm64.tar.gz", "sizeBytes": 1125852 },
      "win32-arm64":     { "present": true, "asset": "better-sqlite3-v11.10.0-node-v127-win32-arm64.tar.gz",     "sizeBytes":  864169 }
    }
  },
  "local": null
}
exit=0
```

## Per-target matrix (Node 22 / ABI 127)

| platform   | arch  | prebuild shipped (12.9.0) | install path        | gating verdict for ch14 §1.12 |
| ---------- | ----- | ------------------------- | ------------------- | ----------------------------- |
| darwin     | arm64 | yes (~ 950 KB)            | prebuild fetch      | **PASS** (required)           |
| linux-glibc| arm64 | yes (~ 1.0 MB)            | prebuild fetch      | **PASS** (required)           |
| linux-musl | arm64 | yes (~ 1.2 MB)            | prebuild fetch      | PASS (alpine support — bonus) |
| win32      | arm64 | yes (~ 0.9 MB)            | prebuild fetch      | PASS (covered separately by SEA) |

ABI mapping reminder (`NODE_MODULE_VERSION`): Node 18 = 108, Node 20 = 115,
Node 22 = 127, Node 24 = 137. v0.3 toolchain pin is Node 22 LTS per
`docs/superpowers/specs/2026-05-03-toolchain-lock-design.md`. The repo's
`.github/workflows/*.yml` currently pins `node-version: '20'`; that pin
must move to `22` for the phase-3 SQLite arm64 jobs to exercise the same
prebuild this spike validated. Filed as a follow-up below.

## Fallback build cost (when the prebuild can't be fetched)

`prebuild-install` falls through to `node-gyp rebuild` if the GitHub
download fails (offline runner, corp proxy stripping `*.githubusercontent.com`,
release yanked, etc.). The compile is plain C against the SQLite amalgamation
that ships in the npm tarball — no external libsqlite needed.

| Host                         | Approx. wall-clock | Disk |
| ---------------------------- | -------------------| ---- |
| GHA `ubuntu-22.04-arm`       | 60-120 s           | ~ 35 MB build dir |
| GHA `macos-14` (arm64)       | 50-90 s            | ~ 30 MB |
| Bare-metal Apple M2 / M3     | 30-60 s            | same |
| Docker `node:22-bookworm`    | 60-120 s           | ~ 35 MB; needs python3 + g++ already in image |
| Docker `node:22-slim`        | **fails**          | base image lacks python3 + g++; install adds ~ 250 MB |
| Docker `node:22-alpine`      | 60-120 s           | needs `apk add python3 make g++ libc6-compat`; uses linuxmusl prebuild first |

Numbers are characteristic of `node-gyp` builds of the SQLite amalgamation
(`sqlite3.c` is ~ 8 MB single TU); cited from upstream issues
(`WiseLibs/better-sqlite3#888`, `#967`) and the T9.10 node-pty spike's
observed compile times on similar hosts. We did not run the full source
build on this host — the question being answered is "do we ever HAVE to",
and the answer is "no for any sane network path".

Build deps required if the prebuild path is ever blocked:
`python3` (>= 3.7), C/C++ toolchain (`build-essential` on Debian/Ubuntu,
Xcode CLT on macOS, `apk add make g++` on Alpine). The default GHA
`ubuntu-22.04`, `ubuntu-22.04-arm`, `macos-13`, `macos-14` images already
include all of these; the only failure mode is the slim/alpine container
case, and we are not targeting those for v0.3 daemon builds.

## Why this retires the ch14 §1.12 risk

The spec entry §1.12 was carrying a TODO of the form "verify
better-sqlite3 has prebuilt binaries for our arm64 targets, otherwise
phase-3 needs a toolchain pre-step". The manifest evidence above
demonstrates:

1. Both versions in our pin range (11.x, 12.x) ship Node-22-ABI prebuilds
   for `darwin-arm64`, `linux-arm64` (glibc), and `linuxmusl-arm64`.
2. The prebuild is fetched by `prebuild-install` automatically during
   `pnpm install`; the daemon's `package.json` does not need any extra
   `npm_config_*` env vars or post-install hooks for arm64.
3. Source-build fallback is bounded (under 2 minutes on every
   v0.3-supported host) and only triggers on a network failure, which is
   already covered by general "GHA is offline" risk, not arm64-specific.

Therefore phase-3 SQLite work can run on the standard
`runs-on: [macos-14, ubuntu-22.04-arm]` matrix with `node-version: '22'`
and no extra setup steps. No new dependency, no new tool, no new lock.

## Risks / follow-ups

1. **Move CI to Node 22.** `.github/workflows/{ci,e2e,release}.yml` still
   pin `node-version: '20'` (ABI 115). Phase-3 cannot consume this
   spike's evidence until those jobs move to `'22'`. That bump is its
   own task per the toolchain-lock design doc — out of scope here.
2. **arm64 runners on the matrix.** GHA `ubuntu-22.04-arm` is now GA;
   `macos-14` (M1) has been GA for over a year. Both should be added to
   the phase-3 SQLite job's matrix. No self-hosted runner needed.
3. **Live load on real arm64.** This spike only validated the manifest
   from an x64 host. Phase-3 should re-run `node probe.mjs` (without
   `--no-load`) inside the actual `macos-14` and `ubuntu-22.04-arm` jobs
   as a 1-line smoke before exercising real workload — the probe's exit
   code is the gate.
4. **Pin the prebuild URL in v0.3 lockfile.** Per the T9.8 SEA spike
   recommendation (`tools/spike-harness/probes/sqlite-in-sea/RESULT.md`
   point 5), production SEA bundles must lock the exact prebuild
   tarball URL + sha. The arm64 tarball names verified above feed
   directly into that lockfile; URLs follow the pattern
   `https://github.com/WiseLibs/better-sqlite3/releases/download/v<ver>/<asset>`.
5. **musl vs glibc.** `linuxmusl-arm64` prebuild exists, so future Alpine
   support is not blocked, but v0.3 target list explicitly excludes
   Alpine. Recorded for posterity.

## Files

- `probe.mjs` — fetches GitHub release manifest; checks arm64 assets at
  the requested ABI; optional live `require('better-sqlite3')` smoke.
  Header documents the forever-stable contract per ch14 §1.B.
- `package.json` — probe-only manifest; not added to the workspace.
- `.gitignore` — excludes `node_modules/` / lockfiles.
