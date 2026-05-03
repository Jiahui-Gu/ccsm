# T9.14 — MSI tooling pick: decision

## Recommendation: WiX 4 (direct authoring)

The v0.3 Windows installer should be authored directly with the
**WiX 4+ toolset** (`wix build`, dotnet global tool, schema
`http://wixtoolset.org/schemas/v4/wxs`), invoked from CI as a
Windows-native step. Electron-builder should **not** be used for
the MSI target.

## Quantitative measurements (this host)

Same Windows 11 Enterprise 26200.8246 host, .NET 10.0.203,
WiX 5.0.2 dotnet global tool, Node 24.14.1, npm 11.11.0.

|                       | WiX 4 (`wix4/`)              | electron-builder (`electron-builder/`) |
| --------------------- | ---------------------------- | --------------------------------------- |
| Cold build wall time  | **33.3 s** (publish 13.4s + wix 19.9s) | **160 s** (failed 1st run, 195s; succeeded 2nd run with `-sval`) |
| Warm rebuild wall time | **16.6 s** (`wix build` only) | **149 s** (full electron repackage)    |
| Output MSI size       | **32 768 B** + 27.8 MiB cab1.cab (sidecar) = ~28 MiB total | **113 262 592 B** (108 MiB MSI, all-in-one) |
| Unpacked payload size | 75.7 MiB (self-contained .NET host, no Electron) | 344 MiB on disk (Electron 41 + Chromium runtime) |
| Worked out-of-the-box | **yes**                      | **no** — `light.exe LGHT1105` ICE / system-policy block on first run; required adding `additionalLightArgs: ["-sval"]` to skip ICE validation, which is unacceptable for a shipped installer. |
| `<ServiceInstall>`    | **supported** (verified GREEN by spike #113 PR #890 on the same host) | **not supported** — template has no service elements, no extension hook, no `additionalWixArgs` path that can inject service authoring |
| Custom actions        | full WiX CA surface (immediate / deferred / impersonated, ExeCommand, VBScriptFile, JScriptFile, BinaryRef) | only `runAfterFinish` (fixed: launches `mainExecutable` post-install, no arbitrary CA) |
| arm64                 | native arm64 support in WiX 4+ | source code defaults arm64 → x64; bundled WiX 3.x vendor "doesn't support the arm64 architecture" (verbatim comment in `MsiTarget.ts`) |
| Toolchain currency    | WiX 4 / 5 (active line)      | WiX 3.x via `electron-builder-binaries` `wix-4.0.0.5512.2` package — labeling misleading; binaries are `candle.exe` + `light.exe` (WiX 3 toolchain) |
| Reproducibility       | `dotnet tool install --global wix --version <pin>` | locked to whatever vendor archive electron-builder-binaries publishes; bumping requires upstream PR |
| Cross-build           | WiX 4 has Linux support via `dotnet tool` (the same `wix` tool runs on Linux), but service install + signtool keep CI on a Windows runner regardless | claimed via Wine + dotnet462; not exercised here. CI will be on Windows for signtool anyway. |
| Signing               | `signtool sign /fd SHA256` on the .msi after `wix build`, plus a separate `signtool` pass on the embedded daemon exe before `wix build` ingests it. Two clean steps. | `signtool` invoked twice automatically on the unpacked .exe and the .msi; daemon binary signing must still be done manually before electron-builder packages |

## Comparison criteria scorecard (criteria from `README.md`)

| # | Criterion                                  | WiX 4 | electron-builder |
| - | ------------------------------------------ | ----- | ---------------- |
| 1 | MSI output size                            | ~28 MiB total (32 KiB MSI + cab) | 108 MiB MSI |
| 2 | Build time (cold / warm)                   | 33s / 17s | 160s / 149s |
| 3 | `<ServiceInstall>` / `<ServiceControl>`    | yes (#890 GREEN) | no (template blocker) |
| 4 | Custom action support                      | full | runAfterFinish only |
| 5 | Cross-build from non-Windows               | yes (`dotnet tool`) | claimed (Wine) |
| 6 | Authenticode signing flow                  | manual `signtool`, two steps | automatic (after the embedded daemon is pre-signed) |
| 7 | Embed daemon binary as separate file + service | yes (just add a `<File>` + `<ServiceInstall>` in a Component) | technically possible to ship the file as part of asarUnpack, but no way to register it as a service |
| 8 | Schema modernity                           | WiX 4/5 (active) | WiX 3.x (maintenance only) |
| 9 | Pin / reproducibility                      | `dotnet tool install --global wix --version 5.0.2` | tied to electron-builder-binaries release cadence |

WiX 4 wins **8 / 9** criteria. Electron-builder wins **1 / 9**
(criterion 6, signing automation — and only for the Electron exe,
not for the daemon binary).

## Why criterion 3 alone is decisive

Spec ch14 §1.14 phase 9.5 (the spike that produced #890) made
`<ServiceInstall>` a hard requirement: the daemon must register
with SCM as `CcsmDaemon` (or equivalent) and start on demand.
Electron-builder's MSI template has **no path** to emit this
authoring without forking upstream. Forking electron-builder for
one feature is unacceptable for a v0.3 ship target per
`feedback_v03_zero_rework.md` ("don't write code that v0.4 will
throw away").

The remaining 8 criteria are tiebreakers — but criterion 3 alone
already settles it.

## Architectural fit with v0.3

The v0.3 architecture is **Electron thin + daemon fat** (per
`project_v03_ship_goal.md`). The Electron app is a UI shell; the
daemon is a separate native binary that runs as a Windows service.
This means:

- The Electron app itself does **not** need to be in the same MSI
  as the daemon — they have different lifecycles, different update
  cadences, and different signing needs. The Electron side can ship
  via the existing NSIS target (already in `package.json` as
  `"win": [{ "target": "nsis" }]`).
- The daemon is what needs an MSI, specifically because of the
  `<ServiceInstall>` requirement that NSIS can't satisfy cleanly
  either (NSIS can call `sc create` but doesn't manage SCM state
  through MSI standard actions, so uninstall residue is harder).

Picking electron-builder here would mean:
1. Bundle the entire Electron payload (108 MiB+) into the MSI just
   to get a service registration the template doesn't support, **or**
2. Ship two installers (NSIS for the Electron app, somehow-other for
   the daemon).

WiX 4 lets us do the right thing: a small (~28 MiB) MSI that ships
**only the daemon + service registration**, separate from the
Electron app's NSIS installer. This matches the architecture and
keeps the daemon updateable independently of UI churn.

## Cost of switching later

If we picked electron-builder now and hit the `<ServiceInstall>`
wall later (which is certain), the migration cost is:

- Re-author the wxs from scratch (electron-builder template ≠ v4 schema).
- Re-do the build script integration.
- Re-do the signing flow (separate signtool invocations).
- Re-validate on 25H2 (need a fresh 9.5 phase pass).

That is the v0.4 throwaway-code smell that the zero-rework rule
forbids. Picking WiX 4 now means the spike #113 work product is
directly reusable: the `Product.wxs` here in `wix4/Product.wxs`
is structurally a clone of #890's, plus a slightly more daemon-shaped
payload to validate file size accounting.

## Out of scope for this spike (deferred to Windows installer task)

These were explicitly **not** decided here, only enumerated:

- Daemon service identity (`LocalSystem` vs `NT SERVICE\\CcsmDaemon`)
  — see #890 follow-up #2.
- `Start="auto"` + `<util:ServiceConfig DelayedAutoStart="yes">` —
  see #890 follow-up #3.
- WiX vendor pin (4.0.x vs 5.0.x) — both are valid for the v4 schema;
  pick whichever the CI runner can install via `dotnet tool restore`
  reproducibly.
- Authenticode signing key procurement — out of scope, gated on
  v0.3's signing placeholder-safe story per `feedback_v03_zero_rework.md`.
- MSI bundling (Burn / Bundle) if we ever want a single
  daemon+app installer — explicitly not v0.3.

## Final answer

**WiX 4.** Author the Windows installer for the daemon directly
with `wix build`. Keep the Electron app on its existing NSIS target.
Reuse the `Product.wxs` pattern from #890 / `wix4/Product.wxs`.
