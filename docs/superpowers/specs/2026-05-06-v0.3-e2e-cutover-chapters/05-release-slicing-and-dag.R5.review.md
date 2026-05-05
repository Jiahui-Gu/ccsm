# Review of chapter 05: Release slicing & DAG

Reviewer: R5 (Testability)
Round: 1

## Findings

### P0-1 (BLOCKER): PR-4 acceptance references a non-existent test file path

**Where**: chapter 05, §3 "PR-4 — TerminalPane host unconditional (HP-4 R1)", "Files touched" line: `tests/terminal/TerminalPane.test.tsx (extend)` (line 119).
**Issue**: ground-truth at HEAD `6e3a1bd4`:
- `ls tests/terminal/` → `usePtyAttach.test.tsx`, `useTerminalResize.test.tsx`, `useXtermSingleton.test.tsx`. **No `TerminalPane.test.tsx`.**
- `ls tests/components/` → 15 test files, **no `TerminalPane.test.tsx`** either.

The acceptance "extend" is wrong on two axes: (a) the file does not exist, so it's CREATE not EXTEND; (b) the conventional path is `tests/components/TerminalPane.test.tsx` (matching its source `src/components/TerminalPane.tsx`), not `tests/terminal/`.
**Why this is P0**: PR-4 is the load-bearing PR for HP-4 R1 (host renders unconditionally — verified at `src/components/TerminalPane.tsx:122` returns `null` today, exactly the gating pattern the spec forbids). Without a UT, the only regression test is the harness `terminal-pane-mounted` case — a 60s+ signal vs a 100ms UT. Worse, the fixer following the spec literally will look for `tests/terminal/TerminalPane.test.tsx`, not find it, and either skip the UT (silent regression) or re-derive the path (delay).
**Suggested fix**: change PR-4 "Files touched" to:

```
tests/components/TerminalPane.test.tsx (NEW)
src/components/TerminalPane.tsx
src/terminal/xtermSingleton.ts
```

And add to PR-4 Acceptance:

> UT covers `claudeAvailable: false`, `claudeAvailable: true + exitKind: 'crashed'`, `claudeAvailable: true + kind: 'idle'` — in all three, `getByTestId('terminal-host')` resolves; the host element exists with the correct `data-sid`.

Cross-link to chapter 03 §1 R5 P0-1 (same finding).

### P0-2 (BLOCKER): PR-1 / PR-5 acceptance references `daemon/api/__tests__/` directory that does not exist

**Where**: chapter 05, §3 PR-1 (line 82) and PR-5 (line 130).
**Issue**: `ls daemon/api/__tests__/` → directory does not exist at HEAD. PR-1 acceptance writes "`daemon/api/__tests__/data.test.ts` (extend)" and PR-5 writes "`daemon/api/__tests__/pty.test.ts` (new)". Same bug pattern as P0-1 — "extend" is wrong (the dir doesn't exist).
**Why this is P0**: PR-1 fixer will look for the file/dir, not find it, and either inline the tests under a different path (drift from spec) or skip the UT (regression). PR-5 says "(new)" which is correct, but the directory itself is also new — needs to be stated, otherwise the fixer's `mkdir` step is invisible to reviewers.
**Suggested fix**:
- PR-1 "Files touched": `daemon/api/__tests__/data.test.ts (NEW directory + file)`.
- PR-5 "Files touched": `daemon/api/__tests__/pty.test.ts (NEW; also creates the __tests__ directory)`.

Add a one-line note at the top of §3: "Where a test path indicates a __tests__ subdirectory that does not yet exist, the PR creates the directory implicitly. Author has verified the existence of the listed source files at HEAD `6e3a1bd4`."

### P0-3 (BLOCKER): G8 gate language pre-supposes a non-zero skip baseline; should pin "zero skip introduced relative to ZERO" not "relative to 35b08d15"

**Where**: chapter 05, §1 gate G8 (line 21): "NO new `it.skip / xtest / xit / harness skip flag` introduced relative to `35b08d15`".
**Issue**: ground-truth (R5, see `04-probe-and-harness-update.R5.review.md` P0-1): at `35b08d15` the count is **0 Vitest `.skip` and 1 `skipLaunch:true`** (capability demo, not a regression skip). G8's "relative to 35b08d15" wording is correct in spirit but reads as if there's a baseline of skips to compare against. Cleaner: "the count of `it.skip / xtest / xit / harness skip flags excluding `cap-skip-launch-bundle-shape` (capability demo) MUST remain exactly 0 in this branch."
**Why this is P0**: ambiguous gate wording is what causes "but my PR didn't add any!" debates at merge time. The G8 mechanical check (grep diff in PR body) needs an unambiguous numerical target. Right now it could be interpreted as "0 new" (relative count) or "0 total" (absolute count) — both happen to be the same number today because the baseline is 0, but only if the baseline is documented.
**Suggested fix**: rewrite G8:

> G8 | Total `it.skip / test.skip / describe.skip / xit / xdescribe` count in `tests/ src/ daemon/ electron/` MUST be exactly 0. Total harness skip-flags (`skipLaunch / requiresClaudeBin / windowsOnly / darwinOnly` set to `true` on a case) MUST not exceed the baseline at `35b08d15` (canonical inventory in chapter 04 §1.1 per R5 reconciliation). | `grep -rEn "(it\|test\|describe)\.skip\(\|\\bxit\\b\|\\bxdescribe\\b" tests/ src/ daemon/ electron/` returns 0; harness flag count diff'd against chapter 04 §1.1.

Cross-link to chapter 04 §1.1 (R5 P0-1).

### P1-1 (must-fix): G5/G6/G7 "two consecutive runs" lacks definition

**Where**: chapter 05, §1 gates G5/G6/G7 (lines 18-20).
**Issue**: "two consecutive runs" — does this mean two runs in the same CI workflow invocation, or two separate PR-trigger runs (gated by manual re-run), or two consecutive merges? The reading affects how a fixer demonstrates green: a one-shot CI may pass once and fail once due to flake; "consecutive" should clarify whether that counts as 0 or 1 of the required 2.
**Why this is P1**: ambiguous gate is a merge-time blocker.
**Suggested fix**: clarify: "two consecutive runs of the e2e job in the same CI workflow invocation, both green — i.e., the e2e job is configured to run twice and both passes are required." Update `.github/workflows/e2e.yml` matrix accordingly (called out as PR-9 task).

### P1-2 (must-fix): DAG has no PR for symptom→test-lever wiring (S1..S9)

**Where**: chapter 05, §2 PR DAG and §3 PR contracts.
**Issue**: chapter 01 §"Symptom catalog" lists 9 symptoms; the DAG covers 9 PRs but PR-N→symptom mapping is implicit. Some symptoms have no PR-named owner (S7 partial — covered by HP-2 fix in PR-1 plus HP-5 in PR-7, but the chapter 05 narrative doesn't say which PR closes S7 alone vs in combination).
**Why this is P1**: at gate-merge time, a question like "which PR was supposed to close S6?" should have a one-line answer. Currently you have to follow chapter 01 → chapter 02 / 03 → chapter 05.
**Suggested fix**: add a §3.0 "Symptom-to-PR closure map":

| Symptom | Closing PR(s) | Verification |
|---------|---------------|--------------|
| S1 | PR-3 + PR-4 + PR-5 | harness `new-session-chat` etc. |
| S2 | PR-3 + PR-6 | harness `attach-replay-from-headless-buffer` |
| S3 | PR-2 | harness `rename` etc. |
| S4 | PR-1 | harness `tray`, `close-dialog-is-native` |
| S5 | PR-3 + PR-4 | harness `terminal-pane-mounted` |
| S6 | PR-7 | harness `theme-toggle` |
| S7 | PR-1 + PR-2 + PR-7 | harness `titlebar`, `startup-paints-before-hydrate` |
| S8 | PR-2 (via S3 chain) | harness `dnd` |
| S9 | PR-8 | (no dedicated harness — diagnostic layer) |

This is the chapter-01 R5 P1-1 lever map, viewed from the PR side.

### P1-3 (must-fix): PR-3 acceptance has no "timeout-rejected" test for `spawnDaemon`

**Where**: chapter 05, §3 PR-3 acceptance (lines 109-110).
**Issue**: "harness `attach-replay-from-headless-buffer` no longer reports `daemon port unavailable after 5s`; new `daemon-port-ready-before-render` harness case is green." But the failure mode "daemon never prints PORT line / hangs forever" — which the Option C decision opens up (since we now `await spawnDaemon()`) — has no acceptance test. See chapter 03 §3 R5 P0-2 for the underlying contract gap.
**Why this is P1**: a hung `spawnDaemon` becomes a hung Electron launch — worse user-visible failure than the current "5s then error toast." A UT for the timeout boundary is needed.
**Suggested fix**: add to PR-3 Files touched: `electron/__tests__/daemon-spawner.test.ts (NEW)`. Add to Acceptance: "UT covers PORT-line happy path, malformed PORT line rejects, stdout-EOF rejects, 10s timeout rejects."

### P1-4 (must-fix): PR-8 "LAST" position is right but the dependency on PR-2/PR-4 production-event-emits is not modeled

**Where**: chapter 05, §3 PR-8 (lines 166-177) and §2 DAG.
**Issue**: per chapter 04 §2 R5 P0-2, a clean probe-utils refresh requires the production code to emit events (`ccsm:app-shell-ready`, `ccsm:terminal-host-mounted`, `ccsm:term-attached`) so probes can `waitForEvent` instead of `waitForFunction` poll. Those event-emits belong in PR-2 (App.tsx, store) and PR-4 (TerminalPane, xtermSingleton). PR-8 currently only edits `scripts/`. If PR-8 lands first vs PR-2/PR-4, the probes have nothing to wait on. The DAG correctly orders PR-8 after PR-2/PR-4/PR-6/PR-7 — but the production-side event-emit responsibility is invisible.
**Why this is P1**: a fixer assigned PR-2 will not know they need to add a `dispatchEvent` line unless the spec says so. PR-8's signal-based probe story silently degrades to poll-based.
**Suggested fix**: add to PR-2 acceptance: "App.tsx fires `window.dispatchEvent(new Event('ccsm:app-shell-ready'))` at end of first useEffect; verify in `tests/AppShell.test.tsx`." Add to PR-4 acceptance: "TerminalPane fires `window.dispatchEvent(new Event('ccsm:terminal-host-mounted', { detail: { sid } }))` once host is in DOM; xtermSingleton fires `'ccsm:term-attached'` post-`open()`. Verify in respective UTs."

### P2-1 (nice-to-have): PR-9 "v0.3 lock" has no rollback plan

**Where**: chapter 05, §3 PR-9 (lines 179-187).
**Issue**: PR-9 bumps version, edits CHANGELOG, verifies gates. If a post-merge regression surfaces (Set A flake on production traffic), how does the team revert? Single-commit revert of PR-9 only reverts the version bump; the underlying PRs remain.
**Why this is P2**: nominal hardening; v0.3.1 follow-up is mentioned in §6 already.
**Suggested fix**: one sentence: "Rollback policy: if a Set A regression is detected within 24h of v0.3 release, revert PR-9 (un-bumps version) and open v0.3.1 with the targeted fix; do NOT revert PR-1..PR-8 individually."

### P2-2 (nice-to-have): Risk-3 (sigkill UT scope creep) has no kill-switch criterion

**Where**: chapter 05, §7 Risk-3 (lines 230-232).
**Issue**: "If so, scope creep into v0.3 — escalate." But to whom, and at what point in the PR-6 timeline? A late escalation (PR-6 is in review when the bug surfaces) loses calendar time.
**Why this is P2**: contingency planning, not blocking.
**Suggested fix**: "Kill-switch: if PR-6 UT surfaces a daemon supervision bug requiring >3 days of fix work, defer the supervision fix to v0.4 reliability spec, mark sigkill-reattach as 'snapshot retention only' (no daemon-side process supervision), and document the deferred behavior in `setB-regression-log.md`."

## Cross-file findings

P0-1 (PR-4 path) — fix in chapter 05 §3 PR-4 + chapter 03 §1 (R5 P0-1). One fixer.

P0-2 (`daemon/api/__tests__/` is NEW dir) — fix in chapter 05 §3 PR-1/PR-5 + chapter 02 §3 (R5 P1-2). One fixer.

P0-3 (G8 wording) — fix in chapter 05 §1 G8 + chapter 04 §1.1 (R5 P0-1) baseline reconciliation. One fixer.

P1-2 (symptom→PR map) is a chapter 05 addition referencing chapter 01 R5 P1-1's symptom→lever map — same fixer should land both columns (lever + closing-PR) in one cross-chapter pass.

P1-4 (production-event emits) cross-cuts PR-2, PR-4, PR-8 — needs to be added to all three PR contracts.
