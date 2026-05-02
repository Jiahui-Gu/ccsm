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
7. Wait up to 10 s for `GET /healthz` on Supervisor UDS to return 200.
8. Add Electron to Start menu / `/Applications` / `.desktop` entry.
9. Register an uninstaller entry.

Common to all uninstallers:
1. Stop the service (wait up to 10 s for clean exit).
2. Unregister the service.
3. Remove the binary, native dir, Electron bundle, Start menu / launcher entries.
4. Prompt user "remove user data?" (default no).
5. If yes: remove state directory.
6. Remove the uninstaller entry.

Specifics:

#### 5.1 Windows MSI

- Tool: WiX 4 (driven by electron-builder's MSI builder OR a hand-written WiX project; pick by which is more reliable for service registration — MUST-SPIKE).
- Service registration: WiX `<ServiceInstall>` element (NOT a `sc.exe` custom action — declarative is cleaner for uninstall).
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
- Uninstaller: a separate `ccsm-uninstall.command` script in `/Library/Application Support/ccsm/`.

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

### 7. v0.4 delta

- **Add** cloudflared binary to the daemon install (download in postinst or vendor in installer; pick MUST-SPIKE later).
- **Add** new Electron features wrapped in same installer; no new installer technology.
- **Add** new sea-config entries if v0.4 adds new pure-JS deps.
- **Unchanged**: sea pipeline, native loading mechanism, signing/notarization steps, per-OS installer technology choices, ship-gate (d) verification approach, the install/uninstall step lists.
