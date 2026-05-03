# Electron-builder MSI attempt

## Setup

`package.json` here is a minimal Electron app (single `main.js` that
opens a window and quits) configured with `"win": [{ "target": "msi"
}]` and a `"msi": {}` block that mirrors what v0.3 would need
(`perMachine: true`, `oneClick: false`, `upgradeCode`).

```bash
cd electron-builder
npm install        # installs electron 41.5.0 + electron-builder 26.8.1
npm run build:msi  # downloads electron + WiX vendor on first run
```

## What happened (run 1, out-of-the-box)

Build **failed**. Verbatim error from electron-builder:

```
• building        target=MSI arch=x64 file=release\CcsmToolingPickEb 0.0.1.msi
• Manufacturer is not set for MSI — please set "author" in the package.json
• downloading     url=https://github.com/electron-userland/electron-builder-binaries/releases/download/wix-4.0.0.5512.2/wix-4.0.0.5512.2.7z
• downloaded      duration=430ms

⨯ light.exe process failed 1105
light.exe : error LGHT1105 : Validation could not run due to system policy.
            To eliminate this warning, run the process as admin or
            suppress ICE validation.
```

`LGHT1105` is the **WiX 3.x** linker (`light.exe`) ICE validation step
hitting a Windows AppLocker / system-policy block on the machine. The
WiX 4 path (the merged spike #113 / this folder's `wix4/`) does **not**
trip this — `wix build` runs ICE validation differently and is policy-OK
on the same host. This alone is a deployment-velocity tax: every contributor
or CI runner with hardened policy will bounce off this on first build.

## What happened (run 2, with `additionalLightArgs: ["-sval"]`)

Adding `additionalLightArgs: ["-sval"]` to the `msi` config to skip
ICE validation lets the build complete:

```
elapsed = 160s (cold)  /  149s (warm rebuild after node_modules cached)
release/CcsmToolingPickEb 0.0.1.msi   = 113,262,592 B  (108.0 MiB)
release/win-unpacked/                 = 344 MiB on disk
```

Skipping ICE is acceptable for a spike, **not** for a shipped installer:
ICE03/06/09 catch real malformed-MSI bugs (file/registry collisions,
component GUID reuse, sequencing). v0.3 cannot ship `-sval` long-term.

## What the template can and cannot express

`electron-builder/packages/app-builder-lib/templates/msi/template.xml`
(116 lines, fetched from upstream `master`) is the entire authoring
surface electron-builder exposes. Inspection findings:

1. **WiX 3.x schema, not WiX 4.** Top-level element is `<Product>`,
   which was merged into `<Package>` in WiX v4. The xmlns attribute
   reads `http://wixtoolset.org/schemas/v4/wxs` but the `<Product>`
   structure is the v3 dialect. Confirmed in
   `MsiTarget.ts`: it shells out to `candle.exe` + `light.exe`
   (the WiX 3.x toolchain — WiX 4+ collapsed both into a single
   `wix build` command).
   ```ts
   const vendorPath = await getBinFromUrl(
     "wix-4.0.0.5512.2", "wix-4.0.0.5512.2.7z", "...")
   const candleArgs = [...]
   await vm.exec(vm.toVmFile(path.join(vendorPath, "candle.exe")), ...)
   await this.light(...)  // light.exe
   ```
   The `wix-4.0.0.5512.2` package name refers to the **electron-builder-binaries**
   release ID, not the WiX major version. The bundled binaries are
   WiX **3.x**.

2. **No `<ServiceInstall>` element anywhere in the template.** The
   template only emits `<Component>` entries with `<File>` children,
   plus optional shortcut and run-after-finish bits. There is no
   placeholder, no `{{-services}}`, no extension hook for inserting
   `<ServiceInstall>` / `<ServiceControl>`. This is the **hard
   blocker** for v0.3, which needs the daemon registered with SCM
   (per spec ch14 §1.14, validated by spike #113).

3. **`additionalWixArgs` and `additionalLightArgs`** forward CLI
   args to candle/light, not custom .wxs fragments. They cannot
   inject new authoring elements into the generated `project.wxs`.

4. **No custom action hooks for the daemon side.** `runAfterFinish`
   exists but only fires the main `mainExecutable` File post-install;
   it cannot accept arbitrary CA logic (signature verify, DACL set,
   service config tweak).

5. **No arm64 support.** Source explicitly stops at x64:
   ```ts
   // wix 4.0.0.5512.2 doesn't support the arm64 architecture so default
   // to x64 when building for arm64.
   const wixArch = arch == Arch.arm64 ? Arch.x64 : arch
   ```
   v0.3 may not ship arm64 today, but locking the future arm64 story
   to "wait for upstream electron-builder-binaries to upgrade WiX" is
   strategic debt.

6. **Cross-build claim.** electron-builder can in theory build Windows
   MSIs from Linux/macOS via Wine, with a comment in
   `MsiTarget.ts` noting `dotnet462` must be preinstalled in the Wine
   prefix. Not exercised on this host (this machine **is** Windows,
   so the cross-build path was not the bottleneck). For CI, given
   the daemon is a cross-compiled Go/Rust/.NET binary anyway, going
   native Windows on the runner is the simpler trade.

## What would need to change upstream to unblock electron-builder

To make electron-builder a viable v0.3 MSI tool, upstream would need
to either:

- (a) Ship a `services` config option that emits `<ServiceInstall>` /
  `<ServiceControl>` into the generated component, **and** upgrade
  the bundled WiX vendor from 3.x to 4+ (the v4 schema requires
  `<Component>`-level service elements per #890's notes), **or**
- (b) Allow injecting a custom .wxs fragment, with documented merge
  semantics into the template's `ProductComponents` ComponentGroup.

Neither exists today. There is no open PR adding either.

Owning a fork of electron-builder for one feature is firmly off the
table for a v0.3 ship target.

## Verdict on the electron-builder path

Cannot meet criterion 3 (`<ServiceInstall>`) without forking upstream.
Hard blocker. Other dimensions (build time, signing flow, ICE policy)
are tractable but become moot.
