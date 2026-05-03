#!/usr/bin/env bash
#
# tools/dogfood-window-check.sh — phase 12 (v0.3 ship gate M5).
#
# Measures the "no architectural regression PRs" rule from
# docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
# Chapter 13 §2 phase 12:
#
#   In the 7-day dogfood window, a PR is an "architectural regression" iff
#   it carries the `architecture-regression` GitHub label OR it modifies any
#   file under the v0.3 forever-stable list (chapter 15 §3 forbidden-patterns):
#     - packages/proto/**/*.proto                         (semantic edits)
#     - packages/daemon/src/listener/**
#     - packages/daemon/src/principal/**
#     - packages/daemon/src/db/migrations/001_initial.sql
#
# This script greps merged PRs in the window via
# `gh pr list --state merged --search "merged:>=<date>"`, asserts label
# absence, and asserts no diff touches the forbidden-file list. Any hit
# fails phase 12.
#
# Usage:
#   tools/dogfood-window-check.sh <since>           # 7-day default window end = now
#   tools/dogfood-window-check.sh <since> --days N  # explicit window length (still ends at "now")
#
#   <since> is one of:
#     - a git SHA (commit-time of that SHA becomes the window start)
#     - an ISO-8601 date or datetime ("2026-05-03" or "2026-05-03T12:00:00Z")
#
# Override marker (one per line, in --override-file):
#   dogfood-allow: <PR#> -- <reason: cite ch15 audit row + reviewer name>
# Each marker exempts a single PR number from the architectural-regression
# block. Reason must be non-empty.
#
# Exit codes:
#   0  no architectural-regression PRs in the window (or all flagged ones
#      explicitly overridden)
#   1  one or more architectural-regression PRs without override (M5 fails)
#   2  usage / environment error (missing args, missing tools, gh auth missing)
#
# Requires: bash 4+, gh (authenticated), git, awk, sed, grep. The script does
# NOT require a standalone `jq` binary — all JSON shaping uses `gh ... --jq`,
# which ships built-in with the gh CLI (gojq). This keeps the script runnable
# on Windows Git Bash and minimal CI images.
#
# Cross-references:
#   - chapter 13 §2 phase 12     — done-criteria this script enforces
#   - chapter 13 §5 milestone M5 — calls this script by name
#   - chapter 15 §3              — forbidden-pattern list referenced here
#
# This script's behaviour is forever-stable for the v0.3 ship window;
# additions to the forbidden list require an R4 sign-off + chapter-15 audit row,
# matching the audit-table-revalidate.sh contract.

set -euo pipefail

PROG="$(basename "$0")"

usage() {
    cat <<EOF >&2
Usage:
  $PROG <since> [--days N] [--repo OWNER/REPO] [--override-file PATH]

Arguments:
  <since>                       Window start. Either:
                                  - git SHA  (commit time = start)
                                  - ISO date ("2026-05-03" or
                                    "2026-05-03T12:00:00Z")

Options:
  --days N                      Window length in days (default 7). The window
                                always ends at "now"; --days only documents
                                the expected length and is also encoded into
                                the report header.
  --repo OWNER/REPO             GitHub repo (default: derived from
                                \`gh repo view\` in the cwd).
  --override-file PATH          File containing PR-level override markers
                                (\`dogfood-allow: <PR#> -- <reason>\`),
                                one per line. Defaults to none; the current
                                PR body is NOT auto-fetched (dogfood window
                                straddles many PRs, no single PR body to
                                read).
  -h, --help                    This message.

Examples:
  # window starts at the commit that tagged ship-candidate
  $PROG \$(git rev-parse v0.3-rc.1)

  # explicit 7-day window from a date
  $PROG 2026-05-03 --days 7

  # with overrides (e.g., reviewer-approved exception in PR #999)
  $PROG 2026-05-03 --override-file /tmp/dogfood-overrides.txt
EOF
    exit 2
}

die() { echo "$PROG: error: $*" >&2; exit 2; }

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------

SINCE_ARG=""
DAYS=7
REPO=""
OVERRIDE_FILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --days)            DAYS="${2:-}"; shift 2 || die "--days needs a number" ;;
        --repo)            REPO="${2:-}"; shift 2 || die "--repo needs OWNER/REPO" ;;
        --override-file)   OVERRIDE_FILE="${2:-}"; shift 2 || die "--override-file needs a path" ;;
        -h|--help)         usage ;;
        --*)               die "unknown flag: $1 (try --help)" ;;
        *)
            if [[ -z "$SINCE_ARG" ]]; then
                SINCE_ARG="$1"
                shift
            else
                die "unexpected positional arg: $1 (only one <since> allowed)"
            fi
            ;;
    esac
done

[[ -z "$SINCE_ARG" ]] && usage

[[ "$DAYS" =~ ^[0-9]+$ ]] || die "--days must be a positive integer (got '$DAYS')"

command -v gh  >/dev/null 2>&1 || die "gh CLI not on PATH"
command -v git >/dev/null 2>&1 || die "git not on PATH"

# -----------------------------------------------------------------------------
# Resolve <since> to an ISO date string accepted by GitHub search
# -----------------------------------------------------------------------------
# GitHub's `merged:>=<value>` accepts a date (YYYY-MM-DD) or a full
# ISO-8601 timestamp. We normalize to a full timestamp when we can derive one
# (SHA path); otherwise we pass the user-supplied date through verbatim.

SINCE_ISO=""
if git rev-parse --verify --quiet "${SINCE_ARG}^{commit}" >/dev/null 2>&1; then
    # Treat as SHA; commit time becomes the window start.
    SINCE_ISO="$(git show -s --format=%cI "$SINCE_ARG")"
elif [[ "$SINCE_ARG" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2}([+-][0-9]{2}:?[0-9]{2}|Z)?)?$ ]]; then
    SINCE_ISO="$SINCE_ARG"
else
    die "<since> must be a git SHA on this clone or an ISO date/datetime (got '$SINCE_ARG')"
fi

# -----------------------------------------------------------------------------
# Resolve repo
# -----------------------------------------------------------------------------

if [[ -z "$REPO" ]]; then
    REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
    [[ -z "$REPO" ]] && die "could not derive repo via 'gh repo view'; pass --repo OWNER/REPO"
fi

# -----------------------------------------------------------------------------
# Forever-stable forbidden-file list (chapter 13 §2 phase 12 verbatim).
# -----------------------------------------------------------------------------
# Each entry is a glob-style pattern matched against `gh pr diff --name-only`
# output. Matching rules (intentionally simple, mirroring spec wording):
#
#   - "<dir>/**" matches any path that begins with "<dir>/"
#   - "<dir>/**/*.<ext>" matches any path under "<dir>/" with that extension
#   - exact-path entries match by string equality
#
# "Semantic edits" of .proto files are not mechanically detectable, so we
# flag ANY .proto touch under packages/proto/ (false-positive cost is the
# cheap dogfood-allow override; false-negative cost is shipping a wire
# regression undetected). Same err-on-the-side-of-flag philosophy as
# tools/audit-table-revalidate.sh.

FORBIDDEN_PATTERNS=(
    'packages/proto/**/*.proto'
    'packages/daemon/src/listener/**'
    'packages/daemon/src/principal/**'
    'packages/daemon/src/db/migrations/001_initial.sql'
)

# Returns 0 if path matches any forbidden pattern, else 1. Echoes the matched
# pattern on success.
match_forbidden() {
    local path="$1"
    local p
    for p in "${FORBIDDEN_PATTERNS[@]}"; do
        case "$p" in
            *'/**/*.'*)
                local dir="${p%%/\*\**}"
                local ext="${p##*.}"
                if [[ "$path" == "$dir"/* && "$path" == *".$ext" ]]; then
                    echo "$p"
                    return 0
                fi
                ;;
            *'/**')
                local dir="${p%/\*\*}"
                if [[ "$path" == "$dir"/* ]]; then
                    echo "$p"
                    return 0
                fi
                ;;
            *)
                if [[ "$path" == "$p" ]]; then
                    echo "$p"
                    return 0
                fi
                ;;
        esac
    done
    return 1
}

# -----------------------------------------------------------------------------
# Parse override file
# -----------------------------------------------------------------------------

declare -A OVERRIDES=()
if [[ -n "$OVERRIDE_FILE" ]]; then
    [[ -f "$OVERRIDE_FILE" ]] || die "--override-file '$OVERRIDE_FILE' not readable"
    while IFS= read -r line; do
        # match: dogfood-allow: <PR#> -- <reason>  (em-dash also accepted)
        local_line="$line"
        # Strip CR
        local_line="${local_line%$'\r'}"
        case "$local_line" in
            *dogfood-allow:*) ;;
            *) continue ;;
        esac
        # Trim leading prefix
        rest="${local_line#*dogfood-allow:}"
        # Trim leading whitespace
        rest="${rest#"${rest%%[![:space:]]*}"}"
        # Split on " -- " or em-dash
        sep=""
        if [[ "$rest" == *" -- "* ]]; then
            sep=" -- "
        elif [[ "$rest" == *$'\xe2\x80\x94'* ]]; then
            sep=$'\xe2\x80\x94'
        else
            continue
        fi
        prnum="${rest%%${sep}*}"
        reason="${rest#*${sep}}"
        # trim
        prnum="${prnum#"${prnum%%[![:space:]]*}"}"
        prnum="${prnum%"${prnum##*[![:space:]]}"}"
        reason="${reason#"${reason%%[![:space:]]*}"}"
        reason="${reason%"${reason##*[![:space:]]}"}"
        # strip leading '#'
        prnum="${prnum#\#}"
        [[ "$prnum" =~ ^[0-9]+$ ]] || continue
        [[ -z "$reason" ]] && continue
        OVERRIDES["$prnum"]="$reason"
    done < "$OVERRIDE_FILE"
fi

# -----------------------------------------------------------------------------
# Fetch merged PRs in window
# -----------------------------------------------------------------------------

echo
echo "=== dogfood-window-check report ==="
echo "spec:           docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md ch13 §2 phase 12"
echo "repo:           $REPO"
echo "since:          $SINCE_ISO  (from arg: $SINCE_ARG)"
echo "expected days:  $DAYS"
echo "overrides:      ${#OVERRIDES[@]}"
echo

TMPDIR_LOCAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT

PR_TSV="$TMPDIR_LOCAL/prs.tsv"

# `gh pr list` requires --search containing the merged: qualifier. We also
# pass --state merged for clarity (search alone would suffice). We use Go
# `--template` (built into gh) so we do NOT need a standalone jq binary.
# Output format per line: number|mergedAt|url|label1,label2,|title
# (labels suffixed with "," for trivial trailing-empty parse; pipe is the
# field separator since '|' is forbidden in PR titles by GitHub UI rules
# only loosely — we still defend by URL-encoding nothing and treating only
# the first 4 pipes as separators below.)
gh pr list \
    --repo "$REPO" \
    --state merged \
    --search "merged:>=$SINCE_ISO" \
    --limit 1000 \
    --json number,title,url,mergedAt,labels \
    --template '{{range .}}{{.number}}|{{.mergedAt}}|{{.url}}|{{range .labels}}{{.name}},{{end}}|{{.title}}{{"\n"}}{{end}}' \
    > "$PR_TSV" \
    || die "gh pr list failed (auth ok? rate limit?)"

PR_COUNT="$(awk 'NF{c++} END{print c+0}' "$PR_TSV")"
echo "merged PRs in window: $PR_COUNT"
echo

if [[ "$PR_COUNT" == "0" ]]; then
    echo "PASS: no merged PRs in window — nothing to check."
    exit 0
fi

# -----------------------------------------------------------------------------
# Iterate, classify
# -----------------------------------------------------------------------------

VIOLATIONS_FILE="$TMPDIR_LOCAL/violations.txt"
: > "$VIOLATIONS_FILE"

while IFS='|' read -r num merged_at url labels_csv title; do
    [[ -z "$num" ]] && continue

    reasons=()

    # Label check — labels_csv is "label1,label2," (trailing comma kept by
    # the Go template; we tolerate it via the trailing-empty splitter below).
    if [[ ",$labels_csv" == *",architecture-regression,"* ]]; then
        reasons+=("label: architecture-regression")
    fi

    # File-touch check — fetch diff name-only
    diff_files="$(gh pr diff --repo "$REPO" "$num" --name-only 2>/dev/null || true)"
    if [[ -n "$diff_files" ]]; then
        while IFS= read -r f; do
            [[ -z "$f" ]] && continue
            # Normalize backslashes (Windows runners)
            nf="${f//\\//}"
            if matched="$(match_forbidden "$nf")"; then
                reasons+=("file: $nf  (pattern: $matched)")
            fi
        done <<< "$diff_files"
    fi

    if [[ ${#reasons[@]} -gt 0 ]]; then
        {
            printf 'PR #%s\t%s\t%s\t%s\n' "$num" "$merged_at" "$url" "$title"
            for r in "${reasons[@]}"; do
                printf '  - %s\n' "$r"
            done
        } >> "$VIOLATIONS_FILE"
    fi
done < "$PR_TSV"

# -----------------------------------------------------------------------------
# Report
# -----------------------------------------------------------------------------

if [[ ! -s "$VIOLATIONS_FILE" ]]; then
    echo "PASS: zero architectural-regression PRs across $PR_COUNT merged PRs."
    exit 0
fi

echo "--- architectural-regression candidates ---"
unresolved=0

# Process violations file: each entry begins with "PR #N\t..." line followed
# by indented reason lines. Walk it record by record.
current_pr=""
current_block=""
flush_block() {
    local pr="$1"
    local block="$2"
    [[ -z "$pr" ]] && return
    if [[ -n "${OVERRIDES[$pr]:-}" ]]; then
        echo "[OVERRIDDEN] $block       reason: ${OVERRIDES[$pr]}"
    else
        echo "[BLOCK]      $block"
        unresolved=1
    fi
}

while IFS= read -r line; do
    if [[ "$line" =~ ^PR\ \#([0-9]+) ]]; then
        flush_block "$current_pr" "$current_block"
        current_pr="${BASH_REMATCH[1]}"
        current_block="$line"$'\n'
    else
        current_block+="$line"$'\n'
    fi
done < "$VIOLATIONS_FILE"
flush_block "$current_pr" "$current_block"

echo
if [[ "$unresolved" -eq 1 ]]; then
    echo "FAIL: one or more architectural-regression PRs without dogfood-allow override." >&2
    echo >&2
    echo "Phase 12 (chapter 13 §2) requires zero architectural regressions during the dogfood window." >&2
    echo "If a flagged PR is genuinely additive (e.g. proto field added, no semantic change)," >&2
    echo "add an override line to the file passed via --override-file:" >&2
    echo "  dogfood-allow: <PR#> -- <reason: cite ch15 audit row + reviewer name>" >&2
    exit 1
fi

echo "PASS: all flagged PRs explicitly overridden."
exit 0
