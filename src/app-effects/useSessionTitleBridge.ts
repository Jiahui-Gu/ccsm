import { useEffect } from 'react';

/**
 * Pipe `session:title` IPC events from main into the store. The watcher
 * emits when the SDK-derived `summary` changes for a session; the store
 * applies via `_applyExternalTitle` (no-ops if the row is missing or
 * the name is already current). Bridge is a no-op in the
 * test/storybook environments where `window.ccsmSession` is missing or
 * the older preload didn't expose `onTitle`.
 *
 * Extracted from App.tsx for SRP under Task #758 Phase C.
 */
export function useSessionTitleBridge(
  applyExternalTitle: (sid: string, title: string) => void
): void {
  useEffect(() => {
    type Bridge = {
      onTitle?: (cb: (e: { sid: string; title: string }) => void) => () => void;
    };
    const bridge = (window as unknown as { ccsmSession?: Bridge }).ccsmSession;
    if (!bridge || typeof bridge.onTitle !== 'function') return;
    return bridge.onTitle((evt) => {
      if (!evt || typeof evt.sid !== 'string' || typeof evt.title !== 'string') return;
      if (evt.sid.length === 0 || evt.title.length === 0) return;
      applyExternalTitle(evt.sid, evt.title);
    });
  }, [applyExternalTitle]);
}
