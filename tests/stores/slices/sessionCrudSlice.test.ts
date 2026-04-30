import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSessionCrudSlice } from '../../../src/stores/slices/sessionCrudSlice';
import { createGroupsSlice, defaultGroups } from '../../../src/stores/slices/groupsSlice';
import type { RootStore } from '../../../src/stores/slices/types';
import type { Session, Group } from '../../../src/types';

// The CRUD slice reaches into `get().groups` via `ensureUsableGroup`,
// so the harness composes both crud + groups slices into a single root
// just like `useStore` does in `store.ts`. This keeps the tests isolated
// from the real Zustand store while exercising the realistic interaction
// between the two slices.
function harness(initial?: Partial<RootStore>) {
  let state: Partial<RootStore> = {
    ...initial,
  };
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
  return { state: () => state, sessions, groups, set, get };
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

describe('sessionCrudSlice', () => {
  beforeEach(() => {
    (window as unknown as { ccsm?: unknown }).ccsm = undefined;
    (window as unknown as { ccsmPty?: unknown }).ccsmPty = undefined;
    (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles = undefined;
  });
  afterEach(() => {
    (window as unknown as { ccsm?: unknown }).ccsm = undefined;
    (window as unknown as { ccsmPty?: unknown }).ccsmPty = undefined;
    (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles = undefined;
  });

  it('initial state', () => {
    const h = harness();
    const s = h.state();
    expect(s.sessions).toEqual([]);
    expect(s.activeId).toBe('');
    expect(s.focusedGroupId).toBeNull();
    expect(s.lastUsedCwd).toBeNull();
    expect(s.userHome).toBe('');
    expect(s.claudeSettingsDefaultModel).toBeNull();
  });

  it('selectSession sets activeId, clears focusedGroupId, clears waiting flag', () => {
    const h = harness({
      sessions: [mkSession('a', 'g1', { state: 'waiting' })],
      groups: [{ id: 'g1', name: 'g', collapsed: false, kind: 'normal' }],
      focusedGroupId: 'g1',
    });
    h.sessions.selectSession('a');
    expect(h.state().activeId).toBe('a');
    expect(h.state().focusedGroupId).toBeNull();
    expect(h.state().sessions[0].state).toBe('idle');
  });

  it('focusGroup sets focusedGroupId', () => {
    const h = harness();
    h.sessions.focusGroup('g-x');
    expect(h.state().focusedGroupId).toBe('g-x');
  });

  it('createSession appends a row, makes it active, and uses default group', () => {
    const h = harness({ groups: defaultGroups });
    h.sessions.createSession('/work');
    const s = h.state();
    expect(s.sessions.length).toBe(1);
    expect(s.activeId).toBe(s.sessions[0].id);
    expect(s.sessions[0].cwd).toBe('/work');
    expect(s.sessions[0].groupId).toBe('g-default');
  });

  it('createSession synthesizes a group when none usable', () => {
    const h = harness({
      groups: [{ id: 'g-arch', name: 'Archive', collapsed: false, kind: 'archive' }],
    });
    h.sessions.createSession('/x');
    const groups = h.state().groups;
    expect(groups.some((g: Group) => g.kind === 'normal')).toBe(true);
    expect(h.state().sessions[0].groupId).toMatch(/^g-/);
  });

  it('createSession defaults cwd to lastUsedCwd, then userHome', () => {
    const h = harness({
      groups: defaultGroups,
      lastUsedCwd: '/recent',
      userHome: '/home/u',
    });
    h.sessions.createSession(null);
    expect(h.state().sessions[0].cwd).toBe('/recent');

    const h2 = harness({ groups: defaultGroups, userHome: '/home/u' });
    h2.sessions.createSession(null);
    expect(h2.state().sessions[0].cwd).toBe('/home/u');
  });

  it('createSession seeds initial model from claudeSettingsDefaultModel', () => {
    const h = harness({
      groups: defaultGroups,
      claudeSettingsDefaultModel: 'sonnet-4.7',
    });
    h.sessions.createSession(null);
    expect(h.state().sessions[0].model).toBe('sonnet-4.7');
  });

  it('createSession expands a collapsed target group', () => {
    const h = harness({
      groups: [{ id: 'g-default', name: 'S', collapsed: true, kind: 'normal' }],
    });
    h.sessions.createSession('/a');
    expect(h.state().groups.find((g: Group) => g.id === 'g-default')!.collapsed).toBe(false);
  });

  it('renameSession does an optimistic local update without bridge', async () => {
    const h = harness({
      sessions: [mkSession('a', 'g1')],
      groups: [{ id: 'g1', name: 'g', collapsed: false, kind: 'normal' }],
    });
    await h.sessions.renameSession('a', 'New name');
    expect(h.state().sessions[0].name).toBe('New name');
  });

  it('deleteSession returns snapshot, drops row, picks same-group sibling as next active', () => {
    const h = harness({
      sessions: [
        mkSession('a', 'g1'),
        mkSession('b', 'g1'),
        mkSession('c', 'g2'),
      ],
      groups: [
        { id: 'g1', name: 'g1', collapsed: false, kind: 'normal' },
        { id: 'g2', name: 'g2', collapsed: false, kind: 'normal' },
      ],
      activeId: 'a',
    });
    const snap = h.sessions.deleteSession('a');
    expect(snap).not.toBeNull();
    expect(h.state().sessions.map((s) => s.id)).toEqual(['b', 'c']);
    expect(h.state().activeId).toBe('b'); // same-group sibling wins
  });

  it('deleteSession returns null for unknown id', () => {
    const h = harness();
    expect(h.sessions.deleteSession('nope')).toBeNull();
  });

  it('restoreSession re-inserts at original index', () => {
    const h = harness({
      sessions: [mkSession('a', 'g1'), mkSession('b', 'g1')],
      groups: [{ id: 'g1', name: 'g1', collapsed: false, kind: 'normal' }],
      activeId: 'a',
    });
    const snap = h.sessions.deleteSession('a')!;
    h.sessions.restoreSession(snap);
    expect(h.state().sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('moveSession reorders within group; rejects archive target', () => {
    const h = harness({
      sessions: [mkSession('a', 'g1'), mkSession('b', 'g1')],
      groups: [
        { id: 'g1', name: 'g1', collapsed: false, kind: 'normal' },
        { id: 'g-arch', name: 'arch', collapsed: false, kind: 'archive' },
      ],
    });
    h.sessions.moveSession('b', 'g1', 'a');
    expect(h.state().sessions.map((s) => s.id)).toEqual(['b', 'a']);
    // Reject move into archive — sessions stay where they are.
    h.sessions.moveSession('a', 'g-arch', null);
    expect(h.state().sessions.find((s) => s.id === 'a')!.groupId).toBe('g1');
  });

  it('changeCwd updates only the active session and clears cwdMissing', () => {
    const h = harness({
      sessions: [
        mkSession('a', 'g1', { cwdMissing: true }),
        mkSession('b', 'g1'),
      ],
      activeId: 'a',
    });
    h.sessions.changeCwd('/new');
    expect(h.state().sessions[0]).toMatchObject({ cwd: '/new', cwdMissing: false });
    expect(h.state().sessions[1].cwd).toBe('/tmp');
  });

  it('setSessionModel updates only the targeted row', () => {
    const h = harness({
      sessions: [mkSession('a', 'g1'), mkSession('b', 'g1')],
    });
    h.sessions.setSessionModel('a', 'opus');
    expect(h.state().sessions[0].model).toBe('opus');
    expect(h.state().sessions[1].model).toBe('');
  });

  it('importSession refocuses an already-imported transcript instead of duplicating', () => {
    const h = harness({
      sessions: [mkSession('uuid-x', 'g1', { resumeSessionId: 'uuid-x' })],
      groups: [{ id: 'g1', name: 'g1', collapsed: false, kind: 'normal' }],
    });
    const id = h.sessions.importSession({
      name: 'whatever',
      cwd: '/x',
      groupId: 'g1',
      resumeSessionId: 'uuid-x',
    });
    expect(id).toBe('uuid-x');
    expect(h.state().sessions.length).toBe(1);
    expect(h.state().activeId).toBe('uuid-x');
  });

  it('importSession appends a fresh row when not already present', () => {
    const h = harness({
      groups: [{ id: 'g1', name: 'g1', collapsed: false, kind: 'normal' }],
    });
    const id = h.sessions.importSession({
      name: 'imported',
      cwd: '/y',
      groupId: 'g1',
      resumeSessionId: 'uuid-y',
    });
    expect(id).toBe('uuid-y');
    expect(h.state().sessions[0].id).toBe('uuid-y');
    expect(h.state().sessions[0].name).toBe('imported');
  });

  // audit #876 H2: deleteSession fan-out must drain every per-sid renderer
  // store, not just `sessions`. Without this fix flashStates[sid] and
  // disconnectedSessions[sid] survived the delete and could re-attach to a
  // re-imported session with the same sid (stale crashed badge / phantom
  // halo). The cleanup is unconditional — even if the maps are empty, the
  // delete path is the right place to express "forget everything about
  // this sid".
  describe('deleteSession fan-out (audit #876 H2)', () => {
    it('clears flashStates[sid] for the deleted session', () => {
      const h = harness({
        sessions: [mkSession('a', 'g1'), mkSession('b', 'g1')],
        groups: [{ id: 'g1', name: 'g1', collapsed: false, kind: 'normal' }],
        activeId: 'a',
        flashStates: { a: true, b: true },
      });
      h.sessions.deleteSession('a');
      expect(h.state().flashStates).toEqual({ b: true });
    });

    it('clears disconnectedSessions[sid] for the deleted session', () => {
      const h = harness({
        sessions: [mkSession('a', 'g1'), mkSession('b', 'g1')],
        groups: [{ id: 'g1', name: 'g1', collapsed: false, kind: 'normal' }],
        activeId: 'a',
        disconnectedSessions: {
          a: { kind: 'crashed', code: 1, signal: null, at: 1 },
          b: { kind: 'clean', code: 0, signal: null, at: 2 },
        },
      });
      h.sessions.deleteSession('a');
      expect(h.state().disconnectedSessions).toEqual({
        b: { kind: 'clean', code: 0, signal: null, at: 2 },
      });
    });

    it('preserves identity when the sid was not present in either map', () => {
      const h = harness({
        sessions: [mkSession('a', 'g1')],
        groups: [{ id: 'g1', name: 'g1', collapsed: false, kind: 'normal' }],
        activeId: 'a',
        flashStates: { other: true },
        disconnectedSessions: {
          other: { kind: 'clean', code: 0, signal: null, at: 1 },
        },
      });
      h.sessions.deleteSession('a');
      // Untouched contents (and same map identity is preserved internally
      // so React selectors don't needlessly re-render).
      expect(h.state().flashStates).toEqual({ other: true });
      expect(h.state().disconnectedSessions).toEqual({
        other: { kind: 'clean', code: 0, signal: null, at: 1 },
      });
    });

    it('tolerates missing maps (slice composed without sessionRuntimeSlice)', () => {
      const h = harness({
        sessions: [mkSession('a', 'g1')],
        groups: [{ id: 'g1', name: 'g1', collapsed: false, kind: 'normal' }],
        activeId: 'a',
      });
      // Both maps are undefined on this harness; delete must not throw.
      expect(() => h.sessions.deleteSession('a')).not.toThrow();
      expect(h.state().sessions).toEqual([]);
    });
  });
});
