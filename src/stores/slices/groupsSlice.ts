// Groups slice: group CRUD + ordering + archive + collapse + undo.
// `deleteGroup` cascades into sessions (removes member rows + drops their
// drafts) — that cross-cut is intentional: archive vs delete is the entire
// distinction here, and the cascade happens in one atomic `set`.
//
// `defaultGroupName()` lives here because both this slice (createGroup
// fallback) and the sessions slice (`ensureUsableGroup`) need it; we
// re-export it for the latter.

import { i18next } from '../../i18n';
import { snapshotDraft, restoreDraft, deleteDrafts } from '../drafts';
import type { Group } from '../../types';
import type {
  GroupSnapshot,
  SessionSnapshot,
  RootStore,
  SetFn,
  GetFn,
} from './types';

/** Resolve the localized default-group name with a hard-coded English
 * fallback so non-renderer call paths (tests, eager hydration before
 * `initI18n` runs) still get a real string instead of the raw i18n key.
 * Keep the fallback in sync with `sidebar.defaultGroupName` in
 * `src/i18n/locales/en.ts`. */
export function defaultGroupName(): string {
  const key = 'sidebar.defaultGroupName';
  try {
    const v = i18next.t(key);
    if (typeof v === 'string' && v && v !== key) return v;
  } catch {
    /* i18next not initialized — fall through to hard-coded English */
  }
  return 'Sessions';
}

export function nextGroupId(): string {
  const g: { crypto?: { randomUUID?: () => string } } =
    (typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { crypto?: { randomUUID?: () => string } })
      : {}) ?? {};
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return `g-${g.crypto.randomUUID()}`;
  }
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const defaultGroups: Group[] = [
  // The bootstrap "Sessions" group also carries `nameKey` so a language
  // switch re-localizes its label (the user never explicitly named this
  // row — it's a default surface, not user input).
  { id: 'g-default', name: 'Sessions', nameKey: 'sidebar.defaultGroupName', collapsed: false, kind: 'normal' },
];

export type GroupsSlice = Pick<
  RootStore,
  | 'groups'
  | 'createGroup'
  | 'renameGroup'
  | 'deleteGroup'
  | 'restoreGroup'
  | 'archiveGroup'
  | 'unarchiveGroup'
  | 'setGroupCollapsed'
>;

export function createGroupsSlice(set: SetFn, get: GetFn): GroupsSlice {
  return {
    groups: defaultGroups,

    createGroup: (name) => {
      const id = nextGroupId();
      const newGroup: Group = {
        id,
        name: name ?? 'New group',
        collapsed: false,
        kind: 'normal',
      };
      set((s) => ({ groups: [...s.groups, newGroup] }));
      return id;
    },

    renameGroup: (id, name) => {
      // Clear `nameKey` so the user-supplied name wins over the i18n default.
      // Default groups seed both `name` and `nameKey` (so language switches
      // re-localize), but once the user renames, that's explicit intent —
      // the renderer (`GroupRow`) prefers `nameKey` when present, so leaving
      // it set would make the rename invisible.
      set((s) => ({
        groups: s.groups.map((g) =>
          g.id === id ? { ...g, name, nameKey: undefined } : g
        ),
      }));
    },

    // Per design principle "don't constrain the user": deleting a group also
    // deletes its sessions. No soft-delete state in MVP — that's what archive is for.
    deleteGroup: (id) => {
      const prev = get();
      const groupIndex = prev.groups.findIndex((g) => g.id === id);
      if (groupIndex === -1) return null;
      const group = prev.groups[groupIndex]!;
      const memberSnapshots: SessionSnapshot[] = prev.sessions
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.groupId === id)
        .map(({ s, i }) => ({
          session: s,
          index: i,
          draft: snapshotDraft(s.id),
          prevActiveId: prev.activeId,
        }));
      const snapshot: GroupSnapshot = {
        group,
        groupIndex,
        sessions: memberSnapshots,
        prevActiveId: prev.activeId,
        prevFocusedGroupId: prev.focusedGroupId,
      };
      set((s) => {
        const remainingSessions = s.sessions.filter((x) => x.groupId !== id);
        const droppedIds = s.sessions
          .filter((x) => x.groupId === id)
          .map((x) => x.id);
        const nextActive = remainingSessions.some((x) => x.id === s.activeId)
          ? s.activeId
          : remainingSessions[0]?.id ?? '';
        if (droppedIds.length > 0) deleteDrafts(droppedIds);
        return {
          groups: s.groups.filter((g) => g.id !== id),
          sessions: remainingSessions,
          activeId: nextActive,
          focusedGroupId: s.focusedGroupId === id ? null : s.focusedGroupId,
        };
      });
      return snapshot;
    },

    restoreGroup: (snapshot) => {
      set((s) => {
        if (s.groups.some((g) => g.id === snapshot.group.id)) return s;
        const insertAt = Math.min(
          Math.max(snapshot.groupIndex, 0),
          s.groups.length
        );
        const groups = [
          ...s.groups.slice(0, insertAt),
          snapshot.group,
          ...s.groups.slice(insertAt),
        ];
        let sessions = s.sessions.slice();
        const ordered = snapshot.sessions
          .slice()
          .sort((a, b) => a.index - b.index);
        for (const snap of ordered) {
          if (sessions.some((x) => x.id === snap.session.id)) continue;
          const insertSesAt = Math.min(
            Math.max(snap.index, 0),
            sessions.length
          );
          sessions = [
            ...sessions.slice(0, insertSesAt),
            snap.session,
            ...sessions.slice(insertSesAt),
          ];
        }
        return {
          groups,
          sessions,
          activeId: snapshot.prevActiveId || s.activeId,
          focusedGroupId: snapshot.prevFocusedGroupId,
        };
      });
      for (const snap of snapshot.sessions) {
        restoreDraft(snap.session.id, snap.draft);
      }
    },

    archiveGroup: (id) => {
      // If there's an existing archive *container* (auto-created from
      // individually-archived sessions) whose `sourceGroupId === id`,
      // merge its sessions into THIS group first, then delete the
      // container, then flip kind. This keeps a single archived entry
      // for the source group regardless of whether the user archived
      // sessions one-by-one before archiving the whole group.
      set((s) => {
        const target = s.groups.find((g) => g.id === id);
        if (!target || target.kind !== 'normal') return s;
        const container = s.groups.find(
          (g) => g.kind === 'archive' && g.sourceGroupId === id
        );
        let nextGroups = s.groups;
        let nextSessions = s.sessions;
        if (container) {
          // Clear `archivedAt` on the merged sessions. The invariant
          // `session.archivedAt set ⇔ session lives in a container` only
          // holds for the container path — after merging into a flipped-
          // archive original, the per-session stamp must come off or a
          // future `unarchiveGroup` (flipped path, which only flips kind)
          // leaves stranded `archivedAt` on sessions that now sit in a
          // normal group, mislabeling them in SessionRow.
          nextSessions = s.sessions.map((x) => {
            if (x.groupId !== container.id) return x;
            const { archivedAt: _drop, ...rest } = x;
            void _drop;
            return { ...rest, groupId: id };
          });
          nextGroups = s.groups.filter((g) => g.id !== container.id);
        }
        nextGroups = nextGroups.map((g) =>
          g.id === id ? { ...g, kind: 'archive' as const } : g
        );
        return { groups: nextGroups, sessions: nextSessions };
      });
    },

    unarchiveGroup: (id) => {
      // Two flavors of archive-kind groups:
      //   1. Flipped originals (no `sourceGroupId`): just flip kind back.
      //   2. Archive containers (`sourceGroupId` set): unarchive each
      //      member session individually (clears `archivedAt`, moves
      //      back to the source group or `g-default`), then delete the
      //      now-empty container. We do NOT flip the container's kind
      //      because the container itself should not survive — its only
      //      purpose was to hold archived sessions.
      const store = get();
      const target = store.groups.find((g) => g.id === id);
      if (!target || target.kind !== 'archive') return;
      if (target.sourceGroupId) {
        const memberIds = store.sessions
          .filter((x) => x.groupId === id)
          .map((x) => x.id);
        for (const sid of memberIds) {
          store.unarchiveSession(sid);
        }
        // unarchiveSession already deletes the container when it empties,
        // but defend in case the container started empty.
        set((s) => ({ groups: s.groups.filter((g) => g.id !== id) }));
        return;
      }
      set((s) => ({
        groups: s.groups.map((g) => (g.id === id ? { ...g, kind: 'normal' } : g)),
      }));
    },

    setGroupCollapsed: (id, collapsed) => {
      set((s) => ({
        groups: s.groups.map((g) => (g.id === id ? { ...g, collapsed } : g)),
      }));
    },
  };
}
