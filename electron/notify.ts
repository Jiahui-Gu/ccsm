// Thin wrapper around Electron's built-in `Notification` API.
//
// History: previous revisions of this file lazily required an inlined notify
// implementation (`./notify-impl/`) which depended on
// `electron-windows-notifications` + `@nodert-win10-au/*`. That native chain
// requires C++17 `/ZW` (C++/CX) but Electron 33's V8 headers `#error
// "C++20 or later required"` — the chain has never built against shipping
// Electron, and production Windows toast had never actually fired (the
// `__setNativeForTests` spy seam masked the runtime require failure).
//
// We swap to Electron's built-in `Notification` (which uses
// ToastNotificationManager underneath the same AUMID — `com.ccsm.app` —
// stamped on the Start Menu shortcut by NSIS / `setup-aumid.ps1`). Trade-offs
// accepted:
//   - No inline action buttons (Allow / Allow always / Reject). Permission
//     approval flows through the main-window Radix Dialog where the user can
//     see the actual command + cwd context before deciding.
//   - No Group/Tag dedupe. The three event types (permission/question/done)
//     don't dedupe each other, so this is a no-op trade.
//
// The public API surface (configureNotify, notify{Permission,Question,Done,
// Dismiss}, disposeNotify, isNotifyAvailable, probeNotifyAvailability,
// notifyLastError) is preserved byte-for-byte so callers don't change.
//
// `notification.on('click', ...)` fires `onAction({ action: 'focus', ... })`
// — the only action the new path emits. The toast-target router in
// `notify-bootstrap.ts` then raises the window and routes focus to the
// session.

import { Notification } from 'electron';

// ---------- Local payload types (kept in lockstep with notifications.ts) ----------

export interface PermissionPayload {
  toastId: string;
  sessionName: string;
  toolName: string;
  toolBrief: string;
  cwdBasename: string;
}

export interface QuestionPayload {
  toastId: string;
  sessionName: string;
  question: string;
  selectionKind: 'single' | 'multi';
  optionCount: number;
  cwdBasename: string;
}

export interface DonePayload {
  toastId: string;
  groupName: string;
  sessionName: string;
  lastUserMsg: string;
  lastAssistantMsg: string;
  elapsedMs: number;
  toolCount: number;
  cwdBasename: string;
}

export type ActionId = 'allow' | 'allow-always' | 'reject' | 'focus';
export interface ActionEvent {
  toastId: string;
  action: ActionId;
  args: Record<string, string>;
}

export interface NotifierOptions {
  appId: string;
  appName: string;
  iconPath?: string;
  silent?: boolean;
  onAction: (event: ActionEvent) => void;
}

// ---------- State ----------

let options: NotifierOptions | null = null;
let lastError: string | null = null;
const liveToasts: Map<string, Notification> = new Map();

// Cap so a runaway emit loop can't pin every toast object in memory forever.
// Each entry is dropped on dismiss / on the notification's own `close` event;
// this is a defensive ceiling.
const LIVE_TOAST_LIMIT = 256;

const QUESTION_BODY_MAX = 200;

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function evictOldestIfNeeded(): void {
  if (liveToasts.size < LIVE_TOAST_LIMIT) return;
  const firstKey = liveToasts.keys().next().value;
  if (firstKey) liveToasts.delete(firstKey);
}

function createNotification(
  toastId: string,
  title: string,
  body: string,
): Notification | null {
  if (!options) return null;
  if (!Notification.isSupported()) return null;
  try {
    const opts: Electron.NotificationConstructorOptions = {
      title,
      body,
      silent: options.silent ?? false,
    };
    if (options.iconPath) opts.icon = options.iconPath;
    const n = new Notification(opts);
    n.on('click', () => {
      try {
        options?.onAction({ toastId, action: 'focus', args: {} });
      } catch (e) {
        console.warn(
          `[notify] onAction handler threw for toast ${toastId}: ${e instanceof Error ? e.message : e}`,
        );
      }
    });
    n.on('close', () => {
      liveToasts.delete(toastId);
    });
    evictOldestIfNeeded();
    liveToasts.set(toastId, n);
    n.show();
    return n;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.warn(`[notify] Notification.show failed: ${lastError}`);
    return null;
  }
}

// ---------- Public API ----------

/**
 * Configure the notifier. Safe to call multiple times. Each call replaces
 * the active options (and therefore the `onAction` handler) wholesale.
 */
export function configureNotify(opts: NotifierOptions): void {
  options = opts;
}

/**
 * Sync — true when Electron's Notification API reports the host OS supports
 * native notifications. Does NOT require `configureNotify` to have run.
 */
export function isNotifyAvailable(): boolean {
  try {
    return Notification.isSupported();
  } catch {
    return false;
  }
}

/**
 * Async variant for callers that historically awaited the (now-defunct)
 * lazy-require probe. Same answer as `isNotifyAvailable()` since the
 * Electron API is synchronous and always present.
 */
export async function probeNotifyAvailability(): Promise<boolean> {
  return isNotifyAvailable();
}

/** Last error message from a Notification.show failure, or null. */
export function notifyLastError(): string | null {
  return lastError;
}

export async function notifyPermission(payload: PermissionPayload): Promise<void> {
  const cwdSuffix = payload.cwdBasename ? ` • ${payload.cwdBasename}` : '';
  const title = `Permission needed: ${payload.toolName}`;
  const briefPart = payload.toolBrief ? ` • ${payload.toolBrief}` : '';
  const body = `${payload.sessionName}${briefPart}${cwdSuffix}`;
  createNotification(payload.toastId, title, body);
}

export async function notifyQuestion(payload: QuestionPayload): Promise<void> {
  const title = `Question: ${payload.sessionName}`;
  const body = truncate(payload.question, QUESTION_BODY_MAX);
  createNotification(payload.toastId, title, body);
}

export async function notifyDone(payload: DonePayload): Promise<void> {
  const titleParts = [payload.groupName, payload.sessionName].filter(Boolean);
  const title = titleParts.join(' / ') || 'Session done';
  const userPart = payload.lastUserMsg ? `> ${payload.lastUserMsg}` : '';
  const assistantPart = payload.lastAssistantMsg ?? '';
  const body = [userPart, assistantPart].filter(Boolean).join('\n');
  createNotification(payload.toastId, title, body);
}

export async function notifyDismiss(toastId: string): Promise<void> {
  const n = liveToasts.get(toastId);
  if (!n) return;
  liveToasts.delete(toastId);
  try {
    n.close();
  } catch {
    // best effort — notification may already be gone
  }
}

export async function disposeNotify(): Promise<void> {
  for (const [, n] of liveToasts) {
    try {
      n.close();
    } catch {
      // best effort
    }
  }
  liveToasts.clear();
}
