// Tests for the individual-session archive flow added in Task #2:
// `archiveSession` / `unarchiveSession` on the CRUD slice + the extended
// `archiveGroup` merge behavior on the groups slice. These cross-slice
// flows are realistic only when both slices share a store, so the
// harness composes both like the real `store.ts` does.

import { describe, it, expect, beforeEach } from 'vitest';
import { createSessionCrudSlice } from '../../../src/stores/slices/sessionCrudSlice';
import { createGroupsSlice } from '../../../src/stores/slices/groupsSlice';
import type { RootStore } from '../../../src/stores/slices/types';
import type { Session, Group } from '../../../src/types';

function harness(initial?: Partial<RootStore>) {
  let state: Partial<RootStore> = { ...initial };
  const set = (
    partial: Partial<RootStore> | ((s: RootStore) => Partial<RootStore> | RootStore)
  ) => {
    const patch = typeof partial === 'function' ? partial(state as RootStore) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state as RootStore;
  const sessions = createSessionCrudSlice(set, get);
  const groups = createGroupsSlice(set, get);
  state = { ...state, ...sessions, ...groups, ...initial };
  return { state: () => state, get, set };
}

function mkSession(id: string, groupId: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    name: `s-${id}`,
    state: 'idle',
    cwd: '/tmp',
    model: '',
    groupId,
    agentType: 'claude-code',
    ...extra,
  };
}

describe('archiveSession / unarchiveSession', () => {
  beforeEach(() => {
    (window as unknown as { ccsm?: unknown }).ccsm = undefined;
    (window as unknown as { ccsmPty?: unknown }).ccsmPty = undefined;
  });

  it('creates an archive container on first archive and stamps archivedAt', () => {
    const h = harness({
      sessions: [mkSession('s1', 'g-default'), mkSession('s2', 'g-default')],
      activeId: 's2',
    });
    h.get().archiveSession('s1');
    const s = h.state();
    const s1 = s.sessions!.find((x) => x.id === 's1')!;
    const container = s.groups!.find(
      (g) => g.kind === 'archive' && g.sourceGroupId === 'g-default'
    )!;
    expect(container).toBeDefined();
    expect(container.name).toBe('Sessions');
    expect(s1.groupId).toBe(container.id);
    expect(typeof s1.archivedAt).toBe('number');
    // Source group should still exist + still hold s2.
    const src = s.groups!.find((g) => g.id === 'g-default')!;
    expect(src.kind).toBe('normal');
    expect(s.sessions!.find((x) => x.id === 's2')!.groupId).toBe('g-default');
  });

  it('reuses an existing container for subsequent archives from same source', () => {
    const h = harness({
      sessions: [
        mkSession('s1', 'g-default'),
        mkSession('s2', 'g-default'),
        mkSession('s3', 'g-default'),
      ],
      activeId: 's3',
    });
    h.get().archiveSession('s1');
    const containerId = h.state().groups!.find(
      (g) => g.kind === 'archive' && g.sourceGroupId === 'g-default'
    )!.id;
    h.get().archiveSession('s2');
    // Still only one container.
    const containers = h.state().groups!.filter(
      (g) => g.kind === 'archive' && g.sourceGroupId === 'g-default'
    );
    expect(containers.length).toBe(1);
    expect(containers[0].id).toBe(containerId);
    // Both sessions moved into it.
    const ids = h.state().sessions!.filter((x) => x.groupId === containerId).map((x) => x.id);
    expect(ids.sort()).toEqual(['s1', 's2']);
  });

  it('hands activeId to a normal session if the archived one was active', () => {
    const h = harness({
      sessions: [mkSession('s1', 'g-default'), mkSession('s2', 'g-default')],
      activeId: 's1',
    });
    h.get().archiveSession('s1');
    expect(h.state().activeId).toBe('s2');
  });

  it('archive-then-unarchive on the only session restores activeId without orphan', () => {
    // When the user archives the active session and immediately
    // unarchives it, activeId should land back on that session — not
    // sit at the empty-string fallback that archiveSession produced
    // when there was no normal-group sibling to hand off to.
    const h = harness({
      sessions: [mkSession('s1', 'g-default')],
      activeId: 's1',
    });
    h.get().archiveSession('s1');
    // No normal-group sibling existed, so activeId fell back to ''.
    expect(h.state().activeId).toBe('');
    h.get().unarchiveSession('s1');
    const s = h.state();
    expect(s.activeId).toBe('s1');
    // No orphan archive container left behind.
    expect(
      s.groups!.find((g) => g.kind === 'archive' && g.sourceGroupId === 'g-default')
    ).toBeUndefined();
    // Session is back in g-default, archivedAt cleared.
    const s1 = s.sessions!.find((x) => x.id === 's1')!;
    expect(s1.groupId).toBe('g-default');
    expect(s1.archivedAt).toBeUndefined();
  });

  it('archiveGroup merges an existing container into the flipped group', () => {
    const h = harness({
      sessions: [
        mkSession('s1', 'g-default'),
        mkSession('s2', 'g-default'),
      ],
      activeId: 's2',
    });
    h.get().archiveSession('s1');
    const containerId = h.state().groups!.find(
      (g) => g.kind === 'archive' && g.sourceGroupId === 'g-default'
    )!.id;
    // Now flip the whole source group to archive.
    h.get().archiveGroup('g-default');
    const s = h.state();
    // Container is gone.
    expect(s.groups!.find((g) => g.id === containerId)).toBeUndefined();
    // g-default is now kind='archive' with no sourceGroupId.
    const flipped = s.groups!.find((g) => g.id === 'g-default')!;
    expect(flipped.kind).toBe('archive');
    expect(flipped.sourceGroupId).toBeUndefined();
    // Both sessions ended up in the flipped group.
    expect(s.sessions!.every((x) => x.groupId === 'g-default')).toBe(true);
    // archivedAt MUST be cleared on the merged sessions: the invariant
    // "archivedAt set ⇔ session lives in a container" only holds for
    // the container path. Leaving the stamp on after merging into a
    // flipped-archive original would mislabel the session after a later
    // `unarchiveGroup` (flipped path only flips kind).
    expect(s.sessions!.find((x) => x.id === 's1')!.archivedAt).toBeUndefined();
  });

  it('archive session → archive group → unarchive group leaves session fully normal', () => {
    // Full repro of the bug fixed: without the `archivedAt` clear in the
    // archiveGroup merge step, this round-trip leaves the session in a
    // normal group but with a stale `archivedAt` stamp → SessionRow
    // mislabels it as archived and "Unarchive" early-returns.
    const h = harness({
      sessions: [mkSession('s1', 'g-default'), mkSession('s2', 'g-default')],
      activeId: 's2',
    });
    h.get().archiveSession('s1');
    h.get().archiveGroup('g-default');
    h.get().unarchiveGroup('g-default');
    const s = h.state();
    const s1 = s.sessions!.find((x) => x.id === 's1')!;
    expect(s1.groupId).toBe('g-default');
    expect(s1.archivedAt).toBeUndefined();
    // The parent group is back to normal — SessionRow.isArchived will
    // also reflect false (the row-level check reads archivedAt directly,
    // which is the right signal here).
    expect(s.groups!.find((g) => g.id === 'g-default')!.kind).toBe('normal');
  });

  it('archiveGroup with no container behaves as the original flip', () => {
    const h = harness({
      sessions: [mkSession('s1', 'g-default')],
      activeId: 's1',
    });
    h.get().archiveGroup('g-default');
    const flipped = h.state().groups!.find((g) => g.id === 'g-default')!;
    expect(flipped.kind).toBe('archive');
    expect(flipped.sourceGroupId).toBeUndefined();
  });

  it('unarchiveSession moves session back to source group and clears archivedAt', () => {
    const h = harness({
      sessions: [mkSession('s1', 'g-default'), mkSession('s2', 'g-default')],
      activeId: 's2',
    });
    h.get().archiveSession('s1');
    h.get().unarchiveSession('s1');
    const s = h.state();
    const s1 = s.sessions!.find((x) => x.id === 's1')!;
    expect(s1.groupId).toBe('g-default');
    expect(s1.archivedAt).toBeUndefined();
    // Container was the only archived holder and is now empty → deleted.
    expect(
      s.groups!.find((g) => g.kind === 'archive' && g.sourceGroupId === 'g-default')
    ).toBeUndefined();
  });

  it('unarchiveSession keeps container if it still has other members', () => {
    const h = harness({
      sessions: [
        mkSession('s1', 'g-default'),
        mkSession('s2', 'g-default'),
        mkSession('s3', 'g-default'),
      ],
      activeId: 's3',
    });
    h.get().archiveSession('s1');
    h.get().archiveSession('s2');
    h.get().unarchiveSession('s1');
    const container = h.state().groups!.find(
      (g) => g.kind === 'archive' && g.sourceGroupId === 'g-default'
    );
    expect(container).toBeDefined();
    // s2 still inside.
    expect(
      h.state().sessions!.find((x) => x.id === 's2')!.groupId
    ).toBe(container!.id);
  });

  it('unarchiveSession falls back to g-default when source group was deleted', () => {
    const otherGroup: Group = {
      id: 'g-other',
      name: 'Other',
      collapsed: false,
      kind: 'normal',
    };
    const h = harness({
      groups: [
        { id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' },
        otherGroup,
      ],
      sessions: [mkSession('s1', 'g-other')],
      activeId: 's1',
    });
    h.get().archiveSession('s1');
    // Delete the source group (cascade removes sessions too, so re-seed
    // an archived session pointing at the stranded container).
    const containerId = h.state().groups!.find(
      (g) => g.kind === 'archive' && g.sourceGroupId === 'g-other'
    )!.id;
    // deleteGroup will purge container members (s1 lives in container
    // now, not in g-other) — so removing g-other doesn't take s1 with
    // it. Verify the assumption first.
    h.get().deleteGroup('g-other');
    const stateAfterDelete = h.state();
    expect(stateAfterDelete.sessions!.find((x) => x.id === 's1')).toBeDefined();
    expect(
      stateAfterDelete.groups!.find((g) => g.id === containerId)
    ).toBeDefined();
    h.get().unarchiveSession('s1');
    const s = h.state();
    expect(s.sessions!.find((x) => x.id === 's1')!.groupId).toBe('g-default');
    // Container deleted (empty).
    expect(s.groups!.find((g) => g.id === containerId)).toBeUndefined();
  });

  it('unarchiveGroup on a container bulk-unarchives all members', () => {
    const h = harness({
      sessions: [
        mkSession('s1', 'g-default'),
        mkSession('s2', 'g-default'),
      ],
      activeId: 's2',
    });
    h.get().archiveSession('s1');
    h.get().archiveSession('s2');
    const containerId = h.state().groups!.find(
      (g) => g.kind === 'archive' && g.sourceGroupId === 'g-default'
    )!.id;
    h.get().unarchiveGroup(containerId);
    const s = h.state();
    expect(s.groups!.find((g) => g.id === containerId)).toBeUndefined();
    expect(s.sessions!.every((x) => x.groupId === 'g-default')).toBe(true);
    expect(s.sessions!.every((x) => x.archivedAt === undefined)).toBe(true);
  });

  it('unarchiveGroup on a flipped-archive original just flips kind back', () => {
    const h = harness({
      sessions: [mkSession('s1', 'g-default')],
    });
    h.get().archiveGroup('g-default');
    expect(h.state().groups!.find((g) => g.id === 'g-default')!.kind).toBe('archive');
    h.get().unarchiveGroup('g-default');
    const g = h.state().groups!.find((g) => g.id === 'g-default')!;
    expect(g.kind).toBe('normal');
    expect(g.sourceGroupId).toBeUndefined();
  });

  it('archiveSession is a no-op on already-archived sessions', () => {
    const h = harness({
      sessions: [mkSession('s1', 'g-default'), mkSession('s2', 'g-default')],
      activeId: 's2',
    });
    h.get().archiveSession('s1');
    const beforeAt = h.state().sessions!.find((x) => x.id === 's1')!.archivedAt;
    const beforeGroups = h.state().groups!.length;
    h.get().archiveSession('s1');
    const after = h.state().sessions!.find((x) => x.id === 's1')!;
    expect(after.archivedAt).toBe(beforeAt);
    expect(h.state().groups!.length).toBe(beforeGroups);
  });
});
