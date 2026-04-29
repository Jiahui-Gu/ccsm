// Focus → badge-clear controller.
//
// Extracted from electron/main.ts per #677 SRP. Two concerns split:
//
//   1. `decideBadgeClear` — pure decider. Given (focused, activeSid,
//      hasBadge), returns whether to clear. No I/O; trivially unit-tested.
//
//   2. `BadgeController` — sink wrapper around BadgeManager.clearSid.
//      `onFocusChange` calls the decider, and on `true` clears the active
//      sid's badge. The renderer-pushed activeSid + the OS focus signal
//      both flow through `onFocusChange`, keeping the call sites in
//      main.ts to a single line each.
//
// The previous inline `clearBadgeForActiveIfFocused` mixed "is the window
// focused?", "do we know the active sid?", and "tell the badge manager to
// clear" all in one function and was called from two places (win.on('focus')
// and ipcMain session:setActive). Splitting decider from sink lets us test
// the conditions without spinning up an electron BrowserWindow.

import type { BadgeManager } from './notify/badge';

export interface BadgeDecisionInput {
  focused: boolean;
  activeSid: string | null;
  hasBadge: boolean;
}

/**
 * Pure 3-condition decider: clear the badge for the active sid only when
 * the window is focused, we know which sid is active, and a BadgeManager
 * is wired up. The `hasBadge` flag is named that way (vs "hasBadgeManager")
 * because the call site can pass `false` whenever a clear would be a no-op
 * (no manager OR manager unwired) — keeps the decider opinion-free about
 * whether the dependency exists vs whether it's empty.
 */
export function decideBadgeClear(input: BadgeDecisionInput): boolean {
  return input.focused && !!input.activeSid && input.hasBadge;
}

export interface FocusChangeInput {
  focused: boolean;
  activeSid: string | null;
}

export class BadgeController {
  constructor(private getBadgeManager: () => BadgeManager | null) {}

  /**
   * Single sink. Fed from win.on('focus') (focused=true) and from the
   * renderer's session:setActive IPC (focused = current window state).
   * Caller computes `focused` from the BrowserWindow because asking
   * electron for it inside the controller would couple this module to
   * the electron import.
   */
  onFocusChange(input: FocusChangeInput): void {
    const mgr = this.getBadgeManager();
    if (!decideBadgeClear({ ...input, hasBadge: !!mgr })) return;
    // input.activeSid is non-null here (decideBadgeClear checked it).
    mgr!.clearSid(input.activeSid as string);
  }
}
