import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../src/stores/store';
import { framesToBlocks } from '../src/stores/store';

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
      messageQueues: {},
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

  it('defaults cwd to userHome when caller passes null', () => {
    useStore.setState({ userHome: 'C:/Users/me' });
    useStore.getState().createSession(null);
    expect(useStore.getState().sessions[0].cwd).toBe('C:/Users/me');
  });

  it('falls back to empty cwd (chip renders `(none)` placeholder) when userHome is unset', () => {
    // Boot IPC pending or unavailable — userHome is '' so default cwd is
    // '' and the chip renders the `(none)` placeholder. The user repicks
    // via the StatusBar cwd popover.
    useStore.getState().createSession(null);
    expect(useStore.getState().sessions[0].cwd).toBe('');
  });

  it('explicit cwd argument wins over userHome default', () => {
    useStore.setState({ userHome: 'C:/Users/me' });
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

  // Bug-3: distinct default session names. Brand-new sessions inherit the cwd
  // basename so the sidebar can tell rows apart at a glance, with `(N)` dedupe
  // when the same cwd produces a collision.
  describe('default name derivation (bug-3)', () => {
    it('derives default name from cwd basename', () => {
      useStore.getState().createSession('C:/projects/foo');
      expect(useStore.getState().sessions[0].name).toBe('foo');
    });

    it('strips ~/ shorthand and uses trailing segment', () => {
      useStore.getState().createSession('~/work/bar');
      expect(useStore.getState().sessions[0].name).toBe('bar');
    });

    it('uses userHome basename when cwd defaults to home', () => {
      useStore.setState({ userHome: 'C:/Users/jiahuigu' });
      useStore.getState().createSession(null);
      expect(useStore.getState().sessions[0].name).toBe('jiahuigu');
    });

    it('appends (N) suffix when basename collides with an existing session', () => {
      useStore.setState({ userHome: 'C:/Users/jiahuigu' });
      useStore.getState().createSession(null);
      useStore.getState().createSession(null);
      useStore.getState().createSession(null);
      const names = useStore.getState().sessions.map((s) => s.name).sort();
      expect(names).toEqual(['jiahuigu', 'jiahuigu (2)', 'jiahuigu (3)']);
    });

    it('falls back to literal "New session" when cwd is empty', () => {
      // userHome unset → defaultCwd is '', no basename available.
      useStore.getState().createSession(null);
      expect(useStore.getState().sessions[0].name).toBe('New session');
    });

    it('explicit name wins over cwd-derived default', () => {
      useStore.getState().createSession({ cwd: 'C:/projects/foo', name: 'Spike' });
      expect(useStore.getState().sessions[0].name).toBe('Spike');
    });

    it('dedupes against user-renamed sessions too', () => {
      useStore.setState({ userHome: 'C:/Users/jiahuigu' });
      useStore.getState().createSession(null); // 'jiahuigu'
      useStore.getState().createSession(null); // 'jiahuigu (2)'
      const id = useStore.getState().sessions[0].id; // most recent (created last)
      useStore.getState().renameSession(id, 'jiahuigu (5)');
      useStore.getState().createSession(null);
      // Existing names: 'jiahuigu', 'jiahuigu (5)'. Next default must skip
      // both occupied slots. Naive numbering would land on (2); we expect (2)
      // to be free since the rename freed it, but the new session must NOT
      // collide with 'jiahuigu (5)'.
      const names = useStore.getState().sessions.map((s) => s.name).sort();
      expect(names).toContain('jiahuigu (5)');
      expect(names).toContain('jiahuigu');
      // The third (newest) must not duplicate any existing name.
      expect(new Set(names).size).toBe(names.length);
    });
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

  it('appendBlocks dedupes a second `question` block with the same toolUseId', () => {
    // Bug A+B fix (2026-04-23): defense in depth. The PRIMARY fix is in
    // stream-to-blocks.ts (suppress the assistant tool_use AskUserQuestion
    // emission), but if anything ever lets two question blocks slip through
    // for one logical question we must collapse them so submit only fires
    // ONE round-trip — otherwise claude.exe is left blocked on a
    // can_use_tool promise that never settles, exits with code 1, and the
    // UI is stranded "running" forever.
    useStore.getState().createSession('~/q');
    const sid = useStore.getState().activeId;
    useStore.getState().appendBlocks(sid, [
      {
        kind: 'question',
        id: 'q-1',
        toolUseId: 'tu-q-1',
        questions: [{ question: 'Pick a stack', options: [{ label: 'TS' }, { label: 'Rust' }] }]
      }
    ]);
    // Same logical question, different block id, same toolUseId — the
    // assistant tool_use path used to emit this duplicate.
    useStore.getState().appendBlocks(sid, [
      {
        kind: 'question',
        id: 'q-2-different-id-same-toolUseId',
        toolUseId: 'tu-q-1',
        questions: [{ question: 'Pick a stack', options: [{ label: 'TS' }, { label: 'Rust' }] }]
      }
    ]);
    const qBlocks = useStore
      .getState()
      .messagesBySession[sid].filter((b) => b.kind === 'question');
    expect(qBlocks).toHaveLength(1);
    expect(qBlocks[0].id).toBe('q-1');
  });

  it('appendBlocks dedupes a second `question` block with the same requestId', () => {
    useStore.getState().createSession('~/q');
    const sid = useStore.getState().activeId;
    useStore.getState().appendBlocks(sid, [
      {
        kind: 'question',
        id: 'q-perm-A',
        requestId: 'perm-A',
        questions: [{ question: 'Pick', options: [{ label: 'X' }] }]
      }
    ]);
    useStore.getState().appendBlocks(sid, [
      {
        kind: 'question',
        id: 'q-perm-A-dup',
        requestId: 'perm-A',
        questions: [{ question: 'Pick', options: [{ label: 'X' }] }]
      }
    ]);
    const qBlocks = useStore
      .getState()
      .messagesBySession[sid].filter((b) => b.kind === 'question');
    expect(qBlocks).toHaveLength(1);
    expect(qBlocks[0].id).toBe('q-perm-A');
  });
});

describe('store: resolvePermission', () => {
  it('replaces the waiting block with a system trace and calls the IPC bridge', () => {
    const ipc = vi.fn().mockResolvedValue(true);
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { agentResolvePermission: ipc }
    };

    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    useStore.getState().appendBlocks(sid, [
      {
        kind: 'waiting',
        id: 'wait-req1',
        prompt: 'OK?',
        intent: 'permission',
        requestId: 'req1',
        toolName: 'Bash',
        toolInput: { command: 'ls' }
      }
    ]);

    useStore.getState().resolvePermission(sid, 'req1', 'allow');

    const blocks = useStore.getState().messagesBySession[sid] ?? [];
    // Trace replaces the waiting block in place — the chat must keep a
    // visible record so users can audit what they approved/denied later.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('system');
    expect(blocks[0]).toMatchObject({
      kind: 'system',
      subkind: 'permission-resolved',
      decision: 'allowed',
      toolName: 'Bash',
      toolInputSummary: 'ls'
    });
    expect(ipc).toHaveBeenCalledWith(sid, 'req1', 'allow');
  });

  it('emits a "denied" trace on deny so the chat retains the rejection', () => {
    const ipc = vi.fn().mockResolvedValue(true);
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { agentResolvePermission: ipc }
    };

    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    useStore.getState().appendBlocks(sid, [
      {
        kind: 'waiting',
        id: 'wait-req2',
        prompt: 'rm?',
        intent: 'permission',
        requestId: 'req2',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /tmp/x' }
      }
    ]);

    useStore.getState().resolvePermission(sid, 'req2', 'deny');

    const blocks = useStore.getState().messagesBySession[sid] ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'system',
      decision: 'denied',
      toolName: 'Bash'
    });
    expect(ipc).toHaveBeenCalledWith(sid, 'req2', 'deny');
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
  // Helper: seed a session with the given id + cwd so the store's
  // loadMessages action can derive the JSONL path.
  function seedSession(id: string, cwd = '/tmp/x') {
    useStore.setState({
      sessions: [
        { id, name: id, state: 'idle', cwd, model: 'claude-opus-4', groupId: 'g-default', agentType: 'claude-code' }
      ]
    });
  }

  it('loadMessages pulls from the IPC bridge and writes to messagesBySession', async () => {
    // PR-H: the IPC now returns raw CLI frames, which framesToBlocks
    // projects into MessageBlock[]. We feed user/assistant frames so the
    // projection produces the expected blocks.
    const frames = [
      { type: 'user', uuid: 'u1', message: { content: 'hi' } },
      {
        type: 'assistant',
        message: { id: 'msg-load-1', content: [{ type: 'text', text: 'hello there' }] }
      }
    ];
    const load = vi.fn().mockResolvedValue({ ok: true, frames });
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { loadHistory: load }
    };
    seedSession('s-ghost');

    await useStore.getState().loadMessages('s-ghost');
    expect(load).toHaveBeenCalledWith('/tmp/x', 's-ghost');
    const blocks = useStore.getState().messagesBySession['s-ghost'];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ id: 'u-u1', kind: 'user' });
    expect(blocks[1]).toMatchObject({ kind: 'assistant' });
  });

  it('loadMessages merges streamed blocks (by id) with persisted history', async () => {
    let resolve!: (v: unknown) => void;
    const load = vi.fn(
      () => new Promise<unknown>((r) => { resolve = r; })
    );
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { loadHistory: load }
    };
    seedSession('s-race');

    const promise = useStore.getState().loadMessages('s-race');
    // Simulate a streaming block landing before the disk read resolves.
    useStore.getState().appendBlocks('s-race', [
      { kind: 'assistant', id: 'live-1', text: 'streaming' }
    ]);
    // Persisted history (different id) should be prepended.
    resolve({
      ok: true,
      frames: [{ type: 'user', uuid: 'persisted-1', message: { content: 'older turn' } }]
    });
    await promise;

    const blocks = useStore.getState().messagesBySession['s-race'];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ id: 'u-persisted-1' });
    expect(blocks[1]).toMatchObject({ id: 'live-1' });
  });

  it('loadMessages dedupes persisted blocks whose id already streamed in', async () => {
    let resolve!: (v: unknown) => void;
    const load = vi.fn(
      () => new Promise<unknown>((r) => { resolve = r; })
    );
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { loadHistory: load }
    };
    seedSession('s-dup');

    const promise = useStore.getState().loadMessages('s-dup');
    useStore.getState().appendBlocks('s-dup', [
      { kind: 'user', id: 'u-dup-1', text: 'fresh' }
    ]);
    resolve({
      ok: true,
      frames: [{ type: 'user', uuid: 'dup-1', message: { content: 'stale' } }]
    });
    await promise;

    const blocks = useStore.getState().messagesBySession['s-dup'];
    expect(blocks).toHaveLength(1);
    // The streaming version wins (stays put at the end of the array).
    expect(blocks[0]).toMatchObject({ id: 'u-dup-1', text: 'fresh' });
  });

  it('selectSession triggers loadMessages when history is missing', () => {
    const load = vi.fn().mockResolvedValue({ ok: true, frames: [] });
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { loadHistory: load }
    };
    useStore.setState({
      sessions: [
        { id: 's-x', name: 's-x', state: 'idle', cwd: '/tmp/x', model: 'claude-opus-4', groupId: 'g-default', agentType: 'claude-code' }
      ]
    });
    useStore.getState().selectSession('s-x');
    expect(load).toHaveBeenCalledWith('/tmp/x', 's-x');
  });

  it('selectSession skips the load when messagesBySession already has an entry', () => {
    const load = vi.fn().mockResolvedValue({ ok: true, frames: [] });
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { loadHistory: load }
    };
    useStore.setState({
      sessions: [
        { id: 's-y', name: 's-y', state: 'idle', cwd: '/tmp/y', model: 'claude-opus-4', groupId: 'g-default', agentType: 'claude-code' }
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

describe('store: installerCorrupt flag', () => {
  it('setInstallerCorrupt(true) flips the flag, setInstallerCorrupt(false) clears it', () => {
    expect(useStore.getState().installerCorrupt).toBe(false);
    useStore.getState().setInstallerCorrupt(true);
    expect(useStore.getState().installerCorrupt).toBe(true);
    useStore.getState().setInstallerCorrupt(false);
    expect(useStore.getState().installerCorrupt).toBe(false);
  });

  it('startSessionAndReconcile clears installerCorrupt on a successful start', async () => {
    // Simulate the recovery flow: a previous start failed with
    // CLAUDE_NOT_FOUND (banner up), the user reinstalled, then the next
    // start succeeds. The success path must lower the banner — without the
    // reset it stays visible until app restart.
    useStore.getState().createSession('~/x');
    const sid = useStore.getState().sessions[0].id;
    useStore.getState().setInstallerCorrupt(true);
    expect(useStore.getState().installerCorrupt).toBe(true);

    const agentStart = vi.fn().mockResolvedValue({ ok: true });
    const agentSetMaxThinkingTokens = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { agentStart, agentSetMaxThinkingTokens }
    };

    const { startSessionAndReconcile } = await import('../src/agent/startSession');
    const ok = await startSessionAndReconcile(sid);
    expect(ok).toBe(true);
    expect(useStore.getState().installerCorrupt).toBe(false);
  });

  it('startSessionAndReconcile leaves installerCorrupt true when start fails with CLAUDE_NOT_FOUND', async () => {
    useStore.getState().createSession('~/x');
    const sid = useStore.getState().sessions[0].id;
    expect(useStore.getState().installerCorrupt).toBe(false);

    const agentStart = vi
      .fn()
      .mockResolvedValue({ ok: false, errorCode: 'CLAUDE_NOT_FOUND', error: 'not found' });
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { agentStart }
    };

    const { startSessionAndReconcile } = await import('../src/agent/startSession');
    const ok = await startSessionAndReconcile(sid);
    expect(ok).toBe(false);
    expect(useStore.getState().installerCorrupt).toBe(true);
  });
});
describe('store: composer focus orchestration', () => {
  it('bumpComposerFocus increments focusInputNonce', () => {
    const start = useStore.getState().focusInputNonce;
    useStore.getState().bumpComposerFocus();
    expect(useStore.getState().focusInputNonce).toBe(start + 1);
    useStore.getState().bumpComposerFocus();
    expect(useStore.getState().focusInputNonce).toBe(start + 2);
  });

  it('resolvePermission bumps focusInputNonce when a matching block is removed', () => {
    const ipc = vi.fn().mockResolvedValue(true);
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { agentResolvePermission: ipc }
    };
    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    useStore.getState().appendBlocks(sid, [
      { kind: 'waiting', id: 'wait-req1', prompt: 'OK?', intent: 'permission', requestId: 'req1' }
    ]);
    const before = useStore.getState().focusInputNonce;
    useStore.getState().resolvePermission(sid, 'req1', 'allow');
    expect(useStore.getState().focusInputNonce).toBe(before + 1);
  });

  it('resolvePermission does NOT bump when no matching block exists (no-op fast path)', () => {
    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    const before = useStore.getState().focusInputNonce;
    useStore.getState().resolvePermission(sid, 'no-such', 'deny');
    expect(useStore.getState().focusInputNonce).toBe(before);
  });
});

describe('store: messageQueues (CLI-style enqueue while running)', () => {
  it('enqueueMessage appends to a per-session FIFO and assigns ids', () => {
    useStore.getState().enqueueMessage('s1', { text: 'first', attachments: [] });
    useStore.getState().enqueueMessage('s1', { text: 'second', attachments: [] });
    const q = useStore.getState().messageQueues['s1'];
    expect(q).toHaveLength(2);
    expect(q[0].text).toBe('first');
    expect(q[1].text).toBe('second');
    expect(q[0].id).not.toBe(q[1].id);
  });

  it('dequeueMessage returns and removes the head', () => {
    useStore.getState().enqueueMessage('s1', { text: 'a', attachments: [] });
    useStore.getState().enqueueMessage('s1', { text: 'b', attachments: [] });
    const head = useStore.getState().dequeueMessage('s1');
    expect(head?.text).toBe('a');
    expect(useStore.getState().messageQueues['s1']).toHaveLength(1);
    expect(useStore.getState().messageQueues['s1'][0].text).toBe('b');
  });

  it('dequeueMessage returns undefined when queue is empty', () => {
    expect(useStore.getState().dequeueMessage('nope')).toBeUndefined();
  });

  it('dequeueMessage drops the key entirely when the last message leaves', () => {
    useStore.getState().enqueueMessage('s1', { text: 'only', attachments: [] });
    useStore.getState().dequeueMessage('s1');
    expect(useStore.getState().messageQueues['s1']).toBeUndefined();
  });

  it('clearQueue wipes a single session without touching others', () => {
    useStore.getState().enqueueMessage('s1', { text: 'a', attachments: [] });
    useStore.getState().enqueueMessage('s2', { text: 'b', attachments: [] });
    useStore.getState().clearQueue('s1');
    expect(useStore.getState().messageQueues['s1']).toBeUndefined();
    expect(useStore.getState().messageQueues['s2']).toHaveLength(1);
  });

  it('clearQueue is a no-op when there is no queue for the session', () => {
    const before = useStore.getState().messageQueues;
    useStore.getState().clearQueue('ghost');
    expect(useStore.getState().messageQueues).toBe(before);
  });

  it('deleteSession also wipes the queue for that session', () => {
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { saveMessages: vi.fn().mockResolvedValue(undefined) }
    };
    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    useStore.getState().enqueueMessage(sid, { text: 'hello', attachments: [] });
    expect(useStore.getState().messageQueues[sid]).toHaveLength(1);
    useStore.getState().deleteSession(sid);
    expect(useStore.getState().messageQueues[sid]).toBeUndefined();
  });

  it('preserves attachments through enqueue/dequeue', () => {
    const att = {
      id: 'att-1',
      name: 'a.png',
      mediaType: 'image/png' as const,
      data: 'AAAA',
      size: 4
    };
    useStore.getState().enqueueMessage('s1', { text: 'with img', attachments: [att] });
    const head = useStore.getState().dequeueMessage('s1');
    expect(head?.attachments).toEqual([att]);
  });
});

describe('store: createSession auto-creates default group when none usable', () => {
  it('synthesizes a normal group when groups[] is empty', () => {
    useStore.setState({ groups: [], sessions: [], activeId: '', focusedGroupId: null });
    useStore.getState().createSession('~/foo');
    const s = useStore.getState();
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].kind).toBe('normal');
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].groupId).toBe(s.groups[0].id);
    // Explicitly assert the orphan-pointer regression is gone.
    expect(s.sessions[0].groupId).not.toBe('g1');
  });

  it('synthesizes a normal group when every existing group is archived', () => {
    const archived = [
      { id: 'g-arch-1', name: 'Old', collapsed: false, kind: 'archive' as const },
      { id: 'g-arch-2', name: 'Older', collapsed: true, kind: 'archive' as const }
    ];
    useStore.setState({
      groups: archived,
      sessions: [],
      activeId: '',
      focusedGroupId: null
    });
    useStore.getState().createSession('~/bar');
    const s = useStore.getState();
    // 1 new normal group + 2 untouched archived groups.
    expect(s.groups).toHaveLength(3);
    const archivedAfter = s.groups.filter((g) => g.kind === 'archive');
    expect(archivedAfter).toHaveLength(2);
    expect(archivedAfter.map((g) => g.id).sort()).toEqual(['g-arch-1', 'g-arch-2']);
    const normal = s.groups.filter((g) => g.kind === 'normal');
    expect(normal).toHaveLength(1);
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].groupId).toBe(normal[0].id);
  });
});

// ─── New robustness coverage (worker B) ────────────────────────────────────

describe('store: restoreSession round-trip', () => {
  beforeEach(() => {
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: {
        saveMessages: vi.fn().mockResolvedValue(undefined),
        // deleteSession fires agent:close over IPC when the session had a
        // live child. Stubbed as a no-op here — the unit test cares about
        // store-state transitions, not whether main.ts tore down a pid.
        agentClose: vi.fn().mockResolvedValue(true)
      }
    };
  });

  it('restores per-session maps but drops running/interrupted (process is dead)', () => {
    useStore.getState().createSession('~/work');
    const sid = useStore.getState().activeId;
    // Hydrate every per-session map a delete would snapshot.
    useStore.getState().appendBlocks(sid, [
      { kind: 'user', id: 'u1', text: 'hello' },
      { kind: 'assistant', id: 'a1', text: 'hi' }
    ]);
    useStore.getState().enqueueMessage(sid, { text: 'queued', attachments: [] });
    useStore.getState().addSessionStats(sid, { turns: 2, costUsd: 0.5, inputTokens: 10, outputTokens: 20 });
    useStore.getState().markStarted(sid);
    useStore.getState().setRunning(sid, true);
    useStore.getState().markInterrupted(sid);

    // Spawn a sibling so prevActiveId resolution has a fallback target.
    useStore.getState().createSession('~/other');
    const sibling = useStore.getState().activeId;
    useStore.getState().selectSession(sid);

    const snap = useStore.getState().deleteSession(sid);
    expect(snap).not.toBeNull();
    expect(useStore.getState().sessions.find((x) => x.id === sid)).toBeUndefined();
    expect(useStore.getState().activeId).toBe(sibling);

    useStore.getState().restoreSession(snap!);
    const after = useStore.getState();
    const restored = after.sessions.find((x) => x.id === sid);
    expect(restored).toBeDefined();
    expect(after.messagesBySession[sid]).toHaveLength(2);
    expect(after.messageQueues[sid]).toHaveLength(1);
    expect(after.statsBySession[sid]).toMatchObject({ turns: 2, costUsd: 0.5 });
    expect(after.startedSessions[sid]).toBe(true);
    // Critically: running/interrupted must NOT be restored — the spawned
    // claude.exe is gone, so resurrecting either flag would strand the UI.
    expect(after.runningSessions[sid]).toBeUndefined();
    expect(after.interruptedSessions[sid]).toBeUndefined();
    // prevActiveId path: we were focused on `sid` before delete, so undo
    // returns focus there.
    expect(after.activeId).toBe(sid);
  });
});

describe('store: restoreGroup round-trip', () => {
  beforeEach(() => {
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { saveMessages: vi.fn().mockResolvedValue(undefined) }
    };
  });

  it('restores group + all member sessions in original positions, drops running/interrupted', () => {
    const gid = useStore.getState().createGroup('Workgroup');
    useStore.getState().focusGroup(gid);
    useStore.getState().createSession('~/a');
    const a = useStore.getState().activeId;
    useStore.getState().focusGroup(gid);
    useStore.getState().createSession('~/b');
    const b = useStore.getState().activeId;
    useStore.getState().focusGroup(gid);
    useStore.getState().createSession('~/c');
    const c = useStore.getState().activeId;

    // Different runtime state on each.
    useStore.getState().appendBlocks(a, [{ kind: 'user', id: 'u-a', text: 'A' }]);
    useStore.getState().setRunning(b, true);
    useStore.getState().markInterrupted(c);
    useStore.getState().markStarted(c);

    const orderBefore = useStore
      .getState()
      .sessions.filter((s) => s.groupId === gid)
      .map((s) => s.id);
    expect(orderBefore).toEqual([c, b, a]);

    const snap = useStore.getState().deleteGroup(gid);
    expect(snap).not.toBeNull();
    expect(useStore.getState().groups.find((g) => g.id === gid)).toBeUndefined();
    expect(useStore.getState().sessions.filter((s) => s.groupId === gid)).toHaveLength(0);

    useStore.getState().restoreGroup(snap!);
    const after = useStore.getState();
    expect(after.groups.find((g) => g.id === gid)).toBeDefined();
    const orderAfter = after.sessions.filter((s) => s.groupId === gid).map((s) => s.id);
    expect(orderAfter).toEqual(orderBefore);
    expect(after.messagesBySession[a]).toHaveLength(1);
    expect(after.startedSessions[c]).toBe(true);
    // Running / interrupted intentionally dropped on restore.
    expect(after.runningSessions[b]).toBeUndefined();
    expect(after.interruptedSessions[c]).toBeUndefined();
  });
});

describe('store: moveSession edge cases', () => {
  it('same-group reorder positions before the anchor', () => {
    const gid = 'g-default';
    useStore.setState({
      groups: [{ id: gid, name: 'Sessions', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: 's1', name: '1', state: 'idle', cwd: '~', model: '', groupId: gid, agentType: 'claude-code' },
        { id: 's2', name: '2', state: 'idle', cwd: '~', model: '', groupId: gid, agentType: 'claude-code' },
        { id: 's3', name: '3', state: 'idle', cwd: '~', model: '', groupId: gid, agentType: 'claude-code' }
      ]
    });
    useStore.getState().moveSession('s3', gid, 's1');
    expect(useStore.getState().sessions.map((s) => s.id)).toEqual(['s3', 's1', 's2']);
  });

  it('cross-group with valid anchor places before the anchor', () => {
    useStore.setState({
      groups: [
        { id: 'gA', name: 'A', collapsed: false, kind: 'normal' },
        { id: 'gB', name: 'B', collapsed: false, kind: 'normal' }
      ],
      sessions: [
        { id: 'a1', name: 'a1', state: 'idle', cwd: '~', model: '', groupId: 'gA', agentType: 'claude-code' },
        { id: 'b1', name: 'b1', state: 'idle', cwd: '~', model: '', groupId: 'gB', agentType: 'claude-code' },
        { id: 'b2', name: 'b2', state: 'idle', cwd: '~', model: '', groupId: 'gB', agentType: 'claude-code' }
      ]
    });
    useStore.getState().moveSession('a1', 'gB', 'b2');
    const s = useStore.getState().sessions;
    expect(s.find((x) => x.id === 'a1')!.groupId).toBe('gB');
    expect(s.map((x) => x.id)).toEqual(['b1', 'a1', 'b2']);
  });

  it('cross-group with anchor in wrong group appends at end of target', () => {
    useStore.setState({
      groups: [
        { id: 'gA', name: 'A', collapsed: false, kind: 'normal' },
        { id: 'gB', name: 'B', collapsed: false, kind: 'normal' }
      ],
      sessions: [
        { id: 'a1', name: 'a1', state: 'idle', cwd: '~', model: '', groupId: 'gA', agentType: 'claude-code' },
        { id: 'a2', name: 'a2', state: 'idle', cwd: '~', model: '', groupId: 'gA', agentType: 'claude-code' },
        { id: 'b1', name: 'b1', state: 'idle', cwd: '~', model: '', groupId: 'gB', agentType: 'claude-code' }
      ]
    });
    // Anchor 'a2' lives in gA, target is gB → anchor invalid, append.
    useStore.getState().moveSession('a1', 'gB', 'a2');
    const s = useStore.getState().sessions;
    expect(s.find((x) => x.id === 'a1')!.groupId).toBe('gB');
    expect(s.map((x) => x.id)).toEqual(['a2', 'b1', 'a1']);
  });

  it('drop on empty group (no anchor) appends', () => {
    useStore.setState({
      groups: [
        { id: 'gA', name: 'A', collapsed: false, kind: 'normal' },
        { id: 'gEmpty', name: 'Empty', collapsed: false, kind: 'normal' }
      ],
      sessions: [
        { id: 'a1', name: 'a1', state: 'idle', cwd: '~', model: '', groupId: 'gA', agentType: 'claude-code' }
      ]
    });
    useStore.getState().moveSession('a1', 'gEmpty', null);
    expect(useStore.getState().sessions.find((x) => x.id === 'a1')!.groupId).toBe('gEmpty');
  });

  it('invalid sessionId is a no-op', () => {
    useStore.setState({
      groups: [{ id: 'gA', name: 'A', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: 'a1', name: 'a1', state: 'idle', cwd: '~', model: '', groupId: 'gA', agentType: 'claude-code' }
      ]
    });
    const before = useStore.getState().sessions;
    useStore.getState().moveSession('does-not-exist', 'gA', null);
    expect(useStore.getState().sessions).toBe(before);
  });

  it('drop on archived group is a no-op', () => {
    useStore.setState({
      groups: [
        { id: 'gA', name: 'A', collapsed: false, kind: 'normal' },
        { id: 'gArch', name: 'Old', collapsed: false, kind: 'archive' }
      ],
      sessions: [
        { id: 'a1', name: 'a1', state: 'idle', cwd: '~', model: '', groupId: 'gA', agentType: 'claude-code' }
      ]
    });
    useStore.getState().moveSession('a1', 'gArch', null);
    expect(useStore.getState().sessions.find((x) => x.id === 'a1')!.groupId).toBe('gA');
  });
});

describe('store: importSession synthesis path', () => {
  it('synthesizes a default normal group when groups[] is empty AND groupId is stale', () => {
    useStore.setState({ groups: [], sessions: [], activeId: '' });
    const id = useStore.getState().importSession({
      name: 'Imported',
      cwd: '/tmp/imp',
      groupId: 'g-stale-12345',
      resumeSessionId: 'resume-abc'
    });
    const s = useStore.getState();
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].kind).toBe('normal');
    expect(s.groups[0].nameKey).toBe('sidebar.defaultGroupName');
    const session = s.sessions.find((x) => x.id === id);
    expect(session).toBeDefined();
    expect(session!.groupId).toBe(s.groups[0].id);
    expect(session!.resumeSessionId).toBe('resume-abc');
  });
});

describe('store: importSession reuses JSONL UUID', () => {
  // Task #292: imported sessions must adopt the JSONL filename UUID as their
  // ccsm runner id, otherwise the SDK's first init frame triggers a
  // `session_id_mismatch` diagnostic and the in-app id diverges from the
  // on-disk transcript filename (breaking the task #22 invariant that
  // ccsm id == CLI sid == JSONL filename UUID).
  it('uses resumeSessionId as the ccsm session id', () => {
    useStore.setState({
      groups: [{ id: 'g1', name: 'G', collapsed: false, kind: 'normal' }],
      sessions: [],
      activeId: ''
    });
    const id = useStore.getState().importSession({
      name: 'Imported',
      cwd: '/tmp/imp',
      groupId: 'g1',
      resumeSessionId: 'jsonl-uuid-aaaa'
    });
    expect(id).toBe('jsonl-uuid-aaaa');
    const s = useStore.getState();
    const session = s.sessions.find((x) => x.id === 'jsonl-uuid-aaaa');
    expect(session).toBeDefined();
    expect(session!.id).toBe('jsonl-uuid-aaaa');
    expect(session!.resumeSessionId).toBe('jsonl-uuid-aaaa');
    expect(s.activeId).toBe('jsonl-uuid-aaaa');
  });

  it('importing the same transcript twice de-dupes onto the existing session', () => {
    useStore.setState({
      groups: [{ id: 'g1', name: 'G', collapsed: false, kind: 'normal' }],
      sessions: [],
      activeId: 'something-else'
    });
    const first = useStore.getState().importSession({
      name: 'Imported',
      cwd: '/tmp/imp',
      groupId: 'g1',
      resumeSessionId: 'dup-uuid'
    });
    expect(useStore.getState().sessions).toHaveLength(1);

    // Switch active off so we can verify importSession re-selects.
    useStore.setState({ activeId: 'something-else' });

    const second = useStore.getState().importSession({
      name: 'Imported again',
      cwd: '/tmp/imp-other',
      groupId: 'g1',
      resumeSessionId: 'dup-uuid'
    });
    expect(second).toBe(first);
    const s = useStore.getState();
    expect(s.sessions).toHaveLength(1);
    expect(s.activeId).toBe('dup-uuid');
    // Original session record untouched (name, cwd not overwritten).
    expect(s.sessions[0].name).toBe('Imported');
    expect(s.sessions[0].cwd).toBe('/tmp/imp');
  });

  it('importing a different resumeSessionId adds a new session', () => {
    useStore.setState({
      groups: [{ id: 'g1', name: 'G', collapsed: false, kind: 'normal' }],
      sessions: [],
      activeId: ''
    });
    useStore.getState().importSession({
      name: 'A',
      cwd: '/tmp/a',
      groupId: 'g1',
      resumeSessionId: 'uuid-A'
    });
    useStore.getState().importSession({
      name: 'B',
      cwd: '/tmp/b',
      groupId: 'g1',
      resumeSessionId: 'uuid-B'
    });
    const s = useStore.getState();
    expect(s.sessions).toHaveLength(2);
    expect(s.activeId).toBe('uuid-B');
    expect(s.sessions.map((x) => x.id).sort()).toEqual(['uuid-A', 'uuid-B']);
  });
});

describe('framesToBlocks', () => {
  it('returns [] for empty input', () => {
    expect(framesToBlocks([])).toEqual([]);
  });

  it('projects a user → assistant turn into matching blocks in order', () => {
    const blocks = framesToBlocks([
      {
        type: 'user',
        uuid: 'u-1',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
      },
      {
        type: 'assistant',
        session_id: 's',
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi back' }]
        }
      }
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(blocks[1]).toMatchObject({ kind: 'assistant', text: 'hi back' });
  });

  it('attaches tool_result content to the matching tool block', () => {
    const blocks = framesToBlocks([
      {
        type: 'assistant',
        session_id: 's',
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }
          ]
        }
      },
      {
        type: 'user',
        uuid: 'u-2',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file1\nfile2' }
          ]
        }
      }
    ]);
    const tool = blocks.find((b) => b.kind === 'tool');
    expect(tool).toBeDefined();
    expect(tool && (tool as { result?: string }).result).toBe('file1\nfile2');
  });

  it('skips slash-command wrapped user frames', () => {
    const blocks = framesToBlocks([
      {
        type: 'user',
        uuid: 'u-1',
        message: { content: [{ type: 'text', text: '<command-name>/cost</command-name>' }] }
      },
      {
        type: 'user',
        uuid: 'u-2',
        message: { content: [{ type: 'text', text: 'real prompt' }] }
      }
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'user', text: 'real prompt' });
  });

  it('ignores stream_event / control_request / agent_metadata noise', () => {
    const blocks = framesToBlocks([
      { type: 'stream_event', event: { type: 'content_block_delta' } },
      { type: 'control_request', request_id: 'r' },
      { type: 'agent_metadata', agent_id: 'a' }
    ]);
    expect(blocks).toEqual([]);
  });
});

describe('store: addSessionStats NaN guard', () => {
  it('coerces NaN / Infinity / non-number deltas to 0 so totals never poison', () => {
    useStore.getState().addSessionStats('s-x', { turns: 1, costUsd: 0.1 });
    useStore.getState().addSessionStats('s-x', {
      turns: NaN,
      costUsd: Infinity,
      // @ts-expect-error — exercising the runtime guard against bad payloads
      inputTokens: 'huh',
      outputTokens: undefined
    });
    const stats = useStore.getState().statsBySession['s-x'];
    expect(Number.isFinite(stats.turns)).toBe(true);
    expect(Number.isFinite(stats.costUsd)).toBe(true);
    expect(stats.turns).toBe(1);
    expect(stats.costUsd).toBeCloseTo(0.1);
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
  });
});

describe('store: defaultGroupName via nameKey sentinel', () => {
  it('synthesized groups carry nameKey, not a frozen string', () => {
    useStore.setState({ groups: [], sessions: [], activeId: '' });
    useStore.getState().createSession('~/x');
    const synth = useStore.getState().groups[0];
    expect(synth.nameKey).toBe('sidebar.defaultGroupName');
  });
});

describe('store: setGlobalModel / setSessionModel split', () => {
  beforeEach(() => {
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = { ccsm: undefined };
  });

  it('setGlobalModel changes the global default but does NOT touch sessions', () => {
    useStore.getState().createSession('~/x');
    const sid = useStore.getState().activeId;
    const origModel = useStore.getState().sessions.find((s) => s.id === sid)!.model;
    useStore.getState().setGlobalModel('claude-opus-4-9');
    expect(useStore.getState().model).toBe('claude-opus-4-9');
    expect(useStore.getState().sessions.find((s) => s.id === sid)!.model).toBe(origModel);
  });

  it('setSessionModel changes one session and leaves the global default alone', () => {
    useStore.getState().createSession('~/a');
    const sa = useStore.getState().activeId;
    useStore.getState().createSession('~/b');
    const sb = useStore.getState().activeId;
    useStore.setState({ model: 'global-default' });
    useStore.getState().setSessionModel(sa, 'pinned-on-a');
    expect(useStore.getState().sessions.find((s) => s.id === sa)!.model).toBe('pinned-on-a');
    expect(useStore.getState().sessions.find((s) => s.id === sb)!.model).not.toBe('pinned-on-a');
    expect(useStore.getState().model).toBe('global-default');
  });
});

describe('store: loadMessages failure seeds [] and clears in-flight', () => {
  it('IPC reject leaves an empty array and the next selectSession does not retry', async () => {
    const load = vi.fn().mockRejectedValue(new Error('preload missing'));
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { loadHistory: load }
    };
    // Suppress the expected console.warn in test output.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useStore.setState({
      sessions: [
        { id: 's-fail', name: '?', state: 'idle', cwd: '/tmp/fail', model: '', groupId: 'g-default', agentType: 'claude-code' }
      ]
    });

    useStore.getState().selectSession('s-fail');
    // First selectSession kicks off loadMessages — wait for the rejection
    // microtask + the in-finally cleanup.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(load).toHaveBeenCalledTimes(1);
    expect(useStore.getState().messagesBySession['s-fail']).toEqual([]);

    // Second selectSession must NOT issue another IPC — the empty sentinel
    // marks the session as "known".
    useStore.getState().selectSession('s-fail');
    await new Promise((r) => setTimeout(r, 0));
    expect(load).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('read_error result surfaces an inline error banner', async () => {
    const load = vi.fn().mockResolvedValue({ ok: false, error: 'read_error', detail: 'EACCES' });
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { loadHistory: load }
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useStore.setState({
      sessions: [
        { id: 's-perm', name: '?', state: 'idle', cwd: '/tmp/perm', model: '', groupId: 'g-default', agentType: 'claude-code' }
      ]
    });
    await useStore.getState().loadMessages('s-perm');
    expect(useStore.getState().messagesBySession['s-perm']).toEqual([]);
    expect(useStore.getState().loadMessageErrors['s-perm']).toContain('read_error');
    warn.mockRestore();
  });

  it('not_found result is treated as empty (no error banner)', async () => {
    const load = vi.fn().mockResolvedValue({ ok: false, error: 'not_found' });
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { loadHistory: load }
    };
    useStore.setState({
      sessions: [
        { id: 's-new', name: '?', state: 'idle', cwd: '/tmp/new', model: '', groupId: 'g-default', agentType: 'claude-code' }
      ]
    });
    await useStore.getState().loadMessages('s-new');
    expect(useStore.getState().messagesBySession['s-new']).toEqual([]);
    expect(useStore.getState().loadMessageErrors['s-new']).toBeUndefined();
  });
});

describe('store: resetSessionContext resets state', () => {
  it("flips state back to 'idle' alongside clearing context", () => {
    useStore.setState({
      sessions: [
        { id: 's-reset', name: '?', state: 'waiting', cwd: '~', model: '', groupId: 'g-default', agentType: 'claude-code' }
      ]
    });
    useStore.getState().markStarted('s-reset');
    useStore.getState().setRunning('s-reset', true);
    (globalThis as unknown as { window?: { ccsm?: unknown } }).window = {
      ccsm: { saveMessages: vi.fn() }
    };

    useStore.getState().resetSessionContext('s-reset');
    const s = useStore.getState().sessions.find((x) => x.id === 's-reset')!;
    expect(s.state).toBe('idle');
    expect(useStore.getState().runningSessions['s-reset']).toBeUndefined();
    expect(useStore.getState().startedSessions['s-reset']).toBeUndefined();
  });
});

describe('store: appendBlocks perf path (concat)', () => {
  // Regression guard for the spread→concat refactor: a large prior array plus
  // a small append must produce the correct combined sequence with the prior
  // entries first, the new entries last, and no mutation of the original.
  it('appends to a large existing array without mutating the source', () => {
    useStore.getState().createSession('~/a');
    const sid = useStore.getState().activeId;
    const big = Array.from({ length: 5000 }, (_, i) => ({
      kind: 'user' as const,
      id: `seed-${i}`,
      text: `m${i}`
    }));
    useStore.getState().replaceMessages(sid, big);
    const before = useStore.getState().messagesBySession[sid];
    expect(before).toHaveLength(5000);
    useStore.getState().appendBlocks(sid, [
      { kind: 'user', id: 'tail-1', text: 'last' }
    ]);
    const after = useStore.getState().messagesBySession[sid];
    expect(after).toHaveLength(5001);
    expect(after[0].id).toBe('seed-0');
    expect(after[4999].id).toBe('seed-4999');
    expect(after[5000].id).toBe('tail-1');
    // Immutability: the previous array reference must NOT have been mutated
    // (Zustand subscribers rely on reference inequality to detect changes).
    expect(before).toHaveLength(5000);
    expect(after).not.toBe(before);
  });
});


describe('store: openPopover / closePopover (global popover mutex)', () => {
  it('initial openPopoverId is null', () => {
    expect(useStore.getState().openPopoverId).toBeNull();
  });

  it('openPopover sets the slot to the requested id', () => {
    useStore.getState().openPopover('cwd');
    expect(useStore.getState().openPopoverId).toBe('cwd');
  });

  it('opening a different popover replaces the previous (mutual exclusion)', () => {
    useStore.getState().openPopover('cwd');
    useStore.getState().openPopover('model');
    expect(useStore.getState().openPopoverId).toBe('model');
  });

  it('closePopover only clears when the requested id matches', () => {
    useStore.getState().openPopover('model');
    // Stale close from a popover that was already superseded must NOT clobber
    // the active owner's slot. This is the key invariant that prevents
    // race-y unmount cleanups from closing the popover the user just opened.
    useStore.getState().closePopover('cwd');
    expect(useStore.getState().openPopoverId).toBe('model');
    useStore.getState().closePopover('model');
    expect(useStore.getState().openPopoverId).toBeNull();
  });

  it('opening the same id twice is a no-op (no state churn)', () => {
    useStore.getState().openPopover('cwd');
    const before = useStore.getState();
    useStore.getState().openPopover('cwd');
    const after = useStore.getState();
    // Reference equality: the action returns the same state object, so
    // subscribers don't get a spurious re-render.
    expect(after).toBe(before);
    expect(after.openPopoverId).toBe('cwd');
  });

  it('closePopover when nothing is open is a no-op', () => {
    expect(useStore.getState().openPopoverId).toBeNull();
    const before = useStore.getState();
    useStore.getState().closePopover('cwd');
    const after = useStore.getState();
    expect(after).toBe(before);
    expect(after.openPopoverId).toBeNull();
  });
});

// task#328 / task#293 / task#369 — REMOVED.
// The previous "per-group cwd default" + "frequency vote" + "recentProjects
// fallback" behaviors are all gone (PR fix-default-cwd-home-and-model-...).
// New spec: default cwd is ALWAYS `userHome` regardless of CLI history,
// recentProjects, or sibling sessions in the same group. Tests for those
// behaviors have been deleted; the new e2e cases live in scripts/harness-
// restore.mjs (`new-session-default-cwd-is-home`,
// `cwd-popover-recent-only-home-on-fresh`, `cwd-popover-lru-after-user-pick`).
describe('store: createSession — default cwd is always home', () => {
  it('falls through to "" when userHome is unset (boot IPC pending or unavailable)', () => {
    useStore.getState().createSession(null);
    expect(useStore.getState().sessions[0].cwd).toBe('');
  });

  it('uses userHome as the new-session default when seeded', () => {
    useStore.setState({ userHome: '/Users/me' });
    useStore.getState().createSession(null);
    expect(useStore.getState().sessions[0].cwd).toBe('/Users/me');
  });

  it('explicit cwd argument still wins over userHome', () => {
    useStore.setState({ userHome: '/Users/me' });
    useStore.getState().createSession('/explicit/path');
    expect(useStore.getState().sessions[0].cwd).toBe('/explicit/path');
  });

  it('does NOT inherit cwd from prior sessions in the same group', () => {
    useStore.setState({ userHome: '/Users/me' });
    const gid = useStore.getState().createGroup('Repo A');
    useStore.getState().focusGroup(gid);
    useStore.getState().createSession('/repo/a');
    useStore.getState().focusGroup(gid);
    useStore.getState().createSession(null);
    expect(useStore.getState().sessions[0].cwd).toBe('/Users/me');
  });

  it('does NOT consult recentProjects for new-session default', () => {
    useStore.setState({ userHome: '/Users/me' });
    useStore.getState().pushRecentProject('/recent/proj');
    useStore.getState().createSession(null);
    expect(useStore.getState().sessions[0].cwd).toBe('/Users/me');
  });
});
