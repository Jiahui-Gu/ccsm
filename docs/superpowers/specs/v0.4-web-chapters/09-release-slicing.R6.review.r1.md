# Review of chapter 09: Release slicing

Reviewer: R6 (Naming / consistency / clarity)
Round: 1

## Findings

### P1-1 (must-fix): "~46 bridge calls" canonical here, but contradicts ~22 in 00, 01, 02

**Where**: §1 line 23 (M2 row) and §3 line 53 ("complete the bridge swap. Every cross-daemon RPC goes over Connect"). Chapter 09 uses 46 (correct, matches chapter 03's canonical inventory).
**Issue**: Same root cause as 00 P1-1, 01 P1-2, 02 P1-1. Chapter 09 is on the right side of this; flagging here so the cross-file fixer doesn't accidentally "correct" 09 down to 22.
**Suggested fix**: no change needed in chapter 09; cross-file fixer must update 00, 01, 02 to 46 (NOT 09 to 22).

### P2-1 (nice-to-have): "M1/M2/M3/M4" milestones vs "M2.A/M2.B/M2.C/M2.Z" sub-batches — naming convention not explicit

**Where**:
- §1 line 22-25 introduces M1-M4.
- §3 line 56-60 introduces M2.A, M2.B, M2.C, M2.Z (sub-batches).
- §6 line 130-134 references "M1 done", "M2 done", etc. for tagging.
- §7 line 142-147 references "Post-M1", "Post-M2", etc. for dogfood gates.

**Issue**: M2.Z is the cleanup batch, conventionally last. Why "Z" and not "M2.D"? Reader has to guess (Z = "the last one"). Also, no equivalent .A/.B sub-batches for M1, M3, M4 — only M2 has them. Reader might wonder if M1.A exists.
**Why P2**: minor; experienced engineers infer.
**Suggested fix**: at §1 add a note: "Sub-batches use letter suffixes (M2.A, M2.B, M2.C); the trailing cleanup PR uses `.Z` to signal 'final cleanup, run after all sibling sub-batches'." Or rename M2.Z to M2.D for uniformity (less expressive, simpler).

### P2-2 (nice-to-have): "rcN" / "rc1" / "rc2" / "rc3" — release-candidate naming uniform but worth a note

**Where**: §6 line 130-134 lists `v0.4.0-rc1`, `v0.4.0-rc2`, `v0.4.0-rc3`, `v0.4.0`. §2 line 47 references "v0.4-rc1 installer" (different format — `v0.4-rc1` vs `v0.4.0-rc1`). §3 line 73 references "v0.4-rc2 installer" (same shorter form).
**Issue**: `v0.4-rc1` vs `v0.4.0-rc1` — two formats. Semver-strict tag is `v0.4.0-rc1`; the "v0.4-rc1" shorthand in prose could be a slip or could intend a different tag.
**Suggested fix**: use `v0.4.0-rcN` consistently in prose to match the table at §6.

## Cross-file findings (if any)

- P1-1: do NOT change 09's "~46" — the fixer for 00/01/02 should bring those *up* to 46, not bring 09 *down* to 22. Make this explicit in the fix-prompt.
