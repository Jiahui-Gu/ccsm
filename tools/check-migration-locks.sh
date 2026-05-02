#!/usr/bin/env bash
# tools/check-migration-locks.sh
#
# FOREVER-STABLE per docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
# chapter 15 §3 item #4 + chapter 07 §4. Do not change behavior without bumping
# the design doc and routing through manager — every v0.4+ PR runs this.
#
# What it does:
#   1. Fetch the v0.3 GitHub release body via `gh release view v0.3.0`. The
#      release tag is the immutable witness — NOT the `main` branch, NOT
#      `packages/daemon/src/db/locked.ts`. If the release does not exist yet
#      (pre-tag), the script exits 0 with a note. The lock is only meaningful
#      AFTER v0.3 ships.
#   2. Parse the `### Migration locks` section to extract `(filename → sha256)`
#      pairs. Lines look like:  001_initial.sql  <64-hex>
#   3. For every recorded pair, recompute SHA256 of the file at HEAD under
#      packages/daemon/src/db/migrations/ and compare. Any mismatch / missing
#      v0.3-vintage file is a hard failure (exit 1).
#   4. If packages/daemon/src/db/locked.ts exists, also assert MIGRATION_LOCKS
#      entries match the release body (catches the "edit migration + edit
#      locked.ts together" attack path; locked.ts is the runtime self-check,
#      release body is the source of truth). locked.ts is created later by
#      Task #56 (T5.4 migration runner) — its absence is NOT a failure here.
#
# Compatibility: bash 3.2+, runs on Linux/macOS GHA runners and Git Bash on
# Windows. Uses sha256sum if available, else shasum -a 256, else node:crypto
# fallback. No new npm deps.

set -euo pipefail

RELEASE_TAG="v0.3.0"
MIGRATIONS_DIR="packages/daemon/src/db/migrations"
LOCKED_TS="packages/daemon/src/db/locked.ts"

log() { printf '[check-migration-locks] %s\n' "$*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

# --- gh availability --------------------------------------------------------
if ! command -v gh >/dev/null 2>&1; then
  fail "gh CLI not found on PATH (required to fetch release body)"
fi

# --- fetch release body, handle pre-tag gracefully --------------------------
# `gh release view` exits non-zero when the release does not exist; capture
# both stdout and exit status without `set -e` aborting us.
set +e
RELEASE_BODY="$(gh release view "$RELEASE_TAG" --json body --jq .body 2>/dev/null)"
GH_STATUS=$?
set -e

if [ "$GH_STATUS" -ne 0 ] || [ -z "$RELEASE_BODY" ]; then
  log "note: release $RELEASE_TAG does not exist yet (pre-tag); skipping lock check"
  log "this script becomes meaningful AFTER v0.3 ships — see design ch15 §3 #4"
  exit 0
fi

# --- pick a sha256 implementation -------------------------------------------
# Prints the hex digest of the file passed as $1 to stdout, nothing else.
sha256_of() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  elif command -v node >/dev/null 2>&1; then
    node -e "const c=require('node:crypto');const fs=require('node:fs');const h=c.createHash('sha256');h.update(fs.readFileSync(process.argv[1]));process.stdout.write(h.digest('hex'));" "$f"
  else
    fail "no sha256 implementation available (need sha256sum, shasum, or node)"
  fi
}

# --- parse `### Migration locks` block --------------------------------------
# Block format (one entry per line, separator is whitespace):
#
#   ### Migration locks
#
#   001_initial.sql  <64 hex chars>
#   002_<name>.sql   <64 hex chars>
#
# We extract everything after the heading until the next `###` heading or EOF,
# then keep lines that look like `<filename>.sql <64-hex>`.
LOCKS_BLOCK="$(printf '%s\n' "$RELEASE_BODY" \
  | awk '
      /^### Migration locks[[:space:]]*$/ { in_block = 1; next }
      in_block && /^###[[:space:]]/ { in_block = 0 }
      in_block { print }
    ')"

if [ -z "$LOCKS_BLOCK" ]; then
  fail "release $RELEASE_TAG body has no '### Migration locks' section"
fi

# Filter to valid `<file>.sql <sha>` rows.
LOCK_ENTRIES="$(printf '%s\n' "$LOCKS_BLOCK" \
  | awk '{
      # Accept "<name>.sql <64hex>" possibly with leading whitespace /
      # markdown bullets (`-`). Tolerate backticks around the filename.
      gsub(/^[[:space:]]*[-*][[:space:]]*/, "", $0);
      gsub(/`/, "", $0);
      if (NF >= 2 && $1 ~ /\.sql$/ && $2 ~ /^[0-9a-fA-F]{64}$/) {
        print $1, tolower($2);
      }
    }')"

if [ -z "$LOCK_ENTRIES" ]; then
  fail "release $RELEASE_TAG '### Migration locks' section has no parseable entries"
fi

# --- compare each entry against the local file ------------------------------
MISMATCH=0
TOTAL=0
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  TOTAL=$((TOTAL + 1))
  filename="${entry%% *}"
  expected="${entry##* }"
  path="$MIGRATIONS_DIR/$filename"

  if [ ! -f "$path" ]; then
    log "MISMATCH: $filename — locked at release but missing in tree ($path)"
    MISMATCH=$((MISMATCH + 1))
    continue
  fi

  actual="$(sha256_of "$path")"
  if [ "$actual" != "$expected" ]; then
    log "MISMATCH: $filename"
    log "  expected: $expected"
    log "  actual:   $actual"
    MISMATCH=$((MISMATCH + 1))
  fi
done <<EOF
$LOCK_ENTRIES
EOF

# --- cross-check locked.ts (if it exists) -----------------------------------
# locked.ts is created by Task #56 (T5.4). It exports a `MIGRATION_LOCKS`
# const mapping filename → sha256. We grep for `"<filename>": "<sha>"` (or
# single-quoted) and assert it matches the release body. Absence is fine.
if [ -f "$LOCKED_TS" ]; then
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    filename="${entry%% *}"
    expected="${entry##* }"
    # Match either `'001_initial.sql': 'hex'` or `"001_initial.sql": "hex"`,
    # with arbitrary whitespace. Quote-style mixing is tolerated.
    if ! grep -Eiq "['\"]${filename}['\"][[:space:]]*:[[:space:]]*['\"]${expected}['\"]" "$LOCKED_TS"; then
      log "MISMATCH: $filename — locked.ts MIGRATION_LOCKS does not match release body"
      log "  expected entry: '$filename': '$expected'"
      MISMATCH=$((MISMATCH + 1))
    fi
  done <<EOF
$LOCK_ENTRIES
EOF
else
  log "note: $LOCKED_TS does not exist yet (Task #56 / T5.4 will land it); skipping locked.ts cross-check"
fi

# --- summary ----------------------------------------------------------------
if [ "$MISMATCH" -gt 0 ]; then
  fail "$MISMATCH of $TOTAL migration lock(s) failed verification"
fi

log "OK: all $TOTAL migration lock(s) verified against release $RELEASE_TAG"
exit 0
