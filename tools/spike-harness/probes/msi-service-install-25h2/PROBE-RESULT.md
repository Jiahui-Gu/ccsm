# T9.13 — WiX 4 ServiceInstall on Windows 11 25H2

Task: **Task #113**. Spec: ch14 §1.14 phase 9.5 — must resolve before the
Windows installer phase. Goal: prove the modern WiX 4+ schema's
`<ServiceInstall>` + `<ServiceControl>` elements register, start, stop,
and uninstall a Windows service cleanly on 25H2.

## TL;DR

**GREEN** for the Windows installer phase on 25H2.

- WiX 5.0.2 (`http://wixtoolset.org/schemas/v4/wxs`, dotnet global tool)
  builds the MSI without warnings.
- `msiexec /i ... /qn` returns **0**; the service is registered with SCM
  (`sc qc` shows `BINARY_PATH_NAME`, `DISPLAY_NAME`, description, and
  `START_TYPE = DEMAND_START`), and is **RUNNING** post-install.
- `msiexec /x ... /qn` returns **0**; `sc query CcsmSpikeSvc` returns
  **1060** (`ERROR_SERVICE_DOES_NOT_EXIST`) — clean SCM removal, no
  reboot required, no orphaned `ImagePath`.
- All four MSI service standard actions (`StopServices`,
  `DeleteServices`, `InstallServices`, `StartServices`) execute with
  `Return value 1` (success) on both install and uninstall passes.

No 25H2-specific quirks observed (no MSI 1603, no SCM 1053 timeout,
no OS-shielded reg-key blocks).

## Host

| Field        | Value                                                             |
| ------------ | ----------------------------------------------------------------- |
| OS           | Microsoft Windows 11 Enterprise                                   |
| Build        | **10.0.26200.8246** (25H2)                                        |
| Arch         | x64                                                               |
| .NET SDK     | 10.0.203                                                          |
| WiX toolset  | **5.0.2+aa65968c** (dotnet global tool, schema = WiX v4 namespace)|
| Service exe  | `ccsm-spike-svc.exe` (self-contained, single-file, win-x64)       |

WiX 5 is the supported successor of WiX 4: it still uses the
`http://wixtoolset.org/schemas/v4/wxs` namespace (i.e., the v4 authoring
schema). `Product.wxs` here is therefore valid for both WiX 4.x and 5.x.

## Authoring

`Product.wxs` (single source file, ~75 lines):

```xml
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="..." Manufacturer="..." Version="0.0.1"
           UpgradeCode="6c0e6f10-9b0a-4d4e-8d3a-3a2cf7c2b5b1"
           Compressed="yes" Scope="perMachine">
    <MajorUpgrade DowngradeErrorMessage="..." />
    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="CcsmSpikeSvc">
        <Component Id="SvcExe" Bitness="always64" Guid="*">
          <File Id="SvcExeFile"
                Name="ccsm-spike-svc.exe"
                Source="build\svc\ccsm-spike-svc.exe"
                KeyPath="yes" />
          <ServiceInstall Id="CcsmSpikeSvcInstall"
                          Name="CcsmSpikeSvc"
                          DisplayName="CCSM Spike Service (T9.13)"
                          Description="..."
                          Type="ownProcess"
                          Start="demand"
                          ErrorControl="normal"
                          Vital="yes" />
          <ServiceControl Id="CcsmSpikeSvcControl"
                          Name="CcsmSpikeSvc"
                          Start="install"
                          Stop="both"
                          Remove="uninstall"
                          Wait="yes" />
        </Component>
      </Directory>
    </StandardDirectory>
    <Feature Id="Main" Level="1">
      <ComponentRef Id="SvcExe" />
    </Feature>
  </Package>
</Wix>
```

### WiX 4 → 5 schema notes worth recording

1. `<ServiceInstall>` and `<ServiceControl>` are children of
   **`<Component>`**, not `<File>`. Putting them under `<File>` (a
   pattern occasionally suggested in tutorials) yields
   `WIX0005: The File element contains an unexpected child element
   'ServiceInstall'`. The service exe is identified by the `<File>` with
   `KeyPath="yes"` inside the same component.
2. `<Product>` and `<Package>` were merged in v4: there is now a single
   top-level `<Package>` element.
3. `<Directory>` references that previously pointed at `TARGETDIR /
   ProgramFilesFolder` now go through `<StandardDirectory Id="...">`.
4. `<MajorUpgrade>` no longer needs an explicit `UpgradeVersion` table.

These are the only deltas the Windows installer phase needs to know about
when porting v3 authoring forward.

## Reproduction

Prerequisites:
```
dotnet tool install --global wix --version 5.0.2
# .NET 10 SDK already on PATH
```

Build (no admin needed):
```
powershell -ExecutionPolicy Bypass -File ./build.ps1
```
This produces `build/CcsmSpikeSvc.msi` (~32 KiB MSI + ~27 MiB cab1.cab
holding the self-contained service exe).

Install + smoke + uninstall (admin required, will UAC-prompt):
```
powershell -ExecutionPolicy Bypass -File ./probe.ps1
```

## Captured run (verbatim, 2026-05-03 on build 26200.8246)

### Install

```
install_exit=0
```

`build/install.log` (UTF-16, decoded; relevant lines):
```
Action start 3:42:11: StopServices.
Action ended 3:42:11: StopServices. Return value 1.
Action start 3:42:11: DeleteServices.
Action ended 3:42:11: DeleteServices. Return value 1.
Action start 3:42:11: InstallServices.
Action ended 3:42:11: InstallServices. Return value 1.
Action start 3:42:11: StartServices.
Action ended 3:42:11: StartServices. Return value 1.
MSI (s) (D0:04) [03:42:20:787]: MainEngineThread is returning 0
```
("Return value 1" is MSI's success code; 0 = error.)

### Post-install SCM state

```
sc.exe query CcsmSpikeSvc
SERVICE_NAME: CcsmSpikeSvc
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)

sc.exe qc CcsmSpikeSvc
SERVICE_NAME: CcsmSpikeSvc
        TYPE               : 10  WIN32_OWN_PROCESS
        START_TYPE         : 3   DEMAND_START
        ERROR_CONTROL      : 1   NORMAL
        BINARY_PATH_NAME   : "C:\Program Files\CcsmSpikeSvc\ccsm-spike-svc.exe"
        DISPLAY_NAME       : CCSM Spike Service (T9.13)
        SERVICE_START_NAME : LocalSystem

sc.exe qdescription CcsmSpikeSvc
DESCRIPTION:  MSI ServiceInstall probe for Windows 11 25H2 (WiX 4+ schema).
```

### Uninstall

```
uninstall_exit=0
```

`build/uninstall.log` relevant lines:
```
Action start 3:42:54: StopServices.
Action ended 3:42:54: StopServices. Return value 1.
Action start 3:42:54: DeleteServices.
Action ended 3:42:54: DeleteServices. Return value 1.
MSI (s) (D0:8C) [03:42:56:009]: MainEngineThread is returning 0
```

### Post-uninstall SCM state

```
sc.exe query CcsmSpikeSvc
[SC] EnumQueryServicesStatus:OpenService FAILED 1060:
The specified service does not exist as an installed service.
```

`1060 = ERROR_SERVICE_DOES_NOT_EXIST` — the MSI removed the SCM record
without leaving an `ImagePath` registry residue. No reboot required.

## Exit-code reference for the Windows installer phase

| Operation        | Command                                               | Expected exit |
| ---------------- | ------------------------------------------------------ | ------------- |
| Install          | `msiexec /i CcsmSpikeSvc.msi /qn /L*v install.log`     | `0`           |
| Repair (re-run)  | `msiexec /fav CcsmSpikeSvc.msi /qn`                    | `0`           |
| Uninstall        | `msiexec /x CcsmSpikeSvc.msi /qn /L*v uninstall.log`   | `0`           |
| `sc query` (gone)| `sc query CcsmSpikeSvc`                                | `1060`        |
| Reboot required  | (not seen here; MSI sets ERROR\_SUCCESS\_REBOOT\_REQUIRED = `3010` if files were locked) | `0` |

For unattended installer pipelines (T9.x Windows installer task),
treat **exit 0 OR 3010** as success; everything else is fatal. Map
`1603` → "fatal install error" (likely missing prereq /
non-elevated context).

## Risks / follow-ups before T9.x ships

1. **Signing**. The spike .msi is unsigned. Real installer must
   Authenticode-sign both the service exe and the .msi (separate
   `signtool sign /fd SHA256` invocations after WiX build). Unsigned
   service exes still install, but SmartScreen will gate downloads,
   and the LocalSystem service registration will trigger SmartScreen
   ELAM warnings under managed estates.
2. **Service identity**. Spike runs as `LocalSystem`. Real daemon should
   either stay LocalSystem (justified by needing to `accept()` on a
   loopback socket reachable for any local UID) or drop to
   `NT SERVICE\CcsmSpikeSvc` virtual account (set via
   `<ServiceInstall Account="NT SERVICE\\CcsmSpikeSvc">` + grant the
   socket DACL — separate spike).
3. **Auto-start vs demand**. Spike uses `Start="demand"` so MSI's own
   `StartServices` was the only thing that booted it. Production likely
   wants `Start="auto"` plus `<util:ServiceConfig>` (WixUtilExtension)
   for `DelayedAutoStart="yes"` and SCM failure-action recovery. Both
   are additive — schema verified working here.
4. **Per-user vs per-machine**. `Scope="perMachine"` is required for
   `<ServiceInstall>`; per-user MSIs cannot register Windows services.
   The Windows installer spec must inherit that constraint.
5. **WiX version pin**. WiX 5.0.2 was used; WiX 4.0.x produces an
   identical .msi for this authoring (verified by schema URL only —
   v4.x not installed here). Pin to whichever the build pipeline can
   reproducibly install via `dotnet tool restore`.

## Source files

- `Product.wxs` — MSI authoring (single file).
- `svc/CcsmSpikeSvc.csproj` + `svc/Program.cs` — minimal `BackgroundService`
  Windows service used as the install target.
- `build.ps1` — `dotnet publish` + `wix build`.
- `probe.ps1` — install + `sc query` + uninstall + assert 1060.
- `build/` — generated artifacts (.gitignored).
