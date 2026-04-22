import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../src/stores/store';

// The store auto-subscribes to persist via hydrateStore(); since we never call
// hydrateStore() in tests, the subscriber is never installed, so set() is
// purely in-memory. We just snapshot the initial state and restore between
// tests for isolation.
const initial = useStore.getState();

beforeEach(() => {
  useStore.setState(
    {
      ...initial,
      sessions: [],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      recentProjects: [],
      activeId: '',
      focusedGroupId: null,
      messagesBySession: {},
      startedSessions: {},
      runningSessions: {},
      focusInputNonce: 0
    },
    true
  );
});

describe('store: createSession', () => {
  it('creates a session in the default group when none focused', () => {
    useStore.getState().createSession('~/foo');
    const s = useStore.getState();
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].cwd).toBe('~/foo');
    expect(s.sessions[0].groupId).toBe('g-default');
    expect(s.activeId).toBe(s.sessions[0].id);
  });

  it('uses focused group when one is focused', () => {
    const gid = useStore.getState().createGroup('Custom');
    useStore.getState().focusGroup(gid);
    useStore.getState().createSession(null);
    expect(useStore.getState().sessions[0].groupId).toBe(gid);
  });

  it('clears focusedGroupId after creating', () => {
    const gid = useStore.getState().createGroup('Custom');
    useStore.getState().focusGroup(gid);
    useStore.getState().createSession(null);
    expect(useStore.getState().focusedGroupId).toBeNull();
  });

  it('falls back to active session group when no focus', () => {
    const gid = useStore.getState().createGroup('Other');
    useStore.getState().focusGroup(gid);
    useStore.getState().createSession('~/a');
    useStore.getState().focusGroup(null);
    useStore.getState().createSession('~/b');
    expect(useStore.getState().sessions[0].groupId).toBe(gid);
    expect(useStore.getState().sessions[1].groupId).toBe(gid);
  });

  it('defaults cwd to most-recent project when caller passes null', () => {
    useStore.getState().pushRecentProject('C:/Users/me/projects/alpha');
    useStore.getState().createSession(null);
    expect(useStore.getState().sessions[0].cwd).toBe('C:/Users/me/projects/alpha');
  });

  it('falls back to ~ when recentProjects is empty', () => {
    useStore.getState().createSession(null);
    expect(useStore.getState().sessions[0].cwd).toBe('~');
  });

  it('explicit cwd argument wins over recentProjects default', () => {
    useStore.getState().pushRecentProject('C:/Users/me/projects/alpha');
    useStore.getState().createSession('C:/other/path');
    expect(useStore.getState().sessions[0].cwd).toBe('C:/other/path');
  });

  it('accepts an options object with name', () => {
    useStore.getState().createSession({
      cwd: '/tmp/repo',
      name: '  Spike  ',
    });
    const s = useStore.getState().sessions[0];
    expect(s.cwd).toBe('/tmp/repo');
    expect(s.name).toBe('Spike');
  });

  it('expands the target group when it was collapsed', () => {
    const gid = useStore.getState().createGroup('Hidden');
    useStore.getState().setGroupCollapsed(gid, true);
    useStore.getState().focusGroup(gid);
    useStore.getState().createSession(null);
    const g = useStore.getState().groups.find((x) => x.id === gid);
    expect(g?.collapsed).toBe(false);
  });

  it('bumps focusInputNonce so the InputBar pulls focus', () => {
    const before = useStore.getState().focusInputNonce;
    useStore.getState().createSession('~/a');
    expect(useStore.getState().focusInputNonce).toBe(before + 1);
  });
});

describe('store: deleteSession', () => {
  it('removes the session and shifts active to the next one', () => {
    useStore.getState().createSession('~/a');
    useStore.getState().createSession('~/b');
    const [sNew, sOld] = useStore.getState().sessions;
    expect(useStore.getState().activeId).toBe(sNew.id);
    useStore.getState().deleteSession(sNew.id);
    expect(useStore.getState().sessions.map((s) => s.id)).toEqual([sOld.id]);
    expect(useStore.getState().activeId).toBe(sOld.id);
  });

  it('cascades to clear messagesBySession / startedSessions / runningSessions', () => {
    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    useStore.getState().appendBlocks(sid, [{ kind: 'user', id: 'u1', text: 'hi' }]);
    useStore.getState().markStarted(sid);
    useStore.getState().setRunning(sid, true);
    useStore.getState().deleteSession(sid);
    const s = useStore.getState();
    expect(s.messagesBySession[sid]).toBeUndefined();
    expect(s.startedSessions[sid]).toBeUndefined();
    expect(s.runningSessions[sid]).toBeUndefined();
  });

  it('leaves activeId empty when deleting the last session', () => {
    useStore.getState().createSession('~/only');
    const sid = useStore.getState().activeId;
    useStore.getState().deleteSession(sid);
    expect(useStore.getState().activeId).toBe('');
  });
});

describe('store: createGroup / deleteGroup', () => {
  it('createGroup returns the new id and appends to groups', () => {
    const id = useStore.getState().createGroup('Refactors');
    const g = useStore.getState().groups.find((x) => x.id === id);
    expect(g).toBeDefined();
    expect(g?.name).toBe('Refactors');
    expect(g?.kind).toBe('normal');
  });

  it('deleteGroup removes its sessions too (no soft-delete)', () => {
    const gid = useStore.getState().createGroup('Doomed');
    useStore.getState().focusGroup(gid);
    useStore.getState().createSession('~/x');
    useStore.getState().createSession('~/y');
    expect(useStore.getState().sessions).toHaveLength(2);
    useStore.getState().deleteGroup(gid);
    expect(useStore.getState().sessions).toHaveLength(0);
    expect(useStore.getState().groups.find((g) => g.id === gid)).toBeUndefined();
  });

  it('deleteGroup picks a remaining session as active when active was inside', () => {
    const gid = useStore.getState().createGroup('Doomed');
    // First create a keeper in default group
    useStore.getState().createSession('~/keeper');
    const keeperId = useStore.getState().sessions[0].id;
    // Now focus doomed and create the in-doomed session (becomes active)
    useStore.getState().focusGroup(gid);
    useStore.getState().createSession('~/in-doomed');
    const doomedId = useStore.getState().sessions[0].id;
    expect(useStore.getState().activeId).toBe(doomedId);
    useStore.getState().deleteGroup(gid);
    expect(useStore.getState().activeId).toBe(keeperId);
  });

  it('archiveGroup / unarchiveGroup flip kind', () => {
    const gid = useStore.getState().createGroup('Archive me');
    useStore.getState().archiveGroup(gid);
    expect(useStore.getState().groups.find((g) => g.id === gid)?.kind).toBe('archive');
    useStore.getState().unarchiveGroup(gid);
    expect(useStore.getState().groups.find((g) => g.id === gid)?.kind).toBe('normal');
  });
});

describe('store: messages + tool result wiring (PR G regression guard)', () => {
  it('appendBlocks is a no-op for empty input', () => {
    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    useStore.getState().appendBlocks(sid, []);
    expect(useStore.getState().messagesBySession[sid]).toBeUndefined();
  });

  it('setToolResult fills result and isError on the matching tool block', () => {
    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    useStore.getState().appendBlocks(sid, [
      {
        kind: 'tool',
        id: 't1',
        toolUseId: 'toolu_001',
        name: 'Read',
        brief: 'foo.ts',
        expanded: false
      }
    ]);
    useStore.getState().setToolResult(sid, 'toolu_001', 'file contents', false);
    const block = useStore.getState().messagesBySession[sid][0];
    expect(block).toMatchObject({ result: 'file contents', isError: false });
  });

  it('setToolResult ignores tool blocks whose toolUseId does not match', () => {
    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    useStore.getState().appendBlocks(sid, [
      { kind: 'tool', id: 't1', toolUseId: 'toolu_xyz', name: 'Bash', brief: 'ls', expanded: false }
    ]);
    useStore.getState().setToolResult(sid, 'toolu_other', 'should not land', false);
    const block = useStore.getState().messagesBySession[sid][0];
    expect((block as { result?: string }).result).toBeUndefined();
  });

  it('setToolResult does nothing for unknown sessionId', () => {
    useStore.getState().setToolResult('does-not-exist', 'toolu_001', 'x', false);
    expect(useStore.getState().messagesBySession['does-not-exist']).toBeUndefined();
  });
});

describe('store: resolvePermission', () => {
  it('removes the matching waiting block and calls the IPC bridge', () => {
    const ipc = vi.fn().mockResolvedValue(true);
    (globalThis as unknown as { window?: { agentory?: unknown } }).window = {
      agentory: { agentResolvePermission: ipc }
    };

    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    useStore.getState().appendBlocks(sid, [
      { kind: 'waiting', id: 'wait-req1', prompt: 'OK?', intent: 'permission', requestId: 'req1' }
    ]);

    useStore.getState().resolvePermission(sid, 'req1', 'allow');

    expect(useStore.getState().messagesBySession[sid]).toEqual([]);
    expect(ipc).toHaveBeenCalledWith(sid, 'req1', 'allow');
  });

  it('is a no-op when no waiting block matches', () => {
    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    const before = useStore.getState();
    useStore.getState().resolvePermission(sid, 'no-such-req', 'deny');
    // No throw, state.messagesBySession reference may stay the same (no-op fast path).
    expect(useStore.getState().sessions).toEqual(before.sessions);
  });
});

describe('store: pushRecentProject', () => {
  it('pushes new path to front, dedups by path, caps at 8', () => {
    for (let i = 0; i < 10; i++) {
      useStore.getState().pushRecentProject(`~/repo-${i}`);
    }
    expect(useStore.getState().recentProjects).toHaveLength(8);
    expect(useStore.getState().recentProjects[0].path).toBe('~/repo-9');
    // Dedup
    useStore.getState().pushRecentProject('~/repo-5');
    const paths = useStore.getState().recentProjects.map((r) => r.path);
    expect(paths.indexOf('~/repo-5')).toBe(0);
    expect(paths.filter((p) => p === '~/repo-5')).toHaveLength(1);
  });

  it('strips trailing slashes and ignores empty input', () => {
    useStore.getState().pushRecentProject('/a/b/c/');
    expect(useStore.getState().recentProjects[0].path).toBe('/a/b/c');
    useStore.getState().pushRecentProject('/');
    // '/' became '' after stripping → ignored
    expect(useStore.getState().recentProjects.find((r) => r.path === '')).toBeUndefined();
  });
});

describe('store: setRunning', () => {
  it('toggles the running flag and is a no-op when value matches', () => {
    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    useStore.getState().setRunning(sid, true);
    expect(useStore.getState().runningSessions[sid]).toBe(true);
    const before = useStore.getState().runningSessions;
    useStore.getState().setRunning(sid, true);
    expect(useStore.getState().runningSessions).toBe(before);
    useStore.getState().setRunning(sid, false);
    expect(useStore.getState().runningSessions[sid]).toBeUndefined();
  });
});

describe('store: setSessionState', () => {
  it("flips a session's state and is a no-op when value matches", () => {
    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    expect(useStore.getState().sessions.find((x) => x.id === sid)?.state).toBe('idle');
    useStore.getState().setSessionState(sid, 'waiting');
    const before = useStore.getState().sessions;
    expect(before.find((x) => x.id === sid)?.state).toBe('waiting');
    useStore.getState().setSessionState(sid, 'waiting');
    // Same value → array reference must not change (downstream selectors rely on this).
    expect(useStore.getState().sessions).toBe(before);
  });
});

describe('store: streamAssistantText + appendBlocks coalesce', () => {
  it('streamAssistantText creates a streaming assistant block on first delta', () => {
    useStore.getState().streamAssistantText('s1', 'msg-1:c0', 'Hel', false);
    const blocks = useStore.getState().messagesBySession['s1'];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'assistant',
      id: 'msg-1:c0',
      text: 'Hel',
      streaming: true
    });
  });

  it('streamAssistantText appends to existing block on subsequent deltas', () => {
    const s = useStore.getState();
    s.streamAssistantText('s1', 'msg-1:c0', 'Hel', false);
    s.streamAssistantText('s1', 'msg-1:c0', 'lo!', false);
    const blocks = useStore.getState().messagesBySession['s1'];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ text: 'Hello!', streaming: true });
  });

  it('streamAssistantText with done=true clears the streaming flag', () => {
    const s = useStore.getState();
    s.streamAssistantText('s1', 'msg-1:c0', 'Hi', false);
    s.streamAssistantText('s1', 'msg-1:c0', '', true);
    const block = useStore.getState().messagesBySession['s1'][0] as { streaming?: boolean };
    expect(block.streaming).toBe(false);
  });

  it('appendBlocks coalesces by id: finalized assistant block replaces the streamed one in place', () => {
    const s = useStore.getState();
    s.streamAssistantText('s1', 'msg-1:c0', 'partial', false);
    s.appendBlocks('s1', [{ kind: 'assistant', id: 'msg-1:c0', text: 'final' }]);
    const blocks = useStore.getState().messagesBySession['s1'];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ id: 'msg-1:c0', text: 'final' });
    // streaming flag was set on the streamed block; the finalized version
    // omits it entirely (undefined).
    expect((blocks[0] as { streaming?: boolean }).streaming).toBeUndefined();
  });

  it('appendBlocks still appends new blocks while replacing matched ones', () => {
    const s = useStore.getState();
    s.streamAssistantText('s1', 'msg-1:c0', 'partial', false);
    s.appendBlocks('s1', [
      { kind: 'assistant', id: 'msg-1:c0', text: 'final' },
      { kind: 'tool', id: 'msg-1:tu0', name: 'Bash', brief: 'ls', expanded: false }
    ]);
    const blocks = useStore.getState().messagesBySession['s1'];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ id: 'msg-1:c0', text: 'final' });
    expect(blocks[1]).toMatchObject({ id: 'msg-1:tu0', kind: 'tool' });
  });
});

describe('store: loadMessages + selectSession autoload (session restore)', () => {
  it('loadMessages pulls from the IPC bridge and writes to messagesBySession', async () => {
    const persisted = [
      { kind: 'user', id: 'u1', text: 'hi' },
      { kind: 'assistant', id: 'a1', text: 'hello there' }
    ];
    const load = vi.fn().mockResolvedValue(persisted);
    (globalThis as unknown as { window?: { agentory?: unknown } }).window = {
      agentory: { loadMessages: load }
    };

    await useStore.getState().loadMessages('s-ghost');
    expect(load).toHaveBeenCalledWith('s-ghost');
    expect(useStore.getState().messagesBySession['s-ghost']).toEqual(persisted);
  });

  it('loadMessages does not clobber blocks that arrived mid-flight', async () => {
    let resolve!: (v: unknown[]) => void;
    const load = vi.fn(
      () => new Promise<unknown[]>((r) => { resolve = r; })
    );
    (globalThis as unknown as { window?: { agentory?: unknown } }).window = {
      agentory: { loadMessages: load }
    };

    const promise = useStore.getState().loadMessages('s-race');
    // Simulate a streaming block landing before the db fetch resolves.
    useStore.getState().appendBlocks('s-race', [
      { kind: 'assistant', id: 'live-1', text: 'streaming' }
    ]);
    resolve([{ kind: 'user', id: 'stale', text: 'old' }]);
    await promise;

    const blocks = useStore.getState().messagesBySession['s-race'];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ id: 'live-1' });
  });

  it('selectSession triggers loadMessages when history is missing', () => {
    const load = vi.fn().mockResolvedValue([]);
    (globalThis as unknown as { window?: { agentory?: unknown } }).window = {
      agentory: { loadMessages: load }
    };
    useStore.setState({
      sessions: [
        { id: 's-x', name: 's-x', state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g-default', agentType: 'claude-code' }
      ]
    });
    useStore.getState().selectSession('s-x');
    expect(load).toHaveBeenCalledWith('s-x');
  });

  it('selectSession skips the load when messagesBySession already has an entry', () => {
    const load = vi.fn().mockResolvedValue([]);
    (globalThis as unknown as { window?: { agentory?: unknown } }).window = {
      agentory: { loadMessages: load }
    };
    useStore.setState({
      sessions: [
        { id: 's-y', name: 's-y', state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g-default', agentType: 'claude-code' }
      ],
      messagesBySession: { 's-y': [] }
    });
    useStore.getState().selectSession('s-y');
    expect(load).not.toHaveBeenCalled();
  });
});

describe('store: selectSession bumps focusInputNonce', () => {
  it('increments focusInputNonce on every selectSession call', () => {
    useStore.getState().createSession('~/a');
    useStore.getState().createSession('~/b');
    const [sB, sA] = useStore.getState().sessions;
    const start = useStore.getState().focusInputNonce;
    useStore.getState().selectSession(sA.id);
    const after1 = useStore.getState().focusInputNonce;
    expect(after1).toBe(start + 1);
    // Re-selecting the same session still bumps — the user clicked, so the
    // input should re-focus regardless of whether activeId actually changed.
    useStore.getState().selectSession(sA.id);
    expect(useStore.getState().focusInputNonce).toBe(after1 + 1);
    useStore.getState().selectSession(sB.id);
    expect(useStore.getState().focusInputNonce).toBe(after1 + 2);
  });

  it('also flips a waiting session to idle while bumping the nonce', () => {
    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    useStore.setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === sid ? { ...x, state: 'waiting' } : x))
    }));
    const start = useStore.getState().focusInputNonce;
    useStore.getState().selectSession(sid);
    const s = useStore.getState();
    expect(s.sessions.find((x) => x.id === sid)?.state).toBe('idle');
    expect(s.focusInputNonce).toBe(start + 1);
  });
});

describe('store: checkCli / CLI missing flow', () => {
  beforeEach(() => {
    // Every test in this suite stubs the cli API on window.agentory; reset
    // to a known baseline each run.
    (globalThis as { window?: unknown }).window = (globalThis as { window?: unknown }).window ?? {};
    (window as unknown as { agentory?: unknown }).agentory = undefined;
    useStore.setState({ cliStatus: { state: 'checking' } });
  });

  it('missing → user picks binary → found', async () => {
    const retryDetect = vi
      .fn()
      .mockResolvedValueOnce({ found: false, searchedPaths: ['where claude (PATH)'] })
      .mockResolvedValueOnce({ found: true, path: '/opt/claude', version: '2.1.5' });
    const setBinaryPath = vi.fn().mockResolvedValue({ ok: true, version: '2.1.5' });
    const browseBinary = vi.fn().mockResolvedValue('/opt/claude');
    (window as unknown as { agentory: unknown }).agentory = {
      cli: {
        getInstallHints: vi.fn(),
        browseBinary,
        setBinaryPath,
        openDocs: vi.fn(),
        retryDetect,
      },
    };

    await useStore.getState().checkCli();
    let s = useStore.getState().cliStatus;
    expect(s.state).toBe('missing');
    if (s.state === 'missing') {
      expect(s.dialogOpen).toBe(true);
      expect(s.searchedPaths).toEqual(['where claude (PATH)']);
    }

    // Simulate the "I already have it → Browse" flow: UI calls setBinaryPath
    // then re-runs checkCli.
    const picked = await (
      window as unknown as {
        agentory: { cli: { browseBinary: () => Promise<string | null> } };
      }
    ).agentory.cli.browseBinary();
    expect(picked).toBe('/opt/claude');
    const res = await (
      window as unknown as {
        agentory: {
          cli: { setBinaryPath: (p: string) => Promise<{ ok: boolean }> };
        };
      }
    ).agentory.cli.setBinaryPath(picked as string);
    expect(res.ok).toBe(true);

    await useStore.getState().checkCli();
    s = useStore.getState().cliStatus;
    expect(s.state).toBe('found');
    if (s.state === 'found') {
      expect(s.binaryPath).toBe('/opt/claude');
      expect(s.version).toBe('2.1.5');
    }
  });

  it('setCliMissing / openCliDialog / closeCliDialog toggle dialogOpen', () => {
    useStore.getState().setCliMissing(['where claude (PATH)']);
    let s = useStore.getState().cliStatus;
    if (s.state !== 'missing') throw new Error('expected missing');
    expect(s.dialogOpen).toBe(true);

    useStore.getState().closeCliDialog();
    s = useStore.getState().cliStatus;
    if (s.state !== 'missing') throw new Error('expected missing');
    expect(s.dialogOpen).toBe(false);

    useStore.getState().openCliDialog();
    s = useStore.getState().cliStatus;
    if (s.state !== 'missing') throw new Error('expected missing');
    expect(s.dialogOpen).toBe(true);
  });

  it('checkCli without preload API marks status found (keeps app usable in tests)', async () => {
    (window as unknown as { agentory?: unknown }).agentory = undefined;
    await useStore.getState().checkCli();
    const s = useStore.getState().cliStatus;
    expect(s.state).toBe('found');
  });
});
