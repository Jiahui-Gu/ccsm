import { useEffect, useRef } from 'react';

interface SessionLike {
  id: string;
  name?: string | null;
}

/**
 * Mirror per-session NAMES to main so the desktop-notify bridge can label
 * toasts with the friendly name (custom rename or SDK auto-summary)
 * instead of the bare UUID. Sister effect to `useSessionActiveBridge` —
 * main needs a synchronous answer when an OS notification fires and we
 * don't want a renderer round-trip on the notify path. Diffs over the
 * previous snapshot so we only IPC for actual changes (mounts, renames,
 * SDK title arrivals, deletions).
 *
 * Also tracks sids seen in the previous render and clears (`setName(sid,
 * null)`) any that have since disappeared, so main's
 * `sessionNamesFromRenderer` map doesn't grow unbounded across the app
 * lifetime as sessions are created and deleted (#613, follow-up to #509).
 *
 * Extracted from App.tsx for SRP under Task #758 Phase C.
 */
export function useSessionNameBridge(sessions: ReadonlyArray<SessionLike>): void {
  const prevSidsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    type Bridge = { setName: (sid: string, name: string | null) => void };
    const bridge = (window as unknown as { ccsmSession?: Bridge }).ccsmSession;
    if (!bridge || typeof bridge.setName !== 'function') return;
    const currentSids = new Set<string>();
    for (const sess of sessions) {
      bridge.setName(sess.id, sess.name ?? null);
      currentSids.add(sess.id);
    }
    for (const staleSid of prevSidsRef.current) {
      if (!currentSids.has(staleSid)) {
        bridge.setName(staleSid, null);
      }
    }
    prevSidsRef.current = currentSids;
  }, [sessions]);
}
