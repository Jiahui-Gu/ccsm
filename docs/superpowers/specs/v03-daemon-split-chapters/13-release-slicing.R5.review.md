# R5 review — 13-release-slicing.md

This is the basis for stage-6 DAG extraction. R5 angle is heaviest here.

## P0

### P0-13-1. Phase 8 (Electron migration) "single PR" but acceptance bundles many sub-deliverables
Phase 8 contents:
- ESLint + grep gate `lint:no-ipc` green.
- All Electron components ported to React Query + generated Connect clients.
- Done when: ship-gate (a) green AND smoke-launch on each OS shows full UX functional.

Plus chapter 08 §5 sequence has 9 sub-steps (a-i). This is **the** big-bang PR by chapter 08 §1 design, but as a downstream DAG node it's a single ~5000+ LOC PR. The R5 instructions say "If phase N has > 5 sub-tasks bundled together, recommend splitting (a single PR shouldn't span 5 components)." 

**Recommendation**: split phase 8 into:
- 8a: Add proto-client wiring + transport bridge + descriptor reader (no behavior change; coexists with IPC).
- 8b: Big-bang IPC removal PR (the cutover; large but mechanical).
- 8c: Cleanup pass (delete dead files, wire CI lint gate).

This **does not** violate brief §3's "big-bang" rule, which is about not having coexisting IPC+Connect code paths in the shipped app — 8a's parallel paths are pre-cutover scaffolding, deleted in 8b.

P0 because the current single-PR design will not pass code review at the LOC budget chapter 13 §4 sets ("< 600 LOC diff target" for "everything else", phase 8 is the explicit exception — but the exception is unbounded).

### P0-13-2. Phase 11(b) depends on phase 4+5+9 but DAG section §3 says `{4,5,6,7,8} → 11{a,b,c,d}`
Section §2 phase 11 says "(b) `sigkill-reattach.spec.ts`" with no dep statement. Section §3 lists 11(b) deps as the union of 4,5,6,7,8. Section §3 then narrates "Phase 11 ship-gates need their corresponding source phases done (a→8, b→4+5+9, c→5, d→10)". 

Three different dep statements:
- Headlong DAG: 11{b} ← {4,5,6,7,8}
- Narration: 11(b) ← 4+5+9
- Implicit (testing strategy 12 §4.2): 11(b) needs Electron present (= phase 8) plus daemon present (= phase 4+5).

**Pick one**. Probably correct: 11(b) depends on phases 4, 5, 8, 9 (Electron + daemon process + PTY for "reattach" + service registration for service-installed nightly variant).

P0 — DAG extraction will produce contradictory edges.

### P0-13-3. Phase ordering omits a "tooling spike" pre-phase
Chapter 14 has 15 MUST-SPIKE items. Several gate phase 2 (transport pick), phase 5 (PTY worker), phase 10 (sea + notarization). The phase list 0-12 has no explicit spike phase — spikes are silently embedded inside phase done-criteria ("All MUST-SPIKE items in [03] resolved" in phase 2; "All MUST-SPIKE items in [06] resolved" in phase 5). 

Spikes can fail (fallbacks may be needed). A failed spike is a chapter-edit, not a phase-redo. Currently downstream extractor sees spike resolution as a sub-task of the implementation phase, which mis-orders work.

**Recommendation**: add explicit spike-resolution phases: Phase 0.5 (transport spikes), Phase 4.5 (PTY worker spike), Phase 9.5 (build/notarization spikes). Or fold spikes into phase 0 + extend done-criteria.

P0 because spikes are gating per chapter 14 §3.

## P1

### P1-13-1. Phase done-criteria measurability
Most are measurable via test pass/fail. Exceptions:
- Phase 0: "runs in CI in < 10 min on a clean cache; > 0% in cached re-run" — second clause "> 0%" is meaningless (any cache hit > 0% qualifies). Pin a target like ">50% cache hit on no-op rebuild".
- Phase 9: "a manual `sc create` (win) / `launchctl bootstrap` (mac) / `systemctl start` (linux) end-to-end works locally" — "manual" + "locally" not CI-verifiable. Pin a CI variant.
- Phase 12: "≥ 1 week of real `claude` CLI usage" + "Daily crash log review" — soft. OK as a process gate, not a CI gate.

### P1-13-2. Phase 2 done-criterion references "Hello-only variant" of `connect-roundtrip`
Chapter 12 §3 lists `connect-roundtrip.spec.ts` as a single test file covering the SessionService RPCs. No "Hello-only variant" mentioned. Either:
- Split the file into `connect-roundtrip-hello.spec.ts` and `connect-roundtrip-full.spec.ts`.
- Use `it.only`-style test filters that the phase 2 CI runs.

State the mechanism.

### P1-13-3. Phase 5 done-criteria omits ship-gate (c) 1-hour soak
Phase 5 done-when: "`pty-attach-stream` + `pty-reattach` + `pty-too-far-behind` integration tests green." Soak is in phase 11(c). OK if ship-gate (c) is a separate validation. But phase 5's "P0 milestone: phase 5 + phase 11 ship-gate (c) is the dogfood quality bar" couples them — clarify the order.

### P1-13-4. DAG ASCII art has dangling/inconsistent edges
```
0 ──► 1 ──► 2 ──► 3 ──► 4 ──► 5
              │            └► 6 (uses crash hooks from session manager)
              │            └► 7
              ├──► 9 (does not need 3-8; gates 10)
              │
              └► 8 ...
```
- The "│" on the left after 2 has 4 outgoing edges (3, 9, 8, ...). Visually shows 2→3, 2→9, 2→8.
- But "3 ──► 4" puts 4 downstream of 3.
- §3 narration says "Phase 1 unblocks phase 2 (server stubs) and phase 8 (client stubs) simultaneously." But ASCII shows 8 hanging off 2, not off 1. Contradiction.

Pick the right graph. The narration is correct (8 needs proto = phase 1). Fix the ASCII.

### P1-13-5. Vague verbs
- §1 "explicit dependencies that allow parallelism" — pinned by §3 narration.
- §4 "no `--no-verify`" — good, pinned.

### P1-13-6. Brief §11 gate-to-phase mapping
Brief §11 has 4 gates a/b/c/d. Chapter 13 §3 maps them to phases. Cross-check:
- (a) ← 8: ✓
- (b) ← 4+5+9 (narration) or 4+5+6+7+8 (DAG): see P0-13-2.
- (c) ← 5: ✓
- (d) ← 10: ✓

OK once P0-13-2 resolved.

## Scalability hotspots
(N/A — phasing chapter)

## Markdown hygiene
- §3 ASCII art OK but see P1-13-4.
- Sub-headings `####` under `###` — consistent.
