import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  blocksToTranscript
} from '../src/slash-commands/handlers';
import { setOpenSettingsListener, setOpenModelPickerListener } from '../src/slash-commands/ui-bridge';

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
      models: [],
      modelsLoaded: false,
      connection: null,
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
  it('the five client commands declare passThrough: false with a handler', () => {
    const clientNames = ['clear', 'cost', 'config', 'model', 'help'];
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
    expect(passNames).toContain('compact');
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
  afterEach(() => {
    setOpenSettingsListener(null);
    setOpenModelPickerListener(null);
  });

  it('/config opens settings (appearance tab)', () => {
    const calls: Array<string | undefined> = [];
    setOpenSettingsListener((tab) => calls.push(tab));
    handleConfig({ sessionId: 's', args: '' });
    expect(calls).toEqual(['appearance']);
  });
  it('/model opens the in-chat model picker (does NOT open settings)', () => {
    const settingsCalls: Array<string | undefined> = [];
    setOpenSettingsListener((tab) => settingsCalls.push(tab));
    let pickerOpens = 0;
    setOpenModelPickerListener(() => {
      pickerOpens += 1;
    });
    handleModel({ sessionId: 's', args: '' });
    expect(pickerOpens).toBe(1);
    expect(settingsCalls).toEqual([]);
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

