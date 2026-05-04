#!/usr/bin/env bash
# packages/daemon/build/install/linux/build-pkg.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §5.3 (Linux deb + rpm).
# Task: T7.4 (#81) — installer: per-OS service registration + state dir creation.
#
# Builds ccsm-<version>.deb and ccsm-<version>.rpm via fpm from the staged
# daemon binary + native/ + systemd unit + postinst/prerm/postrm scripts.
#
# Placeholder-safe (project_v03_ship_intent): if fpm is not on PATH OR the
# host is non-linux (and not in dry-run) OR the daemon binary is missing,
# the script logs a WARN and exits 0. Local dogfood `npm run build` MUST
# NOT fail when fpm / ruby is unavailable.
#
# Env contract (forever-stable):
#   CCSM_VERSION              product version. Default: from root package.json.
#   CCSM_PKG_NAME             package name. Default: ccsm.
#   CCSM_INSTALLER_DRY_RUN    if "1", print the fpm invocations and exit 0.
#
# Inputs (positional):
#   $1   absolute path to the daemon binary
#        (default: <pkg>/dist/ccsm-daemon)
#   $2   absolute path to the native/ dir
#        (default: <pkg>/dist/native)
#   $3   absolute path to write ccsm-*.deb / .rpm
#        (default: <pkg>/dist)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINUX_DIR="$HERE"
BUILD_DIR="$(cd "$HERE/../.." && pwd)"
PKG_DIR="$(cd "$BUILD_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
DIST_DIR="$PKG_DIR/dist"

BINARY="${1:-$DIST_DIR/ccsm-daemon}"
NATIVE_DIR="${2:-$DIST_DIR/native}"
OUT_DIR="${3:-$DIST_DIR}"

DRY_RUN="${CCSM_INSTALLER_DRY_RUN:-0}"

log()  { echo "[install-linux] $*"; }
warn() { echo "[install-linux] WARN: $*" >&2; }

# ---- 0. placeholder-safe gate ----
# fpm is portable (ruby gem) and CAN run on macOS for cross-build dev, so we
# do NOT gate on uname here — only on tool + input presence.
if [[ "$DRY_RUN" != "1" ]]; then
  if ! command -v fpm >/dev/null 2>&1; then
    warn "fpm not on PATH — skipping linux package build."
    warn "(install via: gem install fpm; requires ruby + a sane build env.)"
    exit 0
  fi
  [[ -f "$BINARY" ]]     || { warn "daemon binary missing: $BINARY — skipping."; exit 0; }
  [[ -d "$NATIVE_DIR" ]] || { warn "native dir missing: $NATIVE_DIR — skipping."; exit 0; }
fi

# Resolve version from root package.json if not provided.
VERSION="${CCSM_VERSION:-}"
if [[ -z "$VERSION" ]]; then
  if [[ -f "$REPO_ROOT/package.json" ]]; then
    VERSION="$(/usr/bin/env python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$REPO_ROOT/package.json" 2>/dev/null || echo '0.0.0')"
  else
    VERSION="0.0.0"
  fi
fi

PKG_NAME="${CCSM_PKG_NAME:-ccsm}"

run_or_echo() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[install-linux DRY-RUN]" "$@"
  else
    "$@"
  fi
}

# Build a staging tree mirroring the on-disk layout that fpm will package:
#   $STAGE/usr/lib/ccsm/ccsm-daemon
#   $STAGE/usr/lib/ccsm/native/...
#   $STAGE/lib/systemd/system/ccsm-daemon.service
STAGE="$(mktemp -d -t ccsm-pkg-stage.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

if [[ "$DRY_RUN" != "1" ]]; then
  mkdir -p "$STAGE/usr/lib/ccsm" "$STAGE/lib/systemd/system"
  cp "$BINARY" "$STAGE/usr/lib/ccsm/ccsm-daemon"
  cp -R "$NATIVE_DIR" "$STAGE/usr/lib/ccsm/native"
  chmod 0755 "$STAGE/usr/lib/ccsm/ccsm-daemon"
  cp "$LINUX_DIR/ccsm-daemon.service" "$STAGE/lib/systemd/system/ccsm-daemon.service"
  chmod 0644 "$STAGE/lib/systemd/system/ccsm-daemon.service"
fi

mkdir -p "$OUT_DIR"

# Common fpm args. The same staging dir + scripts produce both .deb and
# .rpm with -t deb / -t rpm.
FPM_COMMON=(
  -s dir
  -n "$PKG_NAME"
  -v "$VERSION"
  -C "$STAGE"
  --description "CCSM (Claude Code Session Manager) daemon"
  --license MIT
  --url "https://github.com/Jiahui-Gu/ccsm"
  --maintainer "ccsm <noreply@ccsm.dev>"
  --after-install "$LINUX_DIR/postinst.sh"
  --before-remove "$LINUX_DIR/prerm.sh"
  --after-remove  "$LINUX_DIR/postrm.sh"
  --config-files /lib/systemd/system/ccsm-daemon.service
  --force
)

# .deb
DEB_PATH="$OUT_DIR/${PKG_NAME}_${VERSION}_amd64.deb"
log "fpm -t deb -> $DEB_PATH"
run_or_echo fpm "${FPM_COMMON[@]}" \
  -t deb \
  -p "$DEB_PATH" \
  --deb-no-default-config-files \
  --depends "systemd"

# .rpm
RPM_PATH="$OUT_DIR/${PKG_NAME}-${VERSION}-1.x86_64.rpm"
log "fpm -t rpm -> $RPM_PATH"
run_or_echo fpm "${FPM_COMMON[@]}" \
  -t rpm \
  -p "$RPM_PATH" \
  --depends "systemd"

log "OK — linux packages built:"
log "  $DEB_PATH"
log "  $RPM_PATH"
log "(package signing is owned by T7.3 sign-linux.sh; pass these paths in.)"
