# Review of chapter 05: Release slicing and DAG

Reviewer: R3 (reliability / observability)
Round: r1

## Findings

### P1-1 (must-fix): PR-3 (Option C await spawnDaemon) has no rollback plan for spawn failure

**Where**: chapter 05, §3 PR-3 contract (lines 102-113) and §7 Risk-1 (lines 224-228).
**Issue**: PR-3 acceptance says "harness `attach-replay-from-headless-buffer` no longer reports `daemon port unavailable after 5s`". Risk-1 acknowledges Option C cold-launch regression risk and says "fall back to Option B (pre-resolved cache)". But no PR-3.5 / contingency PR is defined; the fall-back is a hand-wave. Worse, the spawn FAILURE path (port occupied, daemon binary missing, EACCES) is not in PR-3's risk surface at all — Option C's `await` will throw, electron crashes, no e2e signal beyond a generic crash.
**Why this is P1**: chapter 03 R3 P0-1 (cold-spawn budget) and the failure-path policy must land BEFORE PR-3 ships. Without pre-defined fallback, a v0.3 release-blocker incident becomes a multi-day re-spec.
**Suggested fix**: PR-3 contract MUST add Acceptance bullet: "Spawn failure path is implemented per chapter 03 §3 Spawn failure path (R3 review P0-1): catch + retry with port=0 + native error dialog + non-zero exit. UT in `electron/__tests__/main-startup.test.ts` covers all three branches (success, retry-success, retry-fail-dialog)." Add to §7 Risk-1: "If cold-launch p95 regresses by >500ms on Windows or macOS dev box, abort Option C and dispatch a PR-3b implementing Option B from chapter 03 §3 — DO NOT merge PR-3."

### P1-2 (must-fix): G8 skip-zero gate has no observability for daemon-side regressions

**Where**: chapter 05, §1 gates table (lines 11-23).
**Issue**: G1-G10 cover renderer/test-side green. There is NO gate that verifies daemon stderr is clean (or at least free of `error` level lines) during the harness run. A daemon could be silently logging `error` at every case while tests still pass (e.g. `pty_dead` after a delayed resize), masking genuine regressions.
**Why this is P1**: closes the observability loop. Cheap gate (grep for `error` in captured stderr); high signal.
**Suggested fix**: add G11: "Daemon stderr capture (per chapter 03 §6, chapter 04 §2) contains ZERO `error`-level lines across the Set A run. `warn` permitted. Tooling: `grep -c '\] [0-9T:.-]\+Z error ' tmp/e2e-logs/*.log` returns 0."

### P2-1 (nice-to-have): PR ordering does not wave the reliability/observability work explicitly

**Where**: chapter 05, §5 "Dispatch order recommendation" (lines 200-209).
**Issue**: The wave plan is correct for unblocking, but the reliability-only PRs (cold-spawn measurement table, failure path, log format, stderr capture, sigkill TTL pin, SSE reconnect dedup) are not represented. They will be folded into PR-3 / PR-6 / PR-8 by reviewers, but the dispatch plan does not earmark them.
**Why this is P2**: organisational; the work still gets done if reviewers track the cross-file findings. Worth a paragraph though.
**Suggested fix**: add §5 paragraph: "The R3 reliability/observability findings cross-cut PR-3 (failure path, port counter), PR-6 (SSE dedup, sigkill TTL), and PR-8 (probe-utils dump extensions). Manager MUST verify each fixer reads the corresponding R3.review.md before opening the PR; reviewer R3 in stage-4 verifies on the implementation."

## Cross-file findings

- P1-1 spans chapter 03 §3 (failure path text) + chapter 05 PR-3 contract. Single fixer, paired commit.
- P1-2 (stderr-clean gate) requires chapter 03 §6 log format to be canonical first; coordinate with chapter 03 P1-3 / chapter 04 P1-2.
