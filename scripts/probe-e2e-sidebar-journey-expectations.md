# Sidebar / Group / Session full-operation user-journey expectations

Written BEFORE inspecting any source. Each item describes what a user would
reasonably expect from a polished, GUI-norms-respecting sidebar. The probes
that follow assert these as strict invariants. Any divergence between the
expected behavior here and the observed behavior is a STOP-and-report event,
not a "fix the test" event.

## Creation

### J1 — "New session" button creates into the active group
Expected:
1. Click the global "New session" button in the sidebar.
2. A new session is created with `groupId === activeGroupId` (i.e. the group
   the currently-active session lives in), NOT the first/default group.
3. The new session becomes `activeId` immediately.
4. The composer textarea (in main pane) receives focus so the user can type.
5. If the host group was collapsed, it auto-expands so the new row is visible.

### J2 — "New group" button creates a fresh group
Expected:
1. Click "New group".
2. A new group appears with a default placeholder name (e.g. "Untitled" /
   "New group" / "Group N").
3. The new group becomes the active context (subsequent "New session"
   defaults into it) AND is expanded.
4. The group name immediately enters inline rename mode so the user can
   type a real name without an extra click.

### J3 — Per-group "+" affordance
Expected:
1. Hovering a group header reveals a per-row "+" button.
2. Clicking that "+" creates a session under THAT group (not the active
   group) and selects it.
3. The host group does NOT collapse; if collapsed, it expands first.
4. Archived groups MUST NOT show the "+" button (no creating into archive).

## Deletion

### J4 — Deleting a non-active session
Expected:
1. Right-click a non-active session row → "Delete".
2. The row disappears immediately from the sidebar.
3. `activeId` does NOT change.
4. No prompt for non-active sessions (deletion is reversible-by-undo at
   worst, but a confirm on every non-active delete is too noisy). NOTE:
   confirm dialogs are a defensible alternative — if confirm is required
   we report it as a divergence, not a failure.

### J5 — Deleting the active session falls back gracefully
Expected:
1. Delete the currently-active session.
2. New active = next session in the SAME group (sibling), preferring the
   one immediately below, falling back to immediately above.
3. If the group has no other sessions, fall back to the first session of
   the next non-empty group.
4. If no sessions remain anywhere, app enters a documented empty state.
5. `activeId` is NEVER left as a dangling id pointing at a deleted session.

### J6 — Deleting a running session stops the agent
Expected:
1. A session whose agent process is currently running.
2. Right-click → Delete.
3. The agent process is terminated cleanly (no orphan).
4. The row vanishes from the sidebar.
NOTE: this requires spawning a real claude binary — out of scope for an
isolated probe. We cover the store-level state ("session removed even
when state==running") and assert no exception is thrown. Process-leak
coverage requires integration-level testing.

### J7 — Deleting a group containing sessions
Expected (chosen ahead of inspection):
* The action SHOULD require confirmation when the group contains ≥1
  session ("Delete group X and N sessions inside?").
* On confirm, both the group and its sessions are removed atomically.
* `activeId` falls back per J5 rules if it pointed inside the group.
* If the group is empty, no confirm is needed.

If the actual product instead refuses to delete non-empty groups, or
silently archives them, we STOP and report — both are defensible designs,
but they MUST be one of the documented behaviors, and the probe will
detect which.

## Renaming

### J8 — Session inline rename
Expected:
1. Right-click → "Rename" produces an inline input.
2. Enter commits the trimmed value.
3. Escape cancels (original name restored).
4. Whitespace-only + Enter is a cancel (no empty names).
5. Click outside commits (does not silently discard typing).
6. During IME composition, Enter does NOT commit; commit waits for
   `compositionend`.

### J9 — Group inline rename
Same five rules as J8, applied to groups.

### J10 — Duplicate names
Expected (chosen ahead): duplicate names are ALLOWED. The id is the
identity; the name is just a label. Forcing uniqueness on a free-form
label is user-hostile. If the product enforces uniqueness, that is a
divergence — STOP and report.

## Drag and drop

### J11 — Cross-group drag
Expected: drag session from group A to group B → session lands in B,
disappears from A. (Already covered by `probe-e2e-dnd.mjs`; we add
ordering assertions here.)

### J12 — In-group reorder
Expected: drag session within its group changes its position; new order
is persisted across an app restart (same userData, two electron.launch).

### J13 — Hover-expand collapsed group while dragging
Expected: dragging a session and hovering over a collapsed group's header
for ~400-1500ms auto-expands the group, allowing drop into its body.
(Already covered by `probe-e2e-dnd.mjs`; we re-assert here.)

### J14 — Drag onto archived group
Expected (chosen ahead): drag onto an archived group is REJECTED — the
session stays in its source group. Archive is a "park" state; moving live
sessions in is unexpected. If the product allows it, divergence.

## Group state

### J15 — Collapse/expand persistence
Expected:
1. Collapse a group, switch sessions, switch back → group stays collapsed.
2. Restart the electron app (same userData) → group still collapsed.

### J16 — Archive a group containing sessions
Expected (chosen ahead):
1. Archiving a non-empty group is allowed without confirm.
2. The group moves to a clearly distinct "Archived" zone in the sidebar
   (collapsible, separate from the live list).
3. Sessions inside an archived group are NOT shown in the active list and
   are NOT focusable via tab nav.
4. Unarchive restores the group to its previous position (or to the end).

## Selection

### J17 — Active session highlight + scroll-into-view
Expected:
1. Active row has a clearly visible affordance (background or left bar).
2. With many sessions, programmatically setting `activeId` to a
   bottom-of-list session causes the sidebar's scroll container to bring
   that row into view.
