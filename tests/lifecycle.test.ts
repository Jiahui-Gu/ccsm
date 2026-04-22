import { describe, it, expect, beforeEach, vi } from 'vitest';

type PermReq = {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
};

type AgentEvent = { sessionId: string; message: unknown };
type AgentExit = { sessionId: string; error?: string };

// Each test reaches into this state to drive the simulated SDK and the store.
type Harness = {
  permHandler: (r: PermReq) => void;
  eventHandler: (e: AgentEvent) => void;
  exitHandler: (e: AgentExit) => void;
  store: typeof import('../src/stores/store').useStore;
  setBackgroundWaitingHandler: typeof import('../src/agent/lifecycle').setBackgroundWaitingHandler;
  notifyCalls: Array<{ sessionId: string; title: string; body?: string }>;
  sendCalls: Array<{ sessionId: string; text: string }>;
};

async function freshHarness(): Promise<Harness> {
  // Fresh module graph per test — both lifecycle (so `installed` resets) and
  // store (so its in-memory state starts blank).
  vi.resetModules();
  let permHandler: ((r: PermReq) => void) | null = null;
  let eventHandler: ((e: AgentEvent) => void) | null = null;
  let exitHandler: ((e: AgentExit) => void) | null = null;
  const notifyCalls: Array<{ sessionId: string; title: string; body?: string }> = [];
  const sendCalls: Array<{ sessionId: string; text: string }> = [];
  (globalThis as unknown as { window: { agentory: unknown } }).window = {
    agentory: {
      onAgentEvent: (h: (e: AgentEvent) => void) => {
        eventHandler = h;
        return () => {};
      },
      onAgentExit: (h: (e: AgentExit) => void) => {
        exitHandler = h;
        return () => {};
      },
      onAgentPermissionRequest: (h: (r: PermReq) => void) => {
        permHandler = h;
        return () => {};
      },
      notify: async (payload: { sessionId: string; title: string; body?: string }) => {
        notifyCalls.push(payload);
        return true;
      },
      agentSend: async (sessionId: string, text: string) => {
        sendCalls.push({ sessionId, text });
        return true;
      }
    }
  };
  const lifecycle = await import('../src/agent/lifecycle');
  const storeMod = await import('../src/stores/store');
  lifecycle.subscribeAgentEvents();
  if (!permHandler || !eventHandler || !exitHandler) {
    throw new Error('lifecycle did not register all expected handlers');
  }
  return {
    permHandler,
    eventHandler,
    exitHandler,
    store: storeMod.useStore,
    setBackgroundWaitingHandler: lifecycle.setBackgroundWaitingHandler,
    notifyCalls,
    sendCalls
  };
}

describe('lifecycle: background waiting bridge', () => {
  it('fires the bridge when permission is requested for a NON-active session', async () => {
    const h = await freshHarness();

    h.store.getState().createSession('~/active');
    const activeId = h.store.getState().activeId;
    h.store.getState().createSession('~/bg');
    const bgId = h.store.getState().sessions[0].id;
    h.store.getState().selectSession(activeId);

    const seen: Array<{ sessionId: string; sessionName: string; prompt: string }> = [];
    h.setBackgroundWaitingHandler((info) => seen.push(info));

    h.permHandler({
      sessionId: bgId,
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf /tmp/x' }
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].sessionId).toBe(bgId);
    expect(seen[0].prompt).toBe('Bash: rm -rf /tmp/x');
  });

  it('does NOT fire the bridge when the request is for the ACTIVE session', async () => {
    const h = await freshHarness();

    h.store.getState().createSession('~/only');
    const sid = h.store.getState().activeId;

    const seen: unknown[] = [];
    h.setBackgroundWaitingHandler((info) => seen.push(info));

    h.permHandler({
      sessionId: sid,
      requestId: 'req-2',
      toolName: 'Read',
      input: { file_path: '/etc/hosts' }
    });

    expect(seen).toEqual([]);
    const blocks = h.store.getState().messagesBySession[sid];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'waiting', requestId: 'req-2' });
  });

  it('appends an error block when agent exits with an error', async () => {
    const h = await freshHarness();

    h.store.getState().createSession('~/x');
    const sid = h.store.getState().activeId;
    h.store.getState().setRunning(sid, true);

    h.exitHandler({ sessionId: sid, error: 'boom' });

    expect(h.store.getState().runningSessions[sid]).toBeUndefined();
    const blocks = h.store.getState().messagesBySession[sid];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'error', text: 'boom' });
  });

  it('clears running flag silently on clean exit (no error block)', async () => {
    const h = await freshHarness();

    h.store.getState().createSession('~/x');
    const sid = h.store.getState().activeId;
    h.store.getState().setRunning(sid, true);

    h.exitHandler({ sessionId: sid });

    expect(h.store.getState().runningSessions[sid]).toBeUndefined();
    expect(h.store.getState().messagesBySession[sid]).toBeUndefined();
  });

  it('ExitPlanMode permission becomes a plan-intent waiting block with the plan markdown', async () => {
    const h = await freshHarness();
    h.store.getState().createSession('~/p');
    const sid = h.store.getState().activeId;

    const planMd = '# Plan\n1. Refactor auth\n2. Add tests';
    h.permHandler({
      sessionId: sid,
      requestId: 'req-plan',
      toolName: 'ExitPlanMode',
      input: { plan: planMd }
    });

    const blocks = h.store.getState().messagesBySession[sid];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'waiting',
      intent: 'plan',
      requestId: 'req-plan',
      plan: planMd
    });
  });

  it('non-ExitPlanMode tools still produce a permission-intent block (no plan field)', async () => {
    const h = await freshHarness();
    h.store.getState().createSession('~/p');
    const sid = h.store.getState().activeId;

    h.permHandler({
      sessionId: sid,
      requestId: 'req-bash',
      toolName: 'Bash',
      input: { command: 'ls' }
    });

    const block = h.store.getState().messagesBySession[sid][0];
    expect(block).toMatchObject({ kind: 'waiting', intent: 'permission' });
    expect((block as { plan?: string }).plan).toBeUndefined();
  });

  it('AskUserQuestion becomes an interactive question block with parsed options', async () => {
    const h = await freshHarness();
    h.store.getState().createSession('~/q');
    const sid = h.store.getState().activeId;

    h.permHandler({
      sessionId: sid,
      requestId: 'req-q',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            header: 'Auth',
            question: 'Which auth method?',
            multiSelect: false,
            options: [
              { label: 'JWT', description: 'Stateless tokens' },
              { label: 'Session', description: 'Server-side state' }
            ]
          }
        ]
      }
    });

    const block = h.store.getState().messagesBySession[sid][0] as {
      kind: string;
      requestId?: string;
      questions?: Array<{ question: string; options: Array<{ label: string }> }>;
    };
    expect(block.kind).toBe('question');
    expect(block.requestId).toBe('req-q');
    expect(block.questions).toHaveLength(1);
    expect(block.questions![0].question).toBe('Which auth method?');
    expect(block.questions![0].options.map((o) => o.label)).toEqual(['JWT', 'Session']);
  });

  it('AskUserQuestion with malformed input falls back to a generic permission block', async () => {
    const h = await freshHarness();
    h.store.getState().createSession('~/q2');
    const sid = h.store.getState().activeId;

    h.permHandler({
      sessionId: sid,
      requestId: 'req-bad',
      toolName: 'AskUserQuestion',
      input: { questions: 'not an array' }
    });

    const block = h.store.getState().messagesBySession[sid][0];
    expect(block).toMatchObject({ kind: 'waiting', intent: 'permission' });
  });

  it('fires an OS notification for a NON-active session permission request', async () => {
    const h = await freshHarness();
    h.store.getState().createSession('~/active');
    const activeId = h.store.getState().activeId;
    h.store.getState().createSession('~/bg');
    const bgId = h.store.getState().sessions[0].id;
    h.store.getState().selectSession(activeId);
    h.store.getState().renameSession(bgId, 'Background work');

    h.permHandler({
      sessionId: bgId,
      requestId: 'req-n',
      toolName: 'Bash',
      input: { command: 'ls' }
    });

    expect(h.notifyCalls).toHaveLength(1);
    expect(h.notifyCalls[0].sessionId).toBe(bgId);
    expect(h.notifyCalls[0].title).toBe('Background work needs your input');
    expect(h.notifyCalls[0].body).toBe('Bash: ls');
  });

  it('does not fire OS notification for the ACTIVE session when window is focused', async () => {
    const h = await freshHarness();
    // jsdom defaults to hasFocus()===false; force focused for this test.
    const orig = (globalThis as unknown as { document?: Document }).document?.hasFocus;
    if ((globalThis as unknown as { document?: Document }).document) {
      (globalThis as unknown as { document: Document }).document.hasFocus = () => true;
    }
    h.store.getState().createSession('~/only');
    const sid = h.store.getState().activeId;

    h.permHandler({
      sessionId: sid,
      requestId: 'req-q',
      toolName: 'Read',
      input: { file_path: '/etc/hosts' }
    });

    expect(h.notifyCalls).toEqual([]);

    if (orig && (globalThis as unknown as { document?: Document }).document) {
      (globalThis as unknown as { document: Document }).document.hasFocus = orig;
    }
  });
});

describe('lifecycle: autopilot watchdog', () => {
  function endTurn(h: Harness, sessionId: string) {
    h.eventHandler({
      sessionId,
      message: { type: 'result', subtype: 'success', usage: {}, num_turns: 1, duration_ms: 100 } as never
    });
  }

  it('does NOTHING when watchdog disabled', async () => {
    const h = await freshHarness();
    h.store.getState().createSession('~/x');
    const sid = h.store.getState().activeId;
    h.store.getState().appendBlocks(sid, [{ kind: 'assistant', id: 'a1', text: 'short reply' }]);
    endTurn(h, sid);
    expect(h.sendCalls).toEqual([]);
  });

  it('does NOTHING when last assistant message contains the done token', async () => {
    const h = await freshHarness();
    h.store.getState().setWatchdog({ enabled: true, doneToken: 'DONE!' });
    h.store.getState().createSession('~/x');
    const sid = h.store.getState().activeId;
    h.store.getState().appendBlocks(sid, [{ kind: 'assistant', id: 'a1', text: 'all DONE! goodbye' }]);
    endTurn(h, sid);
    expect(h.sendCalls).toEqual([]);
  });

  it('auto-replies with the configured prompt when token absent', async () => {
    const h = await freshHarness();
    h.store.getState().setWatchdog({
      enabled: true,
      doneToken: 'DONE!',
      otherwisePostfix: 'KEEP GOING'
    });
    h.store.getState().createSession('~/x');
    const sid = h.store.getState().activeId;
    h.store.getState().appendBlocks(sid, [{ kind: 'assistant', id: 'a1', text: 'should I continue?' }]);
    endTurn(h, sid);
    expect(h.sendCalls).toHaveLength(1);
    expect(h.sendCalls[0].sessionId).toBe(sid);
    expect(h.sendCalls[0].text).toContain('DONE!');
    expect(h.sendCalls[0].text).toContain('KEEP GOING');
    // Counter incremented and a status block appended.
    expect(h.store.getState().watchdogCountsBySession[sid]).toBe(1);
    const blocks = h.store.getState().messagesBySession[sid];
    expect(blocks.some((b) => b.kind === 'status' && b.title?.startsWith('Autopilot 1/'))).toBe(true);
  });

  it('skips when a permission request is pending', async () => {
    const h = await freshHarness();
    h.store.getState().setWatchdog({ enabled: true });
    h.store.getState().createSession('~/x');
    const sid = h.store.getState().activeId;
    h.store.getState().appendBlocks(sid, [
      { kind: 'assistant', id: 'a1', text: 'no token here' },
      { kind: 'waiting', id: 'w1', prompt: 'Bash: ls', intent: 'permission', requestId: 'req-1' }
    ]);
    endTurn(h, sid);
    expect(h.sendCalls).toEqual([]);
  });

  it('stops after maxAutoReplies and posts a paused status', async () => {
    const h = await freshHarness();
    h.store.getState().setWatchdog({ enabled: true, doneToken: 'ZZZTOKEN', maxAutoReplies: 2 });
    h.store.getState().createSession('~/x');
    const sid = h.store.getState().activeId;
    h.store.getState().appendBlocks(sid, [{ kind: 'assistant', id: 'a1', text: 'no token in this reply' }]);
    endTurn(h, sid);
    endTurn(h, sid);
    endTurn(h, sid); // third should be capped
    expect(h.sendCalls).toHaveLength(2);
    const blocks = h.store.getState().messagesBySession[sid];
    expect(blocks.some((b) => b.kind === 'status' && b.title === 'Autopilot paused')).toBe(true);
  });

  it('treats maxAutoReplies <= 0 as unlimited', async () => {
    const h = await freshHarness();
    h.store.getState().setWatchdog({ enabled: true, doneToken: 'ZZZTOKEN', maxAutoReplies: 0 });
    h.store.getState().createSession('~/x');
    const sid = h.store.getState().activeId;
    h.store.getState().appendBlocks(sid, [{ kind: 'assistant', id: 'a1', text: 'no token' }]);
    for (let i = 0; i < 5; i++) endTurn(h, sid);
    expect(h.sendCalls).toHaveLength(5);
  });

  it('skips when the latest signal is an error block', async () => {
    const h = await freshHarness();
    h.store.getState().setWatchdog({ enabled: true });
    h.store.getState().createSession('~/x');
    const sid = h.store.getState().activeId;
    h.store.getState().appendBlocks(sid, [
      { kind: 'assistant', id: 'a1', text: 'no token' },
      { kind: 'error', id: 'e1', text: 'rate limit' }
    ]);
    endTurn(h, sid);
    expect(h.sendCalls).toEqual([]);
  });

  it('skips when the latest signal is a warn status (e.g. api_retry)', async () => {
    const h = await freshHarness();
    h.store.getState().setWatchdog({ enabled: true });
    h.store.getState().createSession('~/x');
    const sid = h.store.getState().activeId;
    h.store.getState().appendBlocks(sid, [
      { kind: 'assistant', id: 'a1', text: 'no token' },
      { kind: 'status', id: 's1', tone: 'warn', title: 'Rate limit hit' }
    ]);
    endTurn(h, sid);
    expect(h.sendCalls).toEqual([]);
  });
});

describe('lifecycle: sidebar pulse on agent waiting for input', () => {
  function endTurn(h: Harness, sessionId: string) {
    h.eventHandler({
      sessionId,
      message: { type: 'result', subtype: 'success', usage: {}, num_turns: 1, duration_ms: 100 } as never
    });
  }

  it("flips a background session's state to 'waiting' when its turn ends", async () => {
    const h = await freshHarness();
    h.store.getState().createSession('~/active');
    const activeId = h.store.getState().activeId;
    h.store.getState().createSession('~/bg');
    const bgId = h.store.getState().sessions[0].id;
    h.store.getState().selectSession(activeId);

    endTurn(h, bgId);

    const bg = h.store.getState().sessions.find((s) => s.id === bgId);
    expect(bg?.state).toBe('waiting');
  });

  it("does not flip the focused session's state when its turn ends", async () => {
    const h = await freshHarness();
    if ((globalThis as unknown as { document?: Document }).document) {
      (globalThis as unknown as { document: Document }).document.hasFocus = () => true;
    }
    h.store.getState().createSession('~/only');
    const sid = h.store.getState().activeId;

    endTurn(h, sid);

    const s = h.store.getState().sessions.find((x) => x.id === sid);
    expect(s?.state).toBe('idle');
  });

  it("flips state to 'waiting' on a background permission request", async () => {
    const h = await freshHarness();
    h.store.getState().createSession('~/active');
    const activeId = h.store.getState().activeId;
    h.store.getState().createSession('~/bg');
    const bgId = h.store.getState().sessions[0].id;
    h.store.getState().selectSession(activeId);

    h.permHandler({
      sessionId: bgId,
      requestId: 'req-pulse',
      toolName: 'Bash',
      input: { command: 'ls' }
    });

    const bg = h.store.getState().sessions.find((s) => s.id === bgId);
    expect(bg?.state).toBe('waiting');
  });
});
