# 04 — Probe and harness update (probe-utils refresh + per-case verdict)

This chapter owns [01-cutover-audit](./01-cutover-audit.md) HP-10 and
the dev-574-narrated "88 .skip" reconciliation. It is the LAST in-scope
chapter for repair work — see chapter 01 §"Cross-cutting hypotheses"
for the rationale ("don't shift the diagnostic layer until the
under-test surface is correct").

## 1. Skip inventory & reconciliation

### Author finding (single grep, mechanical)

Running, on `35b08d15`:

```bash
grep -rEn "\b(it|test|describe)\.skip\(|\bxit\(|\bxtest\(|skipIf\(|skip:\s*true" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
  tests src scripts
```

returned **0 hits**. There are no Vitest / Jest skip directives in the
codebase.

The harness skip mechanism is a separate axis, implemented in
`scripts/probe-helpers/harness-runner.mjs` lines 487-526 via
`requiresClaudeBin / windowsOnly / darwinOnly / skipLaunch` case flags.
On `35b08d15`, only ONE such flag is set across the three harnesses:

```
scripts/harness-ui.mjs:1624: { id: 'cap-skip-launch-bundle-shape', skipLaunch: true, … }
```

That case is intentionally `skipLaunch` (a capability demo of the
runner itself, NOT a regression-skip).

### Reviewer / fixer responsibility

The "88 .skip" figure cited by manager (sourced from dev-574 narrative)
does NOT correspond to anything the author can locate on `35b08d15`. We
posit three interpretations:

1. dev-574 was counting harness CASES that fail or are blocked on the
   wave-2 cutover regressions (interpretation: "88 cases dev-574 wants
   us to triage"). Possible — dev-574 ran across pool-1's full test
   tree which includes `.spec.tsx` files this audit may have missed.
2. dev-574 was counting probe assertions guarded by
   `if (!cond) return;`-style early-returns inside harness case bodies.
   These are not formal `.skip`s; they are silent bypasses we may want
   to convert to hard failures.
3. dev-574 was counting an older snapshot of the codebase (pre-#1106
   merge). Less likely — manager's brief explicitly anchors at
   `35b08d15`.

**Reviewer R5 (testability) MUST**: enumerate the canonical "skip-like"
list at `35b08d15` by surveying:

- every `requiresClaudeBin: true` case across the three harnesses
- every `windowsOnly` / `darwinOnly` case
- every harness case where the body contains `if (...) return;` /
  `if (...) { log(...); return; }` early-exits (silent bypasses)
- every `npm test` / `vitest --run` exclude-pattern in `package.json`
  / `vitest.config.ts`

then attach the count to chapter 04 as a reviewer-round addendum.

### Verdict policy

For every "skip-like" entry, the verdict is exactly one of:

- **KEEP**: legitimate platform / environment guard (`windowsOnly` for
  a tray feature unique to win32). Leave unchanged. MUST have a
  one-line `Why kept:` comment in the case body.
- **DELETE**: probe / case is dead — covers a feature that no longer
  exists. Remove the entire case. MUST link to the commit that removed
  the underlying feature.
- **FIX**: case is gated on an env condition that should hold in CI;
  the gate is masking a bug. Remove the gate, expect the case to fail,
  add to the FIX list (chapter 05 §3 PR slicing).
- **MARK**: case requires a downstream feature not in v0.3 (e.g. claude
  binary on Linux runners). Move to Set B (informational) and document
  in chapter 04 §3.

**Iron rule reminder**: NO case may be re-classified as skip in v0.3
under any verdict.

## 2. probe-utils refresh

This section enumerates concrete edits required in
`scripts/probe-utils.mjs`, `scripts/probe-utils-real-cli.mjs`, and
`scripts/probe-helpers/*.mjs` to align with the post-cutover surface
defined in chapter 02.

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
  the error message) so future flakes are debuggable.
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

### scripts/probe-helpers/reset-between-cases.mjs

- Verify it resets `window.__ccsmStore.setState({...initial})` correctly
  — i.e. the store reference is the SAME instance across cases (HP-1
  double-store risk).

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
| `harness-real-cli` | new-session-chat, new-session-focus-cli, alt-screen-fits-visible-viewport, session-rename-writes-jsonl, session-title-syncs-from-jsonl, attach-replay-from-headless-buffer, sigkill-reattach (NEW — author proposes adding) |
| `harness-dnd`      | dnd                                                                                                                          |

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

## 4. New harness cases required by spec

The following cases SHOULD exist post-repair (chapter 05 PRs may add
them):

| Case id                           | Harness            | Asserts                                                              |
|-----------------------------------|--------------------|----------------------------------------------------------------------|
| `daemon-port-ready-before-render` | harness-ui         | `window.ccsmPty` works on the very first RPC (no 5s polling waste).  |
| `sigkill-reattach`                | harness-real-cli   | Full HP-8 flow: spawn → write → SIGKILL → spawn(same sid) → attach → snapshot replay. |
| `loadstate-roundtrip`             | harness-ui         | `await window.ccsm.saveState('k','v'); await window.ccsm.loadState('k') === 'v'`. |

**Why each**:

- `daemon-port-ready-before-render` regression-tests the cold-launch
  contract.
- `sigkill-reattach` is the only e2e signal for HP-8 once the daemon-port
  failure clears.
- `loadstate-roundtrip` is the cheapest e2e regression test for HP-2
  silent removal.

## 5. Out-of-scope (deferred)

- Migrating harness-runner to Vitest. Future infrastructure cleanup.
- Auto-screenshotting failures (Playwright trace integration). v0.4.
- Per-PR sharded CI. Out of v0.3 release scope.

## 6. Acceptance signal for chapter 04

- A canonical skip inventory is committed (probably as
  `docs/superpowers/specs/2026-05-06-v0.3-e2e-cutover-chapters/04a-skip-inventory.md`
  produced by the reviewer round; not yet by author).
- `probe-utils.mjs` `seedStore` resolves within 5s on cold launch in
  CI.
- `waitForTerminalReady` resolves within 10s on cold launch in CI.
- All Set A harness cases pass two consecutive runs in CI.
