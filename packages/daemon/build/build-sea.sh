#!/usr/bin/env bash
# packages/daemon/build/build-sea.sh
# Spec ch10 §1 — build the daemon as a Node 22 Single Executable Application.
#
# Pipeline:
#   1. tsc -> dist/*.js (handled by upstream `pnpm --filter @ccsm/daemon run build`)
#   2. esbuild bundles dist/index.js + pure-JS deps into a single CJS file
#      (dist/bundle.cjs). Native (.node) modules are intentionally NOT bundled
#      — sea cannot embed them; T7.2 (task #83) wires the sibling-dir
#      native-loader. For T7.1 we mark them as `external` and expect
#      build-time absence to surface as a runtime ERR_MODULE_NOT_FOUND
#      until #83 lands.
#   3. node --experimental-sea-config sea-config.json -> dist/sea-prep.blob
#   4. copy current node binary -> dist/ccsm-daemon
#   5. npx postject ... NODE_SEA_BLOB ... -> single executable
#
# Code-signing (T7.3 / task #82) is OUT OF SCOPE here.
#
# macOS fallback: if a downstream signing/notarization step rejects the bare
# sea binary (spike `[macos-notarization-sea]` per spec ch10 §1 / §3), the
# fallback path produces an `.app-wrapped` node binary directory at
# dist/Ccsm.app/Contents/MacOS/ccsm-daemon (a real `node` interpreter +
# bundle.cjs + a minimal Info.plist) — NOT a sea binary. This script
# generates the `.app`-wrapped layout when invoked with `--app-wrapped`.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$HERE/.." && pwd)"
DIST_DIR="$PKG_DIR/dist"
SEA_CONFIG="$HERE/sea-config.json"

APP_WRAPPED=0
for arg in "$@"; do
  case "$arg" in
    --app-wrapped) APP_WRAPPED=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

OS="$(uname -s)"
case "$OS" in
  Linux)  PLATFORM=linux ;;
  Darwin) PLATFORM=mac ;;
  *) echo "build-sea.sh: unsupported OS '$OS' (use build-sea.ps1 on Windows)" >&2; exit 2 ;;
esac

# Step 1: tsc compile (idempotent — fast no-op if already built).
echo "[build-sea] tsc compile"
( cd "$PKG_DIR" && pnpm run build )

if [[ ! -f "$DIST_DIR/index.js" ]]; then
  echo "[build-sea] dist/index.js missing after tsc — aborting" >&2
  exit 1
fi

# Step 2: esbuild bundle. `--platform=node` + `--format=cjs` so sea's main
# can `require()` it. Native modules (.node) are external (per T7.2 plan).
echo "[build-sea] esbuild bundle"
( cd "$PKG_DIR" && npx --yes esbuild dist/index.js \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile=dist/bundle.cjs \
  --external:better-sqlite3 \
  --external:node-pty \
  --external:*.node )

# macOS .app-wrapped fallback short-circuits sea — we just stage `node` and
# the bundle into a .app directory. Caller (T7.3 or release pipeline) is
# responsible for codesigning the .app.
if [[ "$PLATFORM" == "mac" && "$APP_WRAPPED" -eq 1 ]]; then
  echo "[build-sea] mac fallback: producing .app-wrapped node bundle"
  APP="$DIST_DIR/Ccsm.app"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$(command -v node)" "$APP/Contents/MacOS/ccsm-daemon"
  cp "$DIST_DIR/bundle.cjs" "$APP/Contents/Resources/bundle.cjs"
  cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>ccsm-daemon</string>
  <key>CFBundleIdentifier</key><string>com.ccsm.daemon</string>
  <key>CFBundleName</key><string>ccsm-daemon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>CFBundleVersion</key><string>0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
</dict>
</plist>
PLIST
  echo "[build-sea] mac .app-wrapped layout written to $APP"
  exit 0
fi

# Step 3: sea-config -> blob.
echo "[build-sea] node --experimental-sea-config"
( cd "$PKG_DIR" && node --experimental-sea-config "$SEA_CONFIG" )

if [[ ! -f "$DIST_DIR/sea-prep.blob" ]]; then
  echo "[build-sea] dist/sea-prep.blob missing after sea-config — aborting" >&2
  exit 1
fi

# Step 4: copy current node binary as the carrier.
TARGET="$DIST_DIR/ccsm-daemon"
echo "[build-sea] copy node -> $TARGET"
cp "$(command -v node)" "$TARGET"
chmod +w "$TARGET"

# Step 5: postject the blob.
echo "[build-sea] postject inject NODE_SEA_BLOB"
POSTJECT_ARGS=(
  "$TARGET"
  NODE_SEA_BLOB
  "$DIST_DIR/sea-prep.blob"
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
)
if [[ "$PLATFORM" == "mac" ]]; then
  POSTJECT_ARGS+=(--macho-segment-name NODE_SEA)
fi
( cd "$PKG_DIR" && npx --yes postject "${POSTJECT_ARGS[@]}" )

echo "[build-sea] done -> $TARGET"
echo "[build-sea] (code-signing handled by T7.3 / task #82, not invoked here)"
