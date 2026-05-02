#!/usr/bin/env bash
# scripts/build-mac-uninstall-helper.sh
#
# Build ccsm-uninstall-helper Mach-O binaries for macOS (Task #136 / frag-11
# §11.6.4). Produces three artifacts in daemon/dist/:
#
#   ccsm-uninstall-helper-macos-x64        thin Mach-O 64-bit (x86_64)
#   ccsm-uninstall-helper-macos-arm64      thin Mach-O 64-bit (arm64)
#   ccsm-uninstall-helper-macos-universal  fat Mach-O (CAFEBABE) of both
#
# Why all three?
#   - Per-arch thin binaries are what the codesign loop in
#     scripts/sign-macos.cjs and the spec frag-11 §11.3.2 codesign loop
#     iterate over (`daemon/dist/ccsm-uninstall-helper-macos-$arch`).
#   - The universal binary is what ships inside `CCSM.app/Contents/Resources/
#     daemon/ccsm-uninstall-helper` so a single .app launches on both
#     Intel and Apple Silicon Macs without per-arch DMG branching for the
#     helper specifically. (The Electron framework + daemon are still
#     per-arch DMGs.)
#
# Toolchain: only `swiftc` + `lipo` + `file` from Apple's command-line
# tools (`xcode-select --install`). No Swift Package Manager — we compile
# a single .swift file directly to keep the build surface minimal.
#
# Cross-compile note: the swiftc invocations use `-target` so the script
# works regardless of host arch (an x86_64 runner can build the arm64
# slice and vice-versa). macOS deployment target is pinned to 11.0
# (Big Sur, Apple Silicon launch) — same minimum the Electron 41 main
# bundle requires.
#
# Exit codes:
#   0  all three artifacts built + verified (`file` reports correct types)
#   1  swiftc / lipo / file failure, OR running on non-macOS
#   2  toolchain missing (swiftc / lipo not in PATH)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${REPO_ROOT}/installer/uninstall-helper-mac/ccsm-uninstall-helper.swift"
OUT_DIR="${REPO_ROOT}/daemon/dist"
DEPLOYMENT_TARGET="11.0"

log() { printf '[build-mac-uninstall-helper] %s\n' "$*"; }
err() { printf '[build-mac-uninstall-helper] ERROR: %s\n' "$*" >&2; }

# 0. Platform gate. The script CAN only run on macOS (swiftc on the
#    macOS SDK is not available on Win/Linux runners). Fail fast with a
#    clear message so non-mac CI legs skip cleanly.
if [ "$(uname -s)" != "Darwin" ]; then
  err "this script only runs on macOS (uname -s=$(uname -s))"
  exit 1
fi

# 1. Toolchain probe.
for tool in swiftc lipo file; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    err "$tool not found in PATH (run \`xcode-select --install\`)"
    exit 2
  fi
done

if [ ! -f "$SRC" ]; then
  err "source not found: $SRC"
  exit 1
fi

mkdir -p "$OUT_DIR"

OUT_X64="${OUT_DIR}/ccsm-uninstall-helper-macos-x64"
OUT_ARM64="${OUT_DIR}/ccsm-uninstall-helper-macos-arm64"
OUT_UNIVERSAL="${OUT_DIR}/ccsm-uninstall-helper-macos-universal"

# 2. Per-arch thin builds. -O for release optimisation, -wmo for
#    whole-module-optimisation (single-file → marginal but free).
log "compiling x86_64 -> $OUT_X64"
swiftc \
  -O -wmo \
  -target "x86_64-apple-macosx${DEPLOYMENT_TARGET}" \
  -o "$OUT_X64" \
  "$SRC"

log "compiling arm64 -> $OUT_ARM64"
swiftc \
  -O -wmo \
  -target "arm64-apple-macosx${DEPLOYMENT_TARGET}" \
  -o "$OUT_ARM64" \
  "$SRC"

# 3. Universal (CAFEBABE) merge.
log "merging universal -> $OUT_UNIVERSAL"
lipo -create "$OUT_X64" "$OUT_ARM64" -output "$OUT_UNIVERSAL"

# 4. Verify magic bytes via `file`. We assert the human-readable type
#    string that `file` emits matches what we expect — this catches:
#      (a) swiftc silently producing the wrong arch (e.g. host fallback)
#      (b) lipo failing to produce a fat binary (would emit a thin one)
verify_thin() {
  local path="$1" expected_arch="$2"
  local out
  out="$(file "$path")"
  log "  file: $out"
  case "$out" in
    *"Mach-O 64-bit executable ${expected_arch}"*) ;;
    *) err "expected Mach-O 64-bit executable ${expected_arch}, got: $out"; return 1;;
  esac
}

verify_universal() {
  local path="$1"
  local out
  out="$(file "$path")"
  log "  file: $out"
  case "$out" in
    *"Mach-O universal binary"*) ;;
    *) err "expected Mach-O universal binary, got: $out"; return 1;;
  esac
  # Also verify the CAFEBABE magic explicitly (frag-11 spec language).
  local magic
  magic="$(xxd -l 4 -p "$path" 2>/dev/null || head -c 4 "$path" | od -An -tx1 | tr -d ' \n')"
  case "$magic" in
    cafebabe) log "  magic OK: cafebabe" ;;
    *) err "expected CAFEBABE magic, got: $magic"; return 1;;
  esac
}

log "verifying x64"
verify_thin "$OUT_X64" "x86_64"
log "verifying arm64"
verify_thin "$OUT_ARM64" "arm64"
log "verifying universal"
verify_universal "$OUT_UNIVERSAL"

log "OK built and verified all three Mach-O artifacts:"
log "  $OUT_X64"
log "  $OUT_ARM64"
log "  $OUT_UNIVERSAL"
