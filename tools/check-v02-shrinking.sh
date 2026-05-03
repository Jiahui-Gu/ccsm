#!/usr/bin/env bash
# tools/check-v02-shrinking.sh — Wave 2 §5.6 mechanical guard (Task #222)
#
# For each path/glob listed in .v0.2-only-files, enforce step-wise
# monotonic shrinking across every commit between the merge-base and HEAD.
# Fails if any listed file/glob has GROWN at any commit boundary inside
# the branch series, OR vs the merge-base overall.
#
# Why step-wise (Task #279, FOLLOWUP per #278):
#   The original implementation (PR #959) only compared base-vs-HEAD.
#   That allows a file with a shrink budget to silently re-grow within
#   the same branch series — e.g. base=100, commit1 shrinks to 50,
#   commit2 grows back to 100 → base-vs-HEAD shows 100→100 (PASS) but
#   the budget was wasted. Step-wise comparison (each commit ≤ previous
#   for every listed pattern) closes that loophole.
#
# Algorithm (approach A — HEAD~1 chain):
#   1. Resolve base sha (GITHUB_BASE_REF → origin/main → origin/working).
#   2. Walk commits base..HEAD in chronological order. For each adjacent
#      pair (parent, child), for each listed pattern, fail if
#      count_at(child, pattern) > count_at(parent, pattern).
#   3. Also verify count_at(HEAD, pattern) ≤ count_at(base, pattern)
#      (preserves the original base-vs-HEAD invariant; equivalent to the
#      product of step-wise checks but explicit for clearer error msgs).
#
# Semantics:
#   - missing-at-rev + present-at-prev → treated as 0 (file moved/deleted
#     is OK). present-at-rev + missing-at-prev → treated as prev=0, so
#     any growth fails (you should not be adding new v0.2-only files).
#   - missing in both → silent skip.
#   - glob: sum line counts across all files matching the pattern at the
#     given revision (uses `git ls-tree` to enumerate).
#   - Fast path: if no commit in base..HEAD touches a file matching the
#     pattern, that pattern is skipped from the step-wise walk
#     (counts can't have changed).

set -u

LIST_FILE=".v0.2-only-files"

if [ ! -f "$LIST_FILE" ]; then
  echo "check-v02-shrinking: no $LIST_FILE found at repo root, skipping" >&2
  exit 0
fi

# Resolve base sha. Prefer GITHUB_BASE_REF in CI; fall back to merge-base
# with origin/main / origin/working locally.
base_sha=""
if [ -n "${GITHUB_BASE_REF:-}" ]; then
  if git rev-parse --verify "origin/${GITHUB_BASE_REF}" >/dev/null 2>&1; then
    base_sha=$(git merge-base HEAD "origin/${GITHUB_BASE_REF}" 2>/dev/null || true)
  fi
fi
if [ -z "$base_sha" ]; then
  # Local fallback: prefer origin/working (this repo's integration branch)
  # over origin/main. PRs target `working`, so merge-base with it gives the
  # short PR-series chain we actually want to step-walk.
  if git rev-parse --verify origin/working >/dev/null 2>&1; then
    base_sha=$(git merge-base HEAD origin/working 2>/dev/null || true)
  fi
fi
if [ -z "$base_sha" ]; then
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    base_sha=$(git merge-base HEAD origin/main 2>/dev/null || true)
  fi
fi
if [ -z "$base_sha" ]; then
  echo "check-v02-shrinking: cannot resolve base sha (no GITHUB_BASE_REF, no origin/main, no origin/working). Skipping." >&2
  exit 0
fi

head_sha=$(git rev-parse HEAD)
echo "check-v02-shrinking: base = $base_sha"
echo "check-v02-shrinking: head = $head_sha"
echo

# count_at_rev <rev> <pattern> → echoes total line count for files matching
# pattern at the given revision. Empty rev means working tree (HEAD-as-files).
count_at_rev() {
  rev="$1"
  pattern="$2"
  total=0
  case "$pattern" in
    *'*'*|*'?'*|*'['*)
      # Glob: enumerate full tree at rev, filter by glob match in shell.
      dir=$(dirname "$pattern")
      [ "$dir" = "." ] && dir=""
      if [ -n "$dir" ]; then
        files=$(git ls-tree -r --name-only "$rev" -- "$dir" 2>/dev/null || true)
      else
        files=$(git ls-tree -r --name-only "$rev" 2>/dev/null || true)
      fi
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        # shellcheck disable=SC2254
        case "$f" in
          $pattern)
            n=$(git show "${rev}:${f}" 2>/dev/null | wc -l)
            total=$((total + n))
            ;;
        esac
      done <<EOF
$files
EOF
      ;;
    *)
      if git cat-file -e "${rev}:${pattern}" 2>/dev/null; then
        n=$(git show "${rev}:${pattern}" 2>/dev/null | wc -l)
        total=$n
      fi
      ;;
  esac
  echo "$total"
}

# Read patterns into an array (skip blanks/comments).
patterns=()
while IFS= read -r raw || [ -n "$raw" ]; do
  line=$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  case "$line" in
    ''|'#'*) continue ;;
  esac
  patterns+=("$line")
done < "$LIST_FILE"

fail=0
checked=0
skipped=0

# Build commit chain: base_sha first, then base..HEAD in chronological order,
# walking ONLY first-parent commits on this branch series. We want to detect
# re-grow within the PR's own commits, not within merged-in side branches
# (a side branch may legitimately add lines that were later removed by the
# merge — those don't count as "this PR re-grew the file").
chain=("$base_sha")
while IFS= read -r c; do
  [ -z "$c" ] && continue
  chain+=("$c")
done < <(git rev-list --reverse --first-parent "${base_sha}..${head_sha}" 2>/dev/null || true)

n_steps=$(( ${#chain[@]} - 1 ))
echo "check-v02-shrinking: walking ${n_steps} commit step(s) from base to head"
echo

for pattern in "${patterns[@]}"; do
  # Quick presence check: counts at base and head.
  base_count=$(count_at_rev "$base_sha" "$pattern")
  head_count=$(count_at_rev "$head_sha" "$pattern")

  if [ "$base_count" -eq 0 ] && [ "$head_count" -eq 0 ]; then
    skipped=$((skipped + 1))
    echo "SKIP: $pattern (missing in both base and head)"
    continue
  fi

  checked=$((checked + 1))

  # Overall base-vs-head check (preserves original invariant + clear msg).
  if [ "$head_count" -gt "$base_count" ]; then
    delta=$((head_count - base_count))
    echo "GROW(overall): $pattern (base=$base_count, head=$head_count, +$delta)"
    fail=1
    continue
  fi

  # Step-wise check: walk adjacent commit pairs, fail on any re-grow.
  # Skip the walk if no commit in the chain touches this pattern (fast path).
  if [ "$n_steps" -gt 0 ]; then
    touched=0
    # `git log --name-only base..HEAD -- <pattern>` lists touching commits.
    # For globs, git's pathspec handles it directly.
    if git log --first-parent --format=%H "${base_sha}..${head_sha}" -- "$pattern" 2>/dev/null | grep -q .; then
      touched=1
    fi

    if [ "$touched" -eq 1 ]; then
      prev_count="$base_count"
      i=1
      step_grew=0
      while [ "$i" -lt "${#chain[@]}" ]; do
        cur_sha="${chain[$i]}"
        cur_count=$(count_at_rev "$cur_sha" "$pattern")
        if [ "$cur_count" -gt "$prev_count" ]; then
          short=$(git rev-parse --short "$cur_sha")
          step_delta=$((cur_count - prev_count))
          echo "GROW(step):    $pattern at $short (prev=$prev_count, this=$cur_count, +$step_delta)"
          fail=1
          step_grew=1
        fi
        prev_count="$cur_count"
        i=$((i + 1))
      done
      if [ "$step_grew" -eq 0 ]; then
        delta=$((base_count - head_count))
        echo "OK:   $pattern (base=$base_count, head=$head_count, -$delta, step-wise monotonic)"
      fi
    else
      delta=$((base_count - head_count))
      echo "OK:   $pattern (base=$base_count, head=$head_count, -$delta, untouched in series)"
    fi
  else
    delta=$((base_count - head_count))
    echo "OK:   $pattern (base=$base_count, head=$head_count, -$delta)"
  fi
done

echo
echo "check-v02-shrinking: $checked checked, $skipped skipped, $n_steps step(s)"

if [ "$fail" -ne 0 ]; then
  echo
  echo "FAIL: one or more .v0.2-only-files entries grew vs base or vs a"
  echo "      previous commit in this branch series. If this is intentional"
  echo "      (intermediate refactor that re-grows then shrinks again), the"
  echo "      step-wise rule still applies — squash or reorder commits so"
  echo "      each step is monotonically non-increasing for v0.2-only files."
  exit 1
fi

echo "PASS: no v0.2-only file grew (overall or step-wise)."
exit 0
