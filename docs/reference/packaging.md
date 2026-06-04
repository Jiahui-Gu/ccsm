# Packaging

CCSM Next is packaged with [`electron-builder`](https://www.electron.build).
Configuration lives in `package.json → build` — there is a single source of
truth for app id, product name, and icons. The `appId` is `com.ccsm.app`;
`productName` is `CCSM`.

Run a local build:

```bash
npm run make          # all platforms the current OS can produce
npm run make:win      # Windows only (must be run on Windows)
npm run make:mac      # macOS only (must be run on macOS)
npm run make:linux    # Linux only (Linux or WSL; Docker also works)
```

Output is written to `release/`.

## Per-OS output

### Windows

| File                                   | Purpose                                |
| -------------------------------------- | -------------------------------------- |
| `CCSM-Setup-<ver>-x64.exe`         | NSIS installer, 64-bit Intel/AMD       |
| `CCSM-Setup-<ver>-arm64.exe`       | NSIS installer, 64-bit ARM             |
| `CCSM-Setup-<ver>-x64.exe.blockmap`| Delta-update blockmap (auto-updater)   |
| `latest.yml`                           | Auto-update metadata feed              |

Default install path: `%LOCALAPPDATA%\Programs\CCSM\` (per-user install,
no admin prompt in the installer UI). User can override via "Customize" in
the installer.

Known caveats:

- **SmartScreen**: on the first few signed releases, Windows SmartScreen will
  show "Windows protected your PC" because our signing cert has no reputation
  yet. Click **More info → Run anyway**. Reputation builds over ~N thousand
  installs; until then this is expected.
- **Unsigned builds**: if `CSC_LINK` is absent, SmartScreen prompts on every
  launch. This is the path used for dry-run builds.
- **`build.win.publisherName` is intentionally unset** in `package.json`. With
  no publisherName, electron-updater's `verifySignature` step returns `null`
  rather than failing — letting unsigned local / CI dry-run builds still
  exercise the auto-update flow without a code-signing certificate. Once we
  ship a signed release with a real CN, set `publisherName` to the cert's
  Common Name so signature verification becomes mandatory in production.
- **`build.nsis.disableWebInstaller: true`** silences the runtime warning
  electron-updater emits when an NSIS web installer is detected. We ship a
  full installer (single `.exe` carrying the app payload), so the web-installer
  path is unreachable; the flag just removes the noise.

### macOS

| File                            | Purpose                                  |
| ------------------------------- | ---------------------------------------- |
| `CCSM-<ver>-x64.dmg`        | Disk image, Intel                        |
| `CCSM-<ver>-arm64.dmg`      | Disk image, Apple Silicon                |
| `CCSM-<ver>-x64.zip`        | Zip (required by auto-updater on macOS)  |
| `CCSM-<ver>-arm64.zip`      | Zip, Apple Silicon                       |
| `latest-mac.yml`                | Auto-update metadata feed                |

Install path: the user drags `CCSM.app` to `/Applications`.

Known caveats:

- **Gatekeeper requires notarization**: on first launch of an unsigned or
  non-notarized build, macOS blocks with "cannot be opened because the
  developer cannot be verified." Right-click → Open works around it once.
  For real releases, supply `APPLE_ID`, `APPLE_ID_PASSWORD`, and
  `APPLE_TEAM_ID` so `electron-builder` notarizes via `notarytool`.
- **Universal binaries**: we ship separate `x64` and `arm64` artifacts
  rather than a universal DMG. Universal binaries roughly double download
  size without much benefit for a tool users install once.
- **`electron-updater` needs the `.zip`**: the `.dmg` can't self-update
  (macOS API restriction). Publish both; the updater automatically prefers
  the zip.

### Linux

| File                         | Purpose                                   |
| ---------------------------- | ----------------------------------------- |
| `CCSM-<ver>-x64.AppImage`| Portable single-file executable           |
| `CCSM-<ver>-x64.deb`     | Debian / Ubuntu package                   |
| `CCSM-<ver>-x64.rpm`     | Fedora / RHEL / openSUSE package          |
| `latest-linux.yml`           | Auto-update metadata feed                 |

Install:

- `AppImage`: `chmod +x CCSM-*.AppImage && ./CCSM-*.AppImage`.
  Install path: wherever the user runs it from.
- `deb`: `sudo apt install ./CCSM-*.deb`. Install path: `/opt/CCSM/`.
- `rpm`: `sudo rpm -i CCSM-*.rpm`. Install path: `/opt/CCSM/`.

Known caveats:

- **Linux builds are unsigned.** We do not ship a Linux code-signing cert —
  Linux distros don't have a single trust root the way Windows and macOS do.
  Users running AppImage may see a "file is not executable" SELinux prompt
  on some distros; `chmod +x` fixes it.
- **Auto-update on Linux** works only for `AppImage` (deb/rpm auto-update
  requires a repo which we don't host). deb/rpm users must re-download from
  GitHub Releases to upgrade.
- **`node-pty`**: the Linux build rebuilds this native module for the
  Electron ABI in CI. If you see "`NODE_MODULE_VERSION` mismatch" when
  building locally, run `npx @electron/rebuild -f -o node-pty
  --build-from-source`. (The DB uses Node's built-in `node:sqlite`, so it
  needs no rebuild.)

## Icons

We intentionally ship without a custom app icon (bug #332). With no
`build/icon.{icns,ico,png}` present and no `build.{win,mac,linux}.icon`
field in `package.json`, `electron-builder` falls back to its bundled
default Electron icon and the runtime `BrowserWindow` uses the OS default.
Drop a real branded asset into `build/` (and re-add the corresponding
`icon:` fields) when one exists.

## Native modules

The only native dep right now is `node-pty`. `postinstall`
(`scripts/postinstall.mjs`) rebuilds it against the Electron ABI via
`@electron/rebuild`; a failed rebuild falls back to node-pty's bundled
prebuilt binary, asserted by `scripts/after-pack.cjs`. The DB layer uses
Node's built-in `node:sqlite`, so no SQLite native module is bundled or
rebuilt.

## ASAR

The app bundle uses ASAR (`asar: true`), with `node-pty` unpacked via
`asarUnpack`. Native `.node` files cannot be loaded from inside an ASAR
archive; unpacking them is the standard fix.
