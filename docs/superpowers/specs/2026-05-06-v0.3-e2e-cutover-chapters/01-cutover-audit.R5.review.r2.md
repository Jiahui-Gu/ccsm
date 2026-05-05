# Review of chapter 01: Cutover audit

Reviewer: R5 (Testability)
Round: 2

## Round-1 closures

- **R1 P1-1 (symptom catalog S1..S9 lacks "test lever" mapping)** — CLOSED. The "Symptom catalog" table (lines 22-32) now carries a 5th column "Regression-test lever (post-fix)" that maps every S1..S9 to a concrete harness case + UT. S1→`new-session-chat`+`daemon-port-ready-before-render` NEW + `lifecycle.test.ts` UT + `daemon/api/__tests__/pty.test.ts` NEW; S2→`attach-replay-from-headless-buffer`+`daemon-spawner.test.ts` NEW; S3→`rename`+three NEW UTs (`store-eval-order`/`initialState`/`single-instance`); S4→`tray`+`loadstate-roundtrip` NEW + `data.test.ts` NEW; S5→`terminal-pane-mounted`+`TerminalPane.test.tsx` NEW; S6→`theme-toggle`+`useThemeEffect.test.tsx` EXTEND; S7→harnesses + `persist.test.ts` NEW; S8→chained on S3; S9→PR-8 only (latent). Exactly the closed-loop the r1 finding asked for.
- **R1 P1-2 (HP-4 three sub-causes need separate verification levers)** — CLOSED. HP-4 verdict (lines 143-163) now carries "**R5 testability MUST (3-flag verifiability)**: a single composite `waitForTerminalReady → true` signal is INSUFFICIENT to confirm all three sub-causes are repaired. Chapter 03 §1 MUST expose `host`, `term`, `buffer` as three independent assertions, and ch04 §2 `waitForTerminalReady` MUST return a structured shape `{ host, term, buffer, sid, cols, rows }` (not a single boolean). Probe callers MUST assert each flag independently…" — and ch05 PR-8 acceptance pins the structured-shape return (line 304). The r1 P1-2 ask is fully landed.
- **R1 P1-3 (HP-1 acceptance signal needs UT-tier guard)** — CLOSED. HP-1 (lines 44-65) now carries "**MUST UT (R5 testability lever)**: a Vitest UT in `tests/stores/store-eval-order.test.ts` (NEW) MUST assert `(globalThis as any).__ccsmStore === useStore` synchronously after `await import('src/stores/store')` resolves, and that no awaited callback runs between module evaluation and the assignment." That UT is also pinned in ch02 §4 lever table I-1 row and in ch05 PR-2 acceptance. Cross-chapter consistency verified.
- **R1 P2-2 (Q4 reviewer-bait)** — CLOSED. Q4 (lines 324-340) now carries `[**RESOLVED — R5**]` tag and the canonical 0/1/0/0 baseline. Q1/Q2 not annotated (the r1 ask was P2 cosmetic), but the substance of Q1 is answered by HP-1 §"Hypothesis" + the new MUST UT, and Q2 is answered structurally by the HP-2 fix in ch02 §3. Not raising again.
- **R1 P2-1 (HP-13 grep guard)** — NOT CLOSED at the literal level (the chapter 05 §1 G9 grep was not extended to also grep for `__legacy_to_delete__`). However the original underlying risk (re-import of deleted dir would 404 at TS-compile) is structurally guarded by `npm run typecheck` (G2). Pure cosmetic hardening; remains P2; not raising.

## Findings

No P0/P1 from R5 testability angle. The audit chapter now closes the symptom→fix→test loop end-to-end.

### P2-1 (nice-to-have, carryover from r1): Q1/Q2 still phrased as open questions

**Where**: chapter 01, §"Open audit questions" Q1 (lines 314-317) and Q2 (lines 318-320).
**Issue**: Q4 got the `[RESOLVED — R5]` treatment in r1; Q1/Q2 did not. Q1 ("Is `__ccsmStore` legitimately gone post-cutover, or is the binding present but installed too late?") is structurally answered by HP-1 §"Hypothesis" (assignment runs at module eval but bundle defers loading) and the new MUST UT pins the answer at unit-test tier. Q2 ("Was `window.ccsm.loadState` deliberately removed, or accidentally?") is structurally answered by HP-2 + the ch02 §3 re-export contract. The Qs read as unfinished work despite both being settled by the design.
**Why P2**: cosmetic spec hygiene; not load-bearing for any fixer (the relevant chapters carry the answers).
**Suggested fix**: under each of Q1/Q2, add a short `**Answered (round-2)**: Q1 → see HP-1 hypothesis + new MUST UT in `tests/stores/store-eval-order.test.ts`; the ch02 §2 Fix-A code block lifts the assignment to module-eval. Q2 → see HP-2 hypothesis + ch02 §3 required preload-bridge shape.`

## Cross-file findings

None new. All r1 cross-cutting (symptom→lever feeds into ch05 §3.0 closure map; HP-1 UT pinned in ch01 + ch02 §4 + ch05 PR-2; HP-4 3-flag pinned in ch01 + ch03 §1 + ch04 §2 + ch05 PR-8) landed coherently in one fix pass.

## Verdict

**CLEAN** for ch01. Two cosmetic carryovers (Q1/Q2 not annotated, HP-13 grep not tightened) remain at P2 and are not blocking.
