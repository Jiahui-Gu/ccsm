// Pure unread-badge state store.
//
// SRP: this module is the *decider*-tier state holder for the unread badge.
// It keeps a per-sid unread counter map, exposes increment/clear/getTotal
// operations, and emits a `change(total)` event whenever the aggregate
// total changes. It performs ZERO OS calls (no `app.setBadgeCount`, no
// `setOverlayIcon`, no `tray.setImage`) — those live in `sinks/badgeSink.ts`.
//
// Splitting the state from the OS sink (Task #744 Phase B) makes the store
// trivially unit-testable in plain Node (no Electron stubs), and lets the
// sink be swapped, disabled, or duplicated independently of the counter
// logic.
//
// Event contract:
//   - 'change' (total: number) — fires whenever any operation changes the
//     unread total. `reapply()` re-emits unconditionally so a freshly
//     attached sink can resync without callers needing to track totals.

import { EventEmitter } from 'events';

export class BadgeManager extends EventEmitter {
  private unread = new Map<string, number>();

  incrementSid(sid: string): void {
    if (!sid) return;
    this.unread.set(sid, (this.unread.get(sid) ?? 0) + 1);
    this.emit('change', this.getTotal());
  }

  clearSid(sid: string): void {
    if (!sid) return;
    if (!this.unread.has(sid)) return;
    this.unread.delete(sid);
    this.emit('change', this.getTotal());
  }

  clearAll(): void {
    if (this.unread.size === 0) return;
    this.unread.clear();
    this.emit('change', 0);
  }

  getTotal(): number {
    let n = 0;
    for (const v of this.unread.values()) n += v;
    return n;
  }

  /**
   * Re-emit the current total without mutating state. Useful for a sink
   * that attaches after the store has already accumulated counts (e.g.
   * during construction wiring) and needs to resync the OS-visible badge.
   */
  reapply(): void {
    this.emit('change', this.getTotal());
  }
}

/**
 * Wave-2-C singleton — daemon-side badge state. Tray polls the aggregate
 * total via `GET /api/badge/state` (registered in daemon/api/system.ts).
 *
 * Exposed as `bump(sid)` / `forget(sid)` thin wrappers so call sites read
 * "decided to notify, bump unread" rather than tightly coupling to the
 * `incrementSid` / `clearSid` legacy method names. Both wrappers are
 * defensively no-op on falsy sid (matches BadgeManager itself).
 */
export const badgeStore = (() => {
  const mgr = new BadgeManager();
  return {
    bump: (sid: string): void => mgr.incrementSid(sid),
    forget: (sid: string): void => mgr.clearSid(sid),
    clearAll: (): void => mgr.clearAll(),
    getTotal: (): number => mgr.getTotal(),
    onChange: (cb: (total: number) => void): (() => void) => {
      mgr.on('change', cb);
      return () => mgr.off('change', cb);
    },
  };
})();
