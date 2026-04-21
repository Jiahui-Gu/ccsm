# Packaging

Agentory Next is packaged with [`electron-builder`](https://www.electron.build).
Configuration lives in `package.json → build` — there is a single source of
truth for app id, product name, and icons. The `appId` is `com.agentory.next`;
`productName` is `Agentory`.

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
| `Agentory-Setup-<ver>-x64.exe`         | NSIS installer, 64-bit Intel/AMD       |
| `Agentory-Setup-<ver>-arm64.exe`       | NSIS installer, 64-bit ARM             |
| `Agentory-Setup-<ver>-x64.exe.blockmap`| Delta-update blockmap (auto-updater)   |
| `latest.yml`                           | Auto-update metadata feed              |

Default install path: `%LOCALAPPDATA%\Programs\Agentory\` (per-user install,
no admin prompt in the installer UI). User can override via "Customize" in
the installer.

Known caveats:

- **SmartScreen**: on the first few signed releases, Windows SmartScreen will
  show "Windows protected your PC" because our signing cert has no reputation
  yet. Click **More info → Run anyway**. Reputation builds over ~N thousand
  installs; until then this is expected.
- **Unsigned builds**: if `CSC_LINK` is absent, SmartScreen prompts on every
  launch. This is the path used for dry-run builds.

### macOS

| File                            | Purpose                                  |
| ------------------------------- | ---------------------------------------- |
| `Agentory-<ver>-x64.dmg`        | Disk image, Intel                        |
| `Agentory-<ver>-arm64.dmg`      | Disk image, Apple Silicon                |
| `Agentory-<ver>-x64.zip`        | Zip (required by auto-updater on macOS)  |
| `Agentory-<ver>-arm64.zip`      | Zip, Apple Silicon                       |
| `latest-mac.yml`                | Auto-update metadata feed                |

Install path: the user drags `Agentory.app` to `/Applications`.

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
| `Agentory-<ver>-x64.AppImage`| Portable single-file executable           |
| `Agentory-<ver>-x64.deb`     | Debian / Ubuntu package                   |
| `Agentory-<ver>-x64.rpm`     | Fedora / RHEL / openSUSE package          |
| `latest-linux.yml`           | Auto-update metadata feed                 |

Install:

- `AppImage`: `chmod +x Agentory-*.AppImage && ./Agentory-*.AppImage`.
  Install path: wherever the user runs it from.
- `deb`: `sudo apt install ./Agentory-*.deb`. Install path: `/opt/Agentory/`.
- `rpm`: `sudo rpm -i Agentory-*.rpm`. Install path: `/opt/Agentory/`.

Known caveats:

- **Linux builds are unsigned.** We do not ship a Linux code-signing cert —
  Linux distros don't have a single trust root the way Windows and macOS do.
  Users running AppImage may see a "file is not executable" SELinux prompt
  on some distros; `chmod +x` fixes it.
- **Auto-update on Linux** works only for `AppImage` (deb/rpm auto-update
  requires a repo which we don't host). deb/rpm users must re-download from
  GitHub Releases to upgrade.
- **`better-sqlite3`**: the Linux build rebuilds native modules for the
  Electron ABI in CI. If you see "`NODE_MODULE_VERSION` mismatch" when
  building locally, run `npx electron-builder install-app-deps` or, for
  running vitest against Node, `npm rebuild better-sqlite3`.

## Icons

Place branded icons under `build/` (the `buildResources` directory). Required:

- `build/icon.icns` — macOS, 512×512 and 1024×1024 bitmaps.
- `build/icon.ico` — Windows, multi-size ICO (16/32/48/256).
- `build/icon.png` — Linux, 512×512 PNG.

Until real icons land, `electron-builder` falls back to a generic Electron
icon. That's fine for dry-runs; swap before the first public release.

## Native modules

The only native dep right now is `better-sqlite3`. `postinstall` runs
`electron-builder install-app-deps` which rebuilds it against the Electron
ABI. CI additionally runs `npm rebuild better-sqlite3` before `npm test`
because vitest executes under Node, not Electron.

## ASAR

The app bundle uses ASAR (`asar: true`), with `better-sqlite3` unpacked via
`asarUnpack`. Native `.node` files cannot be loaded from inside an ASAR
archive; unpacking them is the standard fix.
