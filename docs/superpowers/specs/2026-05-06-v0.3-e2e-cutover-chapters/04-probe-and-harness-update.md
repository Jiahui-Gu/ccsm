# 04 — Probe and harness update (probe-utils refresh + per-case verdict)

This chapter owns [01-cutover-audit](./01-cutover-audit.md) HP-10 and
the dev-574-narrated "88 .skip" reconciliation. It is the LAST in-scope
chapter for repair work — see chapter 01 §"Cross-cutting hypotheses"
for the rationale ("don't shift the diagnostic layer until the
under-test surface is correct").

## 1. Skip inventory & reconciliation

### §1.1 Canonical baseline (R5 ground-truth, verified at `5d0c5375`)

Ground-truth at the spec branch HEAD `5d0c5375` (rebased onto
`35b08d15`):

```bash
$ grep -rEn "(it|test|describe)\.skip\(|\bxit\b|\bxdescribe\b" \
    --include='*.ts' --include='*.tsx' --include='*.js' tests/ src/ daemon/ electron/
# 0 matches

$ grep -rn "skipLaunch" --include='*.mjs' scripts/
# scripts/probe-helpers/harness-runner.mjs : 13 references (the runner mechanism)
# scripts/harness-ui.mjs:1624 : { id: 'cap-skip-launch-bundle-shape', skipLaunch: true, … }
```

| Source                                                                         | Count |
|--------------------------------------------------------------------------------|-------|
| Vitest `it.skip / test.skip / describe.skip / xit / xdescribe` in `tests/ src/ daemon/ electron/` | **0** |
| `vitest.config.ts` exclude patterns beyond standard `node_modules / dist`      | **0** |
| Harness `skipLaunch: true`                                                     | **1** (`cap-skip-launch-bundle-shape`, capability demo of the runner; KEEP) |
| Harness `requiresClaudeBin: true` in `tests/`                                  | **0** |
| Harness `windowsOnly / darwinOnly / linuxOnly` in `tests/`                     | **0** |

The dev-574-narrated "88" figure was a count of runner gate-evaluation
points (case×capability-flag matrix evaluated by
`scripts/probe-helpers/harness-runner.mjs`), NOT skipped tests. There
is essentially **nothing to triage at the case level** on this baseline:
the only "skip-like" entry is `cap-skip-launch-bundle-shape`, which is
a capability demo and correctly classified KEEP.

### §1.2 Forward guard (mechanical implementation of iron rule §3.1)

The v0.3 rule "zero e2e skip" is a **forward guard against introducing
new skips during the repair**, not a triage backlog. Any future
skip-like introduced during repair MUST be classified as exactly one of:

- **KEEP**: legitimate platform / environment guard (`windowsOnly` for
  a tray feature unique to win32). MUST have a one-line `Why kept:`
  comment in the case body.
- **DELETE**: probe / case is dead — covers a feature that no longer
  exists. Remove the entire case. MUST link to the commit that removed
  the underlying feature.
- **FIX**: case is gated on an env condition that should hold in CI;
  the gate is masking a bug. Remove the gate, expect the case to fail,
  add to the FIX list (chapter 05 §3 PR slicing).
- **MARK**: case requires a downstream feature not in v0.3 (e.g. claude
  binary on Linux runners). Move to Set B (informational) and document
  in chapter 04 §3.

[chapter 05](./05-release-slicing-and-dag.md) §1 G8 is the merge-time
gate that enforces this. Any addition during the repair MUST appear
in the PR body as a classification line, otherwise G8 fails.

**Iron rule reminder**: NO case may be re-classified as skip in v0.3
under any verdict.

### §1.3 Real triage (capability-flag scope)

The "real" triage that the original §1 framing implied — enumerating
every `requiresClaudeBin / windowsOnly / darwinOnly / linuxOnly /
skipLaunch` case across the three harnesses — collapses to a single
finding on this baseline:

> **v0.3 does not introduce a capability-flag regime.** At `5d0c5375`,
> `tests/` contains **0 occurrences** of any of `requiresClaudeBin /
> windowsOnly / darwinOnly / linuxOnly / skipLaunch` (verified at
> `5d0c5375`). The single live `skipLaunch:true` case
> (`cap-skip-launch-bundle-shape`) lives in `scripts/harness-ui.mjs`
> and is a capability demo of the runner mechanism itself.
>
> Future work that needs platform / environment gating MUST go through
> an independent RFC (out of scope for v0.3); v0.3 ships with the
> existing Set A / Set B distinction (§3) as the only gating axis.

Consequently §6 acceptance signal #1 is satisfied by §1.1 above; no
separate `04a-skip-inventory.md` artifact is required.

## 2. probe-utils refresh

This section enumerates concrete edits required in
`scripts/probe-utils.mjs`, `scripts/probe-utils-real-cli.mjs`, and
`scripts/probe-helpers/*.mjs` to align with the post-cutover surface
defined in chapter 02.

### §2.0 Ready-signal contract (signal vs poll)

Each probe MUST distinguish between **signal-based wait** (deterministic:
probe blocks on a specific event/promise that fires when the property
becomes true) and **poll-with-timeout** (best-effort: probe re-checks
every Nms until either truthy or timeout). The two have very different
flake profiles, and the entire "tighten timeouts" story (chapter 04 §6,
chapter 05 §3 PR-8) only works if probes use the strongest signal
their property allows.

| Probe step                                            | Signal type           | Signal source (production-side emitter)                                                                 |
|--------------------------------------------------------|------------------------|----------------------------------------------------------------------------------------------------------|
| `seedStore` "wait for `__ccsmStore`"                  | **sync** (post ch02 §2 fix) | `globalThis.__ccsmStore` is set at module eval; replace `waitForFunction` with single-shot `evaluate` after `domcontentloaded`. |
| `seedStore` "wait for app shell"                      | **event**             | App.tsx fires `window.dispatchEvent(new Event('ccsm:app-shell-ready'))` at end of first useEffect; probe `waitForEvent('ccsm:app-shell-ready')` instead of polling for `[data-testid="app-shell-ready"]`. **Production-emit owner**: PR-2 (App.tsx). |
| `waitForTerminalReady` `host` flag                    | **event**             | TerminalPane fires `window.dispatchEvent(new CustomEvent('ccsm:terminal-host-mounted', { detail: { sid } }))` in `useEffect([sid])` after host element is in DOM. **Production-emit owner**: PR-4 (TerminalPane). |
| `waitForTerminalReady` `term` flag                    | **event**             | xterm singleton fires `window.dispatchEvent(new CustomEvent('ccsm:term-attached', { detail: { sid } }))` after `term.open(hostEl)`. **Production-emit owner**: PR-4 (xtermSingleton). |
| `waitForTerminalReady` `buffer` flag                  | **sync** (true iff `term` true) | `term.buffer.active` is non-null synchronously after `term.open()`; assert in same step as `term`, no separate poll. |
| `daemon-port-ready-before-render` (NEW case)          | **sync**              | Post Option C, port is resolved at first JS execution; assert `await ccsmPty.checkClaudeAvailable()` returns within 500ms wall-clock AND `window.__ccsmDaemonPortLoadIterations === 0` (counter pinned by `electron/preload/bridges/ccsmPty.ts` per ch03 §3 fallback poll). |

Probes that lack a signal source MAY remain poll-with-timeout but MUST
document the reason in a code comment AND log every poll iteration at
TRACE level so flake post-mortem is possible.

**MUST**: production-side event emits (`ccsm:app-shell-ready` /
`ccsm:terminal-host-mounted` / `ccsm:term-attached`) land in their
respective owner PRs (chapter 05 §3 PR-2 / PR-4); PR-8 (probe-utils
refresh) consumes them via `waitForEvent`. If any emit is rejected
during PR review, the corresponding probe falls back to
`waitForFunction` and §2.0 above documents the reason in this table
(do NOT silently revert to polling).

### scripts/probe-utils.mjs

#### `seedStore` (lines 356-366)

Currently:

```js
export async function seedStore(win, state) {
  await win.waitForFunction(
    () => !!window.__ccsmStore && document.querySelector('aside') !== null,
    null,
    { timeout: 20_000 }
  );
  await win.evaluate((s) => {
    const store = window.__ccsmStore;
    if (!store) throw new Error('__ccsmStore missing on window — App.tsx no longer exposes it?');
    store.setState(s);
  }, state);
}
```

**Required edits**:

- Drop the 20s timeout to 8s once chapter 02 §2 fixes HP-1; surface
  the failure faster.
- Replace `'aside'` selector with a more robust readiness signal —
  preferably `[data-testid="app-shell-ready"]` set by App.tsx in a
  post-mount effect. If we keep `aside`, document why (sidebar mounts
  always before terminal pane, so it's a proxy for "first paint").
- The `if (!store) throw new Error(...)` is unreachable after
  `waitForFunction` resolves; it's defensive — leave but update the
  error message to mention chapter 02.

#### `setThemeViaStore` (lines 290-302)

The case now goes via `window.__ccsmStore.setState({ theme: m })` then
relies on `useThemeEffect` to fire. Post-fix, this is correct; ensure
no probe code reaches into `<html>` directly to set classes (would
mask the bug).

### scripts/probe-utils-real-cli.mjs

#### `waitForTerminalReady` (lines 85-113)

Currently polls every 200ms for 10s default, harness uses 60s
overrides. After chapter 03 §1, the three flags should flip within ~5s.

**Required edits**:

- Reduce default timeout to 15s. Harness sites that pass 60000 should
  drop to 30000 in a follow-up cleanup (NOT in scope for the same PR
  to keep the diff focused on the actual surface fix).
- Add a one-time DOM dump on timeout (`win.content().slice(0,500)` in
  the error message) so future flakes are debuggable. Additionally, on
  timeout `await win.evaluate(() => window.__ccsmHydrationTrace)` and
  dump the full trace object to
  `tmp/e2e-logs/<run-id>/<case>.hydration-trace.json` (shape per
  [02-store-and-preload-surface](./02-store-and-preload-surface.md) §4
  "`__ccsmHydrationTrace` shape"); this lets the on-call bisect WHICH
  hydration step (`loadState` round-trip, `setState`, or React commit)
  stalled, instead of guessing from an empty DOM.
- Add `term.cols / term.rows` to the returned object — useful for
  debugging the resize RPC (chapter 03 §5).

### scripts/probe-helpers/harness-runner.mjs

- Verify the `skipLaunch` capability still works after Option C
  (`await spawnDaemon`) lands in main — `skipLaunch: true` cases
  intentionally NEVER boot electron, so they MUST also NEVER trigger
  daemon spawn. Audit `electron/main.ts` to ensure the daemon is only
  spawned inside `app.whenReady().then(...)`, NOT at module
  evaluation; otherwise `skipLaunch` cases pull a daemon process they
  don't need.
- Currently `app.whenReady()` is the entry — verify nothing wave-2
  hoisted out.

#### Daemon stderr capture

The runner MUST pipe the spawned electron process's `stderr` (which
forwards the daemon child's stderr — see [ch03 §6](./03-ptyhost-wiring.md#daemon-stderr-structured-logs)
for the `[ccsmd] <ISO> <level> <category>: ...` format) to a
per-case log file at
`tmp/e2e-logs/<run-id>/<case>.electron.log`.

- The directory `tmp/e2e-logs/<run-id>/` MUST be created at runner
  startup (gitignored). `<run-id>` = ISO-second-precision timestamp
  of the runner invocation; `<case>` = the harness case id.
- On case PASS: the file is retained but NOT surfaced.
- On case FAIL: the runner MUST tail the LAST 200 lines of the file,
  filter for `[ccsmd] <ISO> <level=error>` records first, and
  prepend that excerpt (clearly delimited, e.g. `--- daemon stderr
  (last 200 lines, errors first) ---`) into the case's error
  message before throwing, so the failure surface visible in CI
  logs / harness output carries the daemon-side context without
  requiring an artifact dive.
- Log capture MUST be best-effort: an I/O failure on the log file
  MUST NOT fail an otherwise-passing case (warn to runner stdout
  and continue).

### scripts/probe-helpers/reset-between-cases.mjs

- Verify it resets `window.__ccsmStore.setState({...initial})` correctly
  — i.e. the store reference is the SAME instance across cases (HP-1
  double-store risk).
- **Runtime invariant (R5 testability — replaces one-time grep)**: at
  the start of every case-N reset, capture `beforeRef = await
  win.evaluate(() => (window as any).__ccsmStore)`; after the
  `setState({...initial})` call, capture `afterRef = await
  win.evaluate(() => (window as any).__ccsmStore)`; assert
  `beforeRef === afterRef` (strict equality on the proxied JS reference;
  Playwright serialises both to the same handle iff the underlying
  zustand instance is identical). On mismatch, throw with message
  `"__ccsmStore changed between cases — duplicate-store regression
  (HP-1); see ch02 §2 Fix-B"`. The probe itself becomes the regression
  test; no separate UT needed for the cross-case identity property.
- **Why runtime, not one-time**: a one-time verify at PR-2 land does
  not catch a v0.4+ feature-slice store accidentally creating a
  sibling `useStore` proxy that drifts between cases. The cross-case
  invariant runs every case, every CI run, with zero added cost.

## 3. Set A vs Set B (dogfood)

### Set A — CI gate (must be green to merge)

All cases that:

- run on Windows (the primary developer platform per project history)
- exercise a wave-2 hot path
- have a deterministic outcome on a fresh worktree

Candidate Set A list (post-fix):

| Harness            | Cases (Set A)                                                                                                               |
|--------------------|------------------------------------------------------------------------------------------------------------------------------|
| `harness-ui`       | sidebar-align, settings-open, settings-updates-pane, titlebar, tray, close-dialog-is-native, theme-toggle, import-empty-groups, rename, move-to-group-excludes-own-group, sidebar-long-name-truncates, startup-paints-before-hydrate, terminal-pane-mounted, cap-skip-launch-bundle-shape |
| `harness-real-cli` | new-session-chat, new-session-focus-cli, alt-screen-fits-visible-viewport, session-rename-writes-jsonl, session-title-syncs-from-jsonl, attach-replay-from-headless-buffer |
| `harness-dnd`      | dnd                                                                                                                          |

**Set A scope (R1 strict, manager decision round 1)**: v0.3 Set A contains
only cases that were already green at the v0.2 baseline (`35b08d15^`)
plus the cases needed to verify wave-2 cutover did not regress them. The
NEW `sigkill-reattach` harness case (chapter 04 §4 below) is **Set B
informational in v0.3**; promotion into Set A is a v0.4 candidate per
[03-ptyhost-wiring](./03-ptyhost-wiring.md) §7 F-4.

(The harness-real-cli list is partial — chapter 04 §1 reviewer pass
will fill in the full inventory.)

### Set B — informational bench

Cases that require the developer's local claude binary, run only on
the developer's primary box, and are NEVER a CI gate. These exist to
catch product regressions caught by interactive use. Examples that
likely belong in Set B:

- Any case marked `requiresClaudeBin: true` that depends on actual
  claude responses (vs. just presence of the binary).
- Multi-window / two-electron cases where a Linux CI lacks the display
  budget.

**MUST**: Set B failures are LOGGED, NOT blocking. The gate language
in `.github/workflows/e2e.yml` already supports this (one job per
harness; reviewer to verify).

### Set assignment (R5 testability — Set A vs Set B vs DELETE)

Each currently-red case from `/tmp/t574-e2e.log` MUST be assigned
exactly one of `{Set A, Set B, DELETE}` per chapter 04 §1.2 verdict
policy (KEEP / DELETE / FIX / MARK). The full case-by-case assignment
is committed by the chapter 04 fixer to
`docs/superpowers/specs/2026-05-06-v0.3-e2e-cutover-chapters/04b-case-set-assignment.md`
(**NEW** — file does not exist at HEAD `5d0c5375`; created by the
chapter 04 fixer round). Cases not on either Set A or Set B that are
not DELETE are MARK (deferred to v0.4 with a tracker link).

**Sigkill-reattach pin (CF-3 manager decision)**: the NEW
`sigkill-reattach` harness case (chapter 04 §4 below) is **Set B
informational in v0.3** per chapter 03 §4 (R1 strict). The
`04b-case-set-assignment.md` artifact MUST reflect this; promotion
into Set A is a v0.4 candidate per
[03-ptyhost-wiring](./03-ptyhost-wiring.md) §7 F-4 and is NOT
re-litigated by the §3 assignment pass.

**Why this is its own subsection**: G5/G6/G7 in chapter 05 §1 gate the
merge on "Set A green twice in a row." Without a final canonical Set A
list, a fixer doesn't know which currently-red case must turn green
and which can stay red. The §3.1 list above is the post-fix candidate
target; the `04b-case-set-assignment.md` artifact is the per-case
verdict the gate enforces.

## 4. New harness cases required by spec

The following cases SHOULD exist post-repair (chapter 05 PRs may add
them):

| Case id                           | Harness            | Set (v0.3)        | Asserts                                                              | Budget (CI wall-clock)               |
|-----------------------------------|--------------------|-------------------|----------------------------------------------------------------------|---------------------------------------|
| `daemon-port-ready-before-render` | harness-ui         | Set A             | On harness app launch, `await window.ccsmPty.checkClaudeAvailable()` resolves within **500ms wall-clock** from page-load AND `window.__ccsmDaemonPortLoadIterations === 0` (debug counter pinned by `electron/preload/bridges/ccsmPty.ts` per ch03 §3 fallback poll). Why: the two-pronged assertion directly gates Option C correctness — a silent regression to Option A behaviour (poll succeeds at iteration N>0) is caught by the counter; a regression that adds latency without poll iterations is caught by the wall-clock bound. | total case **≤5s**                    |
| `sigkill-reattach`                | harness-real-cli   | **Set B (informational, v0.3)** | v0.3 scope = v0.2 already-shipping attach-replay assertions pass (basic resume after SIGKILL on the daemon-port substrate). **NO new behaviour assertion in v0.3** (no TTL / cap / cwd-mismatch / eviction assertions — those are v0.4 per [03-ptyhost-wiring](./03-ptyhost-wiring.md) §7). v0.4 candidate for Set A promotion. | **n/a in v0.3** (Set B informational; no budget pinned per CF-3 — the v0.4 promotion PR pins budget when the case becomes a release-blocker) |
| `loadstate-roundtrip`             | harness-ui         | Set A             | `await window.ccsm.saveState('k','v'); await window.ccsm.loadState('k') === 'v'`. | total case **≤3s**                    |

**Why each**:

- `daemon-port-ready-before-render` regression-tests the cold-launch
  contract.
- `sigkill-reattach` (v0.3 = Set B informational) is the e2e signal that
  the v0.2 daemon-port attach-replay path is restored after wave-2
  cutover. v0.3 does NOT promote this case to Set A or assert new
  reliability semantics on it — those live in v0.4 per
  [03-ptyhost-wiring](./03-ptyhost-wiring.md) §7 (F-4).
- `loadstate-roundtrip` is the cheapest e2e regression test for HP-2
  silent removal.

## 5. Out-of-scope (deferred)

- Migrating harness-runner to Vitest. Future infrastructure cleanup.
- Auto-screenshotting failures (Playwright trace integration). v0.4.
- Per-PR sharded CI. Out of v0.3 release scope.

## 6. Acceptance signal for chapter 04

- §1.1 canonical baseline (R5 ground-truth: 0 Vitest skip + 1 KEEP
  `skipLaunch`) is committed in this chapter; no separate
  `04a-skip-inventory.md` artifact required.
- `probe-utils.mjs` `seedStore` resolves within 5s on cold launch in
  CI.
- `waitForTerminalReady` resolves within 10s on cold launch in CI.
- All Set A harness cases pass two consecutive runs in CI.
