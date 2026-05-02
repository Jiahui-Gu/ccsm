# 10 — Build, Package, Installer

The daemon ships as a single executable per OS via Node 22 sea (Single Executable Applications, GA in Node 22) with native modules (`node-pty`, `better-sqlite3`, `xterm-headless`'s C++-free deps, `@connectrpc/connect-node`) embedded or sidecar-loaded. The Electron app ships per-OS as the standard Electron bundle. Each OS has its own installer (MSI / pkg / deb + rpm) that registers the daemon as a system service, places binaries, creates state directories, and verifies via Supervisor `/healthz` before declaring success. Uninstall reverses every step — ship-gate (d) tests this on a fresh Win 11 25H2 VM round-trip. This chapter pins the build pipeline, the native-module strategy, the per-OS installer responsibilities, and the verification harness.

### 1. Daemon binary: Node 22 sea

Build command per OS:

```bash
# packages/daemon/scripts/build-sea.sh (mac/linux) and .ps1 (win)
node --experimental-sea-config sea-config.json
node -e "require('fs').copyFileSync(process.execPath,'dist/ccsm-daemon')"
npx postject dist/ccsm-daemon NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
codesign / signtool / debsign as appropriate
```

`sea-config.json` includes:
- `main: "dist/bundle.js"` — esbuild-produced single-file CJS bundle of all daemon source + npm deps that ARE pure-JS.
- `disableExperimentalSEAWarning: true`
- `useCodeCache: true`
- `useSnapshot: false` (snapshot complicates native module init; revisit in v0.4 if startup is too slow).

> **MUST-SPIKE [sea-on-22-three-os]**: hypothesis: `node --experimental-sea-config` + `postject` produces a working single binary on Win 11 25H2, macOS 14 (arm64 + x64), Ubuntu 22.04. · validation: build a minimal "hello world" daemon that opens Listener A, runs `Hello` RPC, exits cleanly. Run on each target. · fallback: switch to `pkg` (Vercel) — note `pkg` is in maintenance mode and Node 22 support is unofficial; second fallback is a plain `node + bundle.js + node_modules/` zip with a launcher script (loses single-file but ships).

### 2. Native module strategy

Node sea cannot embed `.node` binaries inside the blob. Strategy: ship native `.node` files **alongside** the executable in the install directory; resolve via an absolute path computed from `process.execPath`.

```ts
// packages/daemon/src/native-loader.ts
import path from "node:path";
import { createRequire } from "node:module";
const here = path.dirname(process.execPath);
const requireNative = createRequire(path.join(here, "native/"));
export const Database = requireNative("./better_sqlite3.node");
export const pty = requireNative("./pty.node");
```

Per-OS native bundle layout:

```
<install-dir>/
  ccsm-daemon(.exe)            # the sea binary
  native/
    better_sqlite3.node        # built for the target OS+arch+Node-ABI
    pty.node                   # node-pty
```

Build matrix: `{win-x64, win-arm64, darwin-x64, darwin-arm64, linux-x64, linux-arm64} × {Node 22 ABI}`. Cross-compile native modules in CI using `prebuildify` or vendor's prebuilt artifacts when available.

> **MUST-SPIKE [node-pty-22]**: hypothesis: `node-pty` builds against Node 22 ABI on all six matrix combos. · validation: prebuildify in CI; smoke-spawn `bash` / `cmd.exe` and read 1 KB. · fallback: pin to Node 22 LTS minor with known-good prebuilds; if a target is broken, ship a `child_process` fallback for that OS only with a feature flag — would weaken ship-gate (c) on that OS — escalate to user.

> **MUST-SPIKE [better-sqlite3-22-arm64]**: hypothesis: `better-sqlite3` prebuilds exist for Node 22 ABI on darwin-arm64 and linux-arm64. · validation: install in CI matrix, open `:memory:`, run a CREATE+INSERT+SELECT. · fallback: build from source in CI per target.

### 3. Code signing

| OS | Signing | Notarization |
| --- | --- | --- |
| Windows | `signtool sign /fd SHA256 /tr <RFC3161-TSA> /td SHA256` with EV cert | n/a |
| macOS | `codesign --sign "Developer ID Application: ..." --options runtime --timestamp` | `xcrun notarytool submit --wait`; staple |
| Linux | `debsigs` for .deb; `rpm --addsign` for .rpm; detached `.sig` for raw binary | n/a |

Both the daemon binary AND the native `.node` files are signed. Installer is signed.

> **MUST-SPIKE [macos-notarization-sea]**: hypothesis: a Node sea binary passes Apple notarization with hardened runtime + entitlements `com.apple.security.cs.allow-jit` (Node uses V8 JIT). · validation: notarize a hello-world sea; check stapler. · fallback: revert to a notarized .app bundle wrapping a non-sea `node + bundle.js + node_modules/`.
>
> **Pre-resolution (R5 P0-10-1)**: this spike MUST be resolved in phase 0 (see [13](./13-release-slicing.md)) BEFORE stage-6 (release packaging). If notarization is rejected, the fallback (.app-wrapped bundle) ships, and the §1 sea pipeline downgrades for macOS only — §1 continues to apply for Win + Linux unchanged; §2 native-loading mechanism is unchanged because the .app bundle still loads `.node` files via `createRequire(process.execPath/..)`; §6 build matrix swaps `build-daemon-mac` output from `ccsm-daemon` (sea binary) to `Ccsm.app/Contents/MacOS/ccsm-daemon` (`node` interpreter + `bundle.js` + `node_modules/`); §5.2 pkg installer payload becomes the `.app` bundle rather than the bare binary. Document the fallback decision in the v0.3 release notes.

### 4. Electron build

Standard `electron-builder` per OS. Outputs:
- Windows: NSIS or MSIX (we pick **MSI via electron-builder + custom action** because MSI is what enterprise IT can deploy via GPO; NSIS is fine for non-managed; v0.3 ships MSI as primary).
- macOS: `.app` inside a `.dmg`, signed + notarized.
- Linux: `.deb` and `.rpm` (and an `AppImage` for distros we don't first-class).

Electron does NOT bundle native modules at runtime in v0.3 (no `node-pty` in renderer; no `better-sqlite3`); it is purely UI + Connect client. This dramatically simplifies the Electron build (no `electron-rebuild` step, no per-Electron-version ABI rebuilds).

### 5. Per-OS installer responsibilities

Installer responsibilities common to all OSes:
1. Place `ccsm-daemon` binary + `native/` directory.
2. Place Electron app bundle.
3. Create state directory with correct ownership (per [07](./07-data-and-state.md) §2) and ACL.
4. Create per-OS service account if needed (`_ccsm` mac, `ccsm` linux; LocalService is built-in on win).
5. Register the daemon as a system service.
6. Start the service.
7. Wait up to 10 s for `GET /healthz` on Supervisor UDS to return 200. **Failure mode**: if `/healthz` does not return 200 within the 10 s budget, the installer (a) captures the last 200 lines of the daemon's stdout/stderr (per-OS service-manager log: `journalctl -u ccsm-daemon -n 200`, `log show --predicate 'subsystem == "com.ccsm.daemon"' --last 1m`, Win Event Viewer `Get-WinEvent -LogName Application -ProviderName ccsm-daemon -MaxEvents 200`) into the installer log, (b) attempts service stop, (c) marks the install as failed and returns a non-zero exit / MSI error code (Win: `ERROR_INSTALL_FAILURE` 1603) so MSI rolls back atomic file placement, (d) leaves the state directory intact (no destructive cleanup on first-install failure — a re-attempt should succeed without data loss). Tested by `tools/installer-roundtrip.{ps1,sh}` `--inject-healthz-fail` variant: the test pre-stages a daemon binary that exits non-zero on startup, runs the installer, asserts non-zero exit, asserts service unregistered, asserts state dir untouched.
8. Add Electron to Start menu / `/Applications` / `.desktop` entry.
9. Register an uninstaller entry.

Common to all uninstallers:
1. Stop the service (wait up to 10 s for clean exit).
2. Unregister the service.
3. Remove the binary, native dir, Electron bundle, Start menu / launcher entries.
4. Prompt user "remove user data?" (default no). For unattended / silent installs (Windows MSI: `msiexec /x ... /qn`; mac/linux: scripted), the prompt is suppressed and the decision is taken from the public MSI property `REMOVEUSERDATA` (`0` = keep — default; `1` = remove). On mac/linux, the equivalent is the env var `CCSM_REMOVE_USER_DATA=1` consumed by the uninstaller script. Ship-gate (d) exercises BOTH variants (interactive + silent with `REMOVEUSERDATA=1` and silent with `REMOVEUSERDATA=0`).
5. If yes: remove state directory.
6. Remove the uninstaller entry.

Specifics:

#### 5.1 Windows MSI

- Tool: WiX 4 (driven by electron-builder's MSI builder OR a hand-written WiX project; pick by which is more reliable for service registration — MUST-SPIKE `[msi-tooling-pick]`, see [14](./14-risks-and-spikes.md)).
- Service registration: WiX `<ServiceInstall>` element (NOT a `sc.exe` custom action — declarative is cleaner for uninstall). This is the locked decision for v0.3; the contradiction in some earlier text mentioning `node-windows` / `sc.exe` as alternatives is resolved here in favor of WiX `<ServiceInstall>`. **NOTE for chapter 02**: chapter 02's service-management text MUST align with this choice (cross-fixer F4 to update). The MSI also configures service failure actions (verified post-install via `sc qfailure ccsm-daemon` — restart on first/second failure, run-program on third) and a per-service SID type (verified via `sc qsidtype ccsm-daemon` returning `RESTRICTED` or `UNRESTRICTED` per the WiX `<ServiceConfig>` element); the `MUST-SPIKE [msi-service-install-25h2]` fallback path (PowerShell `New-Service`) is exercised by the same ship-gate (d) test path with a feature flag in the installer (CI variant `ccsm-setup-*-fallback.msi`).
- ACLs on `%PROGRAMDATA%\ccsm\`: grant LocalService Modify; grant interactive user Read on the listener descriptor file.
- Registry: minimal — just the standard MSI `Uninstall` key. No app-specific keys.
- Uninstall verification (ship-gate (d)): script asserts none of the following exist after uninstall:
  - `%ProgramFiles%\ccsm\`
  - `%ProgramData%\ccsm\` (if user opted to remove)
  - Service `ccsm-daemon` in `sc query`
  - Scheduled tasks named `ccsm*`
  - Registry `HKLM\SYSTEM\CurrentControlSet\Services\ccsm-daemon`
  - `Uninstall` registry entry for the product

#### 5.2 macOS pkg

- Tool: `pkgbuild` + `productbuild`, signed with Developer ID Installer cert, notarized.
- LaunchDaemon plist installed to `/Library/LaunchDaemons/com.ccsm.daemon.plist`.
- Postinstall script: `launchctl bootstrap system /Library/LaunchDaemons/com.ccsm.daemon.plist; launchctl enable system/com.ccsm.daemon; launchctl kickstart -k system/com.ccsm.daemon`.
- Uninstaller: a separate `ccsm-uninstall.command` script in `/Library/Application Support/ccsm/`. Round-trip tested by `tools/installer-roundtrip.sh` (mac variant): install pkg → assert `launchctl print system/com.ccsm.daemon` shows running → run `ccsm-uninstall.command` (with `CCSM_REMOVE_USER_DATA=1` and again with `=0`) → assert plist absent + binary absent + (data dir absent or present per flag).

#### 5.3 Linux deb + rpm

- Build with `fpm` driven from `packages/daemon/scripts/build-pkg.sh`.
- Postinst: create `ccsm` user, install `ccsm-daemon.service`, `systemctl daemon-reload && systemctl enable --now ccsm-daemon`.
- Postrm: `systemctl disable --now ccsm-daemon; userdel ccsm` (purge mode only).

> **MUST-SPIKE [msi-service-install-25h2]**: hypothesis: WiX 4 `<ServiceInstall>` for a sea binary works on Win 11 25H2 with proper SDDL. · validation: build MSI, install on clean 25H2 VM, verify `Get-Service ccsm-daemon` shows Running. · fallback: PowerShell `New-Service` from a custom action with SDDL programmatically applied.

### 6. Cross-OS build matrix (CI)

| Job | OS | Arch | Node | Output |
| --- | --- | --- | --- | --- |
| `build-daemon-win` | windows-latest | x64, arm64 | 22 | `ccsm-daemon.exe` + native/ |
| `build-daemon-mac` | macos-14 | x64, arm64 (universal2) | 22 | `ccsm-daemon` + native/ |
| `build-daemon-linux` | ubuntu-22.04 | x64, arm64 | 22 | `ccsm-daemon` + native/ |
| `build-electron-*` | matching OS | matching arch | 22 | electron bundle |
| `package-win-msi` | windows-latest | matching | n/a | `ccsm-setup-x.y.z-x64.msi` |
| `package-mac-pkg` | macos-14 | matching | n/a | `ccsm-x.y.z.pkg` |
| `package-linux-deb` / `-rpm` | ubuntu-22.04 | matching | n/a | `.deb` / `.rpm` |
| `e2e-win-installer-vm` | self-hosted Win 11 25H2 | x64 | n/a | ship-gate (d) result |

**Self-hosted Win 11 25H2 runner provisioning (R4 P0 ship-gate (d))**: provisioning is descoped from this chapter. v0.3 ships against an operator-provisioned self-hosted runner; the snapshot-restore mechanism, base image build, and network configuration live in a separate `infra/win11-runner/` repo. The runner registers under the GitHub Actions label `self-hosted-win11-25h2-vm` referenced in the matrix above and in [11](./11-monorepo-layout.md) §6. If the runner is unavailable on a release candidate, ship-gate (d) is run manually on the operator's Win 11 25H2 device and the result is posted to release notes (see [12](./12-testing-strategy.md) and brief §11(d) clarification).

**Cross-arch (arm64) native smoke**: `build-daemon-{win,mac,linux}` arm64 jobs cross-compile native modules via `prebuildify`. Smoke testing on real arm64 hardware: `darwin-arm64` is smoke-tested on the macos-14 runner (which is arm64-native — Apple silicon). `linux-arm64` and `win-arm64` are cross-built only in v0.3 CI; smoke testing on real arm64 hardware (Raspberry Pi 4 / Surface Pro X) is performed manually pre-tag and the result posted to release notes — automation is deferred to v0.4 once a self-hosted arm64 runner exists. The `tools/sea-smoke/` script (see §7 below) is reused for the manual arm64 smoke step.

**Installer e2e in CI scope**: v0.3 CI runs the full installer e2e (ship-gate (d)) only on Windows (see `e2e-win-installer-vm` above). macOS pkg and Linux deb/rpm installers are smoke-tested manually pre-tag using `tools/installer-roundtrip.sh` against an operator workstation; results are posted to release notes (matches brief §11(d)). v0.4 expands installer e2e coverage to mac + linux self-hosted runners.

### 7. Verification harness scripts

Two scripts close the per-OS sea binary smoke + signing verification gaps (R4 P0).

**`tools/sea-smoke/`** — invoked at the end of each `e2e-installer-{win,mac,linux}` job AFTER the installer has placed the daemon and registered the service. Steps (one shell variant + one PowerShell variant share the same step list):

1. Start the OS service (or reuse the installer-started service): `systemctl start ccsm-daemon` / `launchctl kickstart system/com.ccsm.daemon` / `Start-Service ccsm-daemon`.
2. Poll Supervisor `/healthz` (per-OS UDS path from [02](./02-process-topology.md) §2) for HTTP 200 within 10 s; fail otherwise.
3. Open Listener A via descriptor (per [03](./03-listener-a-and-control-plane.md) §1) and call `Hello` RPC; assert `proto_version` matches expected.
4. Call `SessionService.CreateSession({ command: "echo ok" })`; assert returned `Session.id` non-empty.
5. Subscribe to `PtyService.Attach({ session_id })` stream and assert at least one delta arrives within 5 s containing the literal bytes `ok`.
6. Stop the daemon: `systemctl stop ccsm-daemon` / `launchctl bootout system/com.ccsm.daemon` / `Stop-Service ccsm-daemon`; assert process exits within 5 s.
7. Exit non-zero on any step failure; capture per-OS service-manager log on failure (same capture rule as §5 step 7).

This script runs the actual built `ccsm-daemon` binary placed by the real installer, not a dev-mode `node bundle.js` invocation — that is the entire point. The script is reused by the manual mac/linux pre-tag installer smoke (see §6 above) and by the manual arm64 smoke step.

**`tools/verify-signing.{sh,ps1}`** — invoked in each `package-{win-msi,mac-pkg,linux-deb,linux-rpm}` job AFTER signing and BEFORE artifact upload. Per-OS commands:

- Windows (`verify-signing.ps1`): for each of `ccsm-daemon.exe`, `native\*.node`, and `ccsm-setup-*.msi`, run `Get-AuthenticodeSignature <path>` and assert `.Status -eq 'Valid'` AND `.SignerCertificate.Subject -match 'CN=<expected EV CN>'` AND `.TimeStamperCertificate -ne $null`. Fail the job if any path is `NotSigned` / `HashMismatch` / `UnknownError`.
- macOS (`verify-signing.sh` mac branch): for each of `ccsm-daemon`, every `*.node` under `native/`, the `.app` bundle (if fallback path is taken — see §1), and the `.pkg`, run `codesign --verify --deep --strict --verbose=4 <path>` AND `spctl --assess --type install --verbose <path>` (or `--type execute` for the bare binary). Assert exit zero and that the output contains `accepted` / `valid on disk`.
- Linux (`verify-signing.sh` linux branch): for the `.deb`, run `dpkg-sig --verify <path>` and assert `GOODSIG`; for the `.rpm`, run `rpm --checksig -v <path>` and assert `(sha256) Header SHA256 digest: OK` and `Header V4 RSA/SHA256 Signature, key ID ...: OK`; for the bare binary, verify the detached `.sig` via `gpg --verify ccsm-daemon.sig ccsm-daemon`.

Both scripts are committed in the repo root `tools/` directory (see [11](./11-monorepo-layout.md) §2 directory layout — addition).

### 8. Update flow (R2 P0-10-1)

v0.3 ships a minimal in-place update flow invoked by a future updater (out of scope for v0.3 ship — the flow is specified now so v0.3.x patch releases CAN ship without re-architecture). The flow operates on an already-downloaded, already-signature-verified replacement binary at a staging path (the updater is responsible for download + signature verification using `tools/verify-signing.*` from §7). Flow:

1. **Stop service**: `Stop-Service ccsm-daemon` / `launchctl bootout system/com.ccsm.daemon` / `systemctl stop ccsm-daemon` with a 10 s timeout. If the service has not exited within 10 s, escalate: Win `Stop-Service -Force` → if still running after 5 s, `taskkill /F /PID <pid>`; mac `launchctl kill SIGKILL system/com.ccsm.daemon`; linux `systemctl kill --signal=SIGKILL ccsm-daemon`. Verify via `Get-Process` / `pgrep` that the PID is gone before proceeding.
2. **Replace binary**: rename existing `ccsm-daemon(.exe)` to `ccsm-daemon.prev(.exe)` (atomic on all three OSes when source + dest are on the same volume; installers MUST place binaries on the same volume as state); move staging binary into place; preserve native/ directory ACLs (do NOT replace `native/` unless the staging payload includes a new `native/`; in that case, atomically rename `native/` → `native.prev/` and stage `native/`).
3. **Restart service**: `Start-Service` / `launchctl bootstrap system /Library/LaunchDaemons/com.ccsm.daemon.plist` / `systemctl start ccsm-daemon`.
4. **Health check + rollback**: poll Supervisor `/healthz` for HTTP 200 within 10 s. If 200: delete `ccsm-daemon.prev(.exe)` and `native.prev/` (if staged); update succeeded. If timeout: rollback — stop the failing service (with the same 10 s + SIGKILL escalation as step 1), atomically rename `ccsm-daemon.prev(.exe)` → `ccsm-daemon(.exe)` and `native.prev/` → `native/`, restart service, poll `/healthz` again, log a `crash_log` entry with source `update_rollback` (regardless of whether the rollback healthz succeeds, so the user sees the failure surfaced via [09](./09-crash-collector.md)). The user-facing updater UX surfaces both update-success and update-rollback states.

This flow is the same on all three OSes modulo the per-OS commands. It is exercised by `tools/update-flow.spec.{ps1,sh}` invoked in a manual pre-release smoke (not in per-PR CI for v0.3; promoted to CI in v0.4). The `tools/verify-signing.*` script (§7) is the upstream integrity gate; this flow trusts that the staging binary is already verified.

### 9. v0.4 delta

- **Add** cloudflared binary to the daemon install (download in postinst or vendor in installer; pick MUST-SPIKE later).
- **Add** new Electron features wrapped in same installer; no new installer technology.
- **Add** new sea-config entries if v0.4 adds new pure-JS deps.
- **Unchanged**: sea pipeline, native loading mechanism, signing/notarization steps, per-OS installer technology choices, ship-gate (d) verification approach, the install/uninstall step lists.
