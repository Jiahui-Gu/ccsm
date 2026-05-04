#!/usr/bin/env bash
# packages/daemon/build/install/mac/build-pkg.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5.2 (macOS pkg).
# Task: T7.4 (#81) — installer: per-OS service registration + state dir creation.
#
# Builds ccsm-<version>.pkg via pkgbuild + productbuild from the staged
# daemon binary + native/ + LaunchDaemon plist + pre/postinstall scripts.
#
# Placeholder-safe (project_v03_ship_intent): if pkgbuild / productbuild are
# absent OR the host is not macOS OR the daemon binary is missing, the script
# logs a WARN and exits 0. Local dogfood `npm run build` MUST NOT fail when
# the macOS toolchain is unavailable.
#
# Env contract (forever-stable):
#   CCSM_VERSION              product version. Default: from root package.json.
#   CCSM_PKG_IDENTIFIER       reverse-DNS pkg id. Default: com.ccsm.daemon.
#   CCSM_INSTALLER_DRY_RUN    if "1", print pkgbuild/productbuild invocations
#                             and exit 0 without touching artifacts.
#
# Inputs (positional):
#   $1   absolute path to the daemon binary
#        (default: <pkg>/dist/ccsm-daemon)
#   $2   absolute path to the native/ dir
#        (default: <pkg>/dist/native)
#   $3   absolute path to write ccsm-*.pkg
#        (default: <pkg>/dist)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC_DIR="$HERE"
BUILD_DIR="$(cd "$HERE/../.." && pwd)"
PKG_DIR="$(cd "$BUILD_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
DIST_DIR="$PKG_DIR/dist"

BINARY="${1:-$DIST_DIR/ccsm-daemon}"
NATIVE_DIR="${2:-$DIST_DIR/native}"
OUT_DIR="${3:-$DIST_DIR}"

DRY_RUN="${CCSM_INSTALLER_DRY_RUN:-0}"

log()  { echo "[install-mac] $*"; }
warn() { echo "[install-mac] WARN: $*" >&2; }

# ---- 0. placeholder-safe gate ----
if [[ "$(uname -s)" != "Darwin" ]] && [[ "$DRY_RUN" != "1" ]]; then
  warn "non-darwin host ($(uname -s)); macOS .pkg build skipped."
  warn "this is expected for local cross-platform dogfood builds."
  exit 0
fi

if [[ "$DRY_RUN" != "1" ]]; then
  for tool in pkgbuild productbuild; do
    command -v "$tool" >/dev/null 2>&1 || {
      warn "missing tool: $tool — skipping (Apple Command Line Tools not installed)."
      exit 0
    }
  done
  [[ -f "$BINARY" ]]      || { warn "daemon binary missing: $BINARY — skipping."; exit 0; }
  [[ -d "$NATIVE_DIR" ]]  || { warn "native dir missing: $NATIVE_DIR — skipping."; exit 0; }
fi

# Resolve version from root package.json if not provided.
VERSION="${CCSM_VERSION:-}"
if [[ -z "$VERSION" ]]; then
  if [[ -f "$REPO_ROOT/package.json" ]]; then
    VERSION="$(/usr/bin/python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$REPO_ROOT/package.json" 2>/dev/null || echo '0.0.0')"
  else
    VERSION="0.0.0"
  fi
fi

PKG_ID="${CCSM_PKG_IDENTIFIER:-com.ccsm.daemon}"
DAEMON_INSTALL_PATH="/usr/local/ccsm/ccsm-daemon"

run_or_echo() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[install-mac DRY-RUN]" "$@"
  else
    "$@"
  fi
}

# Build a staging tree:
#   $STAGE/usr/local/ccsm/ccsm-daemon
#   $STAGE/usr/local/ccsm/native/...
#   $STAGE/Library/LaunchDaemons/com.ccsm.daemon.plist (token-substituted)
STAGE="$(mktemp -d -t ccsm-pkg-stage.XXXXXX)"
SCRIPTS="$(mktemp -d -t ccsm-pkg-scripts.XXXXXX)"
trap 'rm -rf "$STAGE" "$SCRIPTS"' EXIT

if [[ "$DRY_RUN" != "1" ]]; then
  mkdir -p "$STAGE/usr/local/ccsm" "$STAGE/Library/LaunchDaemons"
  cp "$BINARY" "$STAGE/usr/local/ccsm/ccsm-daemon"
  cp -R "$NATIVE_DIR" "$STAGE/usr/local/ccsm/native"
  chmod 0755 "$STAGE/usr/local/ccsm/ccsm-daemon"

  # T7.6 (#84) — ship the uninstaller as part of the payload. postinstall
  # then copies it to /Library/Application Support/ccsm/ccsm-uninstall.command
  # (spec ch10 §5.2 line). Keeping the source under /usr/local/ccsm keeps it
  # owned by root and out of the daemon's writable state dir during the
  # window between preinstall (state dir created) and postinstall (uninstall
  # cmd dropped in).
  cp "$MAC_DIR/uninstall.sh" "$STAGE/usr/local/ccsm/uninstall.sh"
  chmod 0755 "$STAGE/usr/local/ccsm/uninstall.sh"

  PLIST_SRC="$MAC_DIR/com.ccsm.daemon.plist"
  PLIST_DST="$STAGE/Library/LaunchDaemons/com.ccsm.daemon.plist"
  sed "s|@CCSM_DAEMON_PATH@|$DAEMON_INSTALL_PATH|g" "$PLIST_SRC" > "$PLIST_DST"
  chmod 0644 "$PLIST_DST"

  cp "$MAC_DIR/preinstall.sh"  "$SCRIPTS/preinstall"
  cp "$MAC_DIR/postinstall.sh" "$SCRIPTS/postinstall"
  chmod 0755 "$SCRIPTS/preinstall" "$SCRIPTS/postinstall"
fi

COMPONENT_PKG="$OUT_DIR/ccsm-component-$VERSION.pkg"
PRODUCT_PKG="$OUT_DIR/ccsm-$VERSION.pkg"

mkdir -p "$OUT_DIR"

log "pkgbuild --identifier $PKG_ID --version $VERSION -> $COMPONENT_PKG"
run_or_echo pkgbuild \
  --root "$STAGE" \
  --scripts "$SCRIPTS" \
  --identifier "$PKG_ID" \
  --version "$VERSION" \
  --install-location "/" \
  "$COMPONENT_PKG"

log "productbuild -> $PRODUCT_PKG"
run_or_echo productbuild \
  --package "$COMPONENT_PKG" \
  --identifier "$PKG_ID" \
  --version "$VERSION" \
  "$PRODUCT_PKG"

log "OK — pkg built: $PRODUCT_PKG"
log "(installer signing + notarization is owned by T7.3 sign-mac.sh and the .pkg sign hook)"
