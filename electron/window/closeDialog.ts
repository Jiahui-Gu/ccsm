import { type CloseAction } from '../prefs/closeAction';

// Pure decider for the close-action dialog response. Given the user's
// choice + dontAskAgain checkbox, returns:
//   - `action`: what main should DO right now ('tray' | 'quit' | 'cancel').
//   - `persist`: which preference (if any) to persist via setCloseAction.
//
// Locked semantics (#1253):
//   * cancel NEVER persists, even when dontAskAgain is checked. Persisting
//     'cancel' is meaningless (there's no 'cancel' close-pref), and we
//     refuse to trap the user — if they cancel + tick the box, treat the
//     tick as discarded.
//   * tray/quit + dontAskAgain → persist that choice as the new pref.
//   * tray/quit alone → no persistence; act once.
// Pure so it can be unit-tested without booting Electron.
export type CloseDialogChoice = 'tray' | 'quit' | 'cancel';

export interface CloseDialogResponse {
  choice: CloseDialogChoice;
  dontAskAgain: boolean;
}

export interface CloseDialogDecision {
  action: CloseDialogChoice;
  persist: CloseAction | null;
}

export function decideCloseAction(
  response: CloseDialogResponse,
): CloseDialogDecision {
  if (response.choice === 'cancel') {
    return { action: 'cancel', persist: null };
  }
  return {
    action: response.choice,
    persist: response.dontAskAgain ? response.choice : null,
  };
}

// Default fallback when the renderer never responds to a
// `window:askCloseAction` request (renderer hung, dialog crashed, IPC
// dropped). Locked to 'tray' on every platform: it's the non-destructive
// option (user can quit explicitly via tray menu) and matches the macOS
// default. Never persists. 10s window matches generous human reaction
// time without leaving the close X feeling completely dead.
export const CLOSE_ASK_TIMEOUT_MS = 10_000;
