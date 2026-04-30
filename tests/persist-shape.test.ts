// Guards the curated persistence payload shape.
//
// Background: the store auto-persist subscriber (see `hydrateStore` in
// `src/stores/store.ts`) rebuilds a snapshot on every state change. We want to
// verify that the snapshot we serialize is intentionally narrow — high-churn
// in-memory fields like `messagesBySession`, `runningSessions`, and
// `messageQueues` MUST NOT bleed into the persisted JSON, otherwise every
// streamed assistant chunk would write the entire transcript to disk.
import { describe, it, expect, vi } from 'vitest';
import { schedulePersist, type PersistedState } from '../src/stores/persist';

describe('persist: curated snapshot payload', () => {
  it('only includes the curated subset of state when serialized', () => {
    const saveState = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { window?: unknown }).window = {
      ccsm: { saveState }
    };
    vi.useFakeTimers();
    try {
      const snap: PersistedState = {
        version: 1,
        sessions: [],
        groups: [],
        activeId: '',
        sidebarWidth: 260,
        theme: 'system',
        fontSize: 'md',
        fontSizePx: 14,
      };
      schedulePersist(snap);
      vi.advanceTimersByTime(500);
      expect(saveState).toHaveBeenCalledTimes(1);
      const [, payload] = saveState.mock.calls[0] as [string, string];
      const parsed = JSON.parse(payload);
      // Allowed top-level keys — exhaustive list. New persisted fields should
      // be added here AND to PersistedState; high-churn runtime state must
      // never appear here.
      const ALLOWED = new Set([
        'version',
        'sessions',
        'groups',
        'activeId',
        'sidebarWidth',
        'sidebarWidthPct',
        'theme',
        'fontSize',
        'fontSizePx'
      ]);
      const FORBIDDEN = [
        'messagesBySession',
        'runningSessions',
        'startedSessions',
        'interruptedSessions',
        'messageQueues',
        'statsBySession',
        'focusInputNonce',
        'installerCorrupt',
        // Removed in PR-D — orphan persisted keys with no live subscribers.
        'model',
        'permission',
        'notificationSettings',
        'recentProjects',
        // Removed in #894 (sidebar collapse + tutorial features deleted).
        'sidebarCollapsed',
        'tutorialSeen'
      ];
      for (const k of Object.keys(parsed)) {
        expect(ALLOWED.has(k), `unexpected persisted key: ${k}`).toBe(true);
      }
      for (const k of FORBIDDEN) {
        expect(parsed).not.toHaveProperty(k);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
