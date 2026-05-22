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
| `reloadNonce`, `attachNonce`, retry counter logic | One `attemptId` field on the session entity; `usePtyAttach`'s `useEffect` depends on `attemptId`, no separate nonce |
| `pendingForkSource: Record<sid, sid>` | `pendingAction: SessionAction \| null` on the new session entity, with discriminated union variants |
| `pendingRenameId: sid \| null` | Same `pendingAction` slot — `{kind: 'rename'}` variant — consumed by RenameInput |
| Imperative store mutators that orchestrate IPC + multiple `set` calls (`reloadSession`, `copySession`) | A thin `dispatchSessionAction(intent)` reducer that produces the new state synchronously; an effect layer reads the pending action and performs IPC |
| Each action's UI handler reaching into 3 slices | UI just dispatches `SessionActionIntent` |

## What this proposal does NOT change

- **The `SessionEntity` data model.** Audit #2 (sidebar agent) flagged
  this as a larger refactor; this proposal **does not** normalize the
  entity. It only reduces the number of parallel maps. If we want to
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
│    kind: 'reload' | 'copy' | 'rename' | 'archive' | 'retry',      │
│    sessionId: '...',                                              │
│    payload?: ...                                                  │
│  })                                                               │
└───────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│  Intent reducer (in store)                                        │
│                                                                   │
│  Synchronously updates state:                                     │
│    - sessions[sid].pendingAction = {kind, payload}                │
│    - sessions[sid].attemptId += 1 (if action implies re-attach)   │
│                                                                   │
│  This is the entire store-side of an action. No IPC calls here.   │
└───────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│  Side-effect runner (a hook in App.tsx, or a small effect file)   │
│                                                                   │
│  Subscribes to pendingAction changes; for each pending action:    │
│    - reload: ptyKill → wait → clear pending; usePtyAttach's       │
│        attemptId-dependent effect re-runs and re-attaches         │
│    - copy:   createNewSid → spawn(fork) → clear pending           │
│    - rename: focus the rename input → clear pending on submit     │
│    - archive: store mutation only → clear pending                 │
│    - retry: same as reload but no kill                            │
└───────────────────────────────────────────────────────────────────┘
```

### Discriminated union shape

```ts
type SessionAction =
  | { kind: 'reload' }
  | { kind: 'copy'; sourceSid: string }
  | { kind: 'rename' }
  | { kind: 'archive'; toGroupId: string | null }
  | { kind: 'retry' };

// On the session entity:
type SessionUiState = {
  pendingAction: SessionAction | null;
  attemptId: number;
  // existing fields stay
};
```

**Why one slot, not one map per action:** today each map is sparse and
mostly empty; their union semantics are "at most one pending action per
session anyway" because the UI gates them (you can't fork-and-reload the
same row). Collapsing into one slot makes the constraint visible and
auto-enforces the "one outstanding action per session" rule.

**`attemptId` instead of `reloadNonce`+`attachNonce`:** the existing
two-nonce setup splits "things that re-run attach" between a store nonce
(reload) and a hook-local nonce (Retry). A single `attemptId` on the
entity is incremented by the reducer for any action that needs re-attach.
`usePtyAttach`'s effect depends on `attemptId`; both reload and retry
just increment it.

## Implementation phases (each = 1 PR)

### Phase 1 — Introduce `SessionAction` + reducer; migrate ONE action (reload) end-to-end

**Goal:** prove the pattern on the smallest action first. Reload is
ideal: 2 files today (`sessionRuntimeSlice.ts` + `usePtyAttach.ts`),
one nonce, one IPC call.

**Risk:** low — additive. Old `reloadNonce` stays initially; new
`pendingAction` runs in parallel; once tests pass, old nonce removed.

**Deliverables:**
- `src/stores/slices/sessionActionSlice.ts` (new) — the reducer +
  `dispatchSessionAction(intent)` action
- `SessionAction` type in `types.ts`
- Side-effect runner for `reload` in a new `useSessionActionRunner` hook
  mounted at App level
- `usePtyAttach` depends on `session.attemptId` instead of `reloadNonce`
- Delete `reloadNonce` + `_clearReloadNonce` after migration
- Tests at the reducer level (pure, no React) + integration test that
  asserts the full reload flow

### Phase 2 — Migrate `copy / pendingForkSource` and `rename / pendingRenameId`

**Goal:** the two remaining ad-hoc maps disappear, replaced by the
`pendingAction` slot.

**Risk:** medium — copy/fork has the most complex side-effect chain
(create session → spawn with fork source → focus → arm rename).
Mitigation: the reducer doesn't change the side-effect logic, it just
reorganizes where state lives. Existing fork tests catch regressions.

**Deliverables:**
- Reducer handles `{kind: 'copy', sourceSid}` and `{kind: 'rename'}`
- Side-effect runner for both
- Delete `pendingForkSource: Record<...>` and `pendingRenameId`
- `usePtyAttach`'s spawn-on-null fallback reads
  `session.pendingAction?.kind === 'copy' ? action.sourceSid : undefined`
  instead of reaching into the global map

### Phase 3 — Migrate `retry` and `archive`

**Goal:** consolidate the remaining two action paths.

**Risk:** low — retry is trivially analogous to reload; archive is
mostly a store mutation today.

**Deliverables:**
- Move `Retry` handler in `TerminalPane` to dispatch `{kind: 'retry'}`
  instead of bumping local `attachNonce` state
- Move archive/unarchive context-menu handlers to dispatch
  `{kind: 'archive'}`
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
  `pendingAction: SessionAction | null` field on the session entity
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

Recommended order:

1. **TerminalRuntime phase 1** (introduce runtime, hooks still adapters)
2. **SessionActionIntent phase 1** (reload migrated; uses
   `runtime.reload()`)
3. **TerminalRuntime phase 2** (drop snapshotReplay callback)
4. **SessionActionIntent phase 2** (copy + rename migrated)
5. **TerminalRuntime phase 3** (retire deprecated accessors)
6. **SessionActionIntent phase 3** (retry + archive migrated)

Total: 6 PRs over ~3 weeks, each shippable and behavior-equivalent on its
own. No big-bang. Every PR can be reverted without dragging the rest
back.

---

## Next step

Same as the terminal runtime proposal: if approved, each phase becomes a
`docs/superpowers/plans/` implementation plan with `superpowers:writing-
plans`-style bite-sized TDD steps. Generating those steps now is
premature; many decisions above are still revisable.
