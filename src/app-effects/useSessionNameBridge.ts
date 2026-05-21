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
 * Perf: the effect's dep is `sessions`, whose array reference changes on
 * every session-runtime store patch (state toggle, title backfill, cwd
 * redirect, etc.) — including hot paths like waiting<->idle on JSONL
 * chunks. Without per-sid diffing we'd fire one IPC per session per chunk
 * even though no name changed. The `prevNamesRef` map below makes the
 * common case (no name changed) a free pass — IPC fires only for the
 * actual delta (added sid, renamed sid, deleted sid).
 *
 * Extracted from App.tsx for SRP under Task #758 Phase C.
 */
export function useSessionNameBridge(sessions: ReadonlyArray<SessionLike>): void {
  const prevNamesRef = useRef<Map<string, string | null>>(new Map());
  useEffect(() => {
    type Bridge = { setName: (sid: string, name: string | null) => void };
    const bridge = (window as unknown as { ccsmSession?: Bridge }).ccsmSession;
    if (!bridge || typeof bridge.setName !== 'function') return;
    const prev = prevNamesRef.current;
    const next = new Map<string, string | null>();
    for (const sess of sessions) {
      const name = sess.name ?? null;
      next.set(sess.id, name);
      // Only IPC when the name (per sid) actually changed — covers mount
      // (sid absent from prev) and rename (sid present, name differs).
      // Pure state-toggle store updates re-run this effect with every
      // sess.name unchanged, so we short-circuit those without any IPC.
      if (!prev.has(sess.id) || prev.get(sess.id) !== name) {
        bridge.setName(sess.id, name);
      }
    }
    // Clear any sid that disappeared since the previous render so main's
    // map doesn't leak across the app lifetime.
    for (const [staleSid] of prev) {
      if (!next.has(staleSid)) {
        bridge.setName(staleSid, null);
      }
    }
    prevNamesRef.current = next;
  }, [sessions]);
}
