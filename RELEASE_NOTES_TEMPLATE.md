# ccsm vX.Y.Z — Release Notes Template

> Replace `vX.Y.Z` everywhere, fill in the sections, delete the template
> banner before publishing. Title format: `ccsm vX.Y.Z — <one-line theme>`.

## Highlights

- (1–3 user-facing bullets — what new thing can the user do?)

## Changes

### Features
- (#NNN) ...

### Fixes
- (#NNN) ...

### Internal / infrastructure
- (#NNN) ...

## Install

| Platform | Download |
|----------|----------|
| Windows | `ccsm-Setup-X.Y.Z.exe` |
| macOS (Intel) | `ccsm-X.Y.Z.dmg` |
| macOS (Apple Silicon) | `ccsm-X.Y.Z-arm64.dmg` |
| Linux (deb) | `ccsm_X.Y.Z_amd64.deb` |
| Linux (AppImage) | `ccsm-X.Y.Z.AppImage` |
| Linux (rpm) | `ccsm-X.Y.Z.x86_64.rpm` |

## Verify your download

Every installer in the table above is published with **three sidecar files**
in this release:

- **`<artifact>.sha256`** — SHA-256 hash. Verify integrity:
  ```bash
  sha256sum -c ccsm-Setup-X.Y.Z.exe.sha256
  ```
- **`<artifact>.intoto.jsonl`** — SLSA L3 build provenance, signed by GitHub's
  OIDC root via the [`slsa-github-generator`](https://github.com/slsa-framework/slsa-github-generator)
  reusable workflow. Verify authenticity end-to-end:
  ```bash
  slsa-verifier verify-artifact ccsm-Setup-X.Y.Z.exe \
    --provenance-path ccsm-Setup-X.Y.Z.exe.intoto.jsonl \
    --source-uri github.com/Jiahui-Gu/ccsm \
    --source-tag vX.Y.Z
  ```
- **`<artifact>.minisig`** — minisign signature with the ccsm release-signing
  key. Verify offline:
  ```bash
  minisign -V -p release-keys/minisign.pub -m ccsm-Setup-X.Y.Z.exe
  ```
  The public key is in the [repo](https://github.com/Jiahui-Gu/ccsm/blob/main/release-keys/minisign.pub).

If any of these fail, **do not run the installer**; open an issue on the repo.

## Known issues

- (list, or "none known")

## Upgrade notes

- (breaking changes, config migrations, etc., or "drop-in upgrade")

## Key rotation (only if applicable this release)

- (see `release-keys/README.md`. Include old fingerprint + new fingerprint
  if the minisign key was rotated for this release.)
