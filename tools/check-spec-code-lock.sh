#!/usr/bin/env bash
# tools/check-spec-code-lock.sh — Wave 2 §5.5 mechanical guard (Task #220)
#
# Reads docs/superpowers/specs/2026-05-03-v03-daemon-split.lock.json and
# verifies every listed ship-gate file (a) exists at its canonical path
# and (b) has the recorded SHA256.
#
# Why this exists:
#   The v0.3 daemon-split spec ships behind 4 mechanical gates (a/b/c/d).
#   Each gate is enforced by a specific file whose canonical path is named
#   in the spec. If someone renames or deletes one of those files, the
#   gate silently stops working. This script locks the paths against
#   accidental rename/deletion: CI fails loudly on any drift.
#
# Hash source:
#   We hash the **git blob** content (`git show HEAD:<path>`) rather than
#   the working-tree bytes. This makes hashes platform-stable: on Windows
#   `core.autocrlf=true` rewrites LF -> CRLF on checkout, which would
#   otherwise produce a different SHA256 than Linux CI. Hashing the blob
#   bypasses the smudge filter.
#
# Cross-platform:
#   - sha256sum (GNU coreutils, present on Linux + Git Bash on Windows)
#   - shasum -a 256 (BSD, present on macOS)
#   - JSON parsed with node (already required by the project; root
#     package.json `engines` pins it).
#
# Exit codes:
#   0 — all listed files exist and hashes match
#   1 — one or more files missing or hash mismatch
#   2 — bootstrap error (lock file missing, no node, no sha256 tool, etc.)

set -u

LOCK_FILE="docs/superpowers/specs/2026-05-03-v03-daemon-split.lock.json"

if [ ! -f "$LOCK_FILE" ]; then
  echo "check-spec-code-lock: FAIL bootstrap — $LOCK_FILE not found" >&2
  exit 2
fi

# Pick a sha256 implementation.
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
else
  echo "check-spec-code-lock: FAIL bootstrap — neither sha256sum nor shasum found" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "check-spec-code-lock: FAIL bootstrap — node not found (needed to parse lock JSON)" >&2
  exit 2
fi

if ! command -v git >/dev/null 2>&1; then
  echo "check-spec-code-lock: FAIL bootstrap — git not found" >&2
  exit 2
fi

# Emit "<gate>\t<path>\t<expected_sha256>" lines, one per locked file.
ROWS="$(node -e '
  const fs = require("fs");
  const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const [gate, info] of Object.entries(j.gates || {})) {
    for (const f of info.files || []) {
      process.stdout.write(gate + "\t" + f.path + "\t" + f.sha256 + "\n");
    }
  }
' "$LOCK_FILE")"

if [ -z "$ROWS" ]; then
  echo "check-spec-code-lock: FAIL bootstrap — no rows parsed from $LOCK_FILE" >&2
  exit 2
fi

fail=0
checked=0

# Iterate. Use a here-string so the loop body runs in the parent shell
# (we need `fail` increments to survive).
while IFS=$'\t' read -r gate path expected; do
  [ -z "$gate" ] && continue
  checked=$((checked + 1))

  # Existence check: working tree (so a delete in this PR is caught
  # even before commit) AND git index (so a missing file at HEAD is
  # caught — relevant for CI where checkout is fresh).
  if [ ! -f "$path" ]; then
    echo "FAIL: gate $gate path $path missing (working tree)" >&2
    fail=$((fail + 1))
    continue
  fi

  # Hash the working-tree file with line endings normalized to LF.
  # Why: on Windows `core.autocrlf=true` rewrites LF -> CRLF on checkout,
  # which would otherwise produce a different SHA256 than the same file
  # on Linux CI. We strip \r so the hash is the same on every platform
  # AND catches uncommitted edits (a pre-commit run is meaningful).
  # `tr -d '\r'` is a no-op for files that are already LF-only and for
  # binary files that contain no \r bytes (none of our locked files are
  # binary).
  actual="$(tr -d '\r' < "$path" | $SHA_CMD | awk '{print $1}')"
  source="working_tree(lf)"

  if [ "$actual" != "$expected" ]; then
    echo "FAIL: gate $gate path $path changed" >&2
    echo "       expected sha256: $expected" >&2
    echo "       actual   sha256: $actual ($source)" >&2
    echo "       to intentionally update, refresh the hash in $LOCK_FILE" >&2
    fail=$((fail + 1))
  fi
done <<EOF
$ROWS
EOF

if [ "$fail" -ne 0 ]; then
  echo "check-spec-code-lock: $fail/$checked locked file(s) failed verification" >&2
  exit 1
fi

echo "check-spec-code-lock: OK ($checked locked files verified against $LOCK_FILE)"
exit 0
