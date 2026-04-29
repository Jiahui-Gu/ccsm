import { useEffect } from 'react';

/**
 * Mirror the renderer's active session id to main so the desktop-notify
 * bridge can suppress toasts for the session the user is already looking
 * at. Fires once on mount and on every activeId change. Bridge is a
 * no-op in the test/storybook environments where `window.ccsmSession` is
 * missing.
 *
 * Extracted from App.tsx for SRP under Task #758 Phase C.
 */
export function useSessionActiveBridge(activeId: string | null | undefined): void {
  useEffect(() => {
    type Bridge = { setActive: (sid: string | null) => void };
    const bridge = (window as unknown as { ccsmSession?: Bridge }).ccsmSession;
    if (!bridge || typeof bridge.setActive !== 'function') return;
    bridge.setActive(activeId || null);
  }, [activeId]);
}
