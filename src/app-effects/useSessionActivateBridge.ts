import { useEffect } from 'react';

/**
 * Listens for `session:activate` from main (fired when the user clicks a
 * desktop notification) and re-selects the named session so it lands
 * focused in the sidebar and chat pane. Mirrors the IPC subscription
 * pattern of `UpdateDownloadedBridge`.
 *
 * Extracted from App.tsx for SRP under Task #724.
 */
export function useSessionActivateBridge(
  selectSession: (sid: string) => void
): void {
  useEffect(() => {
    type Bridge = {
      onActivate: (cb: (e: { sid: string }) => void) => () => void;
    };
    const bridge = (window as unknown as { ccsmSession?: Bridge }).ccsmSession;
    if (!bridge || typeof bridge.onActivate !== 'function') return;
    return bridge.onActivate((evt) => {
      if (evt && typeof evt.sid === 'string' && evt.sid.length > 0) {
        selectSession(evt.sid);
      }
    });
  }, [selectSession]);
}
