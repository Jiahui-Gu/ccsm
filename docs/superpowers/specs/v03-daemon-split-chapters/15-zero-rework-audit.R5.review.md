# R5 review — 15-zero-rework-audit.md

This is the gate chapter. R5 angle: every brief decision and every chapter cross-ref must resolve.

## P0

### P0-15-1. Verdict on §9 (Daemon runtime: Node 22 sea + native deps) reads "**none** (or **additive** if cloudflared is bundled in install dir)"
This is two verdicts in one cell. If cloudflared is bundled — additive. If not — none. The brief §9 is silent on cloudflared bundling. Pick now (recommend: cloudflared is downloaded by daemon at runtime in v0.4, not bundled by installer → verdict = **none**, with cloudflared lifecycle handled by chapter 02 §7 v0.4 delta which already says "cloudflared subprocess ADDED to daemon supervision"). 

P0 because the audit table is the gate-of-gates; an ambiguous verdict invalidates the gate.

## P1

### P1-15-1. §1 audit table missing brief decision §11 sub-points
Brief §11 has 4 sub-decisions (a, b, c, d). Audit table §1 lists each with verdict. ✓ Complete.

### P1-15-2. §2 audit table coverage spot-check
- Chapter 02 sections: §1, §2.1, §2.2, §3, §4, §5, §6, §7. Audit lists §2.1, §2.2, §3, §4. **Missing**: §1 (process inventory), §5 (install/uninstall responsibility table), §6 (process boundary contract). Each has v0.4 implications:
  - §1: claude CLI per session — v0.4 web/iOS may add more session producers. Verdict needed.
  - §5: install responsibility table — v0.4 adds cloudflared registration. Verdict: additive.
  - §6: Electron MUST tolerate UNAVAILABLE — v0.4 web/iOS contract identical. Verdict: none.
- Chapter 09 §3 retention caps not in audit table — fine, "none".
- Chapter 09 §4 RPC surface — covered transitively by chapter 04 audit row.
- Chapter 11 §6 CI matrix — listed.
- Chapter 11 §7 versioning (Changesets) — **missing from audit**. Verdict: none.
- Chapter 13 phase list — listed.

P1 — gaps in audit coverage are not the ship-blocker the chapter claims to be.

### P1-15-3. §3 forbidden patterns — 12 items
Cross-check each is mechanically detectable:
1. Removing/renaming proto field — `buf breaking`. ✓
2. Reusing field number — `buf breaking`. ✓
3. Changing meaning — manual review (no automation). Add a comment in `.proto`?
4. Modifying `001_initial.sql` — SHA256 lock. ✓
5. SnapshotV1 layout change — no automation. Add a unit test that asserts SnapshotV1 layout against a checked-in golden file.
6. Reshaping listener trait/array — manual.
7. Renaming `principalKey` format — manual + maybe regex.
8. `listener-a.json` field meaning — manual.
9. Supervisor URLs — manual.
10. `packages/` dir rename — `git diff --name-only` regex check.
11. Bypassing lint:no-ipc — `lint:no-ipc` already gates.
12. State dir paths — manual.

7 of 12 are manual review only. R5 P1: add a "v0.4 PR template" with these as checklist items, OR write a CI script that scans for forbidden patterns.

### P1-15-4. §4 sub-decision item 4 — single-PR big-bang vs feature branch
Reviewer-asked-to-confirm. See chapter 13 P0-13-1 — recommend split.

### P1-15-5. §4 sub-decision item 9 — transport bridge ship unconditionally
See chapter 08 P0-08-2.

### P1-15-6. Vague verbs
- §5 "the spec MUST NOT proceed to stage 5 merge" — pinned, good.
- §3 "the v0.3 design picked the wrong shape and we go back to spec" — pinned by brief quote.

## Scalability hotspots
(N/A)

## Markdown hygiene
- §1 + §2 tables OK.
- All links `./N-name.md`. ✓ Relative.
- No heading skips.
