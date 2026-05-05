# Review of chapter 05: Release slicing & DAG

Reviewer: R5 (Testability)
Round: 2

## Round-1 closures

- **R1 P0-1 (PR-4 acceptance references non-existent test path)** — CLOSED. PR-4 "Files touched" (lines 190-194) now reads `tests/components/TerminalPane.test.tsx` **(NEW** — file does NOT exist at HEAD `5d0c5375`; verified `ls tests/components/` and `ls tests/terminal/`. The conventional path matches `src/components/TerminalPane.tsx`)**. Both r1 axes fixed: (a) NEW not EXTEND, (b) `tests/components/` not `tests/terminal/`. Plus PR-4 Acceptance now lists the same 3 UT cases as ch03 §1 (claudeAvailable false / crashed / idle). Verified at HEAD: file does NOT exist — NEW correct.
- **R1 P0-2 (`daemon/api/__tests__/` is NEW dir, not extend)** — CLOSED. §3 has a path-existence note at the top (lines 79-87) explicitly listing which `__tests__/` subdirs do NOT yet exist, and PR-1 / PR-5 "Files touched" lines now read **NEW directory + file** with the inline note "the `daemon/api/__tests__/` subdir does not exist at HEAD `5d0c5375`; PR-1 creates it implicitly" (line 119) and "**(NEW; also creates the `daemon/api/__tests__/` directory if PR-1 has not landed first**)" (line 232-233). Both r1 sub-asks landed.
- **R1 P0-3 (G8 wording pre-supposes non-zero skip baseline)** — CLOSED. G8 (line 21) now reads "Vitest skip total = 0 (`it.skip / test.skip / describe.skip / xit / xdescribe` in `tests/ src/ daemon/ electron/`); harness skip-flag count (`skipLaunch / requiresClaudeBin / windowsOnly / darwinOnly / linuxOnly` set true on a case) ≤ ch04 §1.1 baseline (currently 1: `cap-skip-launch-bundle-shape` KEEP)" — the "0 absolute" + "≤ baseline (currently 1, capability demo)" split exactly matches r1 P0-3 suggested wording; ambiguity gone. Cross-link to ch04 §1.1 carried.
- **R1 P1-1 (G5/G6/G7 "two consecutive runs" lacks definition)** — CLOSED. G5/G6/G7 (lines 18-20) now each read "**two consecutive runs in the same CI workflow invocation** (i.e., the e2e job is configured to run twice and both passes are required — NOT two separate PR-trigger runs, NOT two consecutive merges)" — exactly the disambiguation r1 asked for. Tooling column also updated to "`.github/workflows/e2e.yml` job (matrix re-run × 2; both green)".
- **R1 P1-2 (DAG has no PR for symptom→test-lever wiring)** — CLOSED. §3.0 "Symptom-to-PR closure map (R5 testability — closes the loop from ch01)" subsection (lines 89-112) now provides the full S1..S9 → PR(s) → verification-lever mapping, AND notes "each PR's 'Acceptance' subsection below must list its contribution to closing the symptoms in the column above. A PR that claims to close a symptom but does NOT carry its corresponding lever (harness case or UT) is incomplete." The cross-axis lever (ch01 §"Symptom catalog" 5th column) and closing-PR (here) are mutually consistent. Verified row-by-row.
- **R1 P1-3 (PR-3 acceptance has no "timeout-rejected" test for `spawnDaemon`)** — CLOSED. PR-3 "Files touched" (lines 156-160) now lists `electron/__tests__/daemon-spawner.test.ts` **(NEW)**; PR-3 Acceptance (lines 165-175) lists exactly four UT cases per ch03 §3 R5 P0-2: PORT happy / malformed / EOF / 10s timeout, with `vi.useFakeTimers()`. The 10s timeout case is explicitly called out as "the load-bearing test for the Option C contract (a hung daemon must not silently hang Electron startup)". Plus the cold-launch budget acceptance (lines 176-182) auto-falls-back to Option B on >500ms p95 regression, no manager re-deliberation. Verified `electron/__tests__/daemon-spawner.test.ts` does NOT exist at HEAD — NEW correct.
- **R1 P1-4 (PR-8 dependency on PR-2/PR-4 production-event emits not modeled)** — CLOSED. PR-2 Acceptance (lines 142-148) now carries "Acceptance (production-event emit, R5 P1-4 cross-PR responsibility): App.tsx MUST fire `window.dispatchEvent(new Event('ccsm:app-shell-ready'))` at end of its first useEffect (after first commit). The probe in PR-8 consumes this via `waitForEvent` per ch04 §2.0; without the emit landing in PR-2, PR-8's probe degrades silently to polling. Verify in `tests/AppShell.test.tsx`…" PR-4 Acceptance (lines 213-222) carries the analogous responsibility for `ccsm:terminal-host-mounted` (TerminalPane) + `ccsm:term-attached` (xtermSingleton). PR-8 Acceptance (lines 296-305) is the consumer side: "MUST replace `waitForFunction` polls with `waitForEvent` calls for the three production-emit events landed by PR-2 / PR-4." All three PR contracts now visibly own their slice of the signal-based-probe contract.
- **R1 P2-1 (PR-9 has no rollback plan)** and **R1 P2-2 (Risk-3 sigkill scope creep has no kill-switch criterion)** — NOT closed at the literal level (PR-9 still has no rollback paragraph, Risk-3 still says "escalate" without defer-criterion). Both are P2 contingency-planning items. Risk-3 is partially superseded by the manager round-1 decision to defer all sigkill new-semantics to v0.4 (see ch03 §7 + ch04 §3 sigkill Set B pin) — the scope-creep risk is much smaller now because PR-6 explicitly does NOT introduce new TTL/cap/eviction. Not raising again.

## Findings

No P0/P1 from R5 testability angle. ch05 absorbed a heavy round-1 R5 load (3 P0 + 4 P1) and landed all of them with explicit acceptance bullets, NEW/EXTEND annotations grounded at HEAD, and cross-PR signal-emit ownership.

## Cross-file findings

None new. All r1 cross-cuts:
- P0-1 (PR-4 path) → cross-cut to ch03 §1 — both chapters now name the same path + 3 UT cases.
- P0-2 (NEW dir annotations) → cross-cut to ch02 §3 — both chapters carry the NEW dir + file note.
- P0-3 (G8 wording) → cross-cut to ch04 §1.1 baseline — G8 reads against §1.1 baseline; consistency verified.
- P1-2 (symptom→PR map) → cross-cut to ch01 §"Symptom catalog" 5th column — both axes (lever-by-symptom and PR-by-symptom) carry the same harness/UT names; row-by-row consistent.
- P1-4 (production-event emits) → cross-cut to PR-2 + PR-4 + PR-8 — all three carry consistent responsibility notes; ch04 §2.0 is the single contract.

## Verdict

**CLEAN** for ch05. Two P2 carryovers (PR-9 rollback paragraph, Risk-3 kill-switch criterion) remain non-blocking — and Risk-3 is structurally reduced by the round-1 manager decision to defer sigkill new-semantics to v0.4.
