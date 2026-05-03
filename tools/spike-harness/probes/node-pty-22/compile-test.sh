#!/usr/bin/env bash
# T9.10 node-pty install + ABI verification.
#
# Forever-stable contract:
#   args:   none
#   env:    none
#   stdout: human-readable log (install steps, addon path, ABI version)
#   exit:   0 if install succeeded AND a *.node addon for the running Node ABI
#           is present under node_modules/node-pty/build/Release/, 1 otherwise.
#
# Strategy:
#   1. pnpm install (or npm install fallback) inside this probe directory.
#      Probe ships a local package.json so node-pty never touches root deps.
#   2. Locate the compiled / prebuilt *.node addon.
#   3. Verify ABI by `require`-loading from a Node process and printing
#      process.versions.modules + the addon path resolved by node-pty.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "[compile-test] cwd=$DIR"
NODE_ABI=$(node -p 'process.versions.modules')
NODE_PLAT=$(node -p 'process.platform')
NODE_ARCH=$(node -p 'process.arch')
echo "[compile-test] node=$(node -v)  abi=${NODE_ABI}  platform=${NODE_PLAT}/${NODE_ARCH}"

if command -v pnpm >/dev/null 2>&1; then
  echo "[compile-test] using pnpm (node-linker=hoisted to mirror root .npmrc)"
  pnpm install --silent --ignore-workspace --config.node-linker=hoisted
else
  echo "[compile-test] pnpm not found, falling back to npm"
  npm install --silent --no-audit --no-fund
fi

# Resolve real node-pty location (pnpm hoisted may still place it through a
# virtual store on some platforms; trust Node's module resolver).
ADDON_PKG_DIR=$(node -p "require('path').dirname(require.resolve('node-pty/package.json'))")
echo "[compile-test] node-pty resolved at: ${ADDON_PKG_DIR}"

# node-pty 1.1.0 ships N-API prebuilds (ABI-stable across Node 18/20/22/24).
# Loader (lib/utils.js) checks build/Release, build/Debug, then
# prebuilds/<platform>-<arch>/. We accept either source.
BUILD_DIR="${ADDON_PKG_DIR}/build/Release"
PREBUILD_DIR="${ADDON_PKG_DIR}/prebuilds/${NODE_PLAT}-${NODE_ARCH}"

ADDON_DIR=""
if [ -d "$BUILD_DIR" ] && [ -n "$(find "$BUILD_DIR" -maxdepth 1 -name '*.node' -print -quit)" ]; then
  ADDON_DIR="$BUILD_DIR"
  echo "[compile-test] using local rebuild dir: $ADDON_DIR"
elif [ -d "$PREBUILD_DIR" ] && [ -n "$(find "$PREBUILD_DIR" -maxdepth 1 -name '*.node' -print -quit)" ]; then
  ADDON_DIR="$PREBUILD_DIR"
  echo "[compile-test] using fetched prebuild dir: $ADDON_DIR"
else
  echo "[compile-test] FAIL: no addon found in $BUILD_DIR or $PREBUILD_DIR"
  echo "[compile-test] available prebuild platforms:"
  ls "${ADDON_PKG_DIR}/prebuilds/" 2>&1 || true
  exit 1
fi

echo "[compile-test] addon dir contents:"
ls -la "$ADDON_DIR"
echo "[compile-test] addon dir contents:"
ls -la "$ADDON_DIR" || { echo "[compile-test] FAIL: $ADDON_DIR missing"; exit 1; }

NODE_FILES=$(find "$ADDON_DIR" -maxdepth 1 -name '*.node' -print)
if [ -z "$NODE_FILES" ]; then
  echo "[compile-test] FAIL: no *.node addon under $ADDON_DIR"
  exit 1
fi

echo "[compile-test] found .node files:"
echo "$NODE_FILES"

echo "[compile-test] require-load test:"
node -e "const p = require('node-pty'); console.log('node-pty loaded ok, abi=' + process.versions.modules + ' keys=' + Object.keys(p).slice(0,5).join(','));"

echo "[compile-test] PASS"
