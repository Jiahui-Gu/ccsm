# 01 — Cutover audit (wave-2 hot-path residues)

This chapter enumerates every hot path the wave-2 cutover touched, the
observed e2e symptom (linked to `/tmp/t574-e2e.log` evidence), and the
verdict (FIX / KEEP / REVERT). It is the single source of truth for
which chunks of the renderer/preload/daemon seam need work in v0.3.

The audit is organised by **renderer-side surface seen by harnesses**,
not by daemon submodule, because the failing signal we have is
harness-observed.

> Cross-cutting reminder: REVERT is reserved for "wave-2 made a
> deliberate API decision that turned out to be wrong"; it requires
> manager-explicit approval. Default verdict on regressions is FIX
> (forward).

## Symptom catalog (cited evidence)

Each row below maps an observed harness failure to a hypothesis. They
are the dependent variables the audit MUST explain.

| #  | Source                | Observed string                                                                                                          | Affected cases (from log)                                                                                                                                              |
|----|-----------------------|--------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| S1 | harness-real-cli      | `waitForTerminalReady: terminal not ready for sid=… within 60000ms (last: {"host":false,"term":false,"buffer":false})`   | `new-session-chat`, `alt-screen-fits-visible-viewport`, `session-rename-writes-jsonl`, `session-title-syncs-from-jsonl` (5+ total)                                     |
| S2 | harness-real-cli      | `attach-replay-from-headless-buffer: ccsmPty: daemon port unavailable after 5s`                                          | `attach-replay-from-headless-buffer`                                                                                                                                   |
| S3 | harness-ui            | `seedStore … waitForFunction Timeout` (`window.__ccsmStore` never appears)                                               | 5+ cases incl. `rename`, `sidebar-long-name-truncates`, `move-to-group-excludes-own-group`, `terminal-pane-mounted` precondition                                       |
| S4 | harness-ui            | `window.ccsm.loadState is not a function`                                                                                | `tray`, `close-dialog-is-native`                                                                                                                                       |
| S5 | harness-ui            | `terminal host did not mount within 8s — App→TerminalPane wiring broken or pty attach failed`                            | `terminal-pane-mounted`                                                                                                                                                |
| S6 | harness-ui            | `themeClassDark:false themeClassLight:false`                                                                             | `theme-toggle`                                                                                                                                                         |
| S7 | harness-ui            | `waitForFunction Timeout 10000ms`                                                                                        | `titlebar`, `startup-paints-before-hydrate`                                                                                                                            |
| S8 | harness-dnd           | same `seedStore` timeout as S3                                                                                            | `dnd`                                                                                                                                                                  |
| S9 | scripts/probe-*.mjs   | local-only assumptions (no failure string yet, dev-574 narrative)                                                         | latent — surfaces as harness flake during repair                                                                                                                       |

## Hot-path inventory

For each wave-2 hot path, the audit records:

- **What it owns** (one line)
- **Where it lives now** (post-cutover paths)
- **Symptoms attributed** (S# from catalog above)
- **Verdict**: FIX (default) / KEEP (no change required) / REVERT (only with explicit manager approval)
- **Owner chapter** (where the fix is designed)

### HP-1 — `window.__ccsmStore` exposure

- **Owns**: a renderer-side debug affordance that pins the live zustand
  `useStore` onto `window` so harnesses can `setState({...})` and
  `getState()` against the actual store the running app reads from.
- **Now lives**: `src/stores/store.ts:48`
  ```ts
  if (typeof window !== 'undefined') {
    (window as unknown as { __ccsmStore?: typeof useStore }).__ccsmStore = useStore;
  }
  ```
- **Symptoms attributed**: S3, S7, S8 (and S5 transitively — `terminal-pane-mounted` `seedStore`s before its real assertion).
- **Hypothesis**: the assignment runs at module evaluation time, but
  wave-2 cutover changed the bundle so that `src/stores/store.ts` is
  no longer the first store-module loaded — the renderer now waits
  on async `loadPersisted()` before any `useStore` import resolves.
  The `__ccsmStore` binding therefore appears AFTER the harness has
  already started polling. Confirm by inspecting the post-cutover
  bundle order in [02-store-and-preload-surface](./02-store-and-preload-surface.md).
- **Verdict**: **FIX**.
- **Owner chapter**: [02-store-and-preload-surface](./02-store-and-preload-surface.md) §2.

### HP-2 — `window.ccsm.loadState` legacy surface

- **Owns**: the renderer's read-side preference accessor, used by
  `tray` and `close-dialog-is-native` cases (and by
  `startup-paints-before-hydrate` to inject the slow-loadState delay).
- **Now lives**: `src/stores/persist.ts:60-63` calls `window.ccsm.loadState(STATE_KEY)`. The
  preload bridge that historically exposed `ccsm.loadState` is `electron/preload/bridges/ccsmCore.ts`
  (and its peers), but post wave-2-A the implementation moved to
  `daemon/api/data.ts` over HTTP.
- **Symptoms attributed**: S4, contributes to S7 (`startup-paints-before-hydrate`).
- **Hypothesis**: wave-2-A renamed/relocated the renderer-facing
  `loadState` shim during the data-API mv and the preload-side function
  was either dropped from the main-world export or moved to a sibling
  bridge with a different name. Audit MUST locate the post-cutover
  callsite, confirm whether `window.ccsm.loadState` is exposed at all,
  and if not, define the migration in [02-store-and-preload-surface](./02-store-and-preload-surface.md) §3.
- **Verdict**: **FIX** (re-expose under the same name; downstream
  callers — incl. `harness-ui:1132,1165` startup case — assume that
  surface).
- **Owner chapter**: [02-store-and-preload-surface](./02-store-and-preload-surface.md) §3.

### HP-3 — daemon port readiness for preload bridges

- **Owns**: the boot-time handshake that lets every preload bridge
  resolve `http://127.0.0.1:<port>` before issuing the first RPC.
- **Now lives**:
  - `electron/daemon-spawner.ts:49` (`spawnDaemon` → resolves with port via stdout `PORT=<n>`).
  - `electron/main.ts:171` calls `spawnDaemon().catch(...)` (fire-and-forget — no `await`).
  - `electron/main.ts:208` exposes `ipcMain.handle('daemon:getPort', () => getDaemonPort())`.
  - `electron/preload/bridges/ccsmPty.ts:35-50` polls 50× × 100ms = 5s wall, then throws.
- **Symptoms attributed**: S2 (and contributes to S1 — without a port,
  `pty:spawn` cannot start, so `host` never mounts).
- **Hypothesis**: cold electron launches under e2e take longer than 5s
  to (a) reach `app.whenReady`, (b) fork the daemon node child,
  (c) bind the loopback socket, (d) print the `PORT=` line. The
  preload bridge's 5s budget — which starts the moment the FIRST RPC
  fires — can elapse before main has even called `spawnDaemon`. Audit
  must confirm by adding a startup trace and tightening the readiness
  contract.
- **Verdict**: **FIX** (extend boundary, change contract, OR move the
  wait off the per-RPC critical path — design choice in
  [03-ptyhost-wiring](./03-ptyhost-wiring.md) §3).
- **Owner chapter**: [03-ptyhost-wiring](./03-ptyhost-wiring.md) §3.
- **Open Q5 (blocks PR-3 dispatch)**: chapter 03 §3 picks Option C
  (`await spawnDaemon` before `BrowserWindow`), which moves daemon-boot
  latency onto the user-visible "click → window" path. Before PR-3 is
  dispatched, a measured `p50`/`p95` cold-spawn latency table covering
  Win / macOS / Linux MUST be appended to chapter 03 §3 (or a sibling
  measurement note linked from it), with the `35b08d15` baseline as the
  comparison anchor. Budget: ≤500ms regression vs `35b08d15` at p95;
  >500ms triggers automatic fallback to Option B (pre-resolved port
  cache) per chapter 05 §7 Risk-1, NOT manager re-deliberation.
  PR-3 MUST NOT be opened for review until the table exists.

### HP-4 — `host / term / buffer` readiness flags

- **Owns**: the three booleans `waitForTerminalReady`
  (`scripts/probe-utils-real-cli.mjs:85-113`) polls to determine the
  TerminalPane has mounted, the xterm `term` exists on
  `window.__ccsmTerm`, and `term.buffer.active` is non-null.
- **Now lives**: TerminalPane host element selector
  `[data-testid="terminal-host"][data-sid="<sid>"]`; xterm singleton at
  `src/terminal/xtermSingleton.ts`; pty attach at
  `src/terminal/usePtyAttach.ts` (wired to `window.ccsmPty.onData/onExit`).
- **Symptoms attributed**: S1, S5.
- **Hypothesis**: at least three independent root causes are bundled
  in S1; the audit must separate them:
  - **R1**: `host` never mounts → TerminalPane render gated on
    `claudeAvailable` is stuck because `checkClaudeAvailable` RPC times
    out (HP-3 chained).
  - **R2**: `host` mounts, `term` never appears → `xtermSingleton`
    instantiation fails because preload `ccsmPty.spawn` rejects (HP-3
    chained, or `daemon/api/pty.ts` error).
  - **R3**: `host`+`term` ok, `buffer` never appears → SSE event stream
    `event: pty:data` not emitting; `daemon/api/pty.ts:74-` SSE
    multiplexer either not flushing or not subscribed to the right sid.
- **Verdict**: **FIX** (three independent fixes on the same surface).
  **R1 audit pre-step (MUST)**: before changing the host / term / buffer
  three-flag timing in any PR, fixer MUST `git show 35b08d15^:` on
  `src/components/TerminalPane.tsx`, `src/terminal/xtermSingleton.ts`,
  and `src/terminal/usePtyAttach.ts` and record the v0.2 baseline line
  numbers governing each flag's producer + ordering in the PR body.
  Any deviation from v0.2 ordering or DOM topology requires explicit
  user/product approval; absent approval, preserve v0.2 semantics and
  only adapt the harness selectors.
- **Owner chapter**: [03-ptyhost-wiring](./03-ptyhost-wiring.md) §1, §2.

### HP-5 — Theme application on first paint

- **Owns**: setting `<html>.dark` / `<html>.theme-light` / `<html>[data-theme]`
  to match the user's persisted theme choice before first paint.
- **Now lives**: `src/app-effects/useThemeEffect.ts:11-29` — a `useEffect`
  on `App.tsx:100` that runs after mount.
- **Symptoms attributed**: S6.
- **Hypothesis**: the theme value comes from
  `useStore((s) => s.theme)`. Post-cutover hydration is async (waits on
  `window.ccsm.loadState`); during the first render `theme` falls back
  to its initial-state value, the effect runs once with that fallback,
  then `loadPersisted()` resolves and `setState` fires — but the test
  case captured the snapshot before either happened. Two independent
  bugs may exist: (a) initial state's "neither dark nor light" vacuum,
  (b) post-hydrate theme change not retriggering the effect because
  the slice's `theme` field name changed in wave-2-A (verify).
- **Verdict**: **FIX**.
- **Owner chapter**: [02-store-and-preload-surface](./02-store-and-preload-surface.md) §4 (hydration ordering) + a small fix in [03-ptyhost-wiring](./03-ptyhost-wiring.md) is NOT applicable here.

### HP-6 — Hydration trace (`window.__ccsmHydrationTrace`)

- **Owns**: per-load `renderedAt` / `hydrateDoneAt` timestamps used by
  `startup-paints-before-hydrate` to assert React mounted before
  persisted-state load resolved.
- **Now lives**: `src/stores/store.ts` (lines 37-65 referenced earlier;
  trace pinned for harness use).
- **Symptoms attributed**: S7 (partial — also covers HP-2 path).
- **Hypothesis**: the trace object exists, but the `loadStateWrapped`
  injection at `harness-ui.mjs:1165` overrides `window.ccsm.loadState`
  before reload. If HP-2 has dropped that surface entirely, the
  override is no-op and the entire test premise collapses. Once HP-2 is
  fixed, this case auto-recovers; otherwise no.
- **Verdict**: **FIX-DEPENDENT** (no separate change; verify after HP-2 lands).
- **Owner chapter**: [02-store-and-preload-surface](./02-store-and-preload-surface.md) §3 + [04-probe-and-harness-update](./04-probe-and-harness-update.md) §3.

### HP-7 — Preload bridge surface naming

- **Owns**: which symbols live on `window.ccsm`, `window.ccsmPty`,
  `window.ccsmCore`, `window.__ccsmI18n`, `window.__ccsmStore`,
  `window.__ccsmTerm`, `window.__ccsmHydrationTrace`,
  `window.__ccsm584Skeleton`.
- **Now lives**: `electron/preload/bridges/*.ts` (5-bridge skeleton
  established in `f9c99ab5` wave2-prep).
- **Symptoms attributed**: contributes to S3, S4, S6, S7.
- **Verdict**: **FIX** (catalog + canonicalise; many symbols are
  legitimately E2E-only debug affordances and stay; one or two may
  have moved between bridges and need re-export).
- **Owner chapter**: [02-store-and-preload-surface](./02-store-and-preload-surface.md) §1.

### HP-8 — sigkill-reattach correctness

- **Owns**: after `pty:exit{ signal: 'SIGKILL' }`, the renderer must be
  able to re-attach to the same sid and replay the buffer snapshot
  recorded by daemon's `getBufferSnapshot`.
- **Now lives**: `daemon/ptyHost/lifecycle.ts`, `daemon/ptyHost/dataFanout.ts`,
  preload `ccsmPty.attach + getBufferSnapshot` (`electron/preload/bridges/ccsmPty.ts:229,243`).
- **Symptoms attributed**: latent — only one harness case
  (`attach-replay-from-headless-buffer`) covers this and it currently
  errors out at the daemon-port boundary (S2). Once HP-3 is fixed,
  whether this path actually works end-to-end is an unknown.
- **Verdict**: **FIX** (mandatory v0.3 per iron rule §3.4).
- **Owner chapter**: [03-ptyhost-wiring](./03-ptyhost-wiring.md) §4.

### HP-9 — Three RPCs (`SendInput / Resize / CheckClaudeAvailable`)

- **Owns**: the smallest set of pty RPCs the renderer cannot live without.
- **Now lives**:
  - `daemon/api/pty.ts` `input` / `resize` / `checkClaudeAvailable`.
  - preload bridge `electron/preload/bridges/ccsmPty.ts:236-242`.
- **Symptoms attributed**: chained into S1 (R1), implicitly into S5.
- **Verdict**: **FIX** — manager iron rule says these MUST be real
  implementations + UT + Connect-roundtrip in v0.3. Chapter 03 must
  itemise what "real" means per RPC and the UT contract.
- **Owner chapter**: [03-ptyhost-wiring](./03-ptyhost-wiring.md) §5.

### HP-10 — `probe-utils.mjs` / `probe-utils-real-cli.mjs` / `probe-helpers/*.mjs`

- **Owns**: shared driver code every harness imports
  (`seedStore`, `seedSession`, `appWindow`, `waitForTerminalReady`,
  `waitForXtermBuffer`, `dismissFirstRunModals`, etc.).
- **Now lives**: `scripts/probe-utils.mjs`, `scripts/probe-utils-real-cli.mjs`,
  `scripts/probe-helpers/{harness-runner,reset-between-cases}.mjs`.
- **Symptoms attributed**: S9 (latent), and amplifies S3 / S5 because
  e.g. `seedStore` immediately `throw new Error('__ccsmStore missing on
  window …')` once its 20s timeout elapses (`scripts/probe-utils.mjs:362-365`).
- **Verdict**: **FIX** — refresh waitFor predicates, remove pre-cutover
  shortcuts, and align selector strategy with the new TerminalPane
  / hydration story (chapter 04).
- **Owner chapter**: [04-probe-and-harness-update](./04-probe-and-harness-update.md) §1, §2.

### HP-11 — `daemon/api/index.ts` auto-registry

- **Owns**: requires every `daemon/api/*.js` sibling at boot, invoking
  the default export as `(router) => void`. Establishes the routing
  table.
- **Now lives**: `daemon/api/index.ts` plus `daemon/startup/index.ts`.
- **Symptoms attributed**: none directly observed.
- **Verdict**: **KEEP** — out of scope; wave-2 substrate.

### HP-12 — `electron/lifecycle/appLifecycle.ts` daemon shutdown

- **Owns**: `app.on('before-quit')` triggers `killDaemon()` (SIGTERM).
- **Symptoms attributed**: none directly observed; relevant to test
  isolation (a leaked daemon would corrupt the next case's port
  resolution).
- **Verdict**: **KEEP** unless the audit during repair shows leaked
  daemon processes between cases — in which case promote to FIX in
  [04-probe-and-harness-update](./04-probe-and-harness-update.md) §4.

### HP-13 — `__legacy_to_delete__` removal (#1105)

- **Owns**: dead-code removal of pre-wave-2 IPC registrars.
- **Verdict**: **KEEP** — no functional surface left to repair.

## Cross-cutting hypotheses

- The hydration-ordering thread (HP-1, HP-2, HP-5, HP-6) is the
  highest-leverage repair. Fixing it likely closes S3 / S4 / S6 / S7
  (and S5 transitively). Manager should slice this as the FIRST PR.
- The daemon-port-readiness thread (HP-3) is the second highest. It
  closes S2 cleanly and is a precondition for any wiring work on
  S1 (HP-4 / HP-9).
- `probe-utils` refresh (HP-10) MUST be the LAST in-scope change,
  because it's the diagnostic layer; if it shifts before the under-test
  surface is correct, we lose the failing-case signal.

## Open audit questions (lifted to reviewers)

- **Q1**: Is `__ccsmStore` legitimately gone post-cutover, or is the
  binding present but installed too late? Reviewer to verify by
  inspecting the bundled order of `src/stores/store.ts` vs the
  hydration call site.
- **Q2**: Was `window.ccsm.loadState` deliberately removed, or accidentally?
  Reviewer to git-blame `electron/preload/bridges/ccsmCore.ts` and the
  wave-2-A diff for `loadState`.
- **Q3**: For `requiresClaudeBin: true` cases — should they FAIL when
  the binary is missing locally, or remain skip-on-absent? v0.3 iron
  rule says zero skip; pragmatically these need a Set B fallback (chapter 04 §4).
- **Q4** [**RESOLVED — R5**]: dev-574's "88 .skip" count — what's the exact source line set?
  Author found 0 Vitest skip directives in `tests/`, and only 1
  `skipLaunch:true` in `harness-ui.mjs`. Reviewer to reconcile —
  manager prompt cited 88; chapter 04 §1 must produce the canonical
  count.

  **R5 ground-truth answer (canonical, see [04-probe-and-harness-update](./04-probe-and-harness-update.md) §1.1)**:
  at `35b08d15` / `5d0c5375` the count is **0 Vitest
  `it.skip / test.skip / describe.skip / xit / xdescribe` directives**
  in `tests/ src/ daemon/ electron/`, **0 occurrences** of any of
  `requiresClaudeBin / windowsOnly / darwinOnly / linuxOnly /
  skipLaunch` in `tests/`, and **1 `skipLaunch:true` case** in
  `scripts/harness-ui.mjs:1624` (`cap-skip-launch-bundle-shape`,
  capability demo of the runner mechanism; KEEP). dev-574's "88" was a
  case×capability-flag evaluation count inside
  `scripts/probe-helpers/harness-runner.mjs`, NOT actual skipped
  tests.
