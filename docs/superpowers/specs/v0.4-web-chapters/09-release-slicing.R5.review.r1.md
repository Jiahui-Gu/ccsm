# Review of chapter 09: Release slicing

Reviewer: R5 (Testability)
Round: 1

## Findings

### P1-1 (must-fix): M2 done-definition lacks an explicit parity-test deletion gate
**Where**: chapter 09 §3 M2.Z cleanup PR
**Issue**: "M2.Z cleanup PR — delete envelope handler from data socket; delete `electron/ipc/*` files for daemon-domain handlers; delete temporary parity tests; refactor." The parity tests are deleted in this PR, but no precondition: "all 12 batch PRs landed AND each had its parity test green within the previous 7-day dogfood window AND a final cross-bridge integration test passes." Without explicit gating, a worker could land M2.Z while a buggy bridge from a still-merging earlier batch silently regressed — and the parity safety net is gone.
**Why P1**: M2.Z is the irreversible point; once parity tests are deleted, regressions can't be A/B-compared. Need explicit precondition.
**Suggested fix**: §3 done-definition adds a checklist: all batch PRs merged + post-M2 7-day dogfood not started until the FINAL batch PR's parity test ran green + M2.Z runs only after dogfood close.

### P1-2 (must-fix): M3 dogfood "3-day, 4-5 hours of real work" is too thin for testability sign-off
**Where**: chapter 09 §4 M3 done-definition
**Issue**: "3-day dogfood: web client used at least 4-5 hours of real work locally with no critical regressions." 4-5 hours of active use is a tiny sample for catching browser-flake (memory growth, leaked subscribers per chapter 06 §5, intermittent reconnect failure under throttled tab). M3 risk-gate says "if M3 dogfood reveals significant UX gaps, pause M4" — the gate exists but the dogfood window is too short to fairly trigger it.
**Why P1**: M3 is the last chance to catch web-specific regressions before chapter 05's complexity stacks on top. Per `feedback_correctness_over_cost` we don't shortcut testing.
**Suggested fix**: §4 extends to "3 days OR 12 cumulative hours, whichever later, including ≥1 backgrounded-tab >2h test, ≥1 multi-client (Electron + web) session ≥1h, ≥1 reconnect after intentional network drop."

### P1-3 (must-fix): Auto-start at OS boot has no test plan despite being a release gate
**Where**: chapter 09 §5 M4 deliverable 7 + chapter 00 success criteria #6
**Issue**: "auto-start at OS boot setting — opt-in toggle, default OFF, persists across reboots." Success criterion #6: "Auto-start works — opt-in setting flipped ON, machine rebooted, daemon comes up before Electron is launched, web client is reachable within 30s of OS login." This is testable manually only — no CI strategy because reboots can't be cheaply automated. Author should explicitly note "manual test, performed once per release tag, recorded in release notes."
**Why P1**: a documented success criterion with no testing approach is an integrity gap; a regression here would silently land.
**Suggested fix**: §5 done-definition adds "Manual: auto-start verified on real Win box per the success-criteria checklist" as an explicit step. Chapter 08 §9 manual-checklist row covers it.

### P2-1 (nice-to-have): Rollback strategy untested
**Where**: chapter 09 §8
**Issue**: "Catastrophic regression: `v0.4.1` hot-fix release within 24h." The hot-fix path (build → tag → push update channel → users get update) is untested. Could be exercised once during M4 dogfood ("simulate hotfix: bump patch version, push, verify auto-update flow on a test machine"). Carryover from v0.3 but worth a probe in this release.
**Why P2**: hot-fix flow not novel to v0.4; tested by v0.3.
**Suggested fix**: §8 adds optional "verify hotfix path once per release as part of M4 dogfood."

## Cross-file findings

- **M2 parity-test deletion gate** (P1-1) cross-refs chapter 03 §6/§7 + chapter 09 §3 — same fixer who handles parity-test framework spec (cross-file from chapter 03 review).
- **Auto-start manual test** (P1-3) cross-refs chapter 00 success #6 + chapter 09 M4 + chapter 08 §9.
