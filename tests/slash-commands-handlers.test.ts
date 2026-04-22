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
  handleStatus,
  handleDoctor,
  handleMemory,
  handleBug,
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
    // /compact + /init are the only remaining pass-through entries.
    const outcome = await dispatchSlashCommand('/compact', { sessionId: 's1', args: '' });
    expect(outcome).toBe('pass-through');
  });
  it('returns unknown for unrecognised names', async () => {
    const outcome = await dispatchSlashCommand('/nope-nope', { sessionId: 's1', args: '' });
    expect(outcome).toBe('unknown');
  });
  it('treats removed commands (login/logout/resume/mcp/etc) as unknown', async () => {
    for (const removed of ['login', 'logout', 'resume', 'mcp', 'hooks', 'agents', 'review']) {
      // eslint-disable-next-line no-await-in-loop
      const out = await dispatchSlashCommand(`/${removed}`, { sessionId: 's', args: '' });
      expect(out, `expected /${removed} to be unknown after pruning`).toBe('unknown');
    }
  });
});

describe('registry shape', () => {
  it('the nine client commands declare passThrough: false with a handler', () => {
    const clientNames = ['clear', 'cost', 'config', 'model', 'help', 'status', 'doctor', 'memory', 'bug'];
    for (const n of clientNames) {
      const c = findSlashCommand(n);
      expect(c, `command ${n} not in registry`).toBeTruthy();
      expect(c!.passThrough).toBe(false);
      expect(typeof c!.clientHandler).toBe('function');
    }
  });
  it('only /compact and /init remain as pass-through', () => {
    const passNames = SLASH_COMMANDS.filter((c) => !c.clientHandler).map((c) => c.name);
    expect(passNames.sort()).toEqual(['compact', 'init']);
  });
  it('removed commands are gone from the registry', () => {
    for (const removed of ['login', 'logout', 'resume', 'mcp', 'hooks', 'agents', 'review']) {
      expect(findSlashCommand(removed), `expected /${removed} to be removed`).toBeUndefined();
    }
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

  it('/config opens settings (appearance tab)', () => {
    const calls: Array<string | undefined> = [];
    setOpenSettingsListener((tab) => calls.push(tab));
    handleConfig({ sessionId: 's', args: '' });
    expect(calls).toEqual(['appearance']);
  });
  it('/model opens settings on connection tab', () => {
    const calls: Array<string | undefined> = [];
    setOpenSettingsListener((tab) => calls.push(tab));
    handleModel({ sessionId: 's', args: '' });
    expect(calls).toEqual(['connection']);
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

// ───── shared window.agentory stub for /status, /doctor, /memory, /bug ─────
//
// Mocks the IPC surface tightly enough that the handlers can render a status
// or error block; per test the doctor/memory/openExternal stubs can be
// overridden via the `__overrides` field below.
type StubOverrides = {
  doctorRun?: () => Promise<{ checks: Array<{ name: string; ok: boolean; detail: string }> }>;
  memoryOpen?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  openExternal?: (url: string) => Promise<boolean>;
  getVersion?: () => Promise<string>;
};

let stubOverrides: StubOverrides = {};

function installAgentoryStub(): void {
  // jsdom doesn't define `window.agentory`; we add a minimal mock that the
  // handlers can call without exploding. Each test resets stubOverrides in
  // beforeEach.
  Object.defineProperty(window, 'agentory', {
    value: {
      getVersion: () => stubOverrides.getVersion?.() ?? Promise.resolve('0.0.0-test'),
      doctor: { run: () => stubOverrides.doctorRun?.() ?? Promise.resolve({ checks: [] }) },
      memory: { openUserFile: () => stubOverrides.memoryOpen?.() ?? Promise.resolve({ ok: true as const }) },
      openExternal: (url: string) =>
        stubOverrides.openExternal?.(url) ?? Promise.resolve(true),
      window: { platform: 'test' }
    },
    writable: true,
    configurable: true
  });
}

installAgentoryStub();

describe('/status', () => {
  it('renders connection / model / cwd / usage in a status banner', () => {
    useStore.getState().createSession('/tmp/work');
    const sid = useStore.getState().activeId;
    useStore.setState({
      connection: { baseUrl: 'https://api.example.com', model: 'sonnet', hasAuthToken: true }
    });
    useStore.getState().addSessionStats(sid, {
      turns: 1,
      inputTokens: 500,
      outputTokens: 50,
      costUsd: 0.0012
    });
    handleStatus({ sessionId: sid, args: '' });
    const blocks = useStore.getState().messagesBySession[sid] ?? [];
    const s = blocks.find((b) => b.kind === 'status');
    expect(s && s.kind === 'status' && s.title).toBe('Session status');
    if (s && s.kind === 'status') {
      expect(s.detail).toContain('/tmp/work');
      expect(s.detail).toContain('https://api.example.com');
      expect(s.detail).toContain('token present');
      expect(s.detail).toContain('1 turn');
    }
  });
  it('shows "no turns yet" when stats are empty', () => {
    useStore.getState().createSession('/tmp');
    const sid = useStore.getState().activeId;
    handleStatus({ sessionId: sid, args: '' });
    const s = (useStore.getState().messagesBySession[sid] ?? []).find((b) => b.kind === 'status');
    expect(s && s.kind === 'status' && s.detail).toContain('no turns yet');
  });
});

describe('/doctor', () => {
  beforeEach(() => {
    stubOverrides = {};
  });
  it('renders "all checks passed" when every probe is ok', async () => {
    stubOverrides.doctorRun = async () => ({
      checks: [
        { name: 'settings.json', ok: true, detail: '/x' },
        { name: 'claude binary', ok: true, detail: '/bin/claude (v2.1.0)' },
        { name: 'data dir writable', ok: true, detail: '/data' }
      ]
    });
    useStore.getState().createSession('/tmp');
    const sid = useStore.getState().activeId;
    await handleDoctor({ sessionId: sid, args: '' });
    const s = (useStore.getState().messagesBySession[sid] ?? []).find((b) => b.kind === 'status');
    expect(s && s.kind === 'status' && s.title).toBe('Doctor: all checks passed');
    if (s && s.kind === 'status') {
      expect(s.tone).toBe('info');
      expect(s.detail).toContain('[ok]');
      expect(s.detail).toContain('settings.json');
    }
  });
  it('warns when any check fails', async () => {
    stubOverrides.doctorRun = async () => ({
      checks: [
        { name: 'settings.json', ok: false, detail: 'not found' },
        { name: 'claude binary', ok: true, detail: '/bin/claude' }
      ]
    });
    useStore.getState().createSession('/tmp');
    const sid = useStore.getState().activeId;
    await handleDoctor({ sessionId: sid, args: '' });
    const s = (useStore.getState().messagesBySession[sid] ?? []).find((b) => b.kind === 'status');
    expect(s && s.kind === 'status' && s.title).toBe('Doctor: issues found');
    if (s && s.kind === 'status') {
      expect(s.tone).toBe('warn');
      expect(s.detail).toContain('[fail]');
      expect(s.detail).toContain('settings.json');
      expect(s.detail).toContain('not found');
    }
  });
});

describe('/memory', () => {
  beforeEach(() => {
    stubOverrides = {};
  });
  it('renders confirmation when openUserFile succeeds', async () => {
    stubOverrides.memoryOpen = async () => ({ ok: true });
    useStore.getState().createSession('/tmp');
    const sid = useStore.getState().activeId;
    await handleMemory({ sessionId: sid, args: '' });
    const s = (useStore.getState().messagesBySession[sid] ?? []).find((b) => b.kind === 'status');
    expect(s && s.kind === 'status' && s.title).toBe('Opened user memory');
  });
  it('renders error when openUserFile fails', async () => {
    stubOverrides.memoryOpen = async () => ({ ok: false, error: 'EACCES' });
    useStore.getState().createSession('/tmp');
    const sid = useStore.getState().activeId;
    await handleMemory({ sessionId: sid, args: '' });
    const e = (useStore.getState().messagesBySession[sid] ?? []).find((b) => b.kind === 'error');
    expect(e && e.kind === 'error' && e.text).toContain('EACCES');
  });
});

describe('/bug', () => {
  beforeEach(() => {
    stubOverrides = {};
  });
  it('opens a GitHub URL with prefilled environment metadata', async () => {
    let captured: string | null = null;
    stubOverrides.openExternal = async (url) => {
      captured = url;
      return true;
    };
    stubOverrides.getVersion = async () => '1.2.3';
    useStore.getState().createSession('/tmp');
    const sid = useStore.getState().activeId;
    await handleBug({ sessionId: sid, args: '' });
    expect(captured).toBeTruthy();
    expect(captured!).toContain('github.com/Jiahui-Gu/Agentory-next/issues/new');
    // Body is URL-encoded; decoding once should reveal the version line.
    const decoded = decodeURIComponent(captured!);
    expect(decoded).toContain('Agentory: 1.2.3');
    expect(decoded).toContain('Platform: test');
  });
});

