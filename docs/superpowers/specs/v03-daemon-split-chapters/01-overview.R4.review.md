# 01 — Overview — R4 (Testability + Ship-Gate Coverage)

Overview chapter; mostly a roadmap. R4 surface is small.

## P2 — §1 Goal #5 "PTY zero-loss reconnect" cites brief §11(c) — overview should reference the testing chapter where the gate is implemented

§1.5 says "1-hour live `claude` workload survives Electron SIGKILL + relaunch with binary-identical terminal state." Add a `→ see [12-testing-strategy](./12-testing-strategy.md) §4.3 + [06-pty-snapshot-delta](./06-pty-snapshot-delta.md) §8` so readers immediately know where the gate lives. Same for goals 2/3/6 (gate (a)/(b)/(d)). Improves spec navigability for reviewers auditing gate-by-gate.

## P2 — §7 v0.4 delta summary lists "purely additive" claims; overview should also mention the audit chapter's verification

§7 makes 5 strong additivity claims. Add a sentence: "Verified against the per-section audit table in [15-zero-rework-audit](./15-zero-rework-audit.md) §1; reviewers cross-reference."

## Summary

P0: 0 / P1: 0 / P2: 2
No critical findings. Overview is correctly a roadmap; testability lives in destination chapters.
