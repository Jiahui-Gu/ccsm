#!/usr/bin/env bash
# build.sh — Node 22 SEA hello-world build harness (linux + darwin).
#
# Contract (forever-stable per spec ch14 §1.B / ch10 §1):
#   Inputs:  none (NODE22 env var optional override)
#   Outputs: dist/sea-hello-<platform>[.exe]   produced binary
#            dist/run.log                       captured stdout/stderr from running it
#            dist/build.log                     captured build steps
#   Exit:    0 on full pipeline success (build + run + output match)
#            non-zero on any failure (preserves logs)
#
# Algorithm per Node 22 SEA docs (https://nodejs.org/docs/v22.22.2/api/single-executable-applications.html):
#   1. Locate Node 22 binary (env NODE22 or download to .cache/node22/)
#   2. node --experimental-sea-config sea-config.json -> sea-prep.blob
#   3. cp node binary -> dist/sea-hello-<platform>[.exe]
#   4. (macOS) codesign --remove-signature
#   5. postject the blob into the binary copy
#   6. (macOS) ad-hoc re-sign
#   7. Execute resulting binary, capture stdout, compare against expected.
#
# Layer 1: bash + curl + tar + node: standard toolchain.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$HERE/dist"
CACHE="$HERE/.cache"
NODE_VERSION="22.22.2"

mkdir -p "$DIST" "$CACHE"
: > "$DIST/build.log"
log() { echo "[build] $*" | tee -a "$DIST/build.log"; }

UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Linux*)  PLAT="linux";  EXT="";    ARCHIVE_EXT="tar.xz"; PLAT_TAG="linux-x64"  ;;
  Darwin*) PLAT="darwin"; EXT="";    ARCHIVE_EXT="tar.gz"; PLAT_TAG="darwin-arm64";;
  MINGW*|MSYS*|CYGWIN*) PLAT="win32"; EXT=".exe"; ARCHIVE_EXT="zip";   PLAT_TAG="win-x64"     ;;
  *) echo "[build] unsupported uname: $UNAME_S" >&2; exit 10 ;;
esac
log "platform=$PLAT plat-tag=$PLAT_TAG node=$NODE_VERSION"

# ---- 1. locate node22 ----
NODE22="${NODE22:-}"
if [ -z "$NODE22" ]; then
  STAMP="node-v${NODE_VERSION}-${PLAT_TAG}"
  NODE22="$CACHE/$STAMP/bin/node$EXT"
  [ "$PLAT" = "win32" ] && NODE22="$CACHE/$STAMP/node$EXT"
  if [ ! -x "$NODE22" ]; then
    URL="https://nodejs.org/dist/v${NODE_VERSION}/${STAMP}.${ARCHIVE_EXT}"
    log "downloading $URL"
    ARCHIVE="$CACHE/${STAMP}.${ARCHIVE_EXT}"
    curl -fsSL "$URL" -o "$ARCHIVE"
    if [ "$ARCHIVE_EXT" = "zip" ]; then
      (cd "$CACHE" && unzip -q "$ARCHIVE")
    else
      (cd "$CACHE" && tar -xf "$ARCHIVE")
    fi
  fi
fi
[ -x "$NODE22" ] || { log "node22 not executable at $NODE22"; exit 11; }
log "node22=$NODE22 ($("$NODE22" --version))"

# ---- 2. build sea blob ----
( cd "$HERE" && "$NODE22" --experimental-sea-config sea-config.json ) >> "$DIST/build.log" 2>&1
[ -f "$HERE/sea-prep.blob" ] || { log "sea-prep.blob missing"; exit 12; }
log "blob bytes=$(wc -c < "$HERE/sea-prep.blob")"

# ---- 3. copy node binary ----
OUT="$DIST/sea-hello-${PLAT}${EXT}"
cp "$NODE22" "$OUT"
chmod +w "$OUT" || true
log "binary template copied to $OUT"

# ---- 4. macOS: strip signature ----
if [ "$PLAT" = "darwin" ]; then
  codesign --remove-signature "$OUT" >> "$DIST/build.log" 2>&1 || log "codesign --remove-signature warned"
fi

# ---- 5. postject inject ----
# postject is a small npm-published util; vendored via npx for the spike.
SENTINEL="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
NPX="$(dirname "$NODE22")/npx${EXT}"
[ "$PLAT" = "win32" ] && NPX="$(dirname "$NODE22")/npx.cmd"
if [ ! -x "$NPX" ] && [ "$PLAT" != "win32" ]; then NPX="npx"; fi

POSTJECT_ARGS=("$OUT" NODE_SEA_BLOB "$HERE/sea-prep.blob"
               --sentinel-fuse "$SENTINEL"
               --overwrite)
if [ "$PLAT" = "darwin" ]; then
  POSTJECT_ARGS+=(--macho-segment-name NODE_SEA)
fi

log "postject: ${POSTJECT_ARGS[*]}"
"$NPX" --yes postject@1.0.0-alpha.6 "${POSTJECT_ARGS[@]}" >> "$DIST/build.log" 2>&1

# ---- 6. macOS: re-sign ad-hoc ----
if [ "$PLAT" = "darwin" ]; then
  codesign --sign - "$OUT" >> "$DIST/build.log" 2>&1 || { log "codesign re-sign FAILED"; exit 13; }
fi

BIN_BYTES=$(wc -c < "$OUT")
log "final binary bytes=$BIN_BYTES"

# ---- 7. run ----
set +e
"$OUT" > "$DIST/run.log" 2>&1
RC=$?
set -e
log "binary exited rc=$RC"
log "run.log:"; cat "$DIST/run.log" | sed 's/^/    /' | tee -a "$DIST/build.log"

EXPECTED="hello-from-sea-${PLAT}"
if grep -qx "$EXPECTED" "$DIST/run.log"; then
  log "OK — output matches '$EXPECTED'"
  exit 0
fi
log "FAIL — expected '$EXPECTED' not found in run.log"
exit "$RC"
