// cliBridge module entry — registers IPC handlers and exposes the
// per-session ttyd lifecycle to the renderer.
//
// This module is intentionally self-contained: zero coupling to the
// existing in-process SDK runner (`electron/agent`). Worker 3 will
// delete the SDK runner; until then the two coexist (the cliBridge IPC
// is unused by the renderer until Worker 2 wires it).
//
// IPC contract (mirrored in preload.ts):
//   cliBridge:openTtydForSession(sessionId)      → {ok,port,sid} | {ok:false,error}
//   cliBridge:resumeSession(sessionId, sid)      → {ok,port,sid} | {ok:false,error}
//   cliBridge:killTtydForSession(sessionId)      → {ok,killed}
//   cliBridge:checkClaudeAvailable()             → {available, path?}
//   event cliBridge:ttyd-exit                    → {sessionId, code, signal}
//
// Security: every handler that takes an action gates on `fromMainFrame(e)`
// — a compromised iframe (the ttyd one we host, future webviews, etc.)
// must not be able to call into ipcMain with the same `e.sender`. Mirrors
// the pattern in electron/main.ts.

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  bindSender,
  killAll,
  killTtydForSession,
  openTtydForSession,
  resumeTtydForSession,
} from './processManager';
import { resolveClaude } from './claudeResolver';

function fromMainFrame(e: IpcMainInvokeEvent): boolean {
  return e.senderFrame === e.sender.mainFrame;
}

export function registerCliBridgeIpc(): void {
  ipcMain.handle(
    'cliBridge:openTtydForSession',
    async (e, sessionId: unknown) => {
      if (!fromMainFrame(e)) return { ok: false, error: 'rejected' };
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, error: 'bad_session_id' };
      }
      return openTtydForSession(sessionId);
    },
  );

  ipcMain.handle(
    'cliBridge:resumeSession',
    async (e, sessionId: unknown, sid: unknown) => {
      if (!fromMainFrame(e)) return { ok: false, error: 'rejected' };
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, error: 'bad_session_id' };
      }
      if (typeof sid !== 'string' || !sid) {
        return { ok: false, error: 'bad_sid' };
      }
      return resumeTtydForSession(sessionId, sid);
    },
  );

  ipcMain.handle(
    'cliBridge:killTtydForSession',
    (e, sessionId: unknown) => {
      if (!fromMainFrame(e)) return { ok: false as const, error: 'rejected' };
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false as const, error: 'bad_session_id' };
      }
      return killTtydForSession(sessionId);
    },
  );

  ipcMain.handle('cliBridge:checkClaudeAvailable', () => {
    const p = resolveClaude();
    return p ? { available: true, path: p } : { available: false };
  });
}

// Wire the renderer that should receive `cliBridge:ttyd-exit` events.
// Mirrors `sessions.bindSender(win.webContents)` in electron/main.ts.
export function bindCliBridgeSender(wc: WebContents): void {
  bindSender(wc);
}

// Tear down all running ttyd processes. Called from app `before-quit`
// (alongside the existing `sessions.closeAll()`).
export function shutdownCliBridge(): void {
  killAll();
}
