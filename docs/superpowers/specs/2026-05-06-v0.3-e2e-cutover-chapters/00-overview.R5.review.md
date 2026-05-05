# Review of chapter 00: Overview

Reviewer: R5 (Testability)
Round: 1

## Findings

### P0-1 (BLOCKER): cited "88 .skip" baseline is wrong; downstream chapters inherit a phantom KEEP/DELETE/FIX/MARK matrix

**Where**: chapter 00, §2 Scope bullet 5 (lines 64-67) — "dev-574 reports ~88 distinct case-skip combinations across the three harnesses; the audit confirms exact count and classifies each."
**Issue**: R5 ground-truthed at HEAD `6e3a1bd4` (post-author rebase, base `35b08d15`):

```bash
$ grep -rEn "(it|test|describe)\.skip\(|\bxit\b|\bxdescribe\b" \
    --include='*.ts' --include='*.tsx' --include='*.js' tests/ src/ daemon/ electron/
# 0 matches

$ grep -rn "skipLaunch" --include='*.mjs' scripts/
# scripts/probe-helpers/harness-runner.mjs: 13 references (the runner mechanism itself)
# scripts/harness-ui.mjs:1624: { id: 'cap-skip-launch-bundle-shape', skipLaunch: true, ... }   ← exactly ONE case
```

Reality on this baseline: **0 Vitest skip directives, 1 `skipLaunch:true` case (capability demo, not a regression-skip)**. Author already documented this honestly in chapter 01 Q4 (lines 270-277) and chapter 04 §1 (lines 11-34) but chapter 00 still cites the "88" figure as if it were the baseline number to triage. dev-574's "88" almost certainly counts something else (per chapter 04 hypothesis: case×capability-flag matrix evaluations in the runner — the runner has 13 `skipLaunch` references for one case, multiplied across `requiresClaudeBin / windowsOnly / darwinOnly` and ~22 cases = ~88 evaluation points; not skipped tests).

**Why this is P0**: scope bullet 5 frames the entire chapter-04 KEEP/DELETE/FIX/MARK exercise as "audit 88 things." A fixer reading chapter 00 in isolation will burn a day looking for 88 skip-like things that don't exist. Worse, chapter 04 §1's verdict policy (KEEP/DELETE/FIX/MARK) is correct in shape but vacuous in size — there is essentially nothing to triage at the case level (only `cap-skip-launch-bundle-shape`, which is correctly KEEP). The actual v0.3 "skip-like" work is **forward-prevention**: the iron rule §3.1 ("zero e2e skip") is about not introducing new skips during the repair, not removing 88 existing ones. That distinction collapses if the wrong baseline number is enshrined in chapter 00.

**Suggested fix**: rewrite the bullet to:

> Producing a per-harness-case verdict table for every case currently marked with a runner gate flag (`requiresClaudeBin / windowsOnly / darwinOnly / skipLaunch`). Ground-truth at `35b08d15` / `6e3a1bd4`: **0 Vitest `.skip` directives, 1 `skipLaunch:true` case** (`cap-skip-launch-bundle-shape`, capability demo). The dev-574 "~88" figure was a count of runner gate-evaluations across the case×flag matrix, NOT actual skipped tests; the v0.3 spec treats §3.1 ("zero e2e skip") as a forward guard against introducing new skips during repair, not a triage backlog.

Cross-link the rewrite to chapter 04 §1 reconciliation. See the matching P0 in `04-probe-and-harness-update.R5.review.md` which removes the now-obsolete "88-skip triage" framing.

### P1-1 (must-fix): §6 acceptance criteria has no testability bar for chapter outputs

**Where**: chapter 00, §6 "Quality bar / acceptance criteria" (lines 148-171).
**Issue**: §6 says the spec is "done" when each chapter delivers its content (audit table, surface contract, RPC wiring, harness-case verdict, DAG). It says nothing about whether the design is **testable** — i.e., whether each PR-0..PR-9 is independently verifiable, whether each S1..S9 symptom maps to a unit-test or harness-case lever, or whether the e2e cases proposed in chapter 04 §4 actually cover the regressions catalogued in chapter 01. The downstream "implementation is done when e2e CI hits absolute-green twice" is correct but doesn't catch a spec where two PRs share an indistinguishable acceptance signal (a real risk for PR-2 / PR-7 — both gated on `__ccsmStore` reliability).
**Why this is P1** (not P0): the gates G1-G10 in chapter 05 §1 do partially compensate. But that lives in chapter 05; readers who stop at chapter 00 see no testability bar for the spec itself.
**Suggested fix**: add a §6 sub-bullet: "(6) Every PR in chapter 05 §3 has a *unique* acceptance signal — no two PRs share a single failing harness case as their sole green-gate, so a failed CI run identifies exactly one PR to revert." And: "(7) Every S1..S9 symptom in chapter 01 is mapped to either a unit-test in chapter 02/03 OR a harness case in chapter 04 — no symptom is left without a regression test."

### P2-1 (nice-to-have): reader map under-sells R5 angle

**Where**: chapter 00, §8 "Reader map" (lines 186-196).
**Issue**: §8 routes "Testability" to chapters 04, 05 only. But the testability story is heavily in chapter 02 (`tests/stores/initialState.test.ts` proposed, `tests/app-effects/useThemeEffect.test.tsx` extension claimed) and chapter 03 (UT requirements per RPC, dataFanout case extensions). Routing R5 readers only to 04+05 hides half the test surface.
**Why this is P2**: nav-only; not load-bearing.
**Suggested fix**: change "Testability → chapters 04, 05" to "Testability → chapters 02 §5, 03 §2/§5, 04, 05".

## Cross-file findings

P0-1 (skip-baseline) is the load-bearing finding for this round; it cascades to chapter 01 Q4 (already honest, mark RESOLVED), chapter 04 §1 (rewrite the matrix framing — see `04-probe-and-harness-update.R5.review.md` P0-1), and chapter 05 §1 G8 (the gate is forward-correct but its rationale paragraph needs the corrected baseline number). One fixer should land all four edits in a single commit.
