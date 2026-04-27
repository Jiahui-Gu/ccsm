import { useStore } from '../stores/store';

export type NotificationEventType = 'permission' | 'question' | 'turn_done';

export interface DispatchInput {
  sessionId: string;
  eventType: NotificationEventType;
  title: string;
  body?: string;
  /**
   * Minimal metadata forwarded to the main process notification IPC. Plain
   * Electron Notification toasts ignore this — they only need `title` + `body`.
   * `toastId` matches the `requestId` used by PermissionPromptBlock so the
   * action callback (Allow / Allow always / Reject) can route back.
   */
  extras?: {
    toastId?: string;
    sessionName?: string;
    groupName?: string;
    eventType?: NotificationEventType;
  };
}

export type DispatchSkipReason = 'no-api' | 'global-disabled';

export interface DispatchResult {
  dispatched: boolean;
  reason?: DispatchSkipReason;
}

// Single gate: if notifications are enabled globally, fire. No focus gate, no
// debounce, no per-event toggle, no per-session mute. The user wants to know
// whenever a session needs them — that's the whole point of an OS toast.
export async function dispatchNotification(input: DispatchInput): Promise<DispatchResult> {
  const api = window.ccsm;
  if (!api) return { dispatched: false, reason: 'no-api' };

  const settings = useStore.getState().notificationSettings;
  if (!settings.enabled) return { dispatched: false, reason: 'global-disabled' };

  await api.notify({
    sessionId: input.sessionId,
    title: input.title,
    body: input.body,
    eventType: input.eventType,
    silent: !settings.sound,
    extras: input.extras,
  });
  return { dispatched: true };
}

// Triggered by clicking a notification (main → renderer IPC). Selects the
// session, which bumps focusInputNonce so the InputBar pulls focus, and
// scrolls the chat stream to the bottom so the latest activity is visible.
export function handleNotificationFocus(sessionId: string): void {
  const state = useStore.getState();
  if (!state.sessions.some((s) => s.id === sessionId)) return;
  state.selectSession(sessionId);
  if (typeof window === 'undefined') return;
  window.requestAnimationFrame(() => {
    const stream = document.querySelector<HTMLElement>('[data-chat-stream]');
    if (stream) stream.scrollTop = stream.scrollHeight;
  });
}
