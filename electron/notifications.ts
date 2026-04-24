import * as path from 'path';
import { BrowserWindow, Notification } from 'electron';
import {
  notifyPermission,
  notifyQuestion,
  notifyDone,
  notifyDismiss,
  isNotifyAvailable,
} from './notify';
import { shouldSuppressForFocus, registerToastTarget } from './notify-bootstrap';
import { scheduleQuestionRetry } from './notify-retry';

// Wave 3 polish (#252): cap the assistant-message preview that the legacy
// Electron Notification body renders. The @ccsm/notify Adaptive Toast
// re-truncates inside the SDK (xml/done.ts ASSISTANT_LINE_MAX = 80), so we
// match the same budget here for consistency. Anything longer just waste
// pixels in the OS banner.
const DONE_BODY_PREVIEW_MAX = 80;

function truncatePreview(s: string, n = DONE_BODY_PREVIEW_MAX): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
}

export type NotificationEventType = 'permission' | 'question' | 'turn_done' | 'test';

/**
 * Optional rich metadata callers (the renderer's `dispatchNotification`)
 * provide so we can fire a `@ccsm/notify` Adaptive Toast in parallel with
 * the basic `electron.Notification`. None of these fields are required — when
 * absent, only the legacy toast fires.
 */
export interface NotifyExtras {
  /** Stable id used by @ccsm/notify to dedupe + route activations. */
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
  /** Optional rich metadata for the @ccsm/notify Adaptive Toast pipeline. */
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

// Show an OS-level notification. Click brings the window forward and asks the
// renderer to navigate to the originating session. Returns whether a toast was
// actually shown (false if the platform reports notifications unsupported, or
// suppressed because the window is already focused).
//
// Wave 1D: in addition to the legacy Electron Notification, fan out to the
// optional `@ccsm/notify` Adaptive Toast pipeline when extras are supplied
// and the wrapper has loaded. Both fire in parallel with the in-app render —
// failure of either path never blocks the other.
export function showNotification(
  payload: ShowNotificationPayload,
  win: BrowserWindow | null,
): boolean {
  if (!Notification.isSupported()) return false;

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
    return false;
  }

  // Wave 3 polish (#252): for turn_done events, if the host didn't supply
  // a body but did pass `extras.lastAssistantMsg`, surface the first ~80
  // chars as the legacy toast body so the OS banner conveys real context
  // instead of just "{name} is done". The Adaptive Toast pipeline already
  // does this via `xml/done.ts`; we mirror it here for parity on machines
  // where @ccsm/notify is unavailable (non-win32, missing native deps).
  let body = payload.body ?? '';
  if (
    payload.eventType === 'turn_done' &&
    !payload.body &&
    payload.extras?.lastAssistantMsg
  ) {
    body = truncatePreview(payload.extras.lastAssistantMsg);
  }

  const n = new Notification({
    title: payload.title,
    body,
    silent: !!payload.silent,
  });
  n.on('click', () => {
    const target = win && !win.isDestroyed() ? win : BrowserWindow.getAllWindows()[0];
    if (!target || target.isDestroyed()) return;
    if (target.isMinimized()) target.restore();
    if (!target.isVisible()) target.show();
    target.focus();
    target.webContents.send('notification:focusSession', payload.sessionId);
  });
  n.show();

  // Fan out to @ccsm/notify if available + we have enough metadata. All four
  // wrapper functions are async-no-throw; we fire-and-forget so the legacy
  // toast (already shown) isn't blocked by a slow native call.
  void emitAdaptiveToast(payload).catch(() => {
    /* wrapper logs internally */
  });

  return true;
}

async function emitAdaptiveToast(payload: ShowNotificationPayload): Promise<void> {
  if (!isNotifyAvailable()) return;
  const e = payload.extras;
  if (!e || !e.toastId) return;
  const cwdBase = cwdBasename(e.cwd);
  const sessionName = e.sessionName ?? '';
  switch (payload.eventType) {
    case 'permission': {
      if (!e.toolName) return;
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
      // Wave 3 polish (#252): schedule a single re-emit after ~30s in case
      // the user missed the first banner. Cancelled by the
      // `agent:resolvePermission` IPC handler when the question is answered
      // (in-app QuestionBlock submit calls agentResolvePermission with
      // decision='deny' to release the underlying CLI gate).
      // sessionId is forwarded so the retry's fire-time gate (#307) can
      // suppress the re-emit when the user has since focused this session
      // or globally disabled notifications.
      scheduleQuestionRetry(questionPayload, payload.sessionId);
      return;
    }
    case 'turn_done': {
      registerToastTarget(e.toastId, payload.sessionId, 'turn_done');
      // Mirror the SDK's xml/done.ts ASSISTANT_LINE_MAX (80) here so the
      // wrapper sees a payload that matches what the toast will actually
      // render. Defensive duplication: callers (lifecycle.ts) currently
      // truncate to 200; the SDK re-truncates to 80; we tighten on this
      // hop too so any future caller gets the same treatment.
      await notifyDone({
        toastId: e.toastId,
        groupName: e.groupName ?? '',
        sessionName,
        lastUserMsg: e.lastUserMsg ?? '',
        lastAssistantMsg: truncatePreview(
          e.lastAssistantMsg ?? payload.body ?? '',
        ),
        elapsedMs: e.elapsedMs ?? 0,
        toolCount: e.toolCount ?? 0,
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
