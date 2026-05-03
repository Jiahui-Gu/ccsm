#!/usr/bin/env bash
# packages/daemon/build/stage-native.sh
#
# Spec ch10 §2 — copy prebuilt native (.node) addons into <out-dir>/ next to
# the sea binary. The native-loader (`packages/daemon/src/native-loader.ts`)
# resolves them via `createRequire(process.execPath + '/native/')` at
# runtime; the filenames here MUST match `SEA_NATIVE_FILENAME` in that file.
#
# Source-of-truth: prebuildify or upstream prebuilt artifacts under the
# package's node_modules directory. We walk a small list of known relative
# paths and pick the first match.
#
# This script is intentionally OS-current-arch only. CI cross-builds the
# 6-OS×arch matrix in a separate job (see chapter 10 §2 build matrix); each
# matrix shard runs this script after its native-rebuild step.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: stage-native.sh <out-dir>" >&2
  exit 2
fi

OUT_DIR="$1"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$HERE/.." && pwd)"

mkdir -p "$OUT_DIR"

# Candidate paths to look at, in priority order. Prebuildify drops files
# under `prebuilds/<platform>-<arch>/node.napi.node`; upstream's own build
# falls back to `build/Release/<name>.node`. We search both.
copy_first_match() {
  local addon_name="$1"
  local target_filename="$2"
  shift 2
  local candidates=("$@")
  for rel in "${candidates[@]}"; do
    local src="$PKG_DIR/$rel"
    if [[ -f "$src" ]]; then
      cp "$src" "$OUT_DIR/$target_filename"
      echo "[stage-native] $addon_name -> $OUT_DIR/$target_filename (from $rel)"
      return 0
    fi
  done
  echo "[stage-native] WARN: no .node found for $addon_name; tried:" >&2
  for rel in "${candidates[@]}"; do echo "  - $rel" >&2; done
  return 1
}

# better-sqlite3 — prebuildify-compatible names + upstream's build path.
copy_first_match better-sqlite3 better_sqlite3.node \
  node_modules/better-sqlite3/prebuilds/$(node -p 'process.platform + "-" + process.arch')/better-sqlite3.node \
  node_modules/better-sqlite3/prebuilds/$(node -p 'process.platform + "-" + process.arch')/node.napi.node \
  node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  || MISSING_BSQ=1

# node-pty — optional in v0.3 (T4.2+ wires the actual spawn). If the
# package isn't installed yet, do not fail the build; warn so reviewers
# notice. Once node-pty is added to dependencies the absence of the .node
# becomes a hard error via `set -e` on the warning path.
if [[ -d "$PKG_DIR/node_modules/node-pty" ]]; then
  copy_first_match node-pty pty.node \
    node_modules/node-pty/prebuilds/$(node -p 'process.platform + "-" + process.arch')/node-pty.node \
    node_modules/node-pty/prebuilds/$(node -p 'process.platform + "-" + process.arch')/node.napi.node \
    node_modules/node-pty/build/Release/pty.node
else
  echo "[stage-native] node-pty not installed yet (T4.2 hook); skipping pty.node"
fi

if [[ "${MISSING_BSQ:-0}" == "1" ]]; then
  echo "[stage-native] FATAL: better-sqlite3 native binary missing; cannot stage" >&2
  exit 1
fi
