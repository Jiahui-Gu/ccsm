import * as path from 'path';
import type { BrowserWindow } from 'electron';
import {
  notifyPermission,
  notifyQuestion,
  notifyDone,
  notifyDismiss,
  isNotifyAvailable,
} from './notify';
import { shouldSuppressForFocus, registerToastTarget } from './notify-bootstrap';

// Cap the assistant-message preview that the Done toast renders. Matches the
// historical 80-char budget so anything longer doesn't waste pixels in the OS
// banner.
const DONE_BODY_PREVIEW_MAX = 80;
const DONE_USER_PREVIEW_MAX = 80;

function truncatePreview(s: string, n = DONE_BODY_PREVIEW_MAX): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export type NotificationEventType = 'permission' | 'question' | 'turn_done' | 'test';

/**
 * Optional rich metadata callers (the renderer's `dispatchNotification`)
 * provide so the notification can render a richer title/body.
 */
export interface NotifyExtras {
  /** Stable id used to route activations back to the originating session. */
  toastId?: string;
  sessionName?: string;
  groupName?: string;
  /** Tool name for permission events (e.g. `Bash`, `Edit`). */
  toolName?: string;
  /** Single-line tool brief (e.g. `npm run build`). */
  toolBrief?: string;
  /** AskUserQuestion: the question text. */
  question?: string;
  /** AskUserQuestion: 'single' | 'multi'. */
  selectionKind?: 'single' | 'multi';
  /** AskUserQuestion: option count. */
  optionCount?: number;
  /** turn_done: last user message preview. */
  lastUserMsg?: string;
  /** turn_done: last assistant message preview. */
  lastAssistantMsg?: string;
  /** turn_done: turn duration. */
  elapsedMs?: number;
  /** turn_done: tool-use count for the turn. */
  toolCount?: number;
  /** Working directory path; basename is shown in the toast. */
  cwd?: string;
}

export interface ShowNotificationPayload {
  sessionId: string;
  title: string;
  body?: string;
  eventType?: NotificationEventType;
  silent?: boolean;
  /** Optional rich metadata for the notification's title/body composition. */
  extras?: NotifyExtras;
}

function cwdBasename(cwd: string | undefined): string {
  if (!cwd) return '';
  try {
    return path.basename(cwd);
  } catch {
    return '';
  }
}

// Show an OS-level notification via Electron's built-in `Notification` API.
// Returns whether a toast was emitted (false when the host OS has no
// notification support, or the focused-window suppression gate fired).
//
// Click-to-focus: the underlying notify wrapper attaches a `click` handler
// that fires `onAction({ action: 'focus', ... })`. The router installed by
// `notify-bootstrap.ts` then raises the window and routes
// `notification:focusSession` to the renderer.
export function showNotification(
  payload: ShowNotificationPayload,
  _win: BrowserWindow | null,
): boolean {
  // Defensive doubled focus gate. The renderer-side dispatch already checks
  // `document.hasFocus() && activeId === sessionId`, but `document.hasFocus`
  // can lie under devtools / playwright, and a non-active session that's still
  // in the focused window deserves a toast either way. Here in main, if any
  // visible window is focused we suppress — paired with the renderer check
  // this means: focused window AND active session → no toast (handled by
  // renderer); focused window, different session → still no toast (handled
  // here, since the user is already looking at the app and the sidebar pulse
  // is sufficient). Test-only `eventType === 'test'` skips this.
  if (payload.eventType !== 'test' && shouldSuppressForFocus()) {
    // PR #323 + #324 incident: this gate was previously silent, so a flake
    // where a notify was unexpectedly dropped looked indistinguishable from
    // a wrapper failure. Log every focus-suppress with enough context
    // (event type, session, title) to disambiguate during diagnosis.
    console.warn(
      `[notify] suppressed: a window is focused, dropping notification: eventType=${payload.eventType ?? 'unknown'} sessionId=${payload.sessionId} title=${JSON.stringify(payload.title)}`,
    );
    return false;
  }

  if (!isNotifyAvailable()) return false;

  void emitAdaptiveToast(payload).catch(() => {
    /* wrapper logs internally */
  });

  return true;
}

async function emitAdaptiveToast(payload: ShowNotificationPayload): Promise<void> {
  if (!isNotifyAvailable()) return;
  const e = payload.extras;
  const cwdBase = cwdBasename(e?.cwd);
  const sessionName = e?.sessionName ?? '';
  switch (payload.eventType) {
    case 'permission': {
      if (!e?.toolName || !e.toastId) return;
      registerToastTarget(e.toastId, payload.sessionId, 'permission');
      await notifyPermission({
        toastId: e.toastId,
        sessionName,
        toolName: e.toolName,
        toolBrief: e.toolBrief ?? '',
        cwdBasename: cwdBase,
      });
      return;
    }
    case 'question': {
      if (!e?.toastId) return;
      registerToastTarget(e.toastId, payload.sessionId, 'question');
      const questionPayload = {
        toastId: e.toastId,
        sessionName,
        question: e.question ?? payload.body ?? '',
        selectionKind: e.selectionKind ?? 'single',
        optionCount: e.optionCount ?? 0,
        cwdBasename: cwdBase,
      };
      await notifyQuestion(questionPayload);
      return;
    }
    case 'turn_done': {
      if (!e?.toastId) return;
      registerToastTarget(e.toastId, payload.sessionId, 'turn_done');
      await notifyDone({
        toastId: e.toastId,
        groupName: e.groupName ?? '',
        sessionName,
        lastUserMsg: truncatePreview(e.lastUserMsg ?? '', DONE_USER_PREVIEW_MAX),
        lastAssistantMsg: truncatePreview(
          e.lastAssistantMsg ?? payload.body ?? '',
          DONE_BODY_PREVIEW_MAX,
        ),
        elapsedMs: e.elapsedMs ?? 0,
        toolCount: e.toolCount ?? 0,
        cwdBasename: cwdBase,
      });
      return;
    }
    case 'test': {
      // User-driven "Send test notification" — fires regardless of focus
      // (the focus-suppression gate already let us through above) so the
      // user can confirm OS plumbing is wired correctly.
      const toastId = e?.toastId ?? `test-${Date.now()}`;
      registerToastTarget(toastId, payload.sessionId, 'turn_done');
      await notifyDone({
        toastId,
        groupName: '',
        sessionName: 'CCSM test notification',
        lastUserMsg: '',
        lastAssistantMsg: 'If you can see this, notifications work.',
        elapsedMs: 0,
        toolCount: 0,
        cwdBasename: cwdBase,
      });
      return;
    }
    default:
      return;
  }
}

/**
 * Dismiss any live toast for `toastId`. Safe to call when the notify wrapper
 * is unavailable (no-op) or when `toastId` was never registered.
 */
export async function dismissNotification(toastId: string): Promise<void> {
  await notifyDismiss(toastId);
}
