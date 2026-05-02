// electron/daemonClient/surfaceRegistry.ts
//
// Minimal surface-registry shim for the Connect-bridge layer (Task #103,
// frag-3.5.1 §3.5.1.3 + frag-3.7 §3.7.4 + frag-6-7 §6.8 r7 trim lock).
//
// Purpose:
//   The bridge layer needs ONE seat to publish "daemon connection state"
//   into so the renderer can read it via the canonical surface registry
//   (frag-6-7 §6.8). The full multi-priority registry (banner stacking,
//   dedup, i18n key resolution) is owned by the renderer-side bridge
//   (`useDaemonReconnectBridge`, frag-3.7 §3.7.4). This module is the
//   in-main-process write seat that the bridge layer flips when the
//   daemon socket drops / heartbeat resumes.
//
// Why a seat lives here (not next to the renderer):
//   - The bridge layer (Connect-Node client) runs in Electron main, not
//     renderer. It has no IPC channel to the renderer's surface store yet
//     (that channel is task #110 / #115 territory, when the call sites
//     migrate). For #103 we expose the state as an observable in main and
//     a no-op publish hook so the future IPC bridge wires here without
//     changing the Connect client.
//   - The surface registry on the renderer side reads from this seat via
//     a dedicated IPC `surface.daemonStatus` event when #110 lands. Until
//     then this seat is consumed by tests and (read-only) by the
//     reconnect-queue's drain logic.
//
// Design (per frag-6-7 §6.8 r7 lock):
//   The §6.8 r7 trim collapsed the v0.3 daemon-related surface vocabulary
//   to TWO slots:
//     - `'reconnecting'` — daemon socket dropped, bridge is retrying
//                          (priority 50 in the registry; transient banner)
//     - `'reconnected'`  — daemon socket back; queue drained
//                          (transient info, 3s TTL)
//     - `'unreachable'`  — supervisor miss threshold passed; bridge gives
//                          up retry escalation (red banner, P=70)
//     - `'idle'`         — default; nothing to show
//   Anything else (queueOverflow toast, devBuildError, streamGap etc.)
//   was cut by the §6.8 r7 trim and is LOG ONLY — those slots NEVER call
//   `setDaemonStatus`.
//
// Single Responsibility:
//   - PRODUCER: `setDaemonStatus(state)` writes the slot.
//   - DECIDER: none — the slot is a positive enum, no policy here.
//   - SINK: subscribers are notified synchronously via a fan-out callback
//     list. We do not own the renderer-IPC sink — that's a future task.

export type DaemonSurfaceState = 'idle' | 'reconnecting' | 'reconnected' | 'unreachable';

export interface DaemonSurfaceSnapshot {
  readonly state: DaemonSurfaceState;
  /** Wall-clock ms at which the state last changed. Useful for log
   *  correlation + the renderer-side 250ms hold-off (frag-3.7 §3.7.4
   *  toast UX) which suppresses transient flips so a 200ms nodemon
   *  restart shows no surface at all. */
  readonly changedAt: number;
}

export interface DaemonSurfaceRegistry {
  /** Snapshot of the current state. O(1). */
  get(): DaemonSurfaceSnapshot;
  /** Write a new state. Idempotent: writing the same state twice is a
   *  no-op (no `changedAt` update, no subscriber fan-out). */
  set(state: DaemonSurfaceState): void;
  /** Subscribe to changes. Returns an unsubscribe fn. The listener is
   *  invoked synchronously after each `set` that actually changed the
   *  state. NOT invoked for redundant writes. */
  subscribe(listener: (snap: DaemonSurfaceSnapshot) => void): () => void;
}

/**
 * Build a fresh registry. Stateless across instances; the bridge owns one
 * per Connect client (typically a singleton per Electron main process).
 *
 * `now` is injected so tests can drive deterministic timestamps.
 */
export function createDaemonSurfaceRegistry(opts?: {
  readonly now?: () => number;
}): DaemonSurfaceRegistry {
  const now = opts?.now ?? Date.now;
  let snap: DaemonSurfaceSnapshot = { state: 'idle', changedAt: now() };
  const listeners = new Set<(s: DaemonSurfaceSnapshot) => void>();
  return {
    get(): DaemonSurfaceSnapshot {
      return snap;
    },
    set(state: DaemonSurfaceState): void {
      if (state === snap.state) return;
      snap = { state, changedAt: now() };
      // Fan-out is synchronous so tests can assert `set → listener fired`
      // without an async tick. If a listener throws we let it escape —
      // the bridge wraps its own listener calls; the registry treats
      // listener errors as caller bugs.
      for (const l of listeners) l(snap);
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/**
 * The default registry used by the Connect bridge. Lives at module scope
 * so the bridge and any future renderer-IPC shim share one source of
 * truth without dependency-injection plumbing through every call site.
 *
 * Tests that need isolation construct their own registry via
 * `createDaemonSurfaceRegistry` and pass it to the connectClient via the
 * `surfaceRegistry` option (see `connectClient.ts`).
 */
export const defaultDaemonSurfaceRegistry: DaemonSurfaceRegistry =
  createDaemonSurfaceRegistry();
