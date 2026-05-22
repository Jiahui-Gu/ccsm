# SessionActionIntent — design proposal (architectural plan)

> **Status:** PROPOSAL — not an executable plan yet. Companion to
> `2026-05-22-terminal-runtime.md`. This proposal targets the **second-
> highest leverage** debt surfaced by the architecture audit (4 parallel
> subagents, 2026-05-22): the coordination maps that grew piecemeal to
> support right-click actions on sessions. Like the terminal runtime
> proposal, this needs review BEFORE breaking into bite-sized
> implementation plans.

## The problem in one paragraph

A "session action" — reload, copy/fork, rename, archive, retry — is one
verb in the user's mental model. Each action has a side-effect lifecycle
that crosses store, hook, IPC, and back. We've added one **parallel
ad-hoc coordination map** for each action as the need arose:

- `reloadNonce: Record<sid, number>` (`sessionRuntimeSlice`) — bumped by
  `reloadSession` after `pty.kill`, watched by `usePtyAttach` to re-run
  attach.
- `attachNonce` (local to `usePtyAttach`, bumped by Retry) — same shape,
  different layer.
- `pendingForkSource: Record<newSid, srcSid>` (`sessionCrudSlice`) —
  written by `copySession`, read by `usePtyAttach`'s spawn-on-null path,
  cleared post-spawn.
- `pendingRenameId: sid | null` (`types.ts`) — armed by `copySession`,
  consumed by the rename input.
- `disconnectedSessions: Record<sid, ExitInfo>` — written by ptyExit
  classifier, cleared by `_clearPtyExit` on next successful attach.
- `flashStates: Record<sid, FlashState>` (UI attention) — derived from
  session state.

Each map was a reasonable local solution. The cumulative effect: the
"what happens when a user right-clicks a session row" answer requires
reading 4–6 files. New actions (e.g. "duplicate without forking", "move
to group") will each invent another map. The sidebar's memo-chain
contract (#1271) is downstream pressure from this same shape — too many
parallel maps means too many subtrees re-rendering on every action.

## What this proposal replaces

| Current | Replaced by |
|---|---|
| `reloadNonce`, `attachNonce`, retry counter logic | One `attemptId` field in a **parallel runtime map** (`sessionRuntimeById`); `usePtyAttach`'s `useEffect` depends on `attemptId`, no separate nonce |
| `pendingForkSource: Record<sid, sid>` | `pendingAction: SessionAction \| null` in the same parallel runtime map, with discriminated union variants |
| `pendingRenameId: sid \| null` | Same `pendingAction` slot — `{kind: 'rename'}` variant — consumed by RenameInput |
| Imperative store mutators that orchestrate IPC + multiple `set` calls (`reloadSession`, `copySession`) | A thin `dispatchSessionAction(intent)` reducer that produces the new state synchronously; an effect layer reads the pending action and performs IPC |
| Each action's UI handler reaching into 3 slices | UI just dispatches `SessionActionIntent` |

**Out of scope** (not migrated by this proposal):
- `flashStates: Record<sid, FlashState>` — UI attention derived from
  session state, not a session-action intent.
- `disconnectedSessions: Record<sid, ExitInfo>` — runtime exit state
  written by the ptyExit classifier, not an action the user dispatched.

Both stay where they are; conflating them with action intents would
muddy the discriminated union for no win.

## What this proposal does NOT change

- **The `SessionEntity` data model.** Audit #2 (sidebar agent) flagged
  this as a larger refactor; this proposal **does not** normalize the
  entity. It only reduces the number of parallel maps. The new
  `pendingAction` + `attemptId` fields live in a **parallel runtime
  map** (`sessionRuntimeById: Record<sid, SessionRuntime>`), NOT on the
  `SessionEntity` itself. This keeps the persisted entity untouched
  (see "Transient state — must not be persisted" below). If we want to
  normalize later, it's an independent step.
- **IPC contracts.** `window.ccsmPty.spawn / kill / etc.` keep their
  current shape.
- **What the user sees.** No UX change; right-click menus, rename
  flow, fork flow are identical.
- **The terminal runtime.** If both proposals ship, they intersect
  cleanly: the runtime exposes `runtime.attach(sid, cwd)` /
  `runtime.reload()`; the intent dispatcher calls those. Today,
  `usePtyAttach` reads `reloadNonce` directly from the store — that
  becomes "intent dispatcher schedules a `reload` action; the
  side-effect runner calls `runtime.reload()`."

## Target architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  Sidebar row / context menu                                       │
│                                                                   │
│  onClick → dispatchSessionAction({                                │
│    kind: 'reload' | 'copy' | 'rename'                             │
│        | 'archive' | 'unarchive' | 'retry',                       │
│    sessionId: '...',                                              │
│    payload?: ...                                                  │
│  })                                                               │
└───────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│  Intent reducer (in store)                                        │
│                                                                   │
│  Synchronously updates state in a parallel runtime map:           │
│    - sessionRuntimeById[sid].pendingAction = {kind, payload}      │
│    - sessionRuntimeById[sid].attemptId += 1 (only AFTER any       │
│        side-effect that must precede re-attach has completed —    │
│        see "two-phase actions" below)                             │
│                                                                   │
│  This is the entire store-side of an action. No IPC calls here.   │
│  sessionRuntimeById is NOT persisted (see transient-state note).  │
└───────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│  Side-effect runner (a hook in App.tsx, or a small effect file)   │
│                                                                   │
│  Subscribes to pendingAction changes; for each pending action:    │
│    - reload (phase 'killing'):  ptyKill → on success dispatch     │
│        follow-up reducer step that flips to phase 'attaching'     │
│        AND bumps attemptId; usePtyAttach re-runs on attemptId     │
│    - copy:   createNewSid → spawn(fork); if andThenRename, then   │
│        flip pendingAction to {kind:'rename'} on the new sid       │
│    - rename: focus the rename input → clear pending on submit     │
│    - archive / unarchive: store mutation only → clear pending     │
│    - retry: same shape as reload but no kill phase                │
└───────────────────────────────────────────────────────────────────┘
```

### Discriminated union shape

```ts
type SessionAction =
  | { kind: 'reload'; phase: 'killing' | 'attaching' }
  | { kind: 'copy'; sourceSid: string; andThenRename: boolean }
  | { kind: 'rename' }
  | { kind: 'archive' }
  | { kind: 'unarchive' }
  | { kind: 'retry' };

// Parallel runtime map — NOT on the persisted SessionEntity:
type SessionRuntime = {
  pendingAction: SessionAction | null;
  attemptId: number;
};

// In the store slice (transient, not persisted — see PERSISTED_KEYS note):
type SessionRuntimeState = {
  sessionRuntimeById: Record<string /* sid */, SessionRuntime>;
};
```

Notes on each variant:

- **`reload`** is two-phase. Reducer step A sets
  `{kind:'reload', phase:'killing'}` and does NOT bump `attemptId`.
  The side-effect runner awaits `pty.kill`. On kill success, the runner
  dispatches reducer step B which flips to
  `{kind:'reload', phase:'attaching'}` AND bumps `attemptId`. Only then
  does `usePtyAttach`'s effect (which depends on `attemptId`) re-run,
  so we never re-attach to a dying PTY.

  **Kill-failure semantics.** `pty.kill` is best-effort today
  (`sessionRuntimeSlice.reloadSession` bumps `reloadNonce` regardless
  of kill outcome). The proposal preserves this: on kill failure the
  runner still dispatches the phase-B reducer (flip to `'attaching'` +
  bump `attemptId`) and logs a warning. The attach path then handles
  whatever PTY state results — either the old PTY died after all and a
  fresh spawn-on-null succeeds, or it is still alive and the attach
  reuses it. We do NOT introduce a new error variant for kill failure;
  doing so would diverge from current behavior for no observable user
  benefit. This two-phase pattern is the general principle for any
  action whose side-effect must complete (or be observed to have
  failed) before attach re-runs.
- **`copy`** is composite: a single `pendingAction` slot can't
  represent "copy AND rename" if they were separate variants, so the
  variant carries an `andThenRename` flag. The right-click "Copy
  session" path uses `andThenRename: true` (matches today's behavior
  where `copySession` sets both `pendingForkSource[newId]` and
  `pendingRenameId = newId`). A hypothetical "copy without rename"
  UX would set it false.

  **Target-sid ownership.** Today, `pendingForkSource` is keyed by the
  NEW sid (see `src/stores/slices/sessionCrudSlice.ts` —
  `pendingForkSource[newId] = sourceId`). The proposal mirrors this:
  the `{kind:'copy', sourceSid, andThenRename}` action is stored on
  the NEW session's runtime slot
  (`sessionRuntimeById[newSid].pendingAction`), NOT on the source sid.
  The source session does not need to know it is being copied — only
  the new session needs to know where to fork from on first attach.
  `usePtyAttach` for the new sid reads its own runtime slot, sees
  `kind === 'copy'`, and passes `action.sourceSid` to the
  spawn-on-null fallback.
- **`archive` / `unarchive`** are parameter-less in the user-action
  sense. They are split into two variants (rather than one variant with
  a `mode` field) because they are semantically opposite operations and
  the discriminated union reads cleaner that way — the runner has two
  obviously-paired cases. Current `archiveSession` / `unarchiveSession`
  create or reuse archive containers — they don't move to arbitrary
  groups. The target-group resolution stays in the side-effect runner
  (or a helper), not in the intent.
- **`retry`** is the no-kill analogue of `reload`: reducer bumps
  `attemptId` synchronously; runner has nothing to do.

**Why one slot, not one map per action:** today each map is sparse and
mostly empty; their union semantics are "at most one pending action per
session anyway" because the UI gates them (you can't fork-and-reload the
same row). Collapsing into one slot makes the constraint visible and
auto-enforces the "one outstanding action per session" rule.

**`attemptId` instead of `reloadNonce`+`attachNonce`:** the existing
two-nonce setup splits "things that re-run attach" between a store nonce
(reload) and a hook-local nonce (Retry). A single `attemptId` in the
parallel runtime map is incremented by the reducer for any action that
needs re-attach. `usePtyAttach`'s effect depends on `attemptId`; both
reload (after kill completes) and retry just increment it.

## Implementation phases (each = 1 PR)

### Phase 1 — Introduce `SessionAction` + reducer; migrate ONE action (reload) end-to-end

**Goal:** prove the pattern on the smallest action first. Reload is
ideal: 2 files today (`sessionRuntimeSlice.ts` + `usePtyAttach.ts`),
one nonce, one IPC call.

**Risk:** low — additive. Old `reloadNonce` stays initially; new
`pendingAction` runs in parallel; once tests pass, old nonce removed.

**Deliverables:**
- `src/stores/slices/sessionActionSlice.ts` (new) — holds
  `sessionRuntimeById` (transient; deliberately NOT added to
  `PERSISTED_KEYS` — see the persistence note) + the reducer
  + `dispatchSessionAction(intent)` action
- `SessionAction` + `SessionRuntime` types in `types.ts`
- Side-effect runner for `reload` in a new `useSessionActionRunner` hook
  mounted at App level. Implements the two-phase reload: reducer sets
  phase `'killing'` (no attemptId bump) → runner awaits `pty.kill` →
  runner dispatches phase-B reducer that flips to `'attaching'` and
  bumps `attemptId`. On kill failure the runner ALSO dispatches phase-B
  (best-effort, mirrors current `reloadSession` behavior) and logs a
  warning. `usePtyAttach`'s effect depends only on `attemptId`, so it
  cannot re-attach to a dying PTY.
- `usePtyAttach` reads `attemptId` from `sessionRuntimeById[sid]`
  instead of `reloadNonce`
- Delete `reloadNonce` + `_clearReloadNonce` after migration
- Tests at the reducer level (pure, no React) + integration test that
  asserts the full reload flow, including a test that asserts attach
  does NOT re-run between phase-A and phase-B

### Phase 2 — Migrate `copy / pendingForkSource` and `rename / pendingRenameId`

**Goal:** the two remaining ad-hoc maps disappear, replaced by the
`pendingAction` slot.

**Risk:** medium — copy/fork has the most complex side-effect chain
(create session → spawn with fork source → focus → arm rename).
Mitigation: the reducer doesn't change the side-effect logic, it just
reorganizes where state lives. Existing fork tests catch regressions.

**Deliverables:**
- Reducer handles `{kind: 'copy', sourceSid, andThenRename}` and
  `{kind: 'rename'}`
- Side-effect runner for both. For `copy` with `andThenRename:true`,
  on spawn-success the runner sets the new sid's `pendingAction` to
  `{kind:'rename'}` (sequential composite, second step driven by the
  same runner — no action chaining magic).
- Delete `pendingForkSource: Record<...>` and `pendingRenameId`
- `usePtyAttach`'s spawn-on-null fallback reads
  `sessionRuntimeById[sid]?.pendingAction?.kind === 'copy'
    ? action.sourceSid : undefined`
  instead of reaching into the global map

**Explicit step-by-step for `copy` (the composite case):**

The runtime slot for the copy action lives on the NEW sid, mirroring
how `pendingForkSource` is keyed today. End-to-end:

1. UI handler calls `dispatchSessionAction({kind:'copy', sessionId:
   sourceSid, payload:{andThenRename:true}})`.
2. Reducer creates the new session row (same shape as today's
   `copySession`) with a fresh `newSid`, and sets
   `sessionRuntimeById[newSid].pendingAction =
   {kind:'copy', sourceSid, andThenRename:true}`. The source sid's
   runtime slot is untouched.
3. Reducer sets `activeId = newSid`, which causes the terminal pane to
   mount/attach for `newSid` (same trigger as today).
4. `usePtyAttach` runs for `newSid`. The spawn-on-null fallback reads
   `sessionRuntimeById[newSid]?.pendingAction`; sees
   `kind === 'copy'`; calls `pty.spawn` with
   `--fork-session=action.sourceSid`.
5. On spawn success, the runner observes the spawn completed and
   transitions `sessionRuntimeById[newSid].pendingAction` from
   `{kind:'copy', ...}` to `{kind:'rename'}` (only when
   `andThenRename:true`; otherwise clears to `null`).
6. The RenameInput, watching the new sid's `pendingAction` slot for
   `{kind:'rename'}`, focuses itself. On submit, the reducer clears
   the slot to `null`.

This matches the current observable behavior; only the storage shape
moves (one `pendingAction` slot on `sessionRuntimeById[newSid]` instead
of two parallel maps `pendingForkSource[newSid]` + `pendingRenameId`).

### Phase 3 — Migrate `retry` and `archive`

**Goal:** consolidate the remaining two action paths.

**Risk:** low — retry is trivially analogous to reload; archive is
mostly a store mutation today.

**Deliverables:**
- Move `Retry` handler in `TerminalPane` to dispatch `{kind: 'retry'}`
  instead of bumping local `attachNonce` state
- Move the archive context-menu handler to dispatch
  `{kind: 'archive'}` and the unarchive context-menu handler to
  dispatch `{kind: 'unarchive'}` (two distinct variants — see the
  variant notes above for the rationale)
- Delete `attachNonce` from `usePtyAttach`
- Final cleanup of sidebar handlers — every right-click action now
  goes through one dispatch call, no slice-reaching

## Open questions for review

1. **Slot vs queue.** `pendingAction: SessionAction | null` (slot) vs
   `pendingActions: SessionAction[]` (queue)? Today there's no scenario
   where two actions queue legitimately — the UI gates them — so the
   slot is correct AND enforces the gate at the type level.
   **Recommendation: slot.**

2. **Should the reducer fire IPC directly?** Audit's intuition: no.
   Keeping IPC out of the reducer keeps store mutations sync + testable
   without mocks; the side-effect runner is the seam where IPC happens.
   **Recommendation: reducer is sync state-only; side-effect runner is
   the only IPC caller.**

3. **`attemptId` overflow / scope.** A monotonic counter on a single
   entity is fine for the foreseeable lifetime (a user retrying once a
   second for the age of the universe would not overflow JS Number).
   No special handling needed.

4. **Interaction with the terminal runtime proposal.** If
   TerminalRuntime ships first, the side-effect runner for `reload`
   calls `runtime.reload()`; for `retry` calls `runtime.retry()`;
   `usePtyAttach`'s dependency on `attemptId` is replaced by the
   runtime's `attach()` command being called by the runner. Cleaner
   layering: store dispatches intent → runner reads intent →
   runner calls runtime → runtime emits state → adapters react.
   **Recommendation: ship TerminalRuntime phase 1 BEFORE
   SessionActionIntent phase 1 so the runner has a clean target.**

5. **Test coverage cost.** Each phase adds reducer-level unit tests
   (cheap, pure) and replaces some hook-level integration tests.
   Net: more tests, but flatter — pure reducer tests beat mocked
   hook tests for catching regressions in coordination logic.

## What success looks like

After all three phases ship:

- `types.ts`'s coordination-map zoo (`reloadNonce`, `pendingForkSource`,
  `pendingRenameId`, `attachNonce` references) collapses to one
  `pendingAction: SessionAction | null` slot in
  `sessionRuntimeById[sid]` — a transient parallel map, never on the
  persisted `SessionEntity`
- "How does the right-click reload work?" answered by reading 2 files
  (the reducer + the runner) instead of 5
- New session actions are additive: add a variant to the union, add
  a case in the runner, add a context menu handler — no new map, no
  new slice surgery
- The sidebar's memo-chain contract (#1271) becomes less load-bearing:
  one stable `pendingAction` reference per row instead of looking up
  from multiple maps each render

---

## Sequencing with the terminal runtime proposal

Recommended order (revised — fewer interleavings, more stability):

1. **TerminalRuntime phase 1 + 2 first.** The runtime is the stable
   target API; alternating six PRs before that API settles increases
   churn for both proposals.
2. **SessionActionIntent phase 1** (reload — the simplest action,
   built against the now-stable runtime).
3. **Revisit interleaving** for the remaining phases based on how
   Phase 1 went. We may find Phase 2/3 of either proposal can ship
   independently, or that bundling them is cleaner — that call is
   better made with one phase of evidence in hand.

Total still ~6 PRs over ~3 weeks, each shippable and behavior-equivalent
on its own. No big-bang. Every PR can be reverted without dragging the
rest back.

---

## Cross-cutting concern: transient state must NOT be persisted

Both this proposal and the TerminalRuntime proposal introduce new
in-memory state (`sessionRuntimeById` here; FSM state + replay buffers
in the runtime). **None of it belongs in the persisted store.**
Persistence in this codebase is NOT zustand's `persist` middleware —
it is a custom allowlist in `src/stores/persist.ts`: the
`PERSISTED_KEYS` array enumerates the top-level state keys that flow
into the snapshot written via `schedulePersist` / `flushNow`. A
compile-time assertion in `src/stores/store.ts`
(`_AssertPersistedKeysOnState` / `_AssertPersistedKeysOnPersisted`)
guarantees every key in `PERSISTED_KEYS` exists on both the runtime
state type and the on-disk `PersistedState` shape. Anything we add
for action coordination or runtime state must therefore be excluded
from persistence by **not being added to `PERSISTED_KEYS`** — the
allowlist is the single switch.

Concretely:

- `sessionRuntimeById` must NOT appear in `PERSISTED_KEYS` and must
  NOT be added to `PersistedState`. A reloaded app should start with
  an empty runtime map; pending actions don't survive a restart (the
  IPC side-effect they were driving is also gone).
- The TerminalRuntime's FSM state, buffered writes, and snapshot
  sequence numbers are renderer-process lifetime only and never
  touch the persistor — already true today, must remain true.

This is the single source of truth for the constraint; both proposals
defer to it.

---

## Next step

Same as the terminal runtime proposal: if approved, each phase becomes a
`docs/superpowers/plans/` implementation plan with `superpowers:writing-
plans`-style bite-sized TDD steps. Generating those steps now is
premature; many decisions above are still revisable.
