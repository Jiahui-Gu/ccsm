# Per-OS installer scaffolding

> Spec: `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md` chapter 10 §5.
> Task: T7.4 (Issue #81).

This directory holds the per-OS installer artifacts that register the
`ccsm-daemon` binary as a system service and create the daemon's state
directory with the spec-locked ownership/mode. The artifacts are wired into
real `.msi` / `.pkg` / `.deb` / `.rpm` packages by the per-OS builder
scripts; locally and in cert-less CI runs, the builders are
**placeholder-safe** — missing toolchains produce a `WARN:` line and exit
`0` so dogfood `npm run build` keeps passing.

| OS      | Layout                                          | Tooling                      | Builder                                  |
| ------- | ----------------------------------------------- | ---------------------------- | ---------------------------------------- |
| Windows | `win/Product.wxs.template`                      | WiX 4 (`wix build`)          | `win/build-msi.ps1`                      |
| macOS   | `mac/com.ccsm.daemon.plist` + pre/postinstall   | `pkgbuild` + `productbuild`  | `mac/build-pkg.sh`                       |
| Linux   | `linux/ccsm-daemon.service` + postinst/prerm/postrm | `fpm` (deb + rpm)        | `linux/build-pkg.sh`                     |

## What this PR ships

This is **scaffolding** — it produces real installers when the per-OS
toolchain is present, and it lays down the canonical templates / unit /
plist / scripts the spec pins. Three things are explicitly NOT in scope:

- **Post-install `/healthz` wait + 10 s rollback** — owned by T7.5 (#83).
  The MSI's `<ServiceInstall Vital="yes">` + auto-start kicks the service;
  T7.5 polls `/healthz` and triggers MSI rollback / pkg failure on timeout.
- **Uninstaller scripts + `REMOVEUSERDATA` matrix exercise** — owned by
  T7.6 (#84). The MSI declares the public `REMOVEUSERDATA` property and
  the linux `postrm` honours `CCSM_REMOVE_USER_DATA=1`; T7.6 wires the
  ship-gate (d) round-trip test that exercises both `=0` / `=1` variants.
- **CI workflow that calls these builders** — owned downstream
  (T0.9 / mutex on `.github/workflows/*.yml`).

## Locked design decisions

The following choices are pinned by spec ch10 §5 and the test file
`build/__tests__/install-scripts.spec.ts` enforces them as forever-stable
shape gates:

### Windows MSI (`win/Product.wxs.template`)

- WiX 4+ schema (`http://wixtoolset.org/schemas/v4/wxs`).
- Service registration via declarative `<ServiceInstall>` — **NOT** a
  `sc.exe` custom action (cleaner uninstall + rollback semantics).
- Service runs as `NT AUTHORITY\LocalService` (built-in low-priv account;
  no installer-managed account).
- `<ServiceConfigFailureActions>`: restart on first failure (5 s delay) +
  restart on second (30 s) + `none` on third. The third action diverges
  from the spec literal "run-program" because we do not yet ship a
  recovery exe; the installer's `/healthz`-fail rollback path (T7.5) is
  the recovery boundary. Reviewer may flag — see PR body for rationale.
- `<util:ServiceConfig ServiceSidType="restricted">` — required so the
  state-dir DACL can grant the `ccsm-daemon` service SID Modify on
  `%PROGRAMDATA%\ccsm`.
- State directory `%PROGRAMDATA%\ccsm` (matches T5.3 `statePaths()`
  win32 row): DACL grants `LocalService` Modify, `BUILTIN\Users` Read,
  `BUILTIN\Administrators` FullAccess. Matches spec ch10 §5.1 line:
  *"grant LocalService Modify; grant interactive user Read on the
  listener descriptor file"*.
- `REMOVEUSERDATA` public secure property — `1` removes state dir on
  uninstall (silent + interactive variants exercised by ship-gate (d)).
- `<MajorUpgrade>` — upgrade in place; state dir survives.

The canonical upgrade GUID is baked into `build-msi.ps1` and **MUST NOT
change across releases**. Override only via `CCSM_UPGRADE_CODE` env for
downstream forks.

### macOS pkg (`mac/`)

- `com.ccsm.daemon.plist` LaunchDaemon installed to
  `/Library/LaunchDaemons/`.
- `UserName=_ccsm` / `GroupName=_ccsm` — service account created by
  `preinstall.sh` via `dscl` if it does not exist (UID/GID in 200-499
  range per Apple convention).
- `RunAtLoad=true` + `KeepAlive` — launchd restarts on unexpected exit,
  matching systemd `Restart=on-failure`.
- Daemon binary installed at `/usr/local/ccsm/ccsm-daemon`, native modules
  at `/usr/local/ccsm/native/` (matches `process.execPath`-relative
  loader in ch10 §2).
- `preinstall.sh` creates state dir `/Library/Application Support/ccsm`
  mode 0700 owned by `_ccsm:_ccsm` (matches T5.3 `statePaths()` darwin
  row).
- `postinstall.sh` calls `launchctl bootout` (best-effort) →
  `bootstrap system` → `enable` → `kickstart -k`, exactly the recipe in
  spec ch10 §5.2.

### Linux deb + rpm (`linux/`)

- `ccsm-daemon.service` systemd unit installed to
  `/lib/systemd/system/`. The block of LOCKED directives (ch07 §2) is:

  ```ini
  RuntimeDirectory=ccsm
  RuntimeDirectoryMode=0750
  StateDirectory=ccsm
  StateDirectoryMode=0750
  User=ccsm
  Group=ccsm
  ```

  systemd creates `/run/ccsm/` (Listener-A UDS bind dir per ch03 §3) and
  `/var/lib/ccsm/` (state dir per ch07 §2 — matches T5.3 `statePaths()`
  linux row) on service start with correct ownership/mode. The daemon
  does NOT create either directory itself.
- `Type=notify` + `WatchdogSec=30` — daemon emits `sd_notify("READY=1")`
  at startup ordering step 7 and `sd_notify("WATCHDOG=1")` at the
  Supervisor `/healthz` cadence (ch08).
- `postinst.sh` creates `ccsm:ccsm` system user/group (must exist before
  systemd starts the unit or `User=ccsm` is rejected) and runs
  `systemctl daemon-reload && systemctl enable --now ccsm-daemon`.
  Postinst returns `0` even if `enable --now` fails — the installer's
  `/healthz` poll (T7.5) is the ship-gate, not the postinst exit code
  (which would otherwise produce confusing dpkg/rpm hard-failures).
- `prerm.sh` stops + disables on remove; skips on upgrade.
- `postrm.sh` honours `CCSM_REMOVE_USER_DATA=1` env var — removes
  `/var/lib/ccsm` and `userdel ccsm` on purge (ch10 §5 step 4 mac/linux
  silent-uninstall contract).

## Builder contracts

All three builders share an env contract:

| Env var                  | Required | Purpose                                                                               |
| ------------------------ | -------- | ------------------------------------------------------------------------------------- |
| `CCSM_VERSION`           | no       | Product version. Defaults to root `package.json` `version`.                           |
| `CCSM_INSTALLER_DRY_RUN` | no       | `1` to print the `wix` / `pkgbuild` / `fpm` invocations and exit `0` without touching artifacts. |

Plus per-OS extras:

| Builder                  | Extra env / args                                                                  |
| ------------------------ | --------------------------------------------------------------------------------- |
| `win/build-msi.ps1`      | `CCSM_UPGRADE_CODE` (override forks-only), `CCSM_MANUFACTURER`. Args: `-DaemonDir`, `-OutputDir`. |
| `mac/build-pkg.sh`       | `CCSM_PKG_IDENTIFIER` (default `com.ccsm.daemon`). Positional: binary, native dir, output dir.    |
| `linux/build-pkg.sh`     | `CCSM_PKG_NAME` (default `ccsm`). Positional: binary, native dir, output dir.                     |

## Placeholder-safe demonstration

```bash
$ bash packages/daemon/build/install/mac/build-pkg.sh
[install-mac] WARN: non-darwin host (MINGW64_NT-...); macOS .pkg build skipped.
[install-mac] WARN: this is expected for local cross-platform dogfood builds.
$ echo $?
0

$ bash packages/daemon/build/install/linux/build-pkg.sh
[install-linux] WARN: fpm not on PATH — skipping linux package build.
[install-linux] WARN: (install via: gem install fpm; requires ruby + a sane build env.)
$ echo $?
0

$ pwsh packages/daemon/build/install/win/build-msi.ps1
WARNING: [install-win] non-windows host; WiX MSI build skipped.
$ echo $LASTEXITCODE
0
```

Set `CCSM_INSTALLER_DRY_RUN=1` to see the exact `wix build` / `pkgbuild` /
`productbuild` / `fpm` invocations that would run without touching any
artifact.

## Out of scope — downstream tasks

| Concern                                          | Owner                                  |
| ------------------------------------------------ | -------------------------------------- |
| Post-install `/healthz` 10 s wait + rollback     | T7.5 (#83)                             |
| Uninstaller `REMOVEUSERDATA` matrix exercise     | T7.6 (#84)                             |
| Electron app bundle in MSI / pkg / deb / rpm     | T7.7 (#85) `electron-builder` config   |
| Sea-smoke post-install end-to-end                | T7.8 (#86)                             |
| `tools/verify-signing.{sh,ps1}` per-OS           | T7.9 (#80)                             |
| In-place update flow + rollback                  | T7.10                                  |
| CI workflow wiring (`.github/workflows/*.yml`)   | T0.9 (mutex)                           |
| Code signing of the produced `.msi` / `.pkg` / `.deb` / `.rpm` | T7.3 sign-`*` scripts (already merged) |
