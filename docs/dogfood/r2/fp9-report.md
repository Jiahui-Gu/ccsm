# Dogfood r2 fp9 — Truncate from here + Edit/Rewind

**Worker:** dogfood-r2-fp9
**Branch:** dogfood-r2-fp9
**Date:** 2026-04-27
**Build under test:** installed CCSM.exe at `C:/Users/jiahuigu/AppData/Local/Programs/CCSM/CCSM.exe`
**Proxy:** Agent Maestro at `http://localhost:23333/api/anthropic`
**Probe:** `scripts/probe-dogfood-r2-fp9-truncate-rewind.mjs`
**Logs:** `dogfood-logs/r2-fp9/` (probe.log, snap-*.json, findings.json)
**Screenshots:** `docs/screenshots/dogfood-r2/fp9-truncate-rewind/`

## TL;DR verdict

**MIXED — core truncate works, but spec divergence + 1 real cross-restart bug.**

| Check | Verdict | Notes |
|---|---|---|
| A — Right-click assistant → Truncate menu | FAIL (spec divergence) | ccsm has no right-click context menu. Truncate is on USER blocks only via hover Scissors icon. |
| B — Truncate cuts UI + send continues | PASS | 6 → 3 blocks; new prompt resumed cleanly with fresh CLI; `resumeSessionId` cleared. |
| C — Right-click user → Edit and resend | FAIL (spec divergence) | ccsm has no right-click; Edit is a Pencil hover icon. |
| C/edit-flow — Edit loads + send | PASS | composer populated with original text; modified+Enter sends a new turn. |
| D — Edit replaces original turn | **FAIL (intentional design)** | Edit is non-destructive — appends a new user turn instead of replacing. Original turn stays in transcript. The agent sees BOTH copies in history. |
| E — Edit on first user message | PASS | same code path as Check C; works on idx 0. |
| F — Cross-restart truncation persistence | **FAIL (real bug)** | Truncation marker IS persisted, but re-apply on restart silently no-ops because the stored `blockId` doesn't match any JSONL-projected block id — full history is restored. |

## Spec vs implementation divergence

The fp9 spec described "right-click context menu → Truncate from here / Edit and resend" with edit-and-resend doing a **replace** (drop the original turn and everything after, then resubmit). ccsm's actual implementation:

- **No right-click context menus** anywhere on chat blocks. Actions are inline hover icons that fade in on row hover (`opacity-0` → `opacity-100`).
- User blocks have four hover icons in this order: **Pencil (Edit) / RotateCw (Retry) / Copy / Scissors (Truncate)**.
- Assistant blocks have no truncate / rewind action at all.
- **Edit is non-destructive by design** — clicking Pencil only injects the original text into the composer (with the live draft stashed into ↑/↓ recall first if non-empty). The original user turn is preserved; whatever the user sends becomes a NEW turn appended after the existing assistant reply. See `src/components/chat/blocks/UserBlock.tsx:73-92` and the comment at line 76: *"We do NOT delete the existing turn — Edit is non-destructive (use Truncate to drop the turn)."*

Source comments call out this is intentional, not a bug:
- `UserBlock.tsx:14-17` — "Upstream `webview/index.js` puts the same intent behind one ⤺ button + a popup with three options... Per the user's spec we surface the four primary verbs as inline icons instead — fewer clicks, no popup."
- The two-button pattern (Edit = non-destructive append, Truncate = destructive cut) means the user can compose either flow themselves: Edit → Send for "ask again with tweaks", or Truncate → type new prompt for "rewind and retry from this point". Combining the two effectively reproduces the spec's "edit and resend".

**Manager decision needed:** is the spec wrong, or does fp9 want the spec implemented (right-click + replace semantics) on top of the current inline-icon UX? Because Truncate is correctly available, the current UX already covers the "rewind from this user turn" intent through Truncate-then-retype.

## Bug found: cross-restart truncate persistence is silently broken

**Severity:** medium — user-facing data invariant violated; truncation appears to "stick" until app restart, then everything reappears.

### Reproduction (probe)

1. Send 3 prompts (ALPHA / BETA / GAMMA), get 3 user + 3 assistant blocks. Block ids are renderer-generated `u-<base36-rand>-<rand>` (local-echo).
2. Truncate at user2. In-memory transcript drops to 3 blocks, persisted marker is `{ blockId: "u-mogrjvqb-ahyl", truncatedAt: 1777268147399 }`.
3. Send a new prompt — works (resume was cleared).
4. Quit ccsm, relaunch.
5. Hydration calls `loadHistory(cwd, sessionId)` → JSONL frames → `framesToBlocks(frames)` produces user blocks with **JSONL-derived UUID ids** like `u-9eb6e1ba-54bf-43f9-bb7e-c45ec6e450a1`.
6. The marker re-apply at `store.ts:2117-2122` looks for `b.id === marker.blockId`. No match. Silently no-op. Full 10-block transcript restored.

### Snapshot evidence

`dogfood-logs/r2-fp9/snap-after-truncate-before-restart.json`:

```json
"messageCount": 3,
"messageBlocks": [
  { "id": "u-mogrjqx8-yod6", "kind": "user" },
  { "id": "msg_1777268118311:c0", "kind": "assistant" },
  { "id": "u-mogrjvqb-ahyl", "kind": "user" }   // marker target
]
```

`dogfood-logs/r2-fp9/snap-post-restart.json`:

```json
"messageCount": 10,
"blocks": [
  { "id": "u-9eb6e1ba-54bf-43f9-bb7e-c45ec6e450a1", "kind": "user" },  // not the marker id
  ...
]
```

Truncation marker IPC roundtrip both before and after restart returns the same value:

```
{ "blockId": "u-mogrjvqb-ahyl", "truncatedAt": 1777268147399 }
```

So persistence works, but the **id space for marker.blockId never matches the id space framesToBlocks produces**. The comment at `store.ts:2112` claims *"Marker by id is stable because framesToBlocks derives u-<uuid> from the JSONL line"* — but the marker is recorded on whatever id was on screen at truncate time, which for a fresh local-echo block is NOT a JSONL-derived id.

### Likely fix shape (informational — manager to scope a fix worker)

Option 1 — anchor marker by **(turn ordinal + first-N chars of user text)** instead of block id. Survives id space changes.

Option 2 — make local-echo block ids match what JSONL will produce. Hard: local-echo runs before the CLI has assigned a uuid_v4 to that user message.

Option 3 — at marker-write time, replace `marker.blockId` with the JSONL-derived id by reading `messagesBySession` AFTER `loadHistory` has merged JSONL into the renderer (i.e., delay the marker write until first reload, or re-emit it on first hydration). Brittle.

Option 1 (turn-ordinal-based marker) is simplest and resilient.

## Per-check details

### Check A — Right-click assistant for Truncate
- Status: **FAIL** (no such feature)
- Right-clicked the chat region; no `[role="menu"]` or Radix popper appeared.
- Screenshot: `check-a-assistant-rightclick.png`

### Check B — Truncate cuts UI; subsequent send continues
- Status: **PASS**
- Hover on user2 revealed action row; Scissors aria-label `"Truncate from here"`.
- Click: `messagesBySession[sid]` shrank from 6 → 3, last block is the truncated-at user (kept per Bug #309 — inclusive cut).
- `resumeSessionId` was already populated; the post-truncate send still produced a working continuation. (Note: the in-flight `rewindToBlock` action at `store.ts:1948-1955` keeps `resumeSessionId` set so the resumed CLI sees the full pre-truncate JSONL — only the renderer hides the tail. Confirmed by the snapshot showing `resumeSessionId: "d2c277a3-..."` after truncate.)
- Sent "DELTA"; agent replied "DELTA"; final block count 5.
- Screenshots: `check-b-pre-truncate-hover.png`, `check-b-post-truncate.png`, `check-b-post-truncate-resume.png`

### Check C — Right-click user / Edit-and-resend flow
- Right-click context menu: **FAIL** (none).
- Edit (Pencil) hover icon: **PASS**. Click loaded original text `"Reply with the single word: ALPHA"` into composer.
- Modified to `"Reply with the single word: ALPHA (edited)"`, hit Enter.
- Post-send transcript: original `u-mogrjqx8-yod6` STILL present + new `u-mogrkaqb-yj0e` with `(edited)` text appended after.
- Screenshots: `check-c-user-rightclick.png`, `check-c-pre-edit-hover.png`, `check-c-composer-loaded.png`, `check-d-post-edit.png`

### Check D — Edit replaces original turn
- Status: **FAIL** vs spec, **as-designed** vs implementation.
- Original turn preserved alongside the edited turn. Both visible in `messageBlocks`. Agent answered the edited prompt only because the edited prompt is the latest, but it sees both in conversation history.

### Check E — Edit on first user message
- Status: **PASS** (covered by Check C — first remaining user block IS the first user message; no special-case error path).

### Check F — Cross-restart persistence
- Marker IPC: **PASS** — `truncationGet` returns the same `{ blockId, truncatedAt }` after restart.
- Truncate effect on UI after restart: **FAIL** — full transcript reappears. See bug section above.
- Screenshots: `check-f-pre-restart.png`, `check-f-post-restart.png`

## Files referenced
- Probe: `C:/Users/jiahuigu/ccsm-worktrees/pool-4/scripts/probe-dogfood-r2-fp9-truncate-rewind.mjs`
- UI: `C:/Users/jiahuigu/ccsm-worktrees/pool-4/src/components/chat/blocks/UserBlock.tsx`
- Truncate action: `C:/Users/jiahuigu/ccsm-worktrees/pool-4/src/stores/store.ts:1918-1990`
- Marker re-apply: `C:/Users/jiahuigu/ccsm-worktrees/pool-4/src/stores/store.ts:2108-2127`
- IPC types: `C:/Users/jiahuigu/ccsm-worktrees/pool-4/src/global.d.ts:96-108`

## Recommendations for manager
1. **Decide on spec vs design** for right-click context menus + edit-replace semantics. The current inline-icon model is reasonable and intentional; if fp9 wants right-click parity with upstream `webview/index.js`, that's a sizable feature, not a bug.
2. **Dispatch a fix worker for cross-restart truncation persistence** (Check F). Real user-facing data invariant break — every truncate is silently undone on next launch. Probably a 1–2 hour fix using turn-ordinal-anchored markers.
3. **Optional follow-up** — clarify in UI that Edit is non-destructive vs Truncate is destructive. Today the only signal is the icon glyph (Pencil vs Scissors). A first-time user could reasonably think Edit replaces the turn.
