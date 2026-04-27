// task #320 — pick a permission-mode-aware placeholder string for the
// composer textarea while a turn is running.
//
// The "running" placeholder is the most prominent surface visible to the
// user during a turn (the StatusBar permission chip is small and easy to
// miss). Reflecting the active permission posture there tells the user
// what to expect — will I be prompted? are edits being auto-applied? —
// without forcing them to glance away.
//
// Pure function, no React: kept in `lib/` so unit tests can exercise it
// directly with a fake `t`.
import type { PermissionMode } from '../stores/store';

type T = (key: string) => string;

export function runningPlaceholderForMode(t: T, mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return t('chat.runningPlaceholderPlan');
    case 'acceptEdits':
      return t('chat.runningPlaceholderAcceptEdits');
    case 'bypassPermissions':
      return t('chat.runningPlaceholderBypass');
    case 'default':
    default:
      // Unknown / future modes fall back to the conservative "will ask"
      // copy — safer than implying auto-accept.
      return t('chat.runningPlaceholderDefault');
  }
}
