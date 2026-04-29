import { useEffect } from 'react';

/**
 * Pipe `session:cwdRedirected` IPC events from main into the store. Fired
 * by the ptyHost spawn handler when the import-resume copy helper (#603)
 * relocates a JSONL into the spawn cwd's projectDir. Patching
 * `session.cwd` is what keeps the sessionTitles SDK bridge pointing at
 * the live COPY rather than the now-frozen SOURCE on subsequent
 * `renameSession` / `getSessionInfo` / `listForProject` calls.
 *
 * Extracted from App.tsx for SRP under Task #758 Phase C.
 */
export function useCwdRedirectedBridge(
  applyCwdRedirect: (sid: string, newCwd: string) => void
): void {
  useEffect(() => {
    type Bridge = {
      onCwdRedirected?: (cb: (e: { sid: string; newCwd: string }) => void) => () => void;
    };
    const bridge = (window as unknown as { ccsmSession?: Bridge }).ccsmSession;
    if (!bridge || typeof bridge.onCwdRedirected !== 'function') return;
    return bridge.onCwdRedirected((evt) => {
      if (!evt || typeof evt.sid !== 'string' || typeof evt.newCwd !== 'string') return;
      if (evt.sid.length === 0 || evt.newCwd.length === 0) return;
      applyCwdRedirect(evt.sid, evt.newCwd);
    });
  }, [applyCwdRedirect]);
}
