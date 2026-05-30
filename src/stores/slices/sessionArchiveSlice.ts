import {
  ensureUsableGroup,
  nextId,
} from '../lib/sessionCrudHelpers';
import type {
  RootStore,
  SetFn,
  GetFn,
} from './types';

export type SessionArchiveSlice = Pick<
  RootStore,
  | 'archiveSession'
  | 'unarchiveSession'
>;

export function createSessionArchiveSlice(set: SetFn, get: GetFn): SessionArchiveSlice {
  return {
    archiveSession: (sessionId) => {
      // Single-session archive: find-or-create an archive container
      // keyed by the session's current source group, then move the
      // session into the container and stamp `archivedAt`. PTY keeps
      // running. The source group is left intact even if it empties —
      // archive is not delete; the empty group is still a valid drop
      // target for new sessions.
      const cur = get();
      const session = cur.sessions.find((x) => x.id === sessionId);
      if (!session) return;
      // Already archived (either in a flipped-archive group or a
      // container) — no-op.
      const currentGroup = cur.groups.find((g) => g.id === session.groupId);
      if (!currentGroup || currentGroup.kind !== 'normal') return;
      const sourceGroupId = session.groupId;
      const existing = cur.groups.find(
        (g) => g.kind === 'archive' && g.sourceGroupId === sourceGroupId
      );
      const containerId = existing ? existing.id : nextId('g');
      const now = Date.now();
      set((s) => {
        const groups = existing
          ? s.groups
          : [
              ...s.groups,
              {
                id: containerId,
                name: currentGroup.name,
                nameKey: currentGroup.nameKey,
                collapsed: false,
                kind: 'archive' as const,
                sourceGroupId,
              },
            ];
        // Direct `groupId` mutation here (instead of routing through
        // `moveSession`) is intentional: `moveSession` rejects any
        // non-`normal` target by design (it's the DnD move path for
        // user-driven reordering, which must never land in archived
        // territory). Archive flows are the one legitimate way to
        // move a session into an archive-kind group.
        const sessions = s.sessions.map((x) =>
          x.id === sessionId
            ? { ...x, groupId: containerId, archivedAt: now }
            : x
        );
        // If the archived session was active, hand activeId off to the
        // next normal-group session (mirrors deleteSession's fallback
        // behavior). Otherwise keep current activeId.
        let nextActive = s.activeId;
        if (s.activeId === sessionId) {
          const fallback = sessions.find(
            (x) =>
              x.id !== sessionId &&
              groups.find((g) => g.id === x.groupId)?.kind === 'normal'
          );
          nextActive = fallback?.id ?? '';
        }
        return { groups, sessions, activeId: nextActive };
      });
    },

    unarchiveSession: (sessionId) => {
      // Clear `archivedAt`, move back to original source group if it
      // still exists and is normal — otherwise route through
      // `ensureUsableGroup` so we either land in another existing normal
      // group or materialize a fresh one. The earlier `'g-default'`
      // literal fallback orphaned the session (invisible row) when the
      // user had deleted both the source group and `g-default`.
      // If the archive container empties after the move, delete it.
      // If the user has no active session (e.g. they just archived the
      // active one and then immediately unarchived it), restore activeId
      // to the unarchived session — completing the round-trip without
      // an orphaned empty-active-state.
      const store = get();
      const session = store.sessions.find((x) => x.id === sessionId);
      if (!session) return;
      const containerId = session.groupId;
      const container = store.groups.find((g) => g.id === containerId);
      // Only act on sessions that live inside an archive container —
      // sessions inside flipped-kind original groups are unarchived by
      // unarchiving the whole group.
      if (!container || container.kind !== 'archive' || !container.sourceGroupId) {
        return;
      }
      set((s) => {
        // Compute the target group on the latest `s` so any group
        // synthesis lands in the same atomic patch as the session move
        // and the container cleanup — avoids a second `set` racing the
        // empty-container removal against a stale `s.groups`.
        const ensured = ensureUsableGroup(s.groups, container.sourceGroupId);
        const targetGroupId = ensured.groupId;
        const sessions = s.sessions.map((x) => {
          if (x.id !== sessionId) return x;
          const { archivedAt: _drop, ...rest } = x;
          void _drop;
          return { ...rest, groupId: targetGroupId };
        });
        const remainingInContainer = sessions.some(
          (x) => x.groupId === containerId
        );
        const groups = remainingInContainer
          ? ensured.groups
          : ensured.groups.filter((g) => g.id !== containerId);
        const nextActive = s.activeId === '' ? sessionId : s.activeId;
        return { groups, sessions, activeId: nextActive };
      });
    },
  };
}
