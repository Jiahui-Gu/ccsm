# Review of chapter 04: Probe and harness update

Reviewer: R5 (Testability)
Round: 1

## Findings

### P0-1 (BLOCKER): §1 KEEP/DELETE/FIX/MARK matrix is sized for "88 entries" but ground-truth = 1 entry

**Where**: chapter 04, §1 "Skip inventory & reconciliation" (lines 9-84).
**Issue**: R5 ground-truthed at HEAD `6e3a1bd4`:

```bash
$ grep -rEn "(it|test|describe)\.skip\(|\bxit\b|\bxdescribe\b" \
    --include='*.ts' --include='*.tsx' --include='*.js' tests/ src/ daemon/ electron/
# 0 matches  (also: 0 \.skip\( in any *.ts, *.tsx, *.js)

$ grep -rn "skipLaunch" --include='*.mjs' scripts/
# scripts/probe-helpers/harness-runner.mjs : 13 references (the runner mechanism)
# scripts/harness-ui.mjs:1624 : { id: 'cap-skip-launch-bundle-shape', skipLaunch: true, ... }
```

**Reconciliation conclusion (canonical, Q4 answer)**:

| Source | Count |
|--------|-------|
| Vitest `it.skip / test.skip / describe.skip / xit / xdescribe` | **0** |
| `vitest.config.ts` exclude patterns (manager-listed in §1) | (verify by reviewer extracting `vitest.config.*` — none above standard `node_modules/dist`) |
| Harness `requiresClaudeBin: true` | (full grep needed; spec previously narrated 88 — actual count is small, likely <5) |
| Harness `windowsOnly` / `darwinOnly` | (full grep needed; likely <10 combined) |
| Harness `skipLaunch: true` | **1** (`cap-skip-launch-bundle-shape`, capability demo, KEEP) |
| Body-level early-return silent bypasses (`if (...) return;`) | not enumerated — likely the source of dev-574's "88" if any (chapter 04 §1 hypothesis 2) |

The author already documented this honestly in §1 "Author finding" (lines 11-34). The bug is that the verdict policy (KEEP/DELETE/FIX/MARK, lines 67-84) is framed as a triage of "every skip-like entry" — when the ground truth is essentially **nothing to triage**. The verdict policy makes sense as a forward guard ("if a future PR introduces a skip-like, classify it as one of these four") but is currently load-bearing on a backlog that doesn't exist.

§1 ends with "Iron rule reminder: NO case may be re-classified as skip in v0.3 under any verdict." — this is the right load-bearing sentence; the verdict policy paragraphs above it should be restructured to support this rule, not to triage 88 phantom skips.

**Why this is P0**: chapter 04 §6 acceptance signal #1 ("A canonical skip inventory is committed") is currently un-actionable. A fixer cannot deliver `04a-skip-inventory.md` because there is no inventory to deliver. Either the acceptance is "the inventory is one row long" (which is fine and should be stated) or the spec's KEEP/DELETE/FIX/MARK matrix gets retasked to actually-existing entries (`requiresClaudeBin / windowsOnly / darwinOnly` cases — those DO exist and need a real triage).

**Suggested fix**: rewrite §1 in three parts:

1. **§1.1 Canonical baseline (R5 ground-truth)**: the table above, with R5's enumeration as the answer to Q4. Mark the question CLOSED.
2. **§1.2 Forward guard (iron rule §3.1 mechanical implementation)**: the verdict policy KEEP/DELETE/FIX/MARK — rephrased as "any future skip-like introduced during repair MUST be classified as one of these four; chapter 05 §1 G8 is the gate." Drop the "88" framing entirely.
3. **§1.3 Real triage (the actually-existing flag set)**: the `requiresClaudeBin / windowsOnly / darwinOnly` cases DO exist on `35b08d15` (count ≤15 across three harnesses, per §1 hypothesis). Enumerate each, apply KEEP/DELETE/FIX/MARK. This is the actual reviewer-round work product. The dev-574-cited "88" was a runner-evaluation count, not a case count — the real case count is small and triageable in one pass.

Update §6 acceptance signal #1 to: "§1.3 triage of `requiresClaudeBin / windowsOnly / darwinOnly` cases is committed (filename TBD; expect ≤15 entries, not 88)."

### P0-2 (BLOCKER): probe-utils refresh has no "ready signal" — `seedStore` and `waitForTerminalReady` are still poll-with-timeout, not event-driven

**Where**: chapter 04, §2 "probe-utils refresh", `seedStore` and `waitForTerminalReady` subsections (lines 93-148).
**Issue**: chapter 02 §2 acceptance signal is "`seedStore` resolves within 5s." Chapter 04 §2 `seedStore` edits are: drop timeout 20s→8s, replace `'aside'` selector with `[data-testid="app-shell-ready"]`. Both edits make the poll faster, but it's still a `waitForFunction` poll. R5 angle: a poll has no ready signal — it has a *timeout*. The fix discussed in chapter 02 §2 (sync `__ccsmStore` pin at module eval) makes the property *immediately true* on first DOM-ready, so a poll is the wrong primitive — it should be a single check. Same for `waitForTerminalReady`: post chapter 03 §1 fix, host renders unconditionally, so `host:true` should be observable on first paint, not after 200ms × N polls.

The §2 edits also keep `waitForTerminalReady`'s `term:false → poll → term:true` model, which is fine ONLY if there's no event the renderer fires when `__ccsmTerm` is pinned. But chapter 03 §1 `term` subsection mandates "`window.__ccsmTerm = term` … BEFORE the first attach RPC" — that's a sync assignment with no event. So polling is forced.

**Why this is P0**: the entire spec's "tighten timeouts" story (chapter 04 §6 acceptance, chapter 05 §3 PR-8) rests on these probes. If the tightening isn't backed by a *signal* the probe can wait on (vs a timing assumption), the probes will flake under CI load — the exact failure mode chapter 04 §6 #2/#3 ("resolves within 5s/10s in CI") will paper over until it doesn't.

**Suggested fix**: add a §2.0 "Ready-signal contract" subsection BEFORE the per-probe edits:

> Each probe MUST distinguish between **"signal-based wait"** (deterministic: probe blocks on a specific event/promise that fires when the property becomes true) and **"poll-with-timeout"** (best-effort: probe re-checks every Nms until either truthy or timeout). The two have very different flake profiles.
>
> | Probe | Signal type | Signal source |
> |-------|-------------|---------------|
> | `seedStore` step "wait for `__ccsmStore`" | sync (post chapter 02 §2 fix) | `globalThis.__ccsmStore` is set at module eval; replace `waitForFunction` with single-shot `evaluate` after `domcontentloaded` |
> | `seedStore` step "wait for app shell" | event | App.tsx fires custom event `ccsm:app-shell-ready` after first effect; probe `waitForEvent('ccsm:app-shell-ready')` instead of polling for `[data-testid="app-shell-ready"]` |
> | `waitForTerminalReady` `host` flag | event | TerminalPane fires `ccsm:terminal-host-mounted` in `useEffect([sid])`; probe `waitForEvent` |
> | `waitForTerminalReady` `term` flag | event | xterm singleton fires `ccsm:term-attached` after `term.open()`; probe `waitForEvent` |
> | `waitForTerminalReady` `buffer` flag | sync (true iff `term` true) | drop separate poll; assert in same step |
> | `daemon-port-ready-before-render` (NEW) | sync | post Option C, port is resolved at first JS execution; assert `await ccsmPty.getDaemonPort()` returns immediately (≤1 RTT) |
>
> Probes that lack a signal source MAY remain poll-with-timeout but MUST document why (in a code comment) and MUST log every poll iteration at TRACE level so flake post-mortem is possible.

This converts the chapter from "make polls faster" to "use signals where possible, document where polls are forced." The chapter 02 §2 fix IS a signal (sync at eval); chapter 04 §2 should leverage that.

### P1-1 (must-fix): §4 New harness cases lack acceptance bound on test runtime

**Where**: chapter 04, §4 "New harness cases required by spec" (lines 206-223).
**Issue**: three new cases are proposed, with single-sentence "Asserts" descriptions. No per-case timeout budget. No flake budget. No "this case takes <N seconds on CI" bound. Chapter 05 §1 G5/G6/G7 require "two consecutive runs" green — without a per-case time budget, a flaky case that passes 2× in 3 might still ride through.
**Why this is P1**: harness CI cycle time is the manager's #1 cost driver per chapter 01 R4 P2-1. Adding three cases without a budget means the cycle silently grows.
**Suggested fix**: add per-case row "Budget" column:

| Case id | Assertion | Budget (CI) |
|---------|-----------|-------------|
| `daemon-port-ready-before-render` | first RPC ≤200ms | total case ≤5s |
| `sigkill-reattach` | full flow ≤30s | total case ≤45s (TTL boundary) |
| `loadstate-roundtrip` | save+load ≤200ms | total case ≤3s |

If a case exceeds budget twice, manager downgrades to Set B and opens a v0.4 ticket.

### P1-2 (must-fix): §2 `reset-between-cases` "verify same store instance" is asserted in prose but not in code

**Where**: chapter 04, §2, "scripts/probe-helpers/reset-between-cases.mjs" subsection (lines 162-166).
**Issue**: "Verify it resets `window.__ccsmStore.setState({...initial})` correctly — i.e. the store reference is the SAME instance across cases (HP-1 double-store risk)." This is a one-time verify, not a regression test. Same pattern as chapter 02 §2 Fix-B — a "MUST grep" without a CI guard.
**Why this is P1**: the duplicate-store failure is silent (no error, just frozen UI). One-time verify won't catch a v0.4 reintroduction.
**Suggested fix**: in `reset-between-cases.mjs`, add a runtime invariant:

```js
// At case-N start:
const beforeRef = await win.evaluate(() => (window as any).__ccsmStore);
// ... reset ...
const afterRef = await win.evaluate(() => (window as any).__ccsmStore);
assert.strictEqual(beforeRef, afterRef, '__ccsmStore changed between cases — duplicate-store regression');
```

The probe itself becomes the regression test. No separate UT needed.

### P1-3 (must-fix): §3 Set A vs Set B has no map from current red cases to target Set

**Where**: chapter 04, §3 "Set A vs Set B (dogfood)" (lines 168-204).
**Issue**: §3 lists Set A candidate cases (post-fix) and describes Set B cases generically. But chapter 01 §"Symptom catalog" enumerates the currently-red cases by name; §3 doesn't connect them ("which currently-red case ends up in Set A vs Set B post-fix?"). The Set A list in §3's table includes some cases (`tray`, `theme-toggle`, `attach-replay-from-headless-buffer`) that are currently red — good. But what about `requiresClaudeBin: true` cases — they're red on Linux CI today, presumably; §3 says they "likely belong in Set B" but never decides.
**Why this is P1**: G5/G6/G7 in chapter 05 §1 gate the merge on "Set A green twice in a row." Without a final Set A list, a fixer doesn't know which cases must turn green and which can stay red.
**Suggested fix**: in §3, add a final "Set assignment" subsection (post-reviewer-round):

> Post-R5, each currently-red case in `/tmp/t574-e2e.log` is assigned exactly one of {Set A, Set B, DELETE} per chapter 04 §1.3 verdict policy. The list is committed to `04b-case-set-assignment.md` (NEW) by the chapter 04 fixer. Cases not on either Set A or Set B that aren't DELETE are MARK (deferred to v0.4).

### P2-1 (nice-to-have): §6 acceptance signal #2/#3 use absolute timeouts without CI/local distinction

**Where**: chapter 04, §6 (lines 232-239).
**Issue**: "`seedStore` resolves within 5s on cold launch in CI" — but a slow CI runner under load may not hit 5s. Today's CI may or may not match dev's primary box. A timeout that's tight on dev and tight-but-passing on CI is a flake source.
**Why this is P2**: until measured, can't say if 5s is too tight.
**Suggested fix**: add ", measured at p95 over 10 runs on `.github/workflows/e2e.yml`'s default Windows runner" to each timeout. Or split: "≤3s on dev's primary box, ≤8s on CI."

## Cross-file findings

P0-1 (skip-baseline reconcile) cross-cuts chapter 00 §2 (R5 P0-1) and chapter 01 Q4 (R5 P2-2). Single fixer lands all three; canonical answer-text lives in chapter 04 §1.1 with backlinks from 00 and 01.

P0-2 (signal vs poll) cross-cuts chapter 02 §2 (which provides the sync `__ccsmStore` signal) and chapter 03 §1 (which provides the unconditional-host signal). Same fixer should add the corresponding `dispatchEvent('ccsm:...')` lines in production code AND the `waitForEvent` calls in probes. If done in one PR, this should be PR-8 (probe-utils refresh) per chapter 05 — but the production-side event dispatches belong in PR-2 / PR-4, so it spans two PRs. Manager: sequence carefully, or fold the production-side event emits into PR-8 as a documented dependency-inversion exception.
