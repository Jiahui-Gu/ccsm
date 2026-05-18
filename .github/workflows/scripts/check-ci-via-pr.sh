#!/usr/bin/env bash
# check-ci-via-pr.sh — gate "CI green at commit SHA" by walking back to the
# PR that produced that commit, then inspecting the PR head SHA's
# check-runs. Required because ci.yml / e2e.yml only trigger on
# pull_request, so the merge commit on working/main itself never has
# check-runs directly attached.
#
# Usage: check-ci-via-pr.sh <commit-sha> <label-for-summary>
#
# Pass iff every check-run on the PR head is completed AND conclusion in
# {success, neutral, skipped}. Anything else (failure, cancelled,
# timed_out, action_required, stale, or status != completed) → exit 1.
#
# If the commit has no associated PR, exit 1 with a clear message — per
# locked decision: "refuse to promote" rather than silently passing.
#
# Env: OWNER, REPO, GH_TOKEN must be set by the caller.

set -euo pipefail

sha="${1:?sha required}"
label="${2:?label required}"

if [ -z "${OWNER:-}" ] || [ -z "${REPO:-}" ]; then
  echo "::error::OWNER and REPO env vars required"
  exit 2
fi

echo "Gate CI for $label at $sha"

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

# Pull all check-runs (paginated) for the PR head SHA.
runs=$(gh api --paginate "repos/$OWNER/$REPO/commits/$pr_head/check-runs" \
  --jq '.check_runs[] | {name, status, conclusion}')

if [ -z "$runs" ]; then
  {
    echo "### Gate: CI on $label — FAIL";
    echo "No check-runs found on PR #$pr_number head \`$pr_head\`.";
  } >> "$GITHUB_STEP_SUMMARY"
  echo "::error::No check-runs on $pr_head"
  exit 1
fi

# Anything not completed, or completed with a conclusion not in the pass
# set, fails the gate.
bad=$(echo "$runs" | jq -s '
  [ .[]
    | select( (.status != "completed")
           or ( .conclusion as $c
                | (["success","neutral","skipped"] | index($c)) | not ) )
  ]
')
bad_count=$(echo "$bad" | jq 'length')

if [ "$bad_count" -gt 0 ]; then
  {
    echo "### Gate: CI on $label — FAIL";
    echo "PR #$pr_number head \`$pr_head\` has $bad_count bad check-run(s):";
    echo '```json';
    echo "$bad" | jq '.';
    echo '```';
  } >> "$GITHUB_STEP_SUMMARY"
  echo "::error::CI gate failed on $label (PR #$pr_number)"
  echo "$bad" | jq '.'
  exit 1
fi

total=$(echo "$runs" | jq -s 'length')
{
  echo "### Gate: CI on $label — OK";
  echo "PR #$pr_number head \`$pr_head\`: all $total check-run(s) passed.";
} >> "$GITHUB_STEP_SUMMARY"
echo "OK: $total check-runs all green on $label"
