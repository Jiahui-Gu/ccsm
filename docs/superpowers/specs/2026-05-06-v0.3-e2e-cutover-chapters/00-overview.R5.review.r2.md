# Review of chapter 00: Overview

Reviewer: R5 (Testability)
Round: 2

## Round-1 closures

- **R1 P0-1 (skip baseline phantom KEEP/DELETE/FIX/MARK)** — CLOSED. §2 bullet 5 (lines 62-74) now explicitly says "Ground-truth at `35b08d15` / `5d0c5375`: **0 Vitest `.skip` directives, 1 `skipLaunch:true` case** (`cap-skip-launch-bundle-shape`, capability demo of the runner itself; KEEP). The dev-574 '~88' figure was a count of runner gate-evaluations across the case×flag matrix in `scripts/probe-helpers/harness-runner.mjs`, NOT actual skipped tests; v0.3 treats §3.1 ('zero e2e skip') as a forward guard against introducing new skips during repair, not a triage backlog." — exact rewrite from R5 r1 suggestion landed; cross-link to ch04 §1.1 added.
- **R1 P1-1 (testability bar in §6 acceptance criteria)** — NOT CLOSED at the §6 level (no new sub-bullet "(7)/(8)" added). HOWEVER the *spirit* of the finding is now landed elsewhere: ch01 §"Symptom catalog" has the 5th-column "Regression-test lever (post-fix)" mapping every S1..S9 to a UT or harness lever, and ch05 §3.0 has the symptom-to-PR closure map. The R5 r1 ask was "every PR has a unique acceptance signal AND every Sn maps to a lever" — both halves are satisfied at the chapter that owns each axis. Re-asserting the bar in ch00 §6 would be duplication, not a missing guard. Downgrade from r1 P1 to **closed-by-equivalent-coverage**.
- **R1 P2-1 (reader map under-sells R5 angle)** — NOT closed; §8 still routes "Testability → chapters 04, 05" (lines 245-246 unchanged from r1). Pure nav cosmetic; remains P2; not raised again.

## Findings

No P0/P1 from R5 testability angle.

### P2-1 (nice-to-have, carryover from r1): §8 reader map still under-routes Testability

**Where**: chapter 00, §8 "Reader map" (lines 244-246).
**Issue**: still says "Testability → chapters 04, 05"; ch02 §4 now carries a full UT-lever table for I-1/I-3a/I-3b/I-5/§5, ch03 §1 carries the TerminalPane MUST UT, ch03 §3 carries the daemon-spawner MUST UT, ch01 carries the symptom→lever map. R5 readers stopping at ch00 see only half the test surface.
**Why P2**: navigation-only; the actual test surface is correctly placed at the chapters; readers who follow chapter links land on the right spec. Not a regression risk.
**Suggested fix**: change to "Testability → chapters 01 §Symptom catalog, 02 §4, 03 §1/§3/§5, 04, 05 §3.0".

## Cross-file findings

None. All r1 cross-cutting items (CF-1 skip-baseline reconcile across ch00/ch01/ch04/ch05) landed in a single coherent pass.

## Verdict

**CLEAN** for ch00. The single remaining carryover is P2 (nav cosmetic) and not blocking.
