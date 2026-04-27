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

// Cap the assistant-message preview that the Done toast renders. The inlined
// notify module's xml/done.ts ASSISTANT_LINE_MAX = 80 re-truncates inside the
// SDK; we match that budget here for consistency. Anything longer just wastes
// pixels in the OS banner.
const DONE_BODY_PREVIEW_MAX = 80;

function truncatePreview(s: string, n = DONE_BODY_PREVIEW_MAX): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export type NotificationEventType = 'permission' | 'question' | 'turn_done' | 'test';

/**
 * Optional rich metadata callers (the renderer's `dispatchNotification`)
 * provide so the inlined notify module's Adaptive Toast can render correctly.
 */
export interface NotifyExtras {
  /** Stable id used by the inlined notify module to dedupe + route activations. */
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
  /** Optional rich metadata for the inlined notify module Adaptive Toast pipeline. */
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

// Show an OS-level notification (Windows-only). Returns whether a toast was
// emitted (false when notify-impl is unavailable, the platform is unsupported,
// or the focused-window suppression gate fired).
//
// There is no cross-platform fallback: the legacy Electron `Notification` path
// has been removed. macOS / Linux platform adapters are stubbed to throw — the
// `isNotifyAvailable()` gate keeps non-Windows callers silent.
//
// Click-to-focus: when the user clicks the toast, `notify-bootstrap.ts`'s
// onAction handler receives the activation and sends `notification:focusSession`
// through to the renderer.
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
      return;
    }
    case 'turn_done': {
      registerToastTarget(e.toastId, payload.sessionId, 'turn_done');
      // Mirror the SDK's xml/done.ts ASSISTANT_LINE_MAX (80) here so the
      // wrapper sees a payload that matches what the toast will actually
      // render.
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
