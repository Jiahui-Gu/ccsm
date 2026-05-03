#!/usr/bin/env bash
# tools/check-v02-shrinking.sh — Wave 2 §5.6 mechanical guard (Task #222)
#
# For each path/glob listed in .v0.2-only-files, compare current line count
# (HEAD) against the merge-base with origin/main (or $GITHUB_BASE_REF when
# running in CI). Fails if any listed file/glob has GROWN.
#
# Semantics:
#   - missing-at-head + present-at-base → OK (file moved/deleted).
#   - missing-at-base + present-at-head → treated as base=0, so any growth
#     fails. If you legitimately added a brand-new v0.2-only file, that
#     means you should NOT have added it; either delete it or remove its
#     line from .v0.2-only-files.
#   - missing in both → silent skip.
#   - glob: sum line counts across all currently-matching files vs sum
#     across base-matching files (uses `git ls-tree` on the base sha to
#     enumerate base-side matches).

set -u

# POSIX-bash; works on Linux, macOS, Git Bash on Windows.

LIST_FILE=".v0.2-only-files"

if [ ! -f "$LIST_FILE" ]; then
  echo "check-v02-shrinking: no $LIST_FILE found at repo root, skipping" >&2
  exit 0
fi

# Resolve base sha. Prefer GITHUB_BASE_REF in CI; fall back to merge-base
# with origin/main locally. If neither resolves, fall back to HEAD~1 with a
# warning (not fatal — this script is best-effort on shallow checkouts).
base_sha=""
if [ -n "${GITHUB_BASE_REF:-}" ]; then
  # GITHUB_BASE_REF is the target branch name (e.g. "working"). Need the
  # remote ref so we get the actual sha.
  if git rev-parse --verify "origin/${GITHUB_BASE_REF}" >/dev/null 2>&1; then
    base_sha=$(git merge-base HEAD "origin/${GITHUB_BASE_REF}" 2>/dev/null || true)
  fi
fi
if [ -z "$base_sha" ]; then
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    base_sha=$(git merge-base HEAD origin/main 2>/dev/null || true)
  fi
fi
if [ -z "$base_sha" ]; then
  if git rev-parse --verify origin/working >/dev/null 2>&1; then
    base_sha=$(git merge-base HEAD origin/working 2>/dev/null || true)
  fi
fi
if [ -z "$base_sha" ]; then
  echo "check-v02-shrinking: cannot resolve base sha (no GITHUB_BASE_REF, no origin/main, no origin/working). Skipping." >&2
  exit 0
fi

echo "check-v02-shrinking: base = $base_sha"
echo

# count_head <pattern> → echoes total line count for currently-matching files
count_head() {
  pattern="$1"
  total=0
  # Use shell glob expansion. If no match, the pattern stays literal — we
  # detect that by checking if the literal exists as a file.
  # shellcheck disable=SC2086
  set -- $pattern
  if [ "$#" -eq 1 ] && [ "$1" = "$pattern" ] && [ ! -e "$1" ]; then
    echo 0
    return
  fi
  for f in "$@"; do
    if [ -f "$f" ]; then
      n=$(wc -l < "$f" 2>/dev/null || echo 0)
      total=$((total + n))
    fi
  done
  echo "$total"
}

# count_base <pattern> → echoes total line count for files matching pattern
# at base_sha. For literal paths this is one git-show. For globs we enumerate
# the base tree with git ls-tree and shell-glob-match.
count_base() {
  pattern="$1"
  total=0
  case "$pattern" in
    *'*'*|*'?'*|*'['*)
      # Glob: enumerate full base tree, filter by glob match in shell.
      # Strip the trailing `/*` or similar to find a containing dir for ls-tree
      # efficiency; if pattern has no `/` use the repo root.
      dir=$(dirname "$pattern")
      [ "$dir" = "." ] && dir=""
      if [ -n "$dir" ]; then
        files=$(git ls-tree -r --name-only "$base_sha" -- "$dir" 2>/dev/null || true)
      else
        files=$(git ls-tree -r --name-only "$base_sha" 2>/dev/null || true)
      fi
      # Match each against the glob
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        # Use case-pattern matching; pattern is shell-glob.
        # shellcheck disable=SC2254
        case "$f" in
          $pattern)
            n=$(git show "${base_sha}:${f}" 2>/dev/null | wc -l)
            total=$((total + n))
            ;;
        esac
      done <<EOF
$files
EOF
      ;;
    *)
      # Literal path.
      if git cat-file -e "${base_sha}:${pattern}" 2>/dev/null; then
        n=$(git show "${base_sha}:${pattern}" 2>/dev/null | wc -l)
        total=$n
      fi
      ;;
  esac
  echo "$total"
}

fail=0
checked=0
skipped=0

# Read .v0.2-only-files line by line, strip comments + blanks.
while IFS= read -r raw || [ -n "$raw" ]; do
  # Strip leading/trailing whitespace.
  line=$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  # Skip blank + comment.
  case "$line" in
    ''|'#'*) continue ;;
  esac

  head_count=$(count_head "$line")
  base_count=$(count_base "$line")

  if [ "$head_count" -eq 0 ] && [ "$base_count" -eq 0 ]; then
    skipped=$((skipped + 1))
    echo "SKIP: $line (missing in both base and head)"
    continue
  fi

  checked=$((checked + 1))

  if [ "$head_count" -gt "$base_count" ]; then
    delta=$((head_count - base_count))
    echo "GROW: $line (base=$base_count, head=$head_count, +$delta)"
    fail=1
  else
    delta=$((base_count - head_count))
    echo "OK:   $line (base=$base_count, head=$head_count, -$delta)"
  fi
done < "$LIST_FILE"

echo
echo "check-v02-shrinking: $checked checked, $skipped skipped"

if [ "$fail" -ne 0 ]; then
  echo
  echo "FAIL: one or more .v0.2-only-files entries grew vs base."
  echo "      If this is intentional (file moved into shell, intermediate refactor),"
  echo "      explain in the PR body under 'Wire-up evidence' and ping reviewer."
  exit 1
fi

echo "PASS: no v0.2-only file grew."
exit 0
