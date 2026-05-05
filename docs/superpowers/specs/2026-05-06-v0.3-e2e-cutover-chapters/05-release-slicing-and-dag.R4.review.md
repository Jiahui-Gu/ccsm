# Review of chapter 05: Release slicing & DAG

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

### P1-1 (must-fix): Risk-1 cold-launch regression budget is named but not gated

**Where**: chapter 05, §7 "Risks & open questions for reviewers" →
Risk-1 (lines 224-227).
**Issue**: "If the developer's primary box shows a >500ms regression,
fall back to Option B" is the right bail-out, but no PR contract owns
the MEASUREMENT. PR-3's contract (§3 "PR-3" lines 102-113) lists
acceptance "harness `attach-replay-from-headless-buffer` no longer
reports `daemon port unavailable`" but doesn't require capturing the
first-paint delta number. Result: the 500ms gate has no enforcement
point — a regression of 800ms could land and only get noticed by feel.
**Why this is P1**: this is the only user-perceptible perf change in
v0.3 and the spec already acknowledges it needs a budget; the gap is
just where the number gets captured. Easy fix at design time, expensive
to debug post-merge. Not P0 because the mechanism exists (rollback
to Option B); only the gate is missing.
**Suggested fix**: chapter 05 §3 PR-3 contract add a third acceptance
bullet: "PR body includes `console.time('spawnDaemon')` measurement
delta vs. baseline (35b08d15 cold launch); if delta >500ms, manager
must approve OR PR migrates to Option B before merge". Cross-link to
chapter 03 §3 (where the budget should also be written; see
`03-ptyhost-wiring.R4.review.md` P1-1).

### P2-1 (nice-to-have): G5/G6/G7 "two consecutive runs" gate has no time bound

**Where**: chapter 05, §1 "Top-level v0.3 e2e iron rules (recap,
gate-form)" gates G5/G6/G7 (lines 18-20).
**Issue**: "two consecutive runs" guards against flake but not
against slow-creep. If one fixer adds a heavy `await` somewhere on the
hot path, both runs go green but each takes 2x as long. No CI time
budget recorded.
**Why this is P2**: orthogonal to the v0.3 release goal (correctness
green); cycle-time concern. Already partially addressed by
`04-probe-and-harness-update.R4.review.md` P2-1.
**Suggested fix**: G5/G6/G7 each pick up the same wall-clock budget
suggested in chapter 04 §6 review — "and total runtime within
budget X".

### P2-2 (nice-to-have): No DAG node owns the "resource cap baseline" capture

**Where**: chapter 05, §2 "PR DAG" (lines 26-67).
**Issue**: the cap-inventory I'm asking chapter 01 to add (see
`01-cutover-audit.R4.review.md` P1-2 — ≤10 ptys, ≤20 EventSource,
≤256 KiB snapshot, ≤200 MiB daemon RSS) doesn't have a PR slot.
Unowned design notes tend to drift into "we'll do it later".
**Why this is P2**: the caps are nominal-load defaults, not gating
correctness; one fixer adding the section to chapter 01 in any of
PR-1..PR-3 is fine. Listed so manager doesn't drop it on the floor.
**Suggested fix**: assign the cap-inventory documentation work to
PR-3 (it touches daemon-spawn so it's the natural home for "what does
'daemon healthy' mean"); or carve a small PR-1.5 "spec doc: resource
caps" if PR-3 scope balloons.

## Cross-file findings

P1-1 (Risk-1 enforcement) spans:
- chapter 01 §HP-3 (problem statement) — see `01-cutover-audit.R4.review.md` P1-1
- chapter 03 §3 (decision + budget) — see `03-ptyhost-wiring.R4.review.md` P1-1
- chapter 05 §3 PR-3 + §7 Risk-1 (gate) — this file P1-1
Manager assign one fixer (likely PR-3 owner) to write the number in
all three places consistently.

P2-3 (cap inventory ownership) spans chapter 01 (where the section
lives) and chapter 05 (which PR adds it). Suggest single fixer takes
both.
