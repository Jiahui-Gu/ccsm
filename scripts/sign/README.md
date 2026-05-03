# Code signing — env-var contract

> Spec: `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md` chapter 10 §3.
> Task: T7.3 (Issue #82).

The signing scripts live under `packages/daemon/build/` next to the SEA build
pipeline they hook into:

| Script                                   | OS      | What it signs                                                                |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `packages/daemon/build/sign-mac.sh`      | macOS   | `ccsm-daemon` Mach-O + every `native/*.node`, then notarize + staple binary. |
| `packages/daemon/build/sign-win.ps1`     | Windows | `ccsm-daemon.exe` + every `native\*.node` + optional `.msi`.                 |
| `packages/daemon/build/sign-linux.sh`    | Linux   | Detached `.sig` for ELF binary + `debsigs` `.deb` + `rpm --addsign` `.rpm`.  |

All three are invoked automatically as the post-stage step inside
`build-sea.sh` / `build-sea.ps1`. They are **placeholder-safe** (per
`project_v03_ship_intent`): when the env vars below are unset, the host is
not the target OS, or the platform tooling is not installed, each script
logs a `WARN:` line and exits `0`. Local dogfood builds without certs do
not break.

CI release jobs (T0.9 / future) are responsible for setting these env vars
from secrets and treating a missing-cert exit as a hard failure at the
release-job level (e.g. by gating on `tools/verify-signing.{sh,ps1}` from
T7.9, ch10 §7).

---

## macOS — `sign-mac.sh`

| Env var                  | Required | What it is                                                                                                          |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `APPLE_TEAM_ID`          | yes      | 10-character Apple Developer team identifier.                                                                       |
| `APPLE_SIGNING_IDENTITY` | yes      | Exact `security find-identity` line, e.g. `Developer ID Application: Acme Co (XXXXXXXXXX)`.                         |
| `APPLE_NOTARY_PROFILE`   | yes      | Name of an `xcrun notarytool store-credentials` keychain profile that holds Apple ID + app-specific password.       |
| `CCSM_SIGN_DRY_RUN`      | no       | `1` to print the `codesign` / `notarytool` invocations that would run and exit `0` without touching artifacts.      |

Hardened-runtime entitlements file (forever-stable per spec ch14 §1.B):
`tools/spike-harness/entitlements-jit.plist` — grants
`com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory` (both required by
V8 inside Node).

Bundle metadata: `tools/spike-harness/probes/macos-notarization-sea/Info.plist`.

One-time setup on the macOS runner:

```bash
xcrun notarytool store-credentials ccsm-notary \
      --apple-id "<release-bot@yourdomain>" \
      --team-id  "XXXXXXXXXX" \
      --password "<app-specific-password>"
```

---

## Windows — `sign-win.ps1`

| Env var               | Required | What it is                                                                                                  |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `WIN_CERT_PFX`        | yes      | Absolute path to a `.pfx` code-signing certificate. Use an EV cert for SmartScreen reputation.              |
| `WIN_CERT_PASSWORD`   | yes      | Password for the `.pfx` (empty allowed if cert is unprotected, not recommended).                            |
| `WIN_TIMESTAMP_URL`   | no       | RFC3161 timestamp authority URL. Defaults to `http://timestamp.digicert.com`.                               |
| `CCSM_SIGN_DRY_RUN`   | no       | `1` to print the `signtool` invocations that would run and exit `0` without touching artifacts.             |

`signtool.exe` is auto-discovered on `PATH` first; otherwise the script
walks `C:\Program Files (x86)\Windows Kits\10\bin\**\x64\signtool.exe` and
picks the highest-versioned candidate. Install the Windows SDK or pin
`signtool.exe` on `PATH` for release builds.

The MSI signing hook is inert until T7.4 (downstream of T9.13 / Issue #113
PR #890) starts producing `.msi` artifacts. Pass `-MsiPath <path>` to sign
an MSI in the same invocation.

---

## Linux — `sign-linux.sh`

| Env var             | Required | What it is                                                                                              |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `GPG_SIGNING_KEY`   | yes      | GPG key id (long form) used by `debsigs` / `rpm --addsign` / `gpg --detach-sign`. Must be in keyring.   |
| `GPG_PASSPHRASE`    | no       | If set, used via `--pinentry-mode loopback`. Prefer a passphrase-less CI key or `gpg-agent` preset.     |
| `CCSM_SIGN_DRY_RUN` | no       | `1` to print the commands that would run and exit `0`.                                                  |

Per spec ch10 §3, Linux does **not** sign the bare ELF binary at the binary
level (no `codesign` equivalent). The detached `.sig` is produced as the
input to ch10 §7 `verify-signing.sh` (T7.9). Package-level signing is the
real artifact gate:

- `.deb` -> `debsigs --sign=origin -k <key> <pkg>.deb`
- `.rpm` -> `rpm --define '_gpg_name <key>' --addsign <pkg>.rpm`

The downstream `fpm` packaging job (ch10 §5.3) calls `sign-linux.sh` with
the `.deb` / `.rpm` paths it just produced.

---

## Placeholder-safe demonstration

Run any of the scripts with NO env vars set:

```bash
$ bash packages/daemon/build/sign-mac.sh
[sign-mac] WARN: non-darwin host (MINGW64_NT-...); macOS signing skipped.
[sign-mac] WARN: this is expected for local cross-platform dogfood builds.
$ echo $?
0

$ bash packages/daemon/build/sign-linux.sh
[sign-linux] WARN: GPG_SIGNING_KEY not set; skipping linux signing.
[sign-linux] WARN: this is placeholder-safe behavior for dogfood builds.
[sign-linux] WARN: see scripts/sign/README.md for the env-var contract.
$ echo $?
0

$ pwsh packages/daemon/build/sign-win.ps1
WARNING: [sign-win] missing required env: WIN_CERT_PFX, WIN_CERT_PASSWORD
WARNING: [sign-win] skipping signing — placeholder-safe behavior for dogfood builds.
$ echo $LASTEXITCODE
0
```

## Dry-run

Set `CCSM_SIGN_DRY_RUN=1` (and the required env vars to anything, even
placeholder strings) to print the exact `codesign` / `signtool` /
`debsigs` / `rpm --addsign` invocations that would run, without touching
any artifact. The build-sea spec also exercises this path as a unit-test
smoke (see `packages/daemon/build/__tests__/sign-scripts.spec.ts`).

## Out of scope

- The CI workflow that wires these scripts in is **T0.9** (Issue #15). This
  PR does not modify `.github/workflows/ci.yml` or `e2e.yml` (hotfile
  mutex with #17).
- The verifier counterparts (`tools/verify-signing.{sh,ps1}` per ch10 §7)
  are **T7.9** (Issue #80).
- `.pkg` (macOS) and `.msi` (Windows) installer signing are downstream of
  T7.4 / T9.13 follow-ups; the `sign-win.ps1` `-MsiPath` parameter is the
  hook for the MSI side, and `sign-mac.sh` already signs the daemon's
  inputs that the `.pkg` will wrap.
