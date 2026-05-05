# Review of chapter 01: Cutover audit

Reviewer: R5 (Testability)
Round: 1

## Findings

### P1-1 (must-fix): symptom catalog S1..S9 lacks "test lever" mapping

**Where**: chapter 01, §"Symptom catalog (cited evidence)" table (lines 22-32) and downstream HP rows.
**Issue**: each row maps `S<n> → observed string → affected cases`. Excellent for triage. But there is no column mapping `S<n> → which lever (unit-test, harness case, manual probe) regression-tests it post-fix`. As a result, a fixer landing PR-4 has no spec-anchored way to know whether `terminal-pane-mounted` (S5) is the only regression test, or whether they also need a UT in `tests/components/TerminalPane.test.tsx` (which **does not yet exist** at HEAD `6e3a1bd4` — verified via `ls tests/components/`; chapter 05 PR-4 acceptance falsely claims to "extend" it).
**Why this is P1**: without the symptom→lever map, §1 is a one-way arrow (regression → hypothesis) but not a closed loop (regression → hypothesis → fix → test that catches future regression). The R5 angle is exactly this loop.
**Suggested fix**: add a 5th column "Regression-test lever (post-fix)" with values like:

| S# | … | Regression-test lever |
|----|---|------------------------|
| S1 | … | harness `new-session-chat` + `daemon-port-ready-before-render` (NEW); UT `daemon/ptyHost/__tests__/lifecycle.test.ts` for spawn happy path |
| S2 | … | harness `attach-replay-from-headless-buffer` + `daemon-port-ready-before-render` (NEW) |
| S3 | … | harness `rename` + UT `tests/stores/initialState.test.ts` (NEW per ch02 §5) for sync `__ccsmStore` pin |
| S4 | … | harness `tray` + UT `daemon/api/__tests__/data.test.ts` (NEW per ch05 PR-1) for `loadState` round-trip |
| S5 | … | harness `terminal-pane-mounted` + **NEW** UT `tests/components/TerminalPane.test.tsx` for unconditional host render |
| S6 | … | harness `theme-toggle` + UT `tests/app-effects/useThemeEffect.test.tsx` (extend; file already exists) |
| S7 | … | harness `startup-paints-before-hydrate` + harness `titlebar` (no UT — hydration-ordering is integration-only) |
| S8 | … | harness `dnd` (chained on S3 fix) |
| S9 | … | covered by other Sn after probe-utils refresh — no dedicated lever (latent only) |

This makes it impossible to add a fix without a paired test, and impossible to add a test without first naming which symptom it guards.

### P1-2 (must-fix): HP-4's three sub-causes (R1/R2/R3) need separate verification levers

**Where**: chapter 01, §"HP-4 — `host / term / buffer` readiness flags" (lines 110-133), specifically the R1/R2/R3 hypothesis breakdown (lines 121-131).
**Issue**: the audit usefully separates "host never mounts (R1)", "term never appears (R2)", "buffer never appears (R3)" — but the verdict line just says "FIX (three independent fixes on the same surface)". §3 of chapter 03 wires them all to `waitForTerminalReady` which only returns ONE boolean per call. If a fix lands and `waitForTerminalReady` flips green, you don't know which of R1/R2/R3 was the actual repair — the other two might still be broken and only manifest as flake later. R5 angle: a single green signal cannot confirm three independent properties.
**Why this is P1**: this is the exact failure mode that bites repair work — "the test went green so we shipped it" but only because two of three sub-bugs were latent. Particularly dangerous for HP-8 sigkill-reattach which is the only e2e signal for R3 (buffer fanout).
**Suggested fix**: chapter 01 HP-4 verdict line should require chapter 03 §1 to expose three SEPARATE assertions in `waitForTerminalReady`:

```js
return { host, term, buffer, sid, cols, rows };
```

and chapter 04 §2 `waitForTerminalReady` edits should add three independent UT-level assertions (one per flag) rather than only the composite `host && term && buffer`. Cross-link `chapter 03 §1` and `chapter 04 §2`.

### P1-3 (must-fix): HP-1 acceptance signal is "5s vs 20s" — no UT-tier guard

**Where**: chapter 01, HP-1 verdict and pointer to chapter 02 §2 (lines 44-64).
**Issue**: HP-1 (`__ccsmStore` exposure) is described as a module-evaluation-order bug. Chapter 02 §2 Fix-A pins the assignment "BEFORE any await", which is testable at unit-test tier — a Vitest test can `import('src/stores/store')` and assert `globalThis.__ccsmStore === useStore` synchronously after import resolves. But neither chapter 01 nor chapter 02 §2 mandates that UT. The spec leans entirely on the harness `seedStore` resolving in <5s as the green signal (chapter 02 §2 "Acceptance signal").
**Why this is P1**: a pure-eval-order bug is the *cheapest* thing to UT — one test, no async, no electron. Going to harness for an eval-order bug is a 60s round-trip vs 100ms. The `Why this is P0` framing in chapter 02 §2 Fix-A ("detaching it removes the dependency") is correct but the absence of a UT means a future refactor that re-introduces the await-gate has only the harness as guard, and the harness is the slowest signal.
**Suggested fix**: chapter 01 HP-1 verdict add: "MUST have a Vitest UT in `tests/stores/store-eval-order.test.ts` (NEW) asserting `(window as any).__ccsmStore === useStore` synchronously after `await import('src/stores/store')`. Chapter 02 §2 Fix-A code block already shows the right shape; lift to a UT requirement."

### P2-1 (nice-to-have): HP-13 KEEP verdict has no test guard against accidental resurrection

**Where**: chapter 01, HP-13 (lines 244-247) — `__legacy_to_delete__` removal.
**Issue**: HP-13 says "no functional surface left to repair." Fine. But there's no guard against a fixer accidentally re-introducing `ipcMain.handle('legacy:...')` calls or re-importing `__legacy_to_delete__` paths — a regression that the existing test suite would not catch.
**Why this is P2**: low-likelihood (the dir was deleted, the imports would 404 at TS-compile). Listed only because R5 instinct says "removed thing should have a CI guard against return."
**Suggested fix**: chapter 05 §1 G9 already has `grep diff for ipcRenderer.invoke`. Tighten to also `grep diff for "__legacy_to_delete__"`. One word in one gate row.

### P2-2 (nice-to-have): Q1 / Q2 / Q4 in §"Open audit questions" are reviewer-bait without test consequences

**Where**: chapter 01, §"Open audit questions (lifted to reviewers)" (lines 261-277).
**Issue**: Q1 (`__ccsmStore` gone or installed too late?), Q2 (`loadState` deliberately or accidentally removed?), Q4 (88 .skip source) are all framed as "reviewer to verify by …". R5 ground-truthed Q4 already (see `00-overview.R5.review.md` P0-1: 0 Vitest skips, 1 `skipLaunch`). Q1 / Q2 also have mechanical answers a fixer can run (the ground-truth invocations are already in the question text). The chapter should mark which Qs have been answered post-author-rebase rather than leave them all open.
**Why this is P2**: cosmetic — answers exist or are easy to derive; pure spec hygiene.
**Suggested fix**: under each Q, add a line "**Reviewer-round answer** (R<x>)`: …" once a reviewer ground-truths it. R5 lands the Q4 answer in `00-overview.R5.review.md` P0-1; chapter 01 Q4 should be edited to point there.

## Cross-file findings

P1-1 (symptom→lever map) is the central R5 finding for the audit — it cross-cuts chapter 02 (which UTs to add for HP-1/HP-5), chapter 03 (which UTs for HP-3/HP-4/HP-8/HP-9), chapter 04 (which harness cases for which Sn), chapter 05 (PR acceptance signals must reference the lever). One fixer should add the column AND verify each Sn maps to at least one lever from a downstream chapter. If any Sn cannot be mapped, that's a hidden P0 in the design.

P1-3 (HP-1 UT requirement) is also relevant to chapter 02 §2 — same fixer.
