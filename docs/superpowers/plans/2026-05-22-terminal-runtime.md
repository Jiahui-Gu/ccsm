# TerminalRuntime — design proposal (architectural plan)

> **Status:** PROPOSAL — not an executable plan yet. The architecture audit
> (4 parallel subagents, 2026-05-22) identified this as the highest-leverage
> single refactor in the terminal layer. This document captures the design
> so it can be reviewed BEFORE breaking it into per-PR implementation plans.
> Once approved, each phase below becomes a separate `docs/superpowers/plans/`
> implementation plan with bite-sized TDD steps.

## The problem in one paragraph

The renderer-side terminal is conceptually one thing — "a visible xterm that
mirrors a server-side authoritative PTY buffer, attaches to one session at a
time, survives container resizes, and stays at the prompt on attach." In
practice it is implemented as **three React hooks + one mutable module
singleton + a callback handshake between them**:

- `useXtermSingleton` constructs the Terminal once.
- `usePtyAttach` owns attach/detach + the snapshot/seq dedupe + live-tail
  buffering + the post-attach resize replay + scroll invariant.
- `useTerminalResize` owns the ResizeObserver and re-fires the replay
  callback that `usePtyAttach` installed via `setSnapshotReplay`.
- `useAtBottom` reads buffer state directly from `getTerm()`.
- `xtermSingleton.ts` holds `term`, `fit`, `activeSid`, `unsubscribeData`,
  `inputDisposable`, `snapshotReplay`, `keyboardPasteHandled`, each behind
  a manual getter/setter pair, with no invariants enforced between them.

This shape has accreted across 8+ PRs (#852, #864–#867, #888, #1263, #1268,
#1273, #1290, #1291, #1293, #1308) and the latest one (#1308) added two
*more* coordination flags (`replayInFlight`, `replayPending`) because the
two replay drivers raced. Future bugs in this layer will keep adding more
flags unless we collapse the implicit state machine into an explicit one.

## What this proposal replaces

| Current | Replaced by |
|---|---|
| `xtermSingleton.ts` module-scope `let` cells + 12 getter/setter fns | `TerminalRuntime` class instance, single source of truth |
| `setSnapshotReplay` callback handshake | Runtime owns replay; resize hook calls `runtime.resize(...)` directly |
| `snapSeq: null | number` + `buffered[]` + `replayInFlight` + `replayPending` ad-hoc state | Explicit FSM with states `detached / attaching / live / replaying` and a single in-flight controller |
| `attachNonce` + `reloadNonce` driving `useEffect` re-runs | `runtime.attach(sessionId, cwd)` / `runtime.reload()` commands; React just observes state |
| `scrollToBottom()` sprinkled at "the right places" (#1308) | Runtime invariant: after every state transition into `live`, viewport pinned to bottom unless user has explicitly scrolled away |
| `keyboardPasteHandled` module flag for paste dedupe | Owned by the paste sub-controller inside the runtime |

## What this proposal does NOT change

- **xterm.js itself.** We're not switching renderers or addons. CanvasAddon,
  ClipboardAddon, Unicode11Addon, WebLinksAddon stay.
- **The main-process side (`electron/ptyHost`).** The audit flagged a parallel
  "ptyHost should be actor-modeled" debt (#3 in the terminal report) — that
  is a separate proposal. This refactor treats `window.ccsmPty` as the
  contract and changes nothing across the IPC boundary.
- **Test contracts.** All current behaviors stay covered. The shared test
  harness from PR #1309 (`tests/util/terminalHarness.ts`) is the bridge —
  tests assert against the same fakeTerm spies; we add a small set of
  runtime-level tests beside the hook-level ones.
- **#1308 scroll-bottom invariant.** That stays. The runtime makes it
  unconditional rather than scattered.

## Target architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       TerminalRuntime                           │
│                                                                 │
│  state: FSM   { detached | attaching | live | replaying }       │
│                                                                 │
│  owns:                                                          │
│    - Terminal instance (xterm.js)                               │
│    - FitAddon                                                   │
│    - activeSessionId                                            │
│    - data subscription (single, lifetime = process)             │
│    - dedupe state (snapSeq, buffered[])                         │
│    - replay coalescing (in-flight + pending bits)               │
│    - scroll invariant enforcement                               │
│                                                                 │
│  commands:                                                      │
│    - attach(sessionId, cwd) → Promise<AttachOutcome>            │
│    - detach() → void                                            │
│    - resize() → Promise<void>          // called by RO hook     │
│    - retry() → Promise<AttachOutcome>  // user-driven           │
│                                                                 │
│  events (react to via runtime.subscribe(listener)):             │
│    - state changes (drives overlay rendering)                   │
│    - exit (drives ExitOverlay + sidebar red-dot)                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
       ▲                          ▲                       ▲
       │                          │                       │
┌──────┴──────────┐    ┌──────────┴────────┐    ┌─────────┴───────┐
│ usePtyAttach    │    │ useTerminalResize │    │ useAtBottom     │
│ (adapter)       │    │ (adapter)         │    │ (adapter)       │
│                 │    │                   │    │                 │
│ - on sid change │    │ - RO triggers     │    │ - reads runtime │
│   → attach      │    │   runtime.resize  │    │   buffer state  │
│ - exposes state │    │   (debounced)     │    │                 │
└─────────────────┘    └───────────────────┘    └─────────────────┘
```

### State machine

```
                  attach(sid)
   detached ──────────────────────► attaching
      ▲                                │
      │ detach()                       │ snapshot landed
      │                                ▼
      └─────────── live ◄──────────────┘
                    │
                    │ resize()  (coalesced)
                    ▼
                replaying
                    │
                    └─── snapshot landed ──► live
```

**Invariants:**

1. `detached → attaching`: tear down prior subscription, install fresh data
   listener in **buffering** mode (snapSeq = null), call `pty.attach`,
   handle spawn-on-null fallback.
2. `attaching → live`: snapshot has been fetched and written; bumped
   snapSeq; drained `buffered[]`; **`term.scrollToBottom()` called**.
3. `live → replaying`: coalesces. If already `replaying`, set pending bit
   and return; the in-flight transition will re-enter `replaying` once on
   completion if pending is set. Fresh snapshot fetched, `term.reset()`,
   write, drain.
4. `replaying → live`: **`term.scrollToBottom()` called**.
5. `* → detached`: dispose subscription + input handler, clear xterm reset,
   reset internal flags.

These are exactly the rules that #1308's flag soup + scattered
`scrollToBottom()` calls were trying to encode — formalising them into a
single object makes them testable in isolation and removes the cross-hook
callback handshake.

## Implementation phases (each = 1 PR)

The total surface (4 files in `src/terminal/`, 3 test files, no IPC
changes) is small enough to do in 3 PRs, each shippable on its own.

### Phase 1 — Introduce `TerminalRuntime` as the new internal owner; keep hooks as facades

**Goal:** the runtime exists and owns the state, but the public API
(`useXtermSingleton`, `usePtyAttach`, `useTerminalResize`, `useAtBottom`)
is unchanged externally. Hooks become thin adapters; `xtermSingleton.ts`
shrinks to a module-singleton holder for the runtime itself.

**Risk:** low — internal refactor, behavior preserved, harness (#1309)
already covers the assertion surface.

**Deliverables:**
- `src/terminal/TerminalRuntime.ts` (new)
- `src/terminal/xtermSingleton.ts` reduced to `getRuntime()` accessor +
  deprecated re-exports of `getTerm/getFit/...` that delegate to the
  runtime for one transitional release
- Hooks rewritten as `runtime.attach(sid, cwd)` / `runtime.resize()` /
  `runtime.subscribe(setState)` adapters
- Tests at two levels:
  - **runtime-level** (new): direct unit tests against `TerminalRuntime`
    methods, no React. Covers the FSM transitions and invariants
    explicitly.
  - **hook-level** (kept): existing `tests/terminal/usePtyAttach.test.tsx`
    + `useTerminalResize.test.tsx` still pass byte-for-byte against the
    harness from #1309 — these now indirectly verify the adapter layer.

### Phase 2 — Remove the `setSnapshotReplay` callback handshake

**Goal:** with runtime owning resize-driven replay directly, the
`setSnapshotReplay` callback channel and its `getSnapshotReplay()`
accessor disappear. `useTerminalResize` calls `runtime.resize()` instead.

**Risk:** low — the channel was only used by these two files.

**Deliverables:**
- Delete `getSnapshotReplay` / `setSnapshotReplay` (and matching test
  doubles)
- Update `useTerminalResize` to call `runtime.resize()` (debounced
  internally to preserve the 80ms behavior)
- Remove the post-attach fit gate's separate replay trigger inside
  `TerminalRuntime.attach` — it's now indistinguishable from any other
  resize call, eliminating the double-replay race at its root (rather
  than coalescing it as #1308 does today)

### Phase 3 — Retire the deprecated module-singleton accessors

**Goal:** delete `getTerm / getFit / getActiveSid / ...` from
`xtermSingleton.ts`; only `getRuntime()` remains. `__ccsmTerm` global
(used by e2e probes) becomes `__ccsmRuntime` exposing a stable test
surface.

**Risk:** medium — e2e probes change. Mitigate by keeping both globals
for one release.

**Deliverables:**
- Remove deprecated re-exports from `xtermSingleton.ts`
- Update e2e probes that read `window.__ccsmTerm` to read
  `window.__ccsmRuntime.term` (a thin runtime field exposed for tests)
- Migrate `tests/util/terminalHarness.ts` to mock the runtime directly
  instead of mocking the singleton module. Tests are unchanged in
  behavior; only the seam moves up one layer.

## Open questions for review

These are the decisions worth explicitly flagging before phase 1 starts:

1. **Class vs closure.** TerminalRuntime as an exported class with a
   module-singleton instance, or as a closure factory returning the
   command/event API? Audit reports lean toward the class for the FSM
   visibility; closure has fewer testing seams. **Recommendation: class.**

2. **Scroll-bottom strictness.** #1308 made `scrollToBottom()` an
   unconditional invariant at attach + post-replay. Should the runtime
   also pin to bottom if a programmatic write happens while the user has
   scrolled up? Today xterm decides via its auto-follow latch; we should
   **not** override that for live writes — only for transitions into
   `live`. **Recommendation: explicit invariant only on FSM transitions.**

3. **e2e probe stability.** The `__ccsmTerm` global is read by probes
   that bypass mocks (real Electron + real xterm). Phase 3 changes its
   shape. **Recommendation: keep `__ccsmTerm` aliased to `runtime.term`
   for 2 minor releases; deprecation comment + grep targets in probe
   files.**

4. **Headless replica.** The audit's #3 ("ptyHost should be actor-modeled")
   is orthogonal — that's a main-process change. Should anything in the
   runtime API anticipate it? **Recommendation: no — keep the runtime
   IPC-shaped exactly like `window.ccsmPty` today; the actor refactor
   on the main side can change implementation without renaming the
   contract.**

## What success looks like

After all three phases ship:

- `usePtyAttach.ts` shrinks from ~520 lines to ~80 (it becomes a `useSyncExternalStore`-style adapter)
- `xtermSingleton.ts` shrinks from ~500 lines to ~40 (runtime instance + paste helpers that don't fit the runtime)
- Replay-race regression class is structurally impossible (one replay owner)
- "Attach lands at scroll-top" regression class is structurally impossible (FSM invariant + tested at runtime level, not buried in a hook)
- Next session-attach bug ships with one test against the FSM, not three flag tweaks across three files

---

## Next step

If this proposal is approved, I'll generate three `docs/superpowers/plans/`
files (one per phase), each with the bite-sized TDD step structure that
`superpowers:writing-plans` produces — at that point the steps know exactly
what file changes, what tests, what to commit. Generating those steps
NOW is premature: too many decisions above are still revisable.
