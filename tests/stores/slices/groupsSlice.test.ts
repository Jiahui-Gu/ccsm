import { describe, it, expect } from 'vitest';
import {
  createGroupsSlice,
  defaultGroupName,
  defaultGroups,
} from '../../../src/stores/slices/groupsSlice';
import type { RootStore, GroupSnapshot } from '../../../src/stores/slices/types';
import type { Session, Group } from '../../../src/types';

function harness(initial?: Partial<RootStore>) {
  let state: Partial<RootStore> = {
    sessions: [],
    activeId: '',
    focusedGroupId: null,
    ...initial,
  };
  const set = (
    partial: Partial<RootStore> | ((s: RootStore) => Partial<RootStore> | RootStore)
  ) => {
    const patch = typeof partial === 'function' ? partial(state as RootStore) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state as RootStore;
  const slice = createGroupsSlice(set, get);
  state = { ...state, ...slice };
  return { state: () => state, slice, set, get };
}

function mkSession(id: string, groupId: string): Session {
  return {
    id,
    name: `s-${id}`,
    state: 'idle',
    cwd: '/tmp',
    model: '',
    groupId,
    agentType: 'claude-code',
  };
}

describe('groupsSlice', () => {
  it('initial state seeds the bootstrap "Sessions" group', () => {
    const h = harness();
    expect(h.state().groups).toEqual(defaultGroups);
    expect(h.state().groups[0].id).toBe('g-default');
  });

  it('createGroup appends a normal group and returns its id', () => {
    const h = harness();
    const id = h.slice.createGroup('My project');
    expect(id).toMatch(/^g-/);
    const groups = h.state().groups;
    expect(groups[groups.length - 1]).toMatchObject({
      id,
      name: 'My project',
      kind: 'normal',
      collapsed: false,
    });
  });

  it('createGroup falls back to "New group" when no name is given', () => {
    const h = harness();
    const id = h.slice.createGroup();
    const created = h.state().groups.find((g) => g.id === id)!;
    expect(created.name).toBe('New group');
  });

  it('renameGroup updates the matching row only', () => {
    const h = harness();
    h.slice.renameGroup('g-default', 'Renamed');
    expect(h.state().groups.find((g) => g.id === 'g-default')!.name).toBe('Renamed');
  });

  it('archiveGroup / unarchiveGroup flips kind', () => {
    const h = harness();
    h.slice.archiveGroup('g-default');
    expect(h.state().groups.find((g) => g.id === 'g-default')!.kind).toBe('archive');
    h.slice.unarchiveGroup('g-default');
    expect(h.state().groups.find((g) => g.id === 'g-default')!.kind).toBe('normal');
  });

  it('setGroupCollapsed updates the matching row only', () => {
    const h = harness();
    h.slice.setGroupCollapsed('g-default', true);
    expect(h.state().groups.find((g) => g.id === 'g-default')!.collapsed).toBe(true);
  });

  it('deleteGroup cascades into sessions and returns a snapshot', () => {
    const h = harness({
      sessions: [
        mkSession('a', 'g-default'),
        mkSession('b', 'g-other'),
        mkSession('c', 'g-default'),
      ],
      activeId: 'a',
      focusedGroupId: 'g-default',
    });
    // Add a second normal group so the cascade test has a target.
    const secondGroups: Group[] = [
      ...h.state().groups,
      { id: 'g-other', name: 'Other', collapsed: false, kind: 'normal' },
    ];
    h.set({ groups: secondGroups });

    const snap = h.slice.deleteGroup('g-default');
    expect(snap).not.toBeNull();
    const s = snap!;
    expect(s.group.id).toBe('g-default');
    expect(s.sessions.map((x) => x.session.id).sort()).toEqual(['a', 'c']);
    expect(h.state().groups.some((g) => g.id === 'g-default')).toBe(false);
    expect(h.state().sessions.map((x) => x.id)).toEqual(['b']);
    expect(h.state().focusedGroupId).toBeNull();
    // activeId fell back to the surviving session
    expect(h.state().activeId).toBe('b');
  });

  it('deleteGroup returns null for unknown id', () => {
    const h = harness();
    expect(h.slice.deleteGroup('nope')).toBeNull();
  });

  it('restoreGroup re-inserts the group + sessions at original indices', () => {
    const h = harness({
      sessions: [mkSession('a', 'g-default')],
      activeId: 'a',
      focusedGroupId: 'g-default',
    });
    const snap = h.slice.deleteGroup('g-default')!;
    expect(h.state().groups.length).toBe(0);
    h.slice.restoreGroup(snap);
    expect(h.state().groups.find((g) => g.id === 'g-default')).toBeDefined();
    expect(h.state().sessions.find((s) => s.id === 'a')).toBeDefined();
    expect(h.state().focusedGroupId).toBe('g-default');
  });

  it('restoreGroup is idempotent on double-undo', () => {
    const h = harness({
      sessions: [mkSession('a', 'g-default')],
      activeId: 'a',
      focusedGroupId: null,
    });
    const snap = h.slice.deleteGroup('g-default')!;
    h.slice.restoreGroup(snap);
    const lenAfter = h.state().groups.length;
    h.slice.restoreGroup(snap);
    expect(h.state().groups.length).toBe(lenAfter);
  });

  it('defaultGroupName returns a non-empty string fallback', () => {
    expect(typeof defaultGroupName()).toBe('string');
    expect(defaultGroupName().length).toBeGreaterThan(0);
  });

  it('GroupSnapshot type is structural', () => {
    const snap: GroupSnapshot = {
      group: { id: 'x', name: 'x', collapsed: false, kind: 'normal' },
      groupIndex: 0,
      sessions: [],
      prevActiveId: '',
      prevFocusedGroupId: null,
    };
    expect(snap.group.id).toBe('x');
  });
});
