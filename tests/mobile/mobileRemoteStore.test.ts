import { describe, expect, it, vi } from 'vitest';

import { createMobileRemoteStore } from '../../src/mobile/mobileRemoteStore';
import type { PhoneConnectionStatus, RelayClient } from '../../src/mobile/relayClient';
import type { MobileClientMessage, MobileServerMessage } from '../../src/shared/mobileRemote';
import type { SessionNavigatorModel } from '../../src/shared/sessionNavigator';

type FakeRelayClient = RelayClient & {
  sent: MobileClientMessage[];
  recoveryQueue: MobileClientMessage[];
  retryCalls: number;
  emitMessage(message: MobileServerMessage): void;
  emitStatus(status: PhoneConnectionStatus): void;
};

function isRecoveryMessage(message: MobileClientMessage): boolean {
  return (
    message.type === 'sessions.list' ||
    message.type === 'session.snapshot' ||
    message.type === 'session.resize'
  );
}

function createFakeClient(options: { sendError?: Error } = {}): FakeRelayClient {
  const messageHandlers = new Set<(message: MobileServerMessage) => void>();
  const statusHandlers = new Set<(status: PhoneConnectionStatus) => void>();
  const sent: MobileClientMessage[] = [];
  const recoveryQueue: MobileClientMessage[] = [];
  let retryCalls = 0;

  return {
    sent,
    recoveryQueue,
    get retryCalls() {
      return retryCalls;
    },
    connect() {},
    retry() {
      retryCalls += 1;
    },
    send(message) {
      sent.push(message);
      if (isRecoveryMessage(message)) recoveryQueue.push(message);
      if (options.sendError) return Promise.reject(options.sendError);
      return Promise.resolve();
    },
    close() {},
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onStatus(handler) {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
    emitMessage(message) {
      for (const handler of messageHandlers) handler(message);
    },
    emitStatus(status) {
      for (const handler of statusHandlers) handler(status);
    },
  };
}

function navigatorModel(overrides: Partial<SessionNavigatorModel> = {}): SessionNavigatorModel {
  return {
    groups: [
      {
        id: 'g1',
        name: 'Group 1',
        order: 0,
        collapsed: false,
        sessions: [
          { id: 's1', name: 's1', cwd: '/repo', state: 'idle', order: 0 },
          { id: 's2', name: 's2', cwd: '/repo', state: 'idle', order: 1 },
        ],
      },
    ],
    activeSessionId: null,
    ...overrides,
  };
}

function createTestStore(options: { sendError?: Error; requestId?: () => string } = {}) {
  const client = createFakeClient({ sendError: options.sendError });
  const store = createMobileRemoteStore(client, { requestId: options.requestId });
  return { store, client };
}

function connect(store: ReturnType<typeof createMobileRemoteStore>, client: FakeRelayClient): void {
  client.emitStatus('connected');
  void store;
}

describe('mobileRemoteStore', () => {
  it('keeps independent drafts while switching sessions', () => {
    const { store } = createTestStore();
    store.getState().selectSession('s1');
    store.getState().setDraft('first');
    store.getState().selectSession('s2');
    store.getState().setDraft('second');
    expect(store.getState().drafts).toEqual({ s1: 'first', s2: 'second' });
  });

  it('does not alter the selected draft on navigation alone', () => {
    const { store } = createTestStore();
    store.getState().selectSession('s1');
    store.getState().setDraft('draft one');
    store.getState().selectSession('s1');
    expect(store.getState().drafts.s1).toBe('draft one');
  });

  it('clears only the draft acknowledged by the desktop', async () => {
    const { store, client } = createTestStore({ requestId: () => 'req-1' });
    connect(store, client);
    store.getState().selectSession('s1');
    store.getState().setDraft('hello');
    await store.getState().submitDraft();
    const request = client.sent.at(-1) as Extract<MobileClientMessage, { type: 'session.submit' }>;
    store.getState().receive({
      type: 'session.submit.result',
      sid: 's1',
      requestId: request.requestId,
      ok: true,
    });
    expect(store.getState().drafts.s1).toBe('');
    expect(store.getState().pendingSubmission).toBeNull();
    expect(store.getState().submissionError).toBeNull();
  });

  it('preserves a rejected draft and never queues it for reconnect', async () => {
    const { store, client } = createTestStore({ sendError: new Error('connection_changed') });
    connect(store, client);
    store.getState().selectSession('s1');
    store.getState().setDraft('keep me');
    await store.getState().submitDraft();
    expect(store.getState().drafts.s1).toBe('keep me');
    expect(store.getState().submissionError).toBe('connection_changed');
    expect(store.getState().pendingSubmission).toBeNull();
    expect(client.sent.filter((message) => message.type === 'session.submit')).toHaveLength(1);
    expect(client.recoveryQueue).not.toContainEqual(
      expect.objectContaining({ type: 'session.submit' }),
    );
  });

  it('does nothing without a selected session, enabled input, draft text, or while pending', async () => {
    const { store, client } = createTestStore();
    // No selected session.
    await store.getState().submitDraft();
    expect(client.sent).toHaveLength(0);

    // Selected but not connected (inputEnabled false).
    store.getState().selectSession('s1');
    await store.getState().submitDraft();
    expect(client.sent.filter((message) => message.type === 'session.submit')).toHaveLength(0);

    connect(store, client);
    // Connected but draft empty.
    await store.getState().submitDraft();
    expect(client.sent.filter((message) => message.type === 'session.submit')).toHaveLength(0);

    store.getState().setDraft('go');
    let resolveSend: (() => void) | undefined;
    const blockedClient = createFakeClient();
    blockedClient.send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const blockedStore = createMobileRemoteStore(blockedClient);
    blockedClient.emitStatus('connected');
    blockedStore.getState().selectSession('s1');
    blockedStore.getState().setDraft('one');
    const firstSubmit = blockedStore.getState().submitDraft();
    // Second call while pending must not send again.
    await blockedStore.getState().submitDraft();
    const submitCalls = (blockedClient.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([message]) => message.type === 'session.submit',
    );
    expect(submitCalls).toHaveLength(1);
    resolveSend?.();
    await firstSubmit;
  });

  it('preserves edited text when an ack arrives after the user kept typing', async () => {
    const { store, client } = createTestStore({ requestId: () => 'req-2' });
    connect(store, client);
    store.getState().selectSession('s1');
    store.getState().setDraft('hello');
    await store.getState().submitDraft();
    const request = client.sent.at(-1) as Extract<MobileClientMessage, { type: 'session.submit' }>;
    store.getState().setDraft('hello, more');
    store.getState().receive({
      type: 'session.submit.result',
      sid: 's1',
      requestId: request.requestId,
      ok: true,
    });
    expect(store.getState().drafts.s1).toBe('hello, more');
    expect(store.getState().pendingSubmission).toBeNull();
  });

  it('keeps the draft and records an explicit error on a negative result', async () => {
    const { store, client } = createTestStore({ requestId: () => 'req-3' });
    connect(store, client);
    store.getState().selectSession('s1');
    store.getState().setDraft('hello');
    await store.getState().submitDraft();
    const request = client.sent.at(-1) as Extract<MobileClientMessage, { type: 'session.submit' }>;
    store.getState().receive({
      type: 'session.submit.result',
      sid: 's1',
      requestId: request.requestId,
      ok: false,
      error: 'session_not_found',
    });
    expect(store.getState().drafts.s1).toBe('hello');
    expect(store.getState().pendingSubmission).toBeNull();
    expect(store.getState().submissionError).toBe('session_not_found');
  });

  it('ignores a stale or mismatched submit result without clearing another pending request', async () => {
    const { store, client } = createTestStore({ requestId: () => 'req-4' });
    connect(store, client);
    store.getState().selectSession('s1');
    store.getState().setDraft('hello');
    await store.getState().submitDraft();

    store.getState().receive({
      type: 'session.submit.result',
      sid: 's1',
      requestId: 'some-other-request',
      ok: true,
    });
    expect(store.getState().drafts.s1).toBe('hello');
    expect(store.getState().pendingSubmission).not.toBeNull();

    store.getState().receive({
      type: 'session.submit.result',
      sid: 's2',
      requestId: 'req-4',
      ok: true,
    });
    expect(store.getState().drafts.s1).toBe('hello');
    expect(store.getState().pendingSubmission).not.toBeNull();
    void client;
  });

  it('clears pending submission but keeps drafts when the connection drops', async () => {
    let resolveSend: (() => void) | undefined;
    const client = createFakeClient();
    client.send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const store = createMobileRemoteStore(client);
    client.emitStatus('connected');
    store.getState().selectSession('s1');
    store.getState().setDraft('unsent');
    const pending = store.getState().submitDraft();
    expect(store.getState().pendingSubmission).not.toBeNull();

    client.emitStatus('reconnecting');
    expect(store.getState().pendingSubmission).toBeNull();
    expect(store.getState().drafts.s1).toBe('unsent');

    resolveSend?.();
    await pending;
  });

  it('replaces the navigator, retaining the current selection if still present', () => {
    const { store, client } = createTestStore();
    connect(store, client);
    store.getState().selectSession('s1');
    const model = navigatorModel({ activeSessionId: 's2' });
    store.getState().receive({
      type: 'sessions.navigator',
      version: 1,
      model,
    });
    expect(store.getState().selectedSessionId).toBe('s1');
    expect(store.getState().navigator).toEqual(model);
  });

  it('falls back to the navigator active session when the selection is gone', () => {
    const { store, client } = createTestStore();
    connect(store, client);
    store.getState().selectSession('gone');
    const model = navigatorModel({ activeSessionId: 's2' });
    store.getState().receive({ type: 'sessions.navigator', version: 1, model });
    expect(store.getState().selectedSessionId).toBe('s2');
    expect(store.getState().exitedSessionId).toBe('gone');
  });

  it('falls back to the first session by group then session order with no active id', () => {
    const { store, client } = createTestStore();
    connect(store, client);
    store.getState().selectSession('gone');
    const model = navigatorModel({ activeSessionId: null });
    store.getState().receive({ type: 'sessions.navigator', version: 1, model });
    expect(store.getState().selectedSessionId).toBe('s1');
  });

  it('selects null and goes idle when there are no sessions', () => {
    const { store, client } = createTestStore();
    connect(store, client);
    store.getState().selectSession('gone');
    store.getState().receive({
      type: 'sessions.navigator',
      version: 1,
      model: { groups: [], activeSessionId: null },
    });
    expect(store.getState().selectedSessionId).toBeNull();
    expect(store.getState().terminalSync.phase).toBe('idle');
  });

  it('begins terminal sync, sends exactly one snapshot request, and closes the drawer on selection', () => {
    const { store, client } = createTestStore();
    store.getState().setDrawerOpen(true);
    store.getState().selectSession('s1');
    expect(store.getState().terminalSync.sid).toBe('s1');
    expect(store.getState().terminalSync.phase).toBe('syncing');
    expect(store.getState().drawerOpen).toBe(false);
    expect(
      client.sent.filter(
        (message) => message.type === 'session.snapshot' && message.sid === 's1',
      ),
    ).toHaveLength(1);
  });

  it('applies a snapshot as a single numbered render batch and clears only on matching consume', () => {
    const { store, client } = createTestStore();
    store.getState().selectSession('s1');
    store.getState().receive({
      type: 'session.snapshot',
      sid: 's1',
      seq: 0,
      data: 'screen',
      cols: 80,
      rows: 24,
    });
    const batch = store.getState().terminalBatch;
    expect(batch).toEqual({ id: expect.any(Number), effects: [{ type: 'reset', data: 'screen' }] });

    store.getState().consumeTerminalBatch(batch!.id - 1);
    expect(store.getState().terminalBatch).toEqual(batch);

    store.getState().consumeTerminalBatch(batch!.id);
    expect(store.getState().terminalBatch).toBeNull();
    void client;
  });

  it('merges effects into a new monotonically increasing batch id when the prior one is unconsumed', () => {
    const { store } = createTestStore();
    store.getState().selectSession('s1');
    store.getState().receive({
      type: 'session.snapshot',
      sid: 's1',
      seq: 0,
      data: 'first',
      cols: 80,
      rows: 24,
    });
    const first = store.getState().terminalBatch!;
    store.getState().receive({ type: 'pty.data', sid: 's1', seq: 1, chunk: 'more' });
    const second = store.getState().terminalBatch!;
    expect(second.id).toBeGreaterThan(first.id);
    expect(second.effects).toEqual([
      { type: 'reset', data: 'first' },
      { type: 'write', data: 'more' },
    ]);
  });

  it('never applies the same batch id twice', () => {
    const { store } = createTestStore();
    store.getState().selectSession('s1');
    store.getState().receive({
      type: 'session.snapshot',
      sid: 's1',
      seq: 0,
      data: 'screen',
      cols: 80,
      rows: 24,
    });
    const batch = store.getState().terminalBatch!;
    store.getState().consumeTerminalBatch(batch.id);
    store.getState().consumeTerminalBatch(batch.id);
    expect(store.getState().terminalBatch).toBeNull();
  });

  it('immediately re-requests a snapshot through the relay when a gap is detected', () => {
    const { store, client } = createTestStore();
    store.getState().selectSession('s1');
    // Resolve the initial sync so the state machine is live before probing
    // gap detection: while a snapshot is already outstanding it deliberately
    // suppresses a second request (see terminalSync.ts) to avoid a storm.
    store.getState().receive({
      type: 'session.snapshot',
      sid: 's1',
      seq: 0,
      data: 'screen',
      cols: 80,
      rows: 24,
    });
    client.sent.length = 0;
    store.getState().receive({ type: 'pty.data', sid: 's1', seq: 5, chunk: 'later' });
    expect(
      client.sent.filter((message) => message.type === 'session.snapshot' && message.sid === 's1'),
    ).toHaveLength(1);
  });

  it('sends unsafe immediate input for the selected session only when enabled, without touching drafts', () => {
    const { store, client } = createTestStore();
    store.getState().selectSession('s1');
    store.getState().setDraft('untouched');
    store.getState().sendControl('\x03');
    expect(client.sent.filter((message) => message.type === 'session.input')).toHaveLength(0);

    connect(store, client);
    store.getState().sendControl('\x03');
    expect(client.sent).toContainEqual({ type: 'session.input', sid: 's1', data: '\x03' });
    expect(store.getState().drafts.s1).toBe('untouched');
    expect(store.getState().pendingSubmission).toBeNull();
  });

  it('derives inputEnabled and retryMode from the connection contract', () => {
    const { store, client } = createTestStore();
    store.getState().selectSession('s1');
    expect(store.getState().inputEnabled).toBe(false);

    client.emitStatus('connected');
    expect(store.getState().inputEnabled).toBe(true);
    expect(store.getState().retryMode).toBe('automatic');

    client.emitStatus('reconnecting');
    expect(store.getState().inputEnabled).toBe(false);
    expect(store.getState().retryMode).toBe('automatic');

    client.emitStatus('connection_error');
    expect(store.getState().retryMode).toBe('manual');

    client.emitStatus('authentication_failed');
    expect(store.getState().retryMode).toBe('blocked');

    client.emitStatus('update_required');
    expect(store.getState().retryMode).toBe('blocked');
  });

  it('delegates retry to the relay client only in manual mode', () => {
    const { store, client } = createTestStore();
    client.emitStatus('authentication_failed');
    store.getState().retry();
    expect(client.retryCalls).toBe(0);

    client.emitStatus('connection_error');
    store.getState().retry();
    expect(client.retryCalls).toBe(1);

    client.emitStatus('reconnecting');
    store.getState().retry();
    expect(client.retryCalls).toBe(1);
  });

  it('subscribes to relay messages and statuses at creation and can dispose cleanly', () => {
    const client = createFakeClient();
    const store = createMobileRemoteStore(client);
    store.getState().selectSession('s1');
    client.emitMessage({
      type: 'session.snapshot',
      sid: 's1',
      seq: 0,
      data: 'via-message',
      cols: 80,
      rows: 24,
    });
    expect(store.getState().terminalBatch?.effects).toEqual([
      { type: 'reset', data: 'via-message' },
    ]);
    expect(() => store.getState().dispose()).not.toThrow();
  });
});
