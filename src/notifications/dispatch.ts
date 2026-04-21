import { useStore } from '../stores/store';

export type NotificationEventType = 'permission' | 'question' | 'turn_done';

export interface DispatchInput {
  sessionId: string;
  eventType: NotificationEventType;
  title: string;
  body?: string;
}

export type DispatchSkipReason =
  | 'no-api'
  | 'global-disabled'
  | 'event-disabled'
  | 'session-muted'
  | 'focused-active'
  | 'debounced';

export interface DispatchResult {
  dispatched: boolean;
  reason?: DispatchSkipReason;
}

const DEBOUNCE_MS = 30_000;
// Last-fired timestamp per (sessionId|eventType). Module-level on purpose:
// the lifecycle module is a singleton in the renderer, so this map naturally
// scopes to one window. A bounded LRU is overkill — a typical user has at
// most a few dozen sessions × 3 event types.
const lastFiredAt = new Map<string, number>();

function cacheKey(sessionId: string, eventType: NotificationEventType): string {
  return `${sessionId}|${eventType}`;
}

// Test seam: probe-notifications.mjs and unit tests can override these to
// simulate window focus / active session without driving real DOM events.
export interface DispatchEnv {
  hasFocus: () => boolean;
  now: () => number;
}

const defaultEnv: DispatchEnv = {
  hasFocus: () => (typeof document !== 'undefined' ? document.hasFocus() : false),
  now: () => Date.now()
};

let env: DispatchEnv = defaultEnv;

export function setDispatchEnv(next: Partial<DispatchEnv>): void {
  env = { ...defaultEnv, ...env, ...next };
}

export function resetDispatchState(): void {
  env = defaultEnv;
  lastFiredAt.clear();
}

// Apply suppression rules then call the main-process notification IPC. The
// rules are intentionally conservative: a notification is a heavy, OS-level
// interruption, so when in doubt we skip rather than spam. Returns a structured
// result so callers (and tests) can see *why* something was suppressed.
export async function dispatchNotification(input: DispatchInput): Promise<DispatchResult> {
  const api = window.agentory;
  if (!api) return { dispatched: false, reason: 'no-api' };

  const state = useStore.getState();
  const settings = state.notificationSettings;
  if (!settings.enabled) return { dispatched: false, reason: 'global-disabled' };

  const eventEnabled =
    (input.eventType === 'permission' && settings.permission) ||
    (input.eventType === 'question' && settings.question) ||
    (input.eventType === 'turn_done' && settings.turnDone);
  if (!eventEnabled) return { dispatched: false, reason: 'event-disabled' };

  const session = state.sessions.find((s) => s.id === input.sessionId);
  if (session?.notificationsMuted) {
    return { dispatched: false, reason: 'session-muted' };
  }

  // Suppress when the user is already looking at this exact session — they
  // will see the in-app affordance, no need to ping the OS too.
  const focused = env.hasFocus();
  const isActive = state.activeId === input.sessionId;
  if (focused && isActive) {
    return { dispatched: false, reason: 'focused-active' };
  }

  const key = cacheKey(input.sessionId, input.eventType);
  const last = lastFiredAt.get(key) ?? 0;
  const now = env.now();
  if (now - last < DEBOUNCE_MS) {
    return { dispatched: false, reason: 'debounced' };
  }
  lastFiredAt.set(key, now);

  await api.notify({
    sessionId: input.sessionId,
    title: input.title,
    body: input.body,
    eventType: input.eventType,
    silent: !settings.sound
  });
  return { dispatched: true };
}

// Triggered by clicking a notification (main → renderer IPC). Selects the
// session and tries to focus the input bar so the user can act immediately.
// The input-focus path piggybacks on the same DOM affordance the sidebar
// click uses; if the dedicated focusInputNonce pattern lands later from
// fix/click-session-focus-input, swap to it then.
export function handleNotificationFocus(sessionId: string): void {
  const state = useStore.getState();
  if (!state.sessions.some((s) => s.id === sessionId)) return;
  state.selectSession(sessionId);
  // TODO: replace with focusInputNonce bump once fix/click-session-focus-input
  // merges. Until then, find the textarea in the DOM and focus it directly so
  // the user can type without an extra click.
  if (typeof window === 'undefined') return;
  window.requestAnimationFrame(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('textarea[data-input-bar]');
    if (ta) ta.focus();
    const stream = document.querySelector<HTMLElement>('[data-chat-stream]');
    if (stream) stream.scrollTop = stream.scrollHeight;
  });
}
