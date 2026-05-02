# 15 — Zero-Rework Audit — R4 (Testability + Ship-Gate Coverage)

Audit chapter. R4 only flags items where the audit makes a testability claim that isn't backed up.

## P0 — §3 forbidden-pattern list claims mechanical enforcement that doesn't exist

Of the 12 forbidden patterns:

1. "Removing or renaming any `.proto` field..." — enforced by `buf breaking`. Per chapter 04 R4 review (P0): `buf breaking` is disabled until v0.3 tag → enforcement gap during the entire build window.
2. "Reusing a `.proto` field number" — `buf breaking` covers; same gap.
3. "Changing meaning of an existing field" — `buf breaking` cannot detect semantic changes; this is a human-review-only check; calling it "mechanical reviewer checklist" overstates.
4. "Modifying any v0.3 SQL migration file" — per chapter 07 R4 review (P0): the SHA256 lock is mentioned but not specified or tested; enforcement is paper-only.
5. "Changing the SnapshotV1 binary layout" — no enforcement specified anywhere. Add to the lock concept.
6. "Reshaping the Listener trait or the listener slot array length" — no test asserts trait shape; no test asserts array length == 2.
7. "Renaming `principalKey` format" — no test pins the format string outputs.
8. "Changing `listener-a.json` v1 field meanings" — no JSON Schema (per chapter 03 R4 review).
9. "Changing the Supervisor HTTP endpoint URLs" — no contract test (per chapter 03 R4 review).
10. "Reshuffling `packages/` directories" — no test; relies on review.
11. "Bypassing the `lint:no-ipc` gate" — gate itself has soundness issues (per chapter 12 R4).
12. "Changing per-OS state directory paths" — no test pins the paths.

So 8 of 12 "mechanical reviewer checklist" items have no mechanical enforcement, only social. Spec must either:
- Add tests/scripts for each (the work is small per item), OR
- Demote the list from "mechanical" to "human review checklist" so reviewers don't get false confidence.

P0 because chapter 15 is the v0.3 design-quality bar (its own §5: "this audit chapter is the design-quality bar"), and the bar consists largely of un-mechanically-enforced items.

## P1 — §4 sub-decisions list 10 author-made choices but doesn't link to specific tests

Each sub-decision (worker_threads vs child_process, custom snapshot format, descriptor file race, big-bang PR, custom WiX, _ccsm user, crash-raw.ndjson, no-XDG, transport bridge, installer technologies) ought to have a "spike-or-test that justifies the choice." Link them. Without explicit links, the "review-attention items" are abstract.

## P1 — Audit table §1 row §11(c) "Same harness" — but ship-gate (c) per chapter 06 R4 has structural problems (encoder non-determinism, no decoder spec)

The audit verdict "additive" assumes the harness works. Per chapter 06 R4 (P0 ×3), the harness has open soundness issues. The audit should at minimum reference resolution of those issues as a precondition for the verdict. Otherwise the "additive" claim is conditional on bugs being absent in the gate itself.

## P2 — §1 row §6 ("Proto scope: forever-stable") — additive verdict relies on `buf breaking` which is delayed (chapter 04 R4)

Conditional verdict. Note the dependency.

## Summary

P0: 1 / P1: 2 / P2: 1
Most-severe: **§3's forbidden-pattern list claims "mechanical" enforcement for 12 items but only ~4 of them have actual mechanical checks; the design-quality bar is largely social.**
