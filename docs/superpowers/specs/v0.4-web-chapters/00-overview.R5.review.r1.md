# Review of chapter 00: Overview

Reviewer: R5 (Testability)
Round: 1

## Findings

### P1-1 (must-fix): Success criterion #4 (reconnect) implies hermetic testability not delivered by other chapters
**Where**: chapter 00 success criteria #4 — "Web client survives a 30-minute network drop and resumes the same PTY stream via `fromSeq` replay (no full re-snapshot)."
**Issue**: this is the strongest stated guarantee in the spec ("no full re-snapshot" — meaning fanout buffer must hold ≥30 min worth of bytes). Chapter 06 §6 says replay budget is capped at 256 KiB and 30-minute drops "may roll past `fromSeq` → force re-snapshot". The success criterion contradicts the implementation chapter — and neither has a test that proves the actual achievable replay window. As written, criterion #4 cannot be objectively measured.
**Why P1**: a success criterion that contradicts the design chapter is a blocker for the dogfood gate (how do you sign off "this works"?). Either tighten the criterion OR weaken it OR add the buffer-sizing analysis + test that justifies "30 min usually fits in 256 KiB for typical sessions".
**Suggested fix**: chapter 00 #4 reworded to: "Web client survives a 30-minute network drop and resumes via `fromSeq` replay OR fresh snapshot (no data loss; user sees current PTY state on resume)." Chapter 06 §6 + chapter 08 §5 adds an explicit test for the resume-via-snapshot path under long-drop conditions, separate from short-drop seq-replay.

## Cross-file findings

- **Reconnect criterion vs implementation contradiction** (P1-1) cross-refs chapter 00 success #4 + chapter 06 §6 + chapter 08 §5 — single fixer.
