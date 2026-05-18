// In-memory map of sessions with a manual rename awaiting SDK writeback
// confirmation. Used to suppress the auto-summary watcher from clobbering
// the user's chosen name between the moment they hit Enter and the moment
// the SDK rewrites the JSONL summary back to that same string.
//
// Lifecycle:
//   - set on `renameSession` entry (desired = user input)
//   - read by `_applyExternalTitle`: if entry exists and incoming title
//     differs from desired, the external title is dropped; if it matches,
//     the entry is cleared (round-trip confirmed) and the patch applies
//   - cleared on `deleteSession` (avoid leaking entries for dead sids)
//
// Module-scoped (not on the zustand state tree) because it's pure
// renderer-session ephemera — restart is a clean slate. Persisted sessions
// already have a non-default name so `BACKFILL_DEFAULT_NAMES` shields them
// from the boot-time backfill pass.

const pending = new Map<string, string>();

export function setPendingManualRename(sid: string, desiredName: string): void {
  pending.set(sid, desiredName);
}

export function getPendingManualRename(sid: string): string | undefined {
  return pending.get(sid);
}

export function clearPendingManualRename(sid: string): void {
  pending.delete(sid);
}

export function _resetPendingManualRenamesForTests(): void {
  pending.clear();
}
