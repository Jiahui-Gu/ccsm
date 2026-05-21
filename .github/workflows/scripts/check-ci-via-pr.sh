#!/usr/bin/env bash
# check-ci-via-pr.sh — gate "CI green at commit SHA" by walking back to the
# PR that produced that commit, then inspecting the PR head SHA's
# check-runs. Required because ci.yml / e2e.yml only trigger on
# pull_request, so the merge commit on working/main itself never has
# check-runs directly attached.
#
# Usage: check-ci-via-pr.sh <commit-sha> <label-for-summary>
#
# Required env: OWNER, REPO, GH_TOKEN, EXPECTED_CHECKS.
#
# EXPECTED_CHECKS is a newline-separated allowlist of check-run names that
# MUST all be present and green. Newline-separated (not space) so names
# containing spaces (e.g. "lint + typecheck + test (macos-latest)") work
# without quoting gymnastics. Anything outside the allowlist is ignored —
# critical, because the promote-release workflow registers its own
# check-run ("promote working → main + tag") on the same PR head SHA and
# would otherwise self-poison this gate.
#
# Pass iff every name in EXPECTED_CHECKS has a check-run that is completed
# AND conclusion in {success, neutral, skipped}. Missing names → fail
# loud. Names appearing multiple times (re-runs) → use the latest by
# completed_at then id.
#
# If the commit has no associated PR, exit 1 with a clear message — per
# locked decision: "refuse to promote" rather than silently passing.

set -euo pipefail

sha="${1:?sha required}"
label="${2:?label required}"

if [ -z "${OWNER:-}" ] || [ -z "${REPO:-}" ]; then
  echo "::error::OWNER and REPO env vars required"
  exit 2
fi

if [ -z "${EXPECTED_CHECKS:-}" ]; then
  echo "::error::EXPECTED_CHECKS env var required (newline-separated check-run names)"
  exit 2
fi

echo "Gate CI for $label at $sha"

# Render expected list for logs / step summary.
expected_json=$(printf '%s\n' "$EXPECTED_CHECKS" | jq -R . | jq -s '[.[] | select(length > 0)]')
echo "Expected checks:"
echo "$expected_json" | jq -r '.[]'

# /commits/{sha}/pulls returns PRs whose head OR merge_commit_sha matches.
# We take the first; for a merge commit on working/main, that's the PR
# that produced this commit.
pr_json=$(gh api "repos/$OWNER/$REPO/commits/$sha/pulls" --jq '.[0] // empty')

if [ -z "$pr_json" ]; then
  {
    echo "### Gate: CI on $label — REFUSE";
    echo "Commit \`$sha\` has no associated PR. Refusing to promote (someone pushed directly to the branch).";
  } >> "$GITHUB_STEP_SUMMARY"
  echo "::error::No PR associated with $sha on $label — refusing to promote"
  exit 1
fi

pr_number=$(echo "$pr_json" | jq -r '.number')
pr_head=$(  echo "$pr_json" | jq -r '.head.sha')
echo "Associated PR #$pr_number, head $pr_head"

# Pull all check-runs (paginated) for the PR head SHA. Keep full objects
# so we can sort by completed_at / id for re-run dedup.
runs=$(gh api --paginate "repos/$OWNER/$REPO/commits/$pr_head/check-runs" \
  --jq '.check_runs[] | {name, status, conclusion, completed_at, id}')

if [ -z "$runs" ]; then
  {
    echo "### Gate: CI on $label — FAIL";
    echo "No check-runs found on PR #$pr_number head \`$pr_head\`.";
  } >> "$GITHUB_STEP_SUMMARY"
  echo "::error::No check-runs on $pr_head"
  exit 1
fi

# Filter to allowlist, then for each expected name pick the latest
# (completed_at desc, id desc) check-run. Result is a JSON array of
# {name, run} pairs; run is null when nothing matched.
all_runs_json=$(echo "$runs" | jq -s '.')
selected=$(jq -n \
  --argjson runs "$all_runs_json" \
  --argjson expected "$expected_json" \
  '
  $expected
  | map(. as $name
        | { name: $name,
            run: ( $runs
                   | map(select(.name == $name))
                   | sort_by([(.completed_at // ""), (.id // 0)])
                   | last ) })
  ')

# Build lists of missing + bad.
missing=$(echo "$selected" | jq '[.[] | select(.run == null) | .name]')
bad=$(    echo "$selected" | jq '
  [ .[]
    | select(.run != null)
    | select( (.run.status != "completed")
           or ( .run.conclusion as $c
                | (["success","neutral","skipped"] | index($c)) | not ) )
    | { name: .name,
        status: .run.status,
        conclusion: .run.conclusion } ]
')
missing_count=$(echo "$missing" | jq 'length')
bad_count=$(    echo "$bad"     | jq 'length')

# Always log expected vs got for debuggability when the allowlist drifts.
got_filtered=$(echo "$all_runs_json" | jq --argjson e "$expected_json" '[.[] | select(.name as $n | $e | index($n))] | map(.name) | unique')
got_all=$(     echo "$all_runs_json" | jq '[.[].name] | unique')
echo "Got (in allowlist):   $(echo "$got_filtered" | jq -c '.')"
echo "Got (all on PR head): $(echo "$got_all"      | jq -c '.')"

if [ "$missing_count" -gt 0 ] || [ "$bad_count" -gt 0 ]; then
  {
    echo "### Gate: CI on $label — FAIL";
    echo "PR #$pr_number head \`$pr_head\`.";
    if [ "$missing_count" -gt 0 ]; then
      echo "";
      echo "Missing required check(s):";
      echo '```json';
      echo "$missing" | jq '.';
      echo '```';
    fi
    if [ "$bad_count" -gt 0 ]; then
      echo "";
      echo "Failed/incomplete check(s):";
      echo '```json';
      echo "$bad" | jq '.';
      echo '```';
    fi
    echo "";
    echo "Expected:";
    echo '```json';
    echo "$expected_json" | jq '.';
    echo '```';
    echo "Got (all check-runs on PR head, for debugging):";
    echo '```json';
    echo "$got_all" | jq '.';
    echo '```';
  } >> "$GITHUB_STEP_SUMMARY"
  if [ "$missing_count" -gt 0 ]; then
    echo "::error::CI gate failed on $label (PR #$pr_number): $missing_count missing required check(s)"
    echo "$missing" | jq '.'
  fi
  if [ "$bad_count" -gt 0 ]; then
    echo "::error::CI gate failed on $label (PR #$pr_number): $bad_count bad check(s)"
    echo "$bad" | jq '.'
  fi
  exit 1
fi

total=$(echo "$selected" | jq 'length')
{
  echo "### Gate: CI on $label — OK";
  echo "PR #$pr_number head \`$pr_head\`: all $total required check-run(s) passed.";
} >> "$GITHUB_STEP_SUMMARY"
echo "OK: $total required check-runs all green on $label"
