// Tiny event bus the slash-command handlers use to reach into UI surfaces
// (the Settings dialog, the model picker dropdown, etc.) without pulling
// React context through every call site.
//
// App.tsx subscribes once on mount and routes events to the local React
// state that actually owns the open/closed bits. Tests can subscribe too
// and assert on emitted events.

export type SettingsTab =
  | 'appearance'
  | 'notifications'
  | 'endpoints'
  | 'permissions'
  | 'updates';

type Listener = (tab?: SettingsTab) => void;

let openSettingsListener: Listener | null = null;

export function setOpenSettingsListener(fn: Listener | null): void {
  openSettingsListener = fn;
}

export function openSettings(tab?: SettingsTab): void {
  if (openSettingsListener) openSettingsListener(tab);
}
