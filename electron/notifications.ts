import { BrowserWindow, Notification } from 'electron';

export type NotificationEventType = 'permission' | 'question' | 'turn_done' | 'test';

export interface ShowNotificationPayload {
  sessionId: string;
  title: string;
  body?: string;
  eventType?: NotificationEventType;
  silent?: boolean;
}

// Show an OS-level notification. Click brings the window forward and asks the
// renderer to navigate to the originating session. Returns whether a toast was
// actually shown (false if the platform reports notifications unsupported).
export function showNotification(payload: ShowNotificationPayload, win: BrowserWindow | null): boolean {
  if (!Notification.isSupported()) return false;
  const n = new Notification({
    title: payload.title,
    body: payload.body ?? '',
    silent: !!payload.silent
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
  return true;
}
