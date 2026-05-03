# T9.14 — MSI tooling pick: WiX 4 vs electron-builder

Task: **Task #114**. Spec: ch14 §1.16 phase 9.5. Decide between
authoring the v0.3 Windows MSI installer with **WiX 4+** directly,
versus **electron-builder**'s built-in `msi` target.

Inputs:

- Merged spike #113 (PR #890) — WiX 4+ `<ServiceInstall>` proven GREEN
  on Windows 11 25H2 (same host this spike runs on).
- Repo's existing `electron-builder` config in `package.json` (current
  Windows target = `nsis`; MSI is one config switch away).

Companion docs in this folder:

- `wix4/` — minimal MSI built directly with WiX 4+ (`wix build`),
  reusing the same authoring pattern as #113.
- `electron-builder/` — minimal `msi` target attempt + analysis of
  what its template can and cannot express.
- `decision.md` — recommendation, with measurements.

## Comparison criteria

| # | Criterion                                                    | Why it matters for v0.3                                                                                              |
| - | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1 | **MSI output size** (KiB, payload-excluded baseline + delta) | Installer download size budget; smaller MSI overhead is preferred when payload is fixed.                             |
| 2 | **Build time** (cold + warm, seconds)                        | CI minutes per release; >2x dev iteration cost adds up over 9.5 phase tasks.                                         |
| 3 | **`<ServiceInstall>` / `<ServiceControl>` support**          | Hard requirement — daemon must register with SCM (per #113 spec ch14 §1.14). No service install = blocker.            |
| 4 | **Custom action support** (CA exec, immediate / deferred)    | Needed for: minisign signature verify pre-install, daemon socket DACL (`set-pipe-dacl.ps1` parity), post-install reg. |
| 5 | **Cross-build from non-Windows host**                        | CI matrix simplification; if Linux runner can emit Windows MSI we save a Windows runner job.                         |
| 6 | **Authenticode signing flow**                                | v0.3 ships placeholder-safe signing per `feedback_v03_zero_rework.md`; flow must accept `signtool sign /fd SHA256` on the .msi *and* the embedded daemon exe. |
| 7 | **Ability to embed daemon binary** (separate from Electron app) | v0.3 architecture = Electron thin + daemon fat. Daemon exe is a separate binary the MSI must install + register as a service. |
| 8 | **Schema modernity / upstream support**                      | WiX 3.x is in maintenance only; WiX 4/5 is the actively-developed line. Picking the EOL line means migrating again later. |
| 9 | **Pin / reproducibility** (toolchain version pinning)        | Reproducible CI builds; pinned toolchain version surviving major releases.                                           |

## Method

Build identical-payload MSIs with both tools, measure 1 / 2 / 7,
inspect the templates / docs / source for 3 / 4 / 5 / 6 / 8 / 9.
Where actual builds are not possible on this host, capture the
blocker verbatim and fall back to documentation + #890 evidence.

This host (Windows 11 Enterprise 26200.8246, .NET 10.0.203,
WiX 5.0.2 dotnet global tool, Node 24.14.1, npm 11.11.0, no Wine,
no electron-builder vendor cache populated) supports the WiX 4+
direct path natively; the electron-builder MSI path requires its
bundled WiX 3.x vendor archive to be downloaded on first invocation.

## Layout

```
msi-tooling-pick/
  README.md                this file
  decision.md              recommendation + measurements
  wix4/
    Product.wxs            minimal authoring with ServiceInstall
    build.ps1              dotnet publish + wix build
    payload/Program.cs     trivial daemon-shaped exe target
    payload/payload.csproj
    .gitignore
  electron-builder/
    package.json           minimal package with msi target enabled
    main.js                trivial Electron entry
    ATTEMPT.md             what was tried, what blocked, what the template can/cannot do
```
