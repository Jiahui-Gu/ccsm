# Fragment: §11 packaging (extraResources + signing)

**Owner**: worker dispatched per Task #933
**Target spec section**: replace/expand §11 in main spec
**P0 items addressed**: #9 (extraResources), #10 (daemon signing)

## What to write here
Replace this section with the actual `## 11. Packaging` markdown. Cover:

1. **Daemon binary build**:
   - `@yao-pkg/pkg` packages daemon Node code + better-sqlite3 + node-pty
     into single binary per platform (`daemon-win.exe`, `daemon-mac`,
     `daemon-linux`). Native modules included via pkg's asset config.
   - Output to `daemon/dist/`. Build script: `npm run build:daemon` (added
     to root workspace scripts).
2. **electron-builder integration** (v0.3 still uses electron-forge? check
   current setup and cite — pick one tool, stay consistent):
   - Add `extraResources` entry mapping `daemon/dist/daemon-${platform}` →
     installer payload at `resources/daemon/`. Spec the exact config block.
   - Electron main resolves daemon path via `process.resourcesPath +
     '/daemon/daemon-...'` in production; dev uses `daemon/dist/...` directly.
3. **Code signing**:
   - **Windows**: `signtool sign` daemon binary with same EV cert used for
     `CCSM.exe` (currently configured in release.yml — cite). Same SHA-256
     timestamp server. Daemon binary signed BEFORE electron-builder packages
     it, so the installer-level signature covers an already-signed payload.
   - **macOS**: `codesign --options runtime --entitlements ...` daemon
     binary with same Developer ID. Notarization happens at the .dmg level
     after electron-builder; daemon must be signed first or notarization
     rejects.
   - **Linux**: no signing (no infra); SHA256 manifest only.
4. **SHA256 manifest**: published alongside release artifacts as
   `SHA256SUMS.txt`; auto-updater downloads + verifies (§3.1, §7).
5. **CI changes** (release.yml):
   - Add daemon build step BEFORE electron-builder.
   - Sign daemon binary in same CI step that signs the app (cert already
     available there).
   - Publish daemon binary as separate release asset (for daemon-only
     auto-update channel later) AND bundled inside installer.

Cite findings from `~/spike-reports/v03-review-packaging.md`.

## Plan delta
- New Task: daemon pkg build (+4h).
- New Task: electron-builder/forge extraResources wiring (+3h).
- New Task: Win signtool integration in CI (+2h).
- New Task: Mac codesign + notarization (+3h, more if entitlements need
  tweaking).
- New Task: SHA256SUMS.txt publish step (+1h).
- Total packaging block: ~13h.
