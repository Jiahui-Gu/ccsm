# R1 review of 01-cutover-audit — feature-preservation (round 2)

Reviewer: R1 (feature-preservation)
Round: 2

## Round-1 closures

- **[P1 HP-4 R1 "TerminalPane host 无条件渲染"]** — **CLOSED** by CF-4 (commit `55195a8c`). HP-4 verdict now carries an explicit "R1 audit pre-step (MUST)" requiring fixer to `git show 35b08d15^:` on TerminalPane.tsx + xtermSingleton.ts + usePtyAttach.ts and record v0.2 baseline line numbers in the PR body; deviation from v0.2 ordering / DOM topology requires explicit user/product approval. Closes the round-1 concern that v0.3 might silently invert v0.2's claude-missing branch (independent error screen vs inline Retry).
- **[P1 HP-8 sigkill-reattach "v0.3 mandatory" but v0.2 行为未知]** — **CLOSED** by CF-3 (commit `1cdba493`). HP-8 verdict rewritten as "FIX (scope-split, R1 strict)" with (a) v0.3 must-fix = restore the v0.2 daemon-port already-shipping attach-replay path, (b) v0.4 defer = 60s TTL / cwd-mismatch / NEW case Set A promotion / G10 lock. Matches manager round-1 拍板 #1 verbatim.
- **[P2 HP-3 Option C 改"窗口出现"用户可见时序但未量化]** — **CLOSED** by CF-2 (commit `52f6276e`). HP-3 verdict now carries "Open Q5 (blocks PR-3 dispatch)" requiring a measured p50/p95 cold-spawn latency table (Win/macOS/Linux) with ≤500ms regression budget vs `35b08d15`; auto-fallback to Option B on breach (deterministic, NOT manager re-deliberation). PR-3 cannot open for review until table exists.
- **[P2 Q3 "requiresClaudeBin fail-vs-skip" product 决策]** — not actioned in round 1 (P2 deferred per fix-plan, no escalation note added). Acknowledged; status unchanged.

## Round-2 findings

(none)

## Verdict

CLEAN. ch01 round-1 fixes close all R1 P1 findings without introducing new R1 P0/P1. HP-4 baseline-cite is reflected downstream in ch03 §1 and ch05 PR-4. HP-8 scope-split is reflected downstream in ch03 §4 / ch04 §4 / ch05 G10 / PR-6.
