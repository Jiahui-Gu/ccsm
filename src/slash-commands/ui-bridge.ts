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
  | 'connection'
  | 'updates';

type SettingsListener = (tab?: SettingsTab) => void;
type ModelPickerListener = () => void;

let openSettingsListener: SettingsListener | null = null;
let openModelPickerListener: ModelPickerListener | null = null;

export function setOpenSettingsListener(fn: SettingsListener | null): void {
  openSettingsListener = fn;
}

export function openSettings(tab?: SettingsTab): void {
  if (openSettingsListener) openSettingsListener(tab);
}

// Model picker bridge — used by `/model` to pop open an in-chat picker
// (rather than dragging the user into the Settings → Connection pane just
// to flip a default they want to change for this session only).
export function setOpenModelPickerListener(fn: ModelPickerListener | null): void {
  openModelPickerListener = fn;
}

export function openModelPicker(): void {
  if (openModelPickerListener) openModelPickerListener();
}
