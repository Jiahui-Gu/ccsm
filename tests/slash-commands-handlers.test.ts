import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/stores/store';
import {
  BUILT_IN_COMMANDS,
  dispatchSlashCommand,
  parseSlashInvocation,
  findSlashCommand,
} from '../src/slash-commands/registry';
import { handleClear, handleConfig, blocksToTranscript } from '../src/slash-commands/handlers';

const initial = useStore.getState();

function resetStore() {
  useStore.setState(
    {
      ...initial,
      sessions: [],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      recentProjects: [],
      activeId: '',
      focusedGroupId: null,
      messagesBySession: {},
      statsBySession: {},
      startedSessions: {},
      runningSessions: {},
      models: [],
      modelsLoaded: false,
      connection: null,
      focusInputNonce: 0,
    },
    true
  );
}

beforeEach(() => {
  resetStore();
});

describe('parseSlashInvocation', () => {
  it('parses a bare command', () => {
    expect(parseSlashInvocation('/clear')).toEqual({ name: 'clear', args: '' });
  });
  it('parses a command with args', () => {
    expect(parseSlashInvocation('/foo bar baz')).toEqual({ name: 'foo', args: 'bar baz' });
  });
  it('parses a plugin-namespaced command', () => {
    expect(parseSlashInvocation('/superpowers:brainstorm idea')).toEqual({
      name: 'superpowers:brainstorm',
      args: 'idea',
    });
  });
  it('rejects non-slash input', () => {
    expect(parseSlashInvocation('hello')).toBeNull();
  });
  it('rejects multi-line messages', () => {
    expect(parseSlashInvocation('/clear\nmore')).toBeNull();
  });
  it('rejects malformed names', () => {
    expect(parseSlashInvocation('/123')).toBeNull();
    expect(parseSlashInvocation('/')).toBeNull();
  });
});

describe('dispatchSlashCommand', () => {
  it('routes /clear to its client handler', async () => {
    const outcome = await dispatchSlashCommand(
      '/clear',
      BUILT_IN_COMMANDS,
      { sessionId: 's1', args: '' }
    );
    expect(outcome).toBe('handled');
  });
  it('routes /compact as pass-through', async () => {
    const outcome = await dispatchSlashCommand(
      '/compact',
      BUILT_IN_COMMANDS,
      { sessionId: 's1', args: '' }
    );
    expect(outcome).toBe('pass-through');
  });
  it('returns unknown for unrecognised names', async () => {
    const outcome = await dispatchSlashCommand(
      '/nope-nope',
      BUILT_IN_COMMANDS,
      { sessionId: 's1', args: '' }
    );
    expect(outcome).toBe('unknown');
  });
  it('respects a dynamic command in the merged list (pass-through)', async () => {
    const merged = [
      ...BUILT_IN_COMMANDS,
      {
        name: 'run-worker',
        description: 'something',
        source: 'user' as const,
        passThrough: true,
      },
    ];
    const outcome = await dispatchSlashCommand(
      '/run-worker arg',
      merged,
      { sessionId: 's1', args: '' }
    );
    expect(outcome).toBe('pass-through');
  });
});

describe('registry shape', () => {
  it('exposes /clear, /compact, /config as built-ins (no /think — retired in favour of StatusBar Thinking chip)', () => {
    expect(BUILT_IN_COMMANDS.map((c) => c.name)).toEqual(['clear', 'compact', 'config']);
  });
  it('/clear has a client handler, /compact does not, /config has one', () => {
    const clear = findSlashCommand(BUILT_IN_COMMANDS, 'clear');
    const compact = findSlashCommand(BUILT_IN_COMMANDS, 'compact');
    const config = findSlashCommand(BUILT_IN_COMMANDS, 'config');
    expect(clear?.passThrough).toBe(false);
    expect(typeof clear?.clientHandler).toBe('function');
    expect(compact?.passThrough).toBe(true);
    expect(compact?.clientHandler).toBeUndefined();
    expect(config?.passThrough).toBe(false);
    expect(typeof config?.clientHandler).toBe('function');
  });
});

describe('/clear', () => {
  it('wipes the current session context without changing session count or activeId', () => {
    useStore.getState().createSession('/tmp/old');
    const oldId = useStore.getState().activeId;
    useStore.getState().appendBlocks(oldId, [
      { kind: 'user', id: 'u1', text: 'hi' },
      { kind: 'assistant', id: 'a1', text: 'hello' },
    ]);
    useStore.getState().markStarted(oldId);
    useStore
      .getState()
      .addSessionStats(oldId, { turns: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.001 });
    useStore.setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === oldId ? { ...x, resumeSessionId: 'cc-abc' } : x)),
    }));
    const sessionCountBefore = useStore.getState().sessions.length;

    handleClear({ sessionId: oldId, args: '' });

    const s = useStore.getState();
    expect(s.sessions.length).toBe(sessionCountBefore);
    expect(s.activeId).toBe(oldId);
    const session = s.sessions.find((x) => x.id === oldId)!;
    expect(session.resumeSessionId).toBeUndefined();
    expect(s.startedSessions[oldId]).toBeUndefined();
    expect(s.statsBySession[oldId]).toBeUndefined();
    const blocks = s.messagesBySession[oldId] ?? [];
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe('status');
    if (blocks[0].kind === 'status') {
      expect(blocks[0].title).toBe('Context cleared');
    }
  });
});

describe('/config', () => {
  it('dispatches the ccsm:open-settings window event', () => {
    let fired = 0;
    const listener = () => {
      fired += 1;
    };
    window.addEventListener('ccsm:open-settings', listener);
    try {
      handleConfig({ sessionId: 's1', args: '' });
      expect(fired).toBe(1);
    } finally {
      window.removeEventListener('ccsm:open-settings', listener);
    }
  });
});

describe('blocksToTranscript', () => {
  it('flattens user/assistant/tool/status blocks into a transcript', () => {
    const t = blocksToTranscript([
      { kind: 'user', id: 'u', text: 'hi' },
      { kind: 'assistant', id: 'a', text: 'hello' },
      { kind: 'tool', id: 't', name: 'Read', brief: 'foo.ts', expanded: false, result: 'file contents' },
      { kind: 'status', id: 's', tone: 'info', title: 'Done', detail: 'ok' },
    ]);
    expect(t).toContain('User: hi');
    expect(t).toContain('Assistant: hello');
    expect(t).toContain('Tool(Read): foo.ts');
    expect(t).toContain('(info) Done — ok');
  });
});
