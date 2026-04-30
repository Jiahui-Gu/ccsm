import { useEffect } from 'react';

export interface PtyExitEvent {
  code: number | null;
  signal: string | number | null;
}

/**
 * Pipe `pty:exit` events into the store UNCONDITIONALLY (not filtered
 * by activeSid). TerminalPane has its own filtered listener that drives
 * the active-pane red overlay; this second listener is what surfaces
 * background-session deaths in the sidebar (red dot via
 * `disconnectedSessions[sid]`). Both coexist — different concerns, no
 * duplication risk because the store action is idempotent on payload.
 *
 * Extracted from App.tsx for SRP under Task #758 Phase C.
 */
export function usePtyExitBridge(
  applyPtyExit: (sid: string, evt: PtyExitEvent) => void
): void {
  useEffect(() => {
    const pty = window.ccsmPty;
    if (!pty?.onExit) return;
    return pty.onExit((evt) => {
      if (!evt || typeof evt.sessionId !== 'string' || evt.sessionId.length === 0) return;
      applyPtyExit(evt.sessionId, {
        code: evt.code ?? null,
        signal: evt.signal ?? null,
      });
    });
  }, [applyPtyExit]);
}
