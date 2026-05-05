# Review of chapter 04: Probe and harness update

Reviewer: R5 (Testability)
Round: 2

## Round-1 closures

- **R1 P0-1 (KEEP/DELETE/FIX/MARK matrix sized for "88" but ground-truth = 1)** — CLOSED. §1 was rewritten in three parts exactly as r1 suggested:
  - **§1.1 Canonical baseline (R5 ground-truth)** (lines 11-39) with the explicit grep commands and the source/count table (0/0/1 KEEP/0/0). dev-574's "88" called out as runner gate-evaluation count, NOT skipped tests.
  - **§1.2 Forward guard (mechanical implementation of iron rule §3.1)** (lines 41-65) — KEEP/DELETE/FIX/MARK rephrased as "any future skip-like introduced during repair MUST be classified as one of these four; ch05 §1 G8 is the gate." Drops the "88" framing.
  - **§1.3 Real triage (capability-flag scope)** (lines 67-86) — calls out explicitly: "v0.3 does not introduce a capability-flag regime" with **0 occurrences** of any of `requiresClaudeBin / windowsOnly / darwinOnly / linuxOnly / skipLaunch` in `tests/`. Confirms §6 acceptance signal #1 satisfied by §1.1, no separate `04a-skip-inventory.md` artifact required.
  Cross-link to ch05 §1 G8 (which now reads against ch04 §1.1 baseline) landed.
- **R1 P0-2 (probe-utils refresh has no ready signal — `seedStore` and `waitForTerminalReady` still poll-with-timeout)** — CLOSED. §2.0 "Ready-signal contract (signal vs poll)" (lines 95-124) now precedes the per-probe edits, with the exact signal-vs-poll table r1 suggested:
  - `seedStore` "wait for `__ccsmStore`" → **sync** (replace `waitForFunction` with single-shot `evaluate`).
  - `seedStore` "wait for app shell" → **event** (`ccsm:app-shell-ready` from App.tsx; PR-2 owner).
  - `waitForTerminalReady` `host` → **event** (`ccsm:terminal-host-mounted`; PR-4 owner).
  - `waitForTerminalReady` `term` → **event** (`ccsm:term-attached`; PR-4 owner).
  - `waitForTerminalReady` `buffer` → **sync** (no separate poll).
  - `daemon-port-ready-before-render` → **sync** (post Option C; first RPC ≤500ms + iteration counter == 0).
  Plus the closing MUST: production-side event emits MUST land in their owner PRs (PR-2 / PR-4); PR-8 consumes via `waitForEvent`. Exactly the dependency-inversion the r1 finding flagged. Cross-cut to ch05 PR-2 / PR-4 / PR-8 acceptance landed (verified below in cross-file).
- **R1 P1-1 (§4 New harness cases lack acceptance bound on test runtime)** — CLOSED. §4 case table (lines 321-326) now has a **Budget (CI wall-clock)** column: `daemon-port-ready-before-render` ≤5s, `sigkill-reattach` n/a in v0.3 (Set B informational, no budget — v0.4 promotion pins it), `loadstate-roundtrip` ≤3s. Per-case bound landed.
- **R1 P1-2 (`reset-between-cases` "verify same store instance" is prose, not code)** — CLOSED. §2 `reset-between-cases.mjs` subsection (lines 226-244) now carries "**Runtime invariant (R5 testability — replaces one-time grep)**" with the exact code shape r1 suggested: `beforeRef = await win.evaluate(...)`, `afterRef = ...`, `assert.strictEqual(beforeRef, afterRef, '__ccsmStore changed between cases — duplicate-store regression')`. The probe itself becomes the regression test. Cross-cut to ch05 PR-8 acceptance "reset-between-cases runtime invariant" line (line 306-309) landed.
- **R1 P1-3 (Set A vs Set B has no map from current red cases to target Set)** — CLOSED. §3 now carries a "Set assignment (R5 testability — Set A vs Set B vs DELETE)" subsection (lines 290-314) requiring `04b-case-set-assignment.md` (NEW) committed by ch04 fixer round, with each currently-red case from `/tmp/t574-e2e.log` assigned exactly one of Set A / Set B / DELETE per §1.2 verdict policy. Plus the sigkill-reattach pin to Set B informational v0.3 (CF-3 manager decision). Both halves r1 asked for.
- **R1 P2-1 (§6 acceptance #2/#3 use absolute timeouts without CI/local distinction)** — NOT closed at the literal level (§6 still says "within 5s on cold launch in CI" / "within 10s on cold launch in CI" — lines 350-352, no p95 / runner-spec qualifier). The §2.0 ready-signal contract now upgrades the underlying probe primitive from poll to event for most steps, which structurally reduces flake risk; but the absolute-timeout numbers in §6 weren't qualified. P2 carryover; not raising again — the §2.0 fix is the load-bearing one.

## Findings

No P0/P1 from R5 testability angle. ch04 absorbed the most foundational round-1 R5 load (signal-vs-poll discipline + skip-baseline reconciliation) and both landed with concrete contracts.

### P2-1 (nice-to-have, carryover from r1): §6 absolute timeouts not qualified per CI runner

**Where**: chapter 04, §6 acceptance signal bullets 2 & 3 (lines 350-352).
**Issue**: still reads "`probe-utils.mjs` `seedStore` resolves within 5s on cold launch in CI" / "`waitForTerminalReady` resolves within 10s on cold launch in CI" — no p95 / runner-spec / measurement-method qualifier. Under CI runner load (Windows GitHub-hosted with concurrent workflows), cold launch p99 can drift past these bounds; a flake passing 9/10 still rides through.
**Why P2**: the §2.0 signal-vs-poll upgrade is the load-bearing flake reduction; absolute-timeout drift is a downstream concern best measured first.
**Suggested fix**: append ", measured at p95 over 10 cold-launch runs on `.github/workflows/e2e.yml`'s default Windows runner; budget reviewed quarterly."

## Cross-file findings

None new. r1 cross-cuts:
- P0-1 (skip baseline) → ch00 §2 bullet 5 + ch01 Q4 + ch04 §1.1 + ch05 §1 G8 — all four landed in one fix pass, baseline lives in ch04 §1.1, others backlink.
- P0-2 (signal vs poll) → production-event emits in PR-2 (App.tsx `ccsm:app-shell-ready`) and PR-4 (TerminalPane `ccsm:terminal-host-mounted` + xtermSingleton `ccsm:term-attached`); PR-8 consumes via `waitForEvent`. ch05 PR-2/PR-4/PR-8 acceptance bullets all carry the cross-PR responsibility note. Verified.

## Verdict

**CLEAN** for ch04. One cosmetic carryover (P2-1 absolute-timeout qualifiers in §6) remains at P2 — not blocking.
