import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useStore } from '../src/stores/store';
import {
  SLASH_COMMANDS,
  dispatchSlashCommand,
  parseSlashInvocation,
  findSlashCommand
} from '../src/slash-commands/registry';
import {
  handleClear,
  handleCost,
  handleConfig,
  handleModel,
  handleHelp,
  handleCompact,
  blocksToTranscript
} from '../src/slash-commands/handlers';
import { setOpenSettingsListener } from '../src/slash-commands/ui-bridge';

// Snapshot of the pristine store so we can reset between tests. The store
// module auto-attaches handlers via its own side-effects; handlers.ts also
// does so on import. Both are idempotent.
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
      endpoints: [],
      modelsByEndpoint: {},
      defaultEndpointId: null,
      focusInputNonce: 0
    },
    true
  );
}

beforeEach(() => {
  resetStore();
});

describe('parseSlashInvocation', () => {
  it('parses a bare command', () => {
    expect(parseSlashInvocation('/help')).toEqual({ name: 'help', args: '' });
  });
  it('parses a command with args', () => {
    expect(parseSlashInvocation('/model claude-sonnet')).toEqual({
      name: 'model',
      args: 'claude-sonnet'
    });
  });
  it('rejects non-slash input', () => {
    expect(parseSlashInvocation('hello')).toBeNull();
  });
  it('rejects multi-line messages even if first char is /', () => {
    expect(parseSlashInvocation('/help\nmore')).toBeNull();
  });
  it('rejects malformed command names', () => {
    expect(parseSlashInvocation('/123')).toBeNull();
    expect(parseSlashInvocation('/')).toBeNull();
  });
});

describe('dispatchSlashCommand', () => {
  it('prefers clientHandler over pass-through', async () => {
    const outcome = await dispatchSlashCommand('/help', { sessionId: 's1', args: '' });
    expect(outcome).toBe('handled');
  });
  it('returns pass-through for commands with no handler', async () => {
    const outcome = await dispatchSlashCommand('/doctor', { sessionId: 's1', args: '' });
    expect(outcome).toBe('pass-through');
  });
  it('returns unknown for unrecognised names', async () => {
    const outcome = await dispatchSlashCommand('/nope-nope', { sessionId: 's1', args: '' });
    expect(outcome).toBe('unknown');
  });
});

describe('registry shape', () => {
  it('the six client commands declare passThrough: false with a handler', () => {
    const clientNames = ['clear', 'cost', 'config', 'model', 'help', 'compact'];
    for (const n of clientNames) {
      const c = findSlashCommand(n);
      expect(c, `command ${n} not in registry`).toBeTruthy();
      expect(c!.passThrough).toBe(false);
      expect(typeof c!.clientHandler).toBe('function');
    }
  });
  it('other commands are pass-through without a handler', () => {
    const passNames = SLASH_COMMANDS.filter((c) => !c.clientHandler).map((c) => c.name);
    expect(passNames).toContain('doctor');
    expect(passNames).toContain('memory');
    expect(passNames).toContain('login');
  });
});

describe('/clear', () => {
  it('creates a new session and switches to it, leaving a breadcrumb on the old', () => {
    useStore.getState().createSession('/tmp/old');
    const oldId = useStore.getState().activeId;
    handleClear({ sessionId: oldId, args: '' });
    const s = useStore.getState();
    expect(s.sessions.length).toBe(2);
    expect(s.activeId).not.toBe(oldId);
    const oldBlocks = s.messagesBySession[oldId] ?? [];
    expect(oldBlocks.some((b) => b.kind === 'status' && b.title === 'New session created')).toBe(true);
  });
});

describe('/cost', () => {
  it('renders an info banner with formatted tokens + cost', () => {
    useStore.getState().createSession('/tmp');
    const sid = useStore.getState().activeId;
    useStore.getState().addSessionStats(sid, {
      turns: 2,
      inputTokens: 12345,
      outputTokens: 678,
      costUsd: 0.0234
    });
    handleCost({ sessionId: sid, args: '' });
    const blocks = useStore.getState().messagesBySession[sid] ?? [];
    const status = blocks.find((b) => b.kind === 'status');
    expect(status).toBeTruthy();
    if (status && status.kind === 'status') {
      expect(status.title).toBe('Session cost');
      expect(status.detail).toContain('2 turns');
      expect(status.detail).toContain('12k in');
      expect(status.detail).toContain('678 out');
      expect(status.detail).toContain('$0.023');
    }
  });
  it('renders a placeholder when no data yet', () => {
    useStore.getState().createSession('/tmp');
    const sid = useStore.getState().activeId;
    handleCost({ sessionId: sid, args: '' });
    const blocks = useStore.getState().messagesBySession[sid] ?? [];
    const s = blocks.find((b) => b.kind === 'status');
    expect(s && s.kind === 'status' && s.title).toBe('No cost data yet');
  });
});

describe('/config and /model', () => {
  afterEach(() => setOpenSettingsListener(null));

  it('/config opens settings (general tab)', () => {
    const calls: Array<string | undefined> = [];
    setOpenSettingsListener((tab) => calls.push(tab));
    handleConfig({ sessionId: 's', args: '' });
    expect(calls).toEqual(['general']);
  });
  it('/model opens settings on endpoints tab', () => {
    const calls: Array<string | undefined> = [];
    setOpenSettingsListener((tab) => calls.push(tab));
    handleModel({ sessionId: 's', args: '' });
    expect(calls).toEqual(['endpoints']);
  });
});

describe('/help', () => {
  it('lists all registered commands and labels client vs passthru', () => {
    useStore.getState().createSession('/tmp');
    const sid = useStore.getState().activeId;
    handleHelp({ sessionId: sid, args: '' });
    const blocks = useStore.getState().messagesBySession[sid] ?? [];
    const s = blocks.find((b) => b.kind === 'status');
    expect(s && s.kind === 'status').toBe(true);
    if (s && s.kind === 'status') {
      expect(s.title).toBe('Slash commands');
      expect(s.detail).toContain('/help');
      expect(s.detail).toContain('/clear');
      expect(s.detail).toContain('(client)');
      expect(s.detail).toContain('(passthru)');
      expect(s.detail).toContain('⚠');
      expect(s.detail).toContain('Commands starting with ⚠');
    }
  });
});

describe('blocksToTranscript', () => {
  it('flattens user/assistant/tool/status blocks into a transcript', () => {
    const t = blocksToTranscript([
      { kind: 'user', id: 'u', text: 'hi' },
      { kind: 'assistant', id: 'a', text: 'hello' },
      { kind: 'tool', id: 't', name: 'Read', brief: 'foo.ts', expanded: false, result: 'file contents' },
      { kind: 'status', id: 's', tone: 'info', title: 'Done', detail: 'ok' }
    ]);
    expect(t).toContain('User: hi');
    expect(t).toContain('Assistant: hello');
    expect(t).toContain('Tool(Read): foo.ts');
    expect(t).toContain('(info) Done — ok');
  });
});

describe('/compact', () => {
  function stubAgentory(
    createMessage: (args: unknown) => Promise<unknown>,
    saveMessages: (sid: string, blocks: unknown[]) => Promise<void> = async () => {}
  ) {
    (globalThis as { window: { agentory: unknown } }).window = {
      agentory: {
        saveMessages,
        endpoints: { createMessage }
      }
    };
  }

  afterEach(() => {
    // Leave `window` alone; other tests don't rely on it in this file.
  });

  it('wipes messages and inserts a summary on success', async () => {
    useStore.getState().createSession('/tmp');
    const sid = useStore.getState().activeId;
    useStore.setState((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sid ? { ...x, endpointId: 'ep-1', model: 'claude-test' } : x
      ),
      messagesBySession: {
        ...s.messagesBySession,
        [sid]: [
          { kind: 'user', id: 'u1', text: 'refactor foo' },
          { kind: 'assistant', id: 'a1', text: 'did it' }
        ]
      }
    }));

    const captured: Array<Record<string, unknown>> = [];
    const savedCalls: Array<[string, unknown[]]> = [];
    stubAgentory(
      async (args) => {
        captured.push(args as Record<string, unknown>);
        return { ok: true, text: '- Refactored foo\n- Open: none' };
      },
      async (s, b) => {
        savedCalls.push([s, b]);
      }
    );

    await handleCompact({ sessionId: sid, args: '' });

    const blocks = useStore.getState().messagesBySession[sid] ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('status');
    if (blocks[0].kind === 'status') {
      expect(blocks[0].title).toBe('Conversation compacted');
      expect(blocks[0].detail).toContain('Refactored foo');
    }
    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBe('claude-test');
    expect(captured[0].endpointId).toBe('ep-1');
    expect(savedCalls.length).toBe(1);
    expect(savedCalls[0][0]).toBe(sid);
  });

  it('leaves messages untouched on fetch error', async () => {
    useStore.getState().createSession('/tmp');
    const sid = useStore.getState().activeId;
    useStore.setState((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sid ? { ...x, endpointId: 'ep-1', model: 'claude-test' } : x
      ),
      messagesBySession: {
        ...s.messagesBySession,
        [sid]: [
          { kind: 'user', id: 'u1', text: 'hello' },
          { kind: 'assistant', id: 'a1', text: 'hi' }
        ]
      }
    }));

    stubAgentory(async () => ({ ok: false, error: 'boom' }));
    await handleCompact({ sessionId: sid, args: '' });

    const blocks = useStore.getState().messagesBySession[sid] ?? [];
    // original 2 + compacting-notice + error  (order: notice comes first, error last)
    expect(blocks.some((b) => b.kind === 'user' && b.id === 'u1')).toBe(true);
    expect(blocks.some((b) => b.kind === 'assistant' && b.id === 'a1')).toBe(true);
    expect(blocks.some((b) => b.kind === 'error' && b.text.includes('boom'))).toBe(true);
  });

  it('errors when no endpoint is configured', async () => {
    useStore.getState().createSession('/tmp');
    const sid = useStore.getState().activeId;
    // Ensure session has no endpoint and store has no default.
    useStore.setState((s) => ({
      sessions: s.sessions.map((x) => (x.id === sid ? { ...x, endpointId: undefined } : x)),
      defaultEndpointId: null,
      messagesBySession: {
        ...s.messagesBySession,
        [sid]: [{ kind: 'user', id: 'u1', text: 'hi' }]
      }
    }));
    const seen: unknown[] = [];
    stubAgentory(async () => {
      seen.push('called');
      return { ok: true, text: 'x' };
    });
    await handleCompact({ sessionId: sid, args: '' });
    expect(seen).toEqual([]);
    const blocks = useStore.getState().messagesBySession[sid] ?? [];
    expect(blocks.some((b) => b.kind === 'error' && b.text.includes('no endpoint'))).toBe(true);
  });
});
