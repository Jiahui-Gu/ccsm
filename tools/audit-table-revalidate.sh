#!/usr/bin/env bash
# tools/audit-table-revalidate.sh
#
# Re-runs the v0.3 daemon-split design "Chapter 15 Zero-Rework Audit" verdicts
# against a PR's touched-file set. Given a PR number (or arbitrary git diff
# range), the script:
#
#   1. Locates the design spec on disk (forever-stable path:
#      docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md, override
#      with SPEC_PATH env var).
#   2. Parses ch15 §1 (locked-decision audit table) and ch15 §2 (derived-design
#      audit table) to extract the set of forever-stable file paths and their
#      audit verdicts. The spec is the SINGLE SOURCE OF TRUTH; this script
#      MUST NOT hardcode the file list (zero-drift contract).
#   3. Parses ch15 §3 (forbidden-pattern checklist) for additional file paths
#      called out as forever-stable per item 11 / 28 / 29 etc.
#   4. Parses ch14 §1.6 / §1.15 REMOVED items so reintroductions are flagged.
#   5. Compares the PR's touched-file set against the forever-stable set.
#      Any touched forever-stable file fails the audit unless the PR body
#      contains an explicit override marker line of the form
#         audit-override: <path> — <reason>
#      (one line per file; reason free-form, must be non-empty).
#
# Exit codes:
#   0  no forever-stable files touched (or all touches explicitly overridden)
#   1  forever-stable files touched without override (audit fails)
#   2  usage / environment error (missing args, missing tools, unreadable spec)
#
# Requires: bash 4+, awk, grep, sed. `gh` only when --pr is used.
#
# This script itself is forever-stable per chapter 15 §3 (mechanical reviewer
# checklist family). Do not change behavior without an audit row.

set -euo pipefail

PROG="$(basename "$0")"

usage() {
    cat <<EOF >&2
Usage:
  $PROG --pr <number>            Audit GitHub PR by number (uses gh CLI)
  $PROG --diff <range>           Audit local git diff range (e.g. origin/working...HEAD)
  $PROG --files <file>...        Audit explicit file list (read from args; "-" reads stdin)

Options:
  --spec <path>                  Override spec path (default: \$SPEC_PATH or
                                 docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md)
  --pr-body-file <path>          Path to a file containing the PR body (override marker source)
                                 when using --diff or --files. Defaults to empty body.
  --no-spec-ok                   Exit 0 with a notice if spec file does not exist
                                 (default behavior; flag retained for explicitness).
  -h, --help                     This message.

Audit override marker (one per line, in PR body):
  audit-override: <path> — <reason>
  (em-dash or "--" both accepted; reason must be non-empty)

Examples:
  $PROG --pr 826
  $PROG --diff origin/working...HEAD
  git diff --name-only origin/working...HEAD | $PROG --files -
EOF
    exit 2
}

die() { echo "$PROG: error: $*" >&2; exit 2; }

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------

MODE=""
PR_NUM=""
DIFF_RANGE=""
FILE_ARGS=()
SPEC_PATH_OPT=""
PR_BODY_FILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pr)         MODE="pr";   PR_NUM="${2:-}"; shift 2 || die "--pr needs a number" ;;
        --diff)       MODE="diff"; DIFF_RANGE="${2:-}"; shift 2 || die "--diff needs a range" ;;
        --files)      MODE="files"; shift; while [[ $# -gt 0 && "$1" != --* ]]; do FILE_ARGS+=("$1"); shift; done ;;
        --spec)       SPEC_PATH_OPT="${2:-}"; shift 2 || die "--spec needs a path" ;;
        --pr-body-file) PR_BODY_FILE="${2:-}"; shift 2 || die "--pr-body-file needs a path" ;;
        --no-spec-ok) shift ;;
        -h|--help)    usage ;;
        *)            die "unknown arg: $1 (try --help)" ;;
    esac
done

[[ -z "$MODE" ]] && usage

# -----------------------------------------------------------------------------
# Locate spec
# -----------------------------------------------------------------------------

DEFAULT_SPEC="docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md"
SPEC="${SPEC_PATH_OPT:-${SPEC_PATH:-$DEFAULT_SPEC}}"

if [[ ! -f "$SPEC" ]]; then
    # Walk up to find a repo root that contains the spec (for callers that
    # invoke us from any cwd).
    found=""
    d="$(pwd)"
    while [[ "$d" != "/" && "$d" != "" ]]; do
        if [[ -f "$d/$DEFAULT_SPEC" ]]; then
            found="$d/$DEFAULT_SPEC"
            break
        fi
        d="$(dirname "$d")"
    done
    if [[ -n "$found" ]]; then
        SPEC="$found"
    else
        echo "$PROG: notice: spec not found at '$SPEC' — script is a no-op until the v0.3 daemon-split-design spec lands on this branch. Exiting 0." >&2
        exit 0
    fi
fi

# -----------------------------------------------------------------------------
# Collect touched files
# -----------------------------------------------------------------------------

TOUCHED=()
PR_BODY=""

case "$MODE" in
    pr)
        [[ -z "$PR_NUM" ]] && die "--pr requires a number"
        command -v gh >/dev/null 2>&1 || die "gh CLI not on PATH (required for --pr)"
        # name-only diff
        while IFS= read -r line; do
            [[ -n "$line" ]] && TOUCHED+=("$line")
        done < <(gh pr diff "$PR_NUM" --name-only)
        PR_BODY="$(gh pr view "$PR_NUM" --json body --jq .body 2>/dev/null || true)"
        ;;
    diff)
        [[ -z "$DIFF_RANGE" ]] && die "--diff requires a range"
        while IFS= read -r line; do
            [[ -n "$line" ]] && TOUCHED+=("$line")
        done < <(git diff --name-only "$DIFF_RANGE")
        if [[ -n "$PR_BODY_FILE" && -f "$PR_BODY_FILE" ]]; then
            PR_BODY="$(cat "$PR_BODY_FILE")"
        fi
        ;;
    files)
        if [[ ${#FILE_ARGS[@]} -eq 1 && "${FILE_ARGS[0]}" == "-" ]]; then
            while IFS= read -r line; do
                [[ -n "$line" ]] && TOUCHED+=("$line")
            done
        else
            for f in "${FILE_ARGS[@]}"; do
                [[ -n "$f" ]] && TOUCHED+=("$f")
            done
        fi
        if [[ -n "$PR_BODY_FILE" && -f "$PR_BODY_FILE" ]]; then
            PR_BODY="$(cat "$PR_BODY_FILE")"
        fi
        ;;
esac

if [[ ${#TOUCHED[@]} -eq 0 ]]; then
    echo "$PROG: notice: empty diff — nothing to audit." >&2
    exit 0
fi

# -----------------------------------------------------------------------------
# Parse spec — extract forever-stable file paths from ch15 §1 / §2 / §3
# -----------------------------------------------------------------------------
#
# Heuristics:
#   - We restrict scanning to chapter 15 (single source of truth for the
#     audit). Chapter boundary detection: line matches '^## Chapter 15' to
#     '^## Chapter 1[6-9]' or EOF.
#   - Within ch15 we extract every backtick-quoted token whose shape looks
#     like a repository file path. A token qualifies if it has NO whitespace,
#     contains either a known top-level segment (packages/, tools/, docs/,
#     native/, scripts/, src/, build/, electron/, tests/) followed by '/',
#     OR a known subpath fragment (db/, daemon/, proto/, pty/, supervisor/,
#     state-dir/, listeners/) followed by something ending in a tracked
#     extension, AND ends with a known file extension
#     (.ts .tsx .js .mjs .cjs .sh .json .sql .md .yml .yaml .bin .ndjson
#     .ps1 .wxs .schema.json), AND contains no glob/brace expansion
#     metacharacters (*, {, }, ?). Bare-filename mentions (e.g.
#     `001_initial.sql`) are also captured — they match by basename.
#
# This intentionally errs on the side of inclusion — false positives are
# benign (they only fire if a PR touches a path whose basename collides
# with a spec mention, in which case the override marker is cheap), but
# false negatives would silently skip an audit row, so we prefer to flag.

TMPDIR_LOCAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT

CH15="$TMPDIR_LOCAL/ch15.md"
CH14="$TMPDIR_LOCAL/ch14.md"
PATHS_FILE="$TMPDIR_LOCAL/paths.txt"
REMOVED_FILE="$TMPDIR_LOCAL/removed.txt"

awk '
    /^## Chapter 15/ { inside=1; next }
    /^## Chapter 1[6-9]|^## Chapter [2-9][0-9]/ { inside=0 }
    inside { print }
' "$SPEC" > "$CH15"

awk '
    /^## Chapter 14/ { inside=1; next }
    /^## Chapter 15/ { inside=0 }
    inside { print }
' "$SPEC" > "$CH14"

if [[ ! -s "$CH15" ]]; then
    die "could not extract Chapter 15 from spec '$SPEC' (heading '## Chapter 15' not found)"
fi

# Extract backtick spans. -o for only-matching, -h to suppress filenames.
# Then strip leading/trailing backticks.
extract_paths() {
    local src="$1"
    grep -oE '`[^`]+`' "$src" \
      | sed -e 's/^`//' -e 's/`$//' \
      | awk '
        # Reject empty
        NF == 0 { next }
        # Reject globs / brace expansions / spaces
        /\*|\{|\}|\?| / { next }
        # Reject leading-slash absolute (URLs, sock paths, HTTP routes)
        /^\// { next }
        # Reject scoped npm specs like @ccsm/proto (no extension, not a path)
        /^@/ { next }
        # Reject identifiers that look like API symbols (CamelCase.member or
        # service{...} fragments) — those are filtered above by the brace rule
        # but also reject things containing "::" or "()" or "<".
        /\(|\)|<|>|=|;|::|"/ { next }
        {
            tok = $0
            # Must contain a known file extension at end OR be a bare filename
            # mentioned in spec context.
            if (tok ~ /\.(ts|tsx|js|mjs|cjs|sh|json|sql|md|yml|yaml|bin|ndjson|ps1|wxs)$/) {
                # Also require a "/" if it has any path segment, OR allow bare
                # basename (no slash) — both are valid spec mentions.
                print tok
                next
            }
            # Allow bare directory references that end with "/" (e.g. tools/spike-harness/)
            # but require at least 2 path segments — top-level dirs like
            # "packages/" or "native/" are too coarse to be useful (every PR
            # under that subtree would trigger them).
            if (tok ~ /\/$/ && tok ~ /^(packages|tools|docs|native|scripts|src|build|electron|tests|db|daemon|proto|pty|supervisor)\/[^\/]+\/$/) {
                print tok
                next
            }
            # Allow extensionless dotfiles under a known top-level dir
            # (e.g. tools/.no-ipc-allowlist, packages/electron/.no-ipc-allowlist).
            # These are config files explicitly named in spec (ch15 §3 #29) and
            # have no extension to anchor the previous rule.
            if (tok ~ /^(packages|tools|docs|native|scripts|src|build|electron|tests)\/([^\/]+\/)*\.[A-Za-z0-9_][A-Za-z0-9._-]*$/) {
                print tok
                next
            }
        }
      ' \
      | sort -u
}

extract_paths "$CH15" > "$PATHS_FILE"

# REMOVED items from chapter 14 — pull paragraphs mentioning REMOVED, capture
# any backtick tokens. Used for the reintroduction warning. Also scan heading
# lines (e.g. `##### 1.15 [watchdog-darwin-approach] — REMOVED from ...`) and
# extract the bracketed identifier so headings without backticked tokens still
# fire the reintroduction warning.
if [[ -s "$CH14" ]]; then
    {
        awk '/REMOVED/ {print; for (i=0;i<3;i++){ if ((getline line) > 0) print line; else break } }' "$CH14" \
          | grep -oE '`[^`]+`' \
          | sed -e 's/^`//' -e 's/`$//'
        # Heading-line bracketed identifiers on REMOVED lines
        awk '/^#+ .*REMOVED/ {
            s = $0
            while (match(s, /\[[^]]+\]/)) {
                tok = substr(s, RSTART+1, RLENGTH-2)
                # skip markdown link anchors like [Chapter 14]
                if (tok !~ /^[Cc]hapter / && tok != "" ) print tok
                s = substr(s, RSTART+RLENGTH)
            }
        }' "$CH14"
    } | sort -u > "$REMOVED_FILE"
else
    : > "$REMOVED_FILE"
fi

if [[ ! -s "$PATHS_FILE" ]]; then
    die "spec parsed but no forever-stable file paths extracted from ch15 — parser may be out of sync with spec format. Inspect '$CH15' and update $PROG."
fi

# -----------------------------------------------------------------------------
# Match touched files against forever-stable set
# -----------------------------------------------------------------------------
#
# A touched file matches a spec entry if:
#   (a) the touched path equals the spec entry, OR
#   (b) the touched path ends with "/<spec entry>" (handles spec entries that
#       are basename-only like "001_initial.sql" or "listener-a.json"), OR
#   (c) the spec entry ends with "/" and the touched path starts with the spec
#       entry (directory match).
#
# For each match we record the spec entry; the verdict text is recovered by
# grepping ch15 for the line containing the entry and printing surrounding
# context.

VIOLATIONS_FILE="$TMPDIR_LOCAL/violations.txt"
: > "$VIOLATIONS_FILE"

# Read spec paths into an array (bash 4+).
mapfile -t SPEC_PATHS < "$PATHS_FILE"

for tf in "${TOUCHED[@]}"; do
    # Normalize to forward slashes
    nf="${tf//\\//}"
    for sp in "${SPEC_PATHS[@]}"; do
        match=0
        if [[ "$nf" == "$sp" ]]; then
            match=1
        elif [[ "$sp" != */ && "$sp" != */* && "$nf" == */"$sp" ]]; then
            # bare basename spec entry
            match=1
        elif [[ "$sp" == */ && "$nf" == "$sp"* ]]; then
            match=1
        fi
        if [[ $match -eq 1 ]]; then
            printf '%s\t%s\n' "$nf" "$sp" >> "$VIOLATIONS_FILE"
        fi
    done
done

# Also check REMOVED items for re-introduction patterns. We don't fail on
# these — they emit a warning and (if no override) escalate to a fail.
REINTRO_FILE="$TMPDIR_LOCAL/reintro.txt"
: > "$REINTRO_FILE"
if [[ -s "$REMOVED_FILE" ]]; then
    while IFS= read -r removed_tok; do
        for tf in "${TOUCHED[@]}"; do
            nf="${tf//\\//}"
            if [[ "$nf" == *"$removed_tok"* ]]; then
                printf '%s\t%s\n' "$nf" "$removed_tok" >> "$REINTRO_FILE"
            fi
        done
    done < "$REMOVED_FILE"
fi

# -----------------------------------------------------------------------------
# Parse PR body for override markers
# -----------------------------------------------------------------------------
#
# Format (one per line):
#   audit-override: <path> — <reason>
#   audit-override: <path> -- <reason>
#
# We accept either em-dash (U+2014) or "--" as the separator, with optional
# surrounding whitespace. The path must match exactly the touched file path
# (forward slashes).

OVERRIDE_FILE="$TMPDIR_LOCAL/overrides.txt"
: > "$OVERRIDE_FILE"
if [[ -n "$PR_BODY" ]]; then
    # Use awk to extract overrides.
    printf '%s\n' "$PR_BODY" | awk '
        /^[[:space:]]*audit-override:[[:space:]]*/ {
            sub(/^[[:space:]]*audit-override:[[:space:]]*/, "")
            # Split on em-dash (U+2014, UTF-8 e2 80 94) or " -- "
            n = index($0, "\xe2\x80\x94")
            if (n == 0) {
                n = index($0, " -- ")
                if (n > 0) { sep_len = 4 } else { sep_len = 0 }
            } else {
                sep_len = 3
            }
            if (n == 0) next
            path = substr($0, 1, n-1)
            reason = substr($0, n+sep_len)
            # trim
            sub(/[[:space:]]+$/, "", path); sub(/^[[:space:]]+/, "", path)
            sub(/[[:space:]]+$/, "", reason); sub(/^[[:space:]]+/, "", reason)
            if (path == "" || reason == "") next
            printf "%s\t%s\n", path, reason
        }
    ' > "$OVERRIDE_FILE"
fi

# -----------------------------------------------------------------------------
# Report
# -----------------------------------------------------------------------------

verdict_for() {
    local entry="$1"
    # Find first line in ch15 mentioning the entry, return a short context.
    grep -nF "\`$entry\`" "$CH15" 2>/dev/null \
      | head -1 \
      | sed 's/^[0-9]*://'  \
      | awk '{
            # collapse whitespace
            gsub(/[[:space:]]+/, " ")
            if (length($0) > 240) $0 = substr($0, 1, 237) "..."
            print $0
        }'
}

is_overridden() {
    local f="$1"
    grep -qE "^${f//\//\\/}"$'\t' "$OVERRIDE_FILE" 2>/dev/null
}

unresolved=0
echo
echo "=== audit-table-revalidate report ==="
echo "spec:           $SPEC"
echo "mode:           $MODE"
echo "touched files:  ${#TOUCHED[@]}"
echo "spec entries:   ${#SPEC_PATHS[@]} forever-stable paths"
echo

if [[ -s "$VIOLATIONS_FILE" ]]; then
    echo "--- forever-stable file touches ---"
    # Deduplicate by touched-file path; collect spec entries per file.
    awk -F '\t' '
        { e[$1] = (e[$1] ? e[$1] ", " $2 : $2) }
        END { for (k in e) print k "\t" e[k] }
    ' "$VIOLATIONS_FILE" | sort | while IFS=$'\t' read -r tf entries; do
        if is_overridden "$tf"; then
            status="OVERRIDDEN"
        else
            status="BLOCK"
            unresolved=1
            echo "$tf" >> "$TMPDIR_LOCAL/unresolved.txt"
        fi
        printf '  [%s] %s\n' "$status" "$tf"
        printf '           spec entry: %s\n' "$entries"
        # First entry's verdict for context
        first_entry="${entries%%, *}"
        verdict="$(verdict_for "$first_entry")"
        if [[ -n "$verdict" ]]; then
            printf '           verdict ctx: %s\n' "$verdict"
        fi
    done
    echo
fi

if [[ -s "$REINTRO_FILE" ]]; then
    echo "--- ch14 REMOVED-item reintroduction warnings ---"
    sort -u "$REINTRO_FILE" | while IFS=$'\t' read -r tf tok; do
        if is_overridden "$tf"; then
            status="OVERRIDDEN"
        else
            status="WARN"
            # Reintroduction without override is also a block.
            echo "$tf" >> "$TMPDIR_LOCAL/unresolved.txt"
        fi
        printf '  [%s] %s touches REMOVED-item token `%s`\n' "$status" "$tf" "$tok"
    done
    echo
fi

if [[ -f "$TMPDIR_LOCAL/unresolved.txt" && -s "$TMPDIR_LOCAL/unresolved.txt" ]]; then
    echo "FAIL: forever-stable files touched without override marker." >&2
    echo >&2
    echo "To override (only when re-spec sign-off says so), add lines to PR body:" >&2
    sort -u "$TMPDIR_LOCAL/unresolved.txt" | while IFS= read -r f; do
        echo "  audit-override: $f -- <reason: cite ch15 audit row + reviewer name>" >&2
    done
    exit 1
fi

if [[ ! -s "$VIOLATIONS_FILE" && ! -s "$REINTRO_FILE" ]]; then
    echo "PASS: no forever-stable files touched."
fi

exit 0
