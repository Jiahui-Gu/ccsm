# build/ — electron-builder buildResources

This directory holds icons, entitlements, and other static assets consumed
by `electron-builder` (configured in `../electron-builder.yml`).

For v0.3 the directory exists as a placeholder: real assets land in T7.3
(#82) and the corresponding signing/notarization tasks. Files expected
later:

- `icon.icns` — macOS app icon
- `icon.png`  — Linux app icon (512x512 PNG)
- `entitlements.mac.plist` — hardened-runtime entitlements (notarization)
- `background.png` (optional) — DMG background art

`electron-builder` resolves these by name from `directories.buildResources`
(`build/` here). Do not commit large binary assets without first checking
they are needed; placeholders are fine until T7.3.
