#!/usr/bin/env bash
# tools/check-migration-additivity.sh
#
# Enforces ch15 §3 #13: NOT NULL column on existing table requires DEFAULT.
#
# FOREVER-STABLE per docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
# chapter 15 §3 item #13. v0.3 ships `001_initial.sql` as the immutable baseline
# (locked by tools/check-migration-locks.sh). v0.4+ migrations land additively
# as `00[2-9]_*.sql` (and onward). Any post-baseline migration that adds a
# `NOT NULL` column to an existing table WITHOUT a `DEFAULT` clause would
# break upgrades for users with existing rows — sqlite cannot back-fill a
# value, and the migration would abort mid-flight.
#
# What it does:
#   1. Scan packages/daemon/src/db/migrations/00[2-9]_*.sql (v0.4+ migrations).
#      `001_*.sql` is the v0.3 baseline and is exempt — it is locked separately
#      by tools/check-migration-locks.sh and has no pre-existing rows to back-
#      fill against.
#   2. Normalize each file: strip line comments (`-- ...`) and block comments
#      (`/* ... */`), collapse all whitespace runs to a single space.
#   3. Split on `;` to get individual statements.
#   4. For each `ALTER TABLE ... ADD COLUMN ...` statement, assert that if the
#      column is `NOT NULL`, it also has a `DEFAULT` clause. New tables
#      (`CREATE TABLE`) are exempt because they have no pre-existing rows to
#      back-fill — `NOT NULL` without `DEFAULT` is fine on a brand-new table.
#
# Compatibility: bash 3.2+, POSIX grep + sed + awk. Runs on Linux/macOS GHA
# runners and Git Bash on Windows. No new npm deps, no SQL parser dep —
# regex on normalized SQL is sufficient for the simple `ADD COLUMN` shape
# the spec produces.
#
# Override for fixture testing: set `MIGRATIONS_DIR` env var to point at a
# fixture directory to validate the script's own logic.

set -euo pipefail

MIGRATIONS_DIR="${MIGRATIONS_DIR:-packages/daemon/src/db/migrations}"

log() { printf '[check-migration-additivity] %s\n' "$*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

if [ ! -d "$MIGRATIONS_DIR" ]; then
  fail "migrations dir not found: $MIGRATIONS_DIR"
fi

# Glob 002_*.sql through 009_*.sql. v0.3 baseline (001_*.sql) is exempt.
# `nullglob`-style behavior via a guard: if no matches, the literal pattern
# survives and we skip the loop.
shopt -s nullglob 2>/dev/null || true

VIOLATIONS=0
SCANNED=0

for sql_file in "$MIGRATIONS_DIR"/00[2-9]_*.sql; do
  [ -f "$sql_file" ] || continue
  SCANNED=$((SCANNED + 1))

  # Normalize:
  #   - strip /* ... */ block comments (greedy across lines via tr to single line first)
  #   - strip -- line comments
  #   - collapse all whitespace (incl newlines) to a single space
  normalized="$(
    sed -e 's:/\*[^*]*\*\+\([^/*][^*]*\*\+\)*/::g' "$sql_file" \
      | sed -e 's/--[^\n]*$//' \
      | tr '\n' ' ' \
      | tr -s '[:space:]' ' '
  )"

  # Split on `;` and inspect each statement.
  # Use awk to emit one statement per line so we can grep ALTER TABLE rows.
  while IFS= read -r stmt; do
    # Trim leading/trailing whitespace
    stmt="$(printf '%s' "$stmt" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -z "$stmt" ] && continue

    # Only ALTER TABLE ... ADD COLUMN statements are constrained. CREATE TABLE
    # is exempt (new table = no pre-existing rows to back-fill). Match case-
    # insensitively against the normalized form.
    upper="$(printf '%s' "$stmt" | tr '[:lower:]' '[:upper:]')"
    case "$upper" in
      *"ALTER TABLE"*"ADD COLUMN"*|*"ALTER TABLE"*"ADD "*)
        # Continue to NOT NULL / DEFAULT check below.
        ;;
      *)
        continue
        ;;
    esac

    # Check NOT NULL presence.
    case "$upper" in
      *"NOT NULL"*) ;;
      *) continue ;;
    esac

    # NOT NULL is present — assert DEFAULT is also present in the same statement.
    case "$upper" in
      *"DEFAULT"*)
        # OK — has DEFAULT.
        ;;
      *)
        log "VIOLATION in $sql_file:"
        log "  statement: $stmt"
        log "  reason: ADD COLUMN with NOT NULL but no DEFAULT — would break upgrade for existing rows"
        VIOLATIONS=$((VIOLATIONS + 1))
        ;;
    esac
  done <<EOF
$(printf '%s' "$normalized" | awk 'BEGIN{RS=";"} {print}')
EOF
done

if [ "$VIOLATIONS" -gt 0 ]; then
  fail "$VIOLATIONS NOT NULL-without-DEFAULT violation(s) across $SCANNED migration file(s)"
fi

log "OK: scanned $SCANNED migration file(s) under $MIGRATIONS_DIR (no 00[2-9]_*.sql violations)"
exit 0
