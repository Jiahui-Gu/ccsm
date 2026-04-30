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
      set((s) => ({
        groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)),
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
      set((s) => ({
        groups: s.groups.map((g) => (g.id === id ? { ...g, kind: 'archive' } : g)),
      }));
    },

    unarchiveGroup: (id) => {
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
