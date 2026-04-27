# Release flow

This document describes how to cut a release of CCSM Next and how signing
secrets are wired into CI.

## TL;DR — cut a release

```bash
# 1. Bump the version.
npm version patch   # or minor / major
# That produces a commit "vX.Y.Z" and a tag "vX.Y.Z".

# 2. Push both.
git push origin HEAD
git push origin --tags
```

The tag push triggers `.github/workflows/release.yml`:

1. `verify` job — `npm run lint`, `npm run typecheck`, `npm test` on Ubuntu.
2. `build` matrix — Linux / macOS / Windows build each platform's installers
   using `electron-builder`.
3. Each build uploads its artifacts into a **draft** GitHub Release named
   after the tag. Once all three jobs are green, edit the release on GitHub
   and click **Publish**.

## Dry run (no real release)

Use the `workflow_dispatch` trigger on the `Release` workflow to exercise the
full build pipeline without touching the Releases tab. Artifacts land on the
workflow run (Actions → Release → artifacts section). Every PR that touches
release infra should include a dry-run link in its body.

## Secrets

Signing is **optional**. If any of the secrets below are missing, the build
prints a GitHub Actions warning and continues with unsigned output — the
installers still work, but macOS Gatekeeper will quarantine them and Windows
SmartScreen will show a "publisher unknown" prompt on first launch.

| Secret              | Platform | Purpose                                                                      |
| ------------------- | -------- | ---------------------------------------------------------------------------- |
| `CSC_LINK`          | win, mac | Base64-encoded code-signing `.p12` certificate, or `https://` URL to one.    |
| `CSC_KEY_PASSWORD`  | win, mac | Password for the `.p12` in `CSC_LINK`.                                       |
| `APPLE_ID`          | mac      | Apple ID email used for notarization.                                        |
| `APPLE_ID_PASSWORD` | mac      | App-specific password generated at https://appleid.apple.com.                |
| `APPLE_TEAM_ID`     | mac      | 10-character Apple Developer Team ID.                                        |

### Adding / rotating secrets

1. **GitHub**: Repository → Settings → Secrets and variables → Actions →
   **New repository secret**.
2. **`CSC_LINK`**: if using a file, `base64 -i cert.p12 | pbcopy` and paste
   the encoded blob. `electron-builder` decodes base64 transparently.
3. **Rotation**: create the new secret value, update the repo secret, kick
   off a dry-run build to confirm. Old certs that appear on the signed
   output can't be revoked after the fact — they're embedded in existing
   installers — but the new build will use the new cert.

### Why not Sentry / telemetry?

We intentionally do not ship any telemetry. The author uses this app daily
and prefers to discover problems by using it. If an updater error occurs it
is visible in Settings → Updates and via the `update:error` IPC channel.

## Auto-update feed

`electron-updater` reads update metadata from the GitHub release matching the
repo in `package.json → build.publish[0]`. The `latest.yml` / `latest-mac.yml`
/ `latest-linux.yml` files are produced by `electron-builder` and must be
attached to the published release for the auto-updater to see it.

If you publish a release and clients don't pick it up, check:

1. The release is **not** marked as a pre-release (update feed skips those by
   default).
2. `latest*.yml` files are attached alongside the binaries.
3. The installed client is `app.isPackaged === true` — updater is a no-op in
   dev mode by design.
