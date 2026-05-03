#!/usr/bin/env bash
# build-sea.sh — build a Node 22 SEA wrapping probe.mjs.
#
# Steps (per spec ch10 §1 / Node 22 SEA docs):
#   1. npm install (local devDeps: better-sqlite3, esbuild, postject)
#   2. esbuild probe.mjs into a CJS bundle (SEA only supports CJS entry)
#   3. node --experimental-sea-config sea-config.json -> probe.blob
#   4. Copy node binary -> probe-sea(.exe)
#   5. postject inject the blob into the binary
#   6. Stage better_sqlite3.node next to the binary
#   7. Run ./probe-sea and capture output

set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR="$(pwd)/out"
BIN_NAME="probe-sea"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) BIN_NAME="probe-sea.exe" ;;
esac

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "[1/7] install devDeps"
npm install --no-audit --no-fund --silent

echo "[2/7] bundle probe.mjs -> probe.bundle.cjs (CJS, external better-sqlite3)"
# Mark better-sqlite3 external so its require() resolves at runtime against
# node_modules sitting next to the binary, not bundled into the SEA blob.
npx esbuild probe.mjs \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --external:better-sqlite3 \
  --external:node:sea \
  --outfile=probe.bundle.cjs

echo "[3/7] generate SEA blob"
node --experimental-sea-config sea-config.json

echo "[4/7] copy node binary"
NODE_BIN="$(command -v node)"
cp "$NODE_BIN" "$OUT_DIR/$BIN_NAME"

echo "[5/7] postject inject blob"
npx postject "$OUT_DIR/$BIN_NAME" NODE_SEA_BLOB probe.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  ${OSTYPE:+}

echo "[6/7] stage better_sqlite3.node next to binary"
SQLITE_NODE="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ ! -f "$SQLITE_NODE" ]; then
  echo "FAIL: $SQLITE_NODE not found after npm install" >&2
  exit 2
fi
cp "$SQLITE_NODE" "$OUT_DIR/better_sqlite3.node"
# Also copy the JS wrapper tree so require('better-sqlite3') resolves.
mkdir -p "$OUT_DIR/node_modules"
cp -R node_modules/better-sqlite3 "$OUT_DIR/node_modules/"
# better-sqlite3 depends on bindings + file-uri-to-path at runtime
for dep in bindings file-uri-to-path; do
  if [ -d "node_modules/$dep" ]; then
    cp -R "node_modules/$dep" "$OUT_DIR/node_modules/"
  fi
done

echo "[7/7] run probe-sea"
chmod +x "$OUT_DIR/$BIN_NAME" || true
"$OUT_DIR/$BIN_NAME" || {
  ec=$?
  echo "probe-sea exited $ec" >&2
  exit $ec
}
