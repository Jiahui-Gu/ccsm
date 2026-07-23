import { describe, expect, it, vi } from 'vitest';

import { createMobileRemoteStore, deriveSubmissionError } from '../../src/mobile/mobileRemoteStore';
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
    message.type === 'session.snapshot'
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
    expect(store.getState().pendingSubmissions.s1).toBeUndefined();
    expect(store.getState().submissionErrors.s1).toBeUndefined();
  });

  it('preserves a rejected draft and never queues it for reconnect', async () => {
    const { store, client } = createTestStore({ sendError: new Error('connection_changed') });
    connect(store, client);
    store.getState().selectSession('s1');
    store.getState().setDraft('keep me');
    await store.getState().submitDraft();
    expect(store.getState().drafts.s1).toBe('keep me');
    expect(store.getState().submissionErrors.s1).toBe('connection_changed');
    expect(store.getState().pendingSubmissions.s1).toBeUndefined();
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
    expect(store.getState().pendingSubmissions.s1).toBeUndefined();
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
    expect(store.getState().pendingSubmissions.s1).toBeUndefined();
    expect(store.getState().submissionErrors.s1).toBe('session_not_found');
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
    expect(store.getState().pendingSubmissions.s1).not.toBeUndefined();

    store.getState().receive({
      type: 'session.submit.result',
      sid: 's2',
      requestId: 'req-4',
      ok: true,
    });
    expect(store.getState().drafts.s1).toBe('hello');
    expect(store.getState().pendingSubmissions.s1).not.toBeUndefined();
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
    expect(store.getState().pendingSubmissions.s1).not.toBeUndefined();

    client.emitStatus('reconnecting');
    expect(store.getState().pendingSubmissions).toEqual({});
    expect(store.getState().drafts.s1).toBe('unsent');

    resolveSend?.();
    await pending;
  });

  it('ignores a stale submit rejection that arrives after a disconnect already cleared pending', async () => {
    let rejectSend: ((error: unknown) => void) | undefined;
    const client = createFakeClient();
    client.send = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    const store = createMobileRemoteStore(client);
    client.emitStatus('connected');
    store.getState().selectSession('s1');
    store.getState().setDraft('keep me');
    const submission = store.getState().submitDraft();
    expect(store.getState().pendingSubmissions.s1).not.toBeUndefined();

    // Disconnect clears the pending submission (existing contract) before
    // the deferred send() ever settles.
    client.emitStatus('reconnecting');
    expect(store.getState().pendingSubmissions).toEqual({});

    rejectSend?.(new Error('connection_changed'));
    await submission;

    expect(store.getState().submissionErrors.s1).toBeUndefined();
    expect(store.getState().pendingSubmissions).toEqual({});
    expect(store.getState().drafts.s1).toBe('keep me');
  });

  it('does not let a stale rejection from an old request clobber a newer pending submission', async () => {
    const rejectors: Array<(error: unknown) => void> = [];
    const client = createFakeClient();
    client.send = vi.fn((message: MobileClientMessage) => {
      // Only session.submit sends are deferred here; selectSession's
      // fire-and-forget session.snapshot recovery request must not shift the
      // rejectors indices below.
      if (message.type !== 'session.submit') return Promise.resolve();
      return new Promise<void>((_resolve, reject) => {
        rejectors.push(reject);
      });
    });
    let requestSequence = 0;
    const store = createMobileRemoteStore(client, {
      requestId: () => `req-${(requestSequence += 1)}`,
    });
    client.emitStatus('connected');
    store.getState().selectSession('s1');
    store.getState().setDraft('first');
    const firstSubmit = store.getState().submitDraft();
    const firstPending = store.getState().pendingSubmissions.s1;
    expect(firstPending?.requestId).toBe('req-1');

    // The first request's send() never settles here; the connection drops
    // and recovers, clearing it, and a second submission takes its place.
    client.emitStatus('reconnecting');
    client.emitStatus('connected');
    store.getState().setDraft('second');
    const secondSubmit = store.getState().submitDraft();
    const secondPending = store.getState().pendingSubmissions.s1;
    expect(secondPending?.requestId).toBe('req-2');

    // The stale first request rejects only now, well after the newer pending
    // submission has taken its place.
    rejectors[0]?.(new Error('connection_changed'));
    await firstSubmit;

    expect(store.getState().pendingSubmissions.s1).toEqual(secondPending);
    expect(store.getState().submissionErrors.s1).toBeUndefined();

    rejectors[1]?.(new Error('later_failure'));
    await secondSubmit;
    expect(store.getState().submissionErrors.s1).toBe('later_failure');
    expect(store.getState().pendingSubmissions.s1).toBeUndefined();
  });

  // Review issue 2: `pendingSubmission` must never be a single global slot.
  // Two live sessions can each have their own unacknowledged submission at
  // once; one sid's gating, draft-clearing, and correlation must never leak
  // into another sid's.
  describe('per-session pending submissions (review issue 2)', () => {
    it('lets a newly selected session submit while an older session still has an unacknowledged submission', async () => {
      let requestSequence = 0;
      const { store, client } = createTestStore({ requestId: () => `req-${(requestSequence += 1)}` });
      connect(store, client);

      store.getState().selectSession('s1');
      store.getState().setDraft('from s1');
      await store.getState().submitDraft(); // unacknowledged for the rest of this test

      store.getState().selectSession('s2');
      store.getState().setDraft('from s2');
      await store.getState().submitDraft();

      const submitMessages = client.sent.filter(
        (message): message is Extract<MobileClientMessage, { type: 'session.submit' }> =>
          message.type === 'session.submit',
      );
      // A singleton `pendingSubmission` guard blocks ANY session from
      // submitting while another session's submission is unacknowledged, so
      // only s1's request would ever be sent here.
      expect(submitMessages).toHaveLength(2);
      expect(submitMessages[0]).toMatchObject({ sid: 's1', draft: 'from s1' });
      expect(submitMessages[1]).toMatchObject({ sid: 's2', draft: 'from s2' });
      expect(submitMessages[0]?.requestId).not.toBe(submitMessages[1]?.requestId);
    });

    it("acknowledges each session's submission independently — one sid's ack never clears or overwrites another sid's pending submission", async () => {
      let requestSequence = 0;
      const { store, client } = createTestStore({ requestId: () => `req-${(requestSequence += 1)}` });
      connect(store, client);

      store.getState().selectSession('s1');
      store.getState().setDraft('from s1');
      await store.getState().submitDraft();
      const s1Submit = client.sent.find(
        (message): message is Extract<MobileClientMessage, { type: 'session.submit' }> =>
          message.type === 'session.submit' && message.sid === 's1',
      )!;

      store.getState().selectSession('s2');
      store.getState().setDraft('from s2');
      await store.getState().submitDraft();
      const s2Submit = client.sent.find(
        (message): message is Extract<MobileClientMessage, { type: 'session.submit' }> =>
          message.type === 'session.submit' && message.sid === 's2',
      );
      // Fails under the unfixed singleton guard: s2's submission above is
      // silently dropped because s1 is still unacknowledged.
      expect(s2Submit).toBeDefined();

      // A crossed/forged ack (s1's sid paired with s2's requestId) must
      // never clear or overwrite either session's state.
      store.getState().receive({
        type: 'session.submit.result',
        sid: 's1',
        requestId: s2Submit!.requestId,
        ok: true,
      });
      expect(store.getState().drafts.s1).toBe('from s1');
      expect(store.getState().pendingSubmissions.s1).toMatchObject({ requestId: s1Submit.requestId });
      expect(store.getState().pendingSubmissions.s2).toMatchObject({ requestId: s2Submit!.requestId });

      // Acknowledge s2 for real — only s2's unchanged draft/pending entry clears.
      store.getState().receive({
        type: 'session.submit.result',
        sid: 's2',
        requestId: s2Submit!.requestId,
        ok: true,
      });
      expect(store.getState().drafts.s2).toBe('');
      expect(store.getState().pendingSubmissions.s2).toBeUndefined();
      expect(store.getState().drafts.s1).toBe('from s1'); // s1 still untouched
      expect(store.getState().pendingSubmissions.s1).toMatchObject({ requestId: s1Submit.requestId });

      // Acknowledge s1 independently afterward.
      store.getState().receive({ type: 'session.submit.result', sid: 's1', requestId: s1Submit.requestId, ok: true });
      expect(store.getState().drafts.s1).toBe('');
      expect(store.getState().pendingSubmissions.s1).toBeUndefined();
    });

    it("keeps newer text typed after sending when that session's own ack arrives, even while a different session has its own unacknowledged submission", async () => {
      let requestSequence = 0;
      const { store, client } = createTestStore({ requestId: () => `req-${(requestSequence += 1)}` });
      connect(store, client);

      store.getState().selectSession('s1');
      store.getState().setDraft('from s1');
      await store.getState().submitDraft(); // s1 stays unacknowledged for the whole test

      store.getState().selectSession('s2');
      store.getState().setDraft('from s2');
      await store.getState().submitDraft();
      const s2Submit = client.sent.find(
        (message): message is Extract<MobileClientMessage, { type: 'session.submit' }> =>
          message.type === 'session.submit' && message.sid === 's2',
      );
      expect(s2Submit).toBeDefined(); // same singleton-guard failure as the tests above

      // The user keeps typing on s2 after Send, before its ack arrives.
      store.getState().setDraft('from s2, more');
      store.getState().receive({
        type: 'session.submit.result',
        sid: 's2',
        requestId: s2Submit!.requestId,
        ok: true,
      });

      expect(store.getState().drafts.s2).toBe('from s2, more'); // never clobbered by the stale ack
      expect(store.getState().pendingSubmissions.s2).toBeUndefined();
      expect(store.getState().drafts.s1).toBe('from s1'); // untouched throughout
    });

    it("clears every session's pending submission on connection loss while preserving every session's draft", async () => {
      const resolvers: Array<() => void> = [];
      const client = createFakeClient();
      client.send = vi.fn((message: MobileClientMessage) => {
        client.sent.push(message);
        if (message.type !== 'session.submit') return Promise.resolve();
        return new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
      });
      let requestSequence = 0;
      const store = createMobileRemoteStore(client, {
        requestId: () => `req-${(requestSequence += 1)}`,
      });
      client.emitStatus('connected');

      store.getState().selectSession('s1');
      store.getState().setDraft('s1 unsent');
      const s1First = store.getState().submitDraft();

      store.getState().selectSession('s2');
      store.getState().setDraft('s2 unsent');
      const s2First = store.getState().submitDraft();

      client.emitStatus('reconnecting');
      client.emitStatus('connected');

      expect(store.getState().drafts.s1).toBe('s1 unsent');
      expect(store.getState().drafts.s2).toBe('s2 unsent');
      expect(store.getState().pendingSubmissions).toEqual({});

      // Each session must be independently resubmittable once its pending
      // request was cleared by the disconnect — under the unfixed singleton
      // guard, s2's submission is never sent above (blocked by s1), so it
      // stays permanently blocked here too once s1's second attempt takes
      // the single slot.
      store.getState().selectSession('s1');
      const s1Second = store.getState().submitDraft();
      store.getState().selectSession('s2');
      const s2Second = store.getState().submitDraft();

      const submitMessages = client.sent.filter(
        (message): message is Extract<MobileClientMessage, { type: 'session.submit' }> =>
          message.type === 'session.submit',
      );
      expect(submitMessages.filter((message) => message.sid === 's1')).toHaveLength(2);
      expect(submitMessages.filter((message) => message.sid === 's2')).toHaveLength(2);

      resolvers.forEach((resolve) => resolve());
      await Promise.all([s1First, s2First, s1Second, s2Second]);
    });
  });

  // Follow-up A: `submissionError` remained a single global slot even after
  // `pendingSubmissions` (review issue 2, above) was scoped per sid. A
  // rejected submission for one session leaked into every other session's
  // derived error — including a session that never submitted anything and
  // was not even selected when the rejection arrived.
  describe('per-session submission errors (follow-up A)', () => {
    async function submitAndReject(
      store: ReturnType<typeof createMobileRemoteStore>,
      client: FakeRelayClient,
      sid: string,
      draft: string,
      error: string,
    ): Promise<void> {
      store.getState().selectSession(sid);
      store.getState().setDraft(draft);
      await store.getState().submitDraft();
      const submit = client.sent
        .filter(
          (message): message is Extract<MobileClientMessage, { type: 'session.submit' }> =>
            message.type === 'session.submit' && message.sid === sid,
        )
        .at(-1)!;
      store.getState().receive({
        type: 'session.submit.result',
        sid,
        requestId: submit.requestId,
        ok: false,
        error,
      });
    }

    it("does not attribute session A's rejected submission to session B, even once B is selected", async () => {
      const { store, client } = createTestStore();
      connect(store, client);

      store.getState().selectSession('s1');
      store.getState().setDraft('from s1');
      await store.getState().submitDraft(); // sent, unacknowledged
      const s1Submit = client.sent
        .filter(
          (message): message is Extract<MobileClientMessage, { type: 'session.submit' }> =>
            message.type === 'session.submit',
        )
        .at(-1)!;

      // Switch away from s1 before its rejection ever arrives.
      store.getState().selectSession('s2');

      store.getState().receive({
        type: 'session.submit.result',
        sid: 's1',
        requestId: s1Submit.requestId,
        ok: false,
        error: 'alpha_rejected',
      });

      // s2 never submitted anything and must never observe s1's error
      // through the selected-session derivation.
      expect(deriveSubmissionError('s2', store.getState().submissionErrors)).toBeNull();
      // s1's own error is still tracked even while a different sid is selected.
      expect(store.getState().submissionErrors.s1).toBe('alpha_rejected');

      // Switching back to s1 must render its own error again.
      store.getState().selectSession('s1');
      expect(deriveSubmissionError('s1', store.getState().submissionErrors)).toBe('alpha_rejected');
    });

    it("clears only the edited session's error, leaving a different session's own error untouched", async () => {
      const { store, client } = createTestStore();
      connect(store, client);
      await submitAndReject(store, client, 's1', 'from s1', 'alpha_rejected');
      await submitAndReject(store, client, 's2', 'from s2', 'beta_rejected');
      expect(store.getState().submissionErrors).toEqual({ s1: 'alpha_rejected', s2: 'beta_rejected' });

      store.getState().selectSession('s1');
      store.getState().setDraft('from s1, edited');
      expect(deriveSubmissionError('s1', store.getState().submissionErrors)).toBeNull();
      expect(deriveSubmissionError('s2', store.getState().submissionErrors)).toBe('beta_rejected');
    });

    it("resubmitting a session clears only that session's own prior error", async () => {
      const { store, client } = createTestStore();
      connect(store, client);
      await submitAndReject(store, client, 's1', 'from s1', 'alpha_rejected');
      await submitAndReject(store, client, 's2', 'from s2', 'beta_rejected');

      store.getState().selectSession('s1');
      expect(store.getState().submissionErrors.s1).toBe('alpha_rejected');
      await store.getState().submitDraft(); // resubmits the preserved draft, no edit
      expect(deriveSubmissionError('s1', store.getState().submissionErrors)).toBeNull();
      expect(deriveSubmissionError('s2', store.getState().submissionErrors)).toBe('beta_rejected');
    });

    it('keeps two different sessions independently rejected at the same time, each attributable only to its own sid', async () => {
      const { store, client } = createTestStore();
      connect(store, client);
      await submitAndReject(store, client, 's1', 'from s1', 'alpha_rejected');
      await submitAndReject(store, client, 's2', 'from s2', 'beta_rejected');

      expect(store.getState().submissionErrors).toEqual({ s1: 'alpha_rejected', s2: 'beta_rejected' });
      expect(deriveSubmissionError('s1', store.getState().submissionErrors)).toBe('alpha_rejected');
      expect(deriveSubmissionError('s2', store.getState().submissionErrors)).toBe('beta_rejected');
    });

    it("preserves a session's visible submission error across a connection drop and reconnect (existing semantics, unchanged)", async () => {
      const { store, client } = createTestStore();
      connect(store, client);
      await submitAndReject(store, client, 's1', 'from s1', 'alpha_rejected');
      expect(store.getState().submissionErrors.s1).toBe('alpha_rejected');

      client.emitStatus('reconnecting');
      client.emitStatus('connected');

      expect(store.getState().submissionErrors.s1).toBe('alpha_rejected');
    });
  });

  // Follow-up B: the authoritative navigator is this store's own source of
  // truth for which sids are still live (`collectLiveSessionIds`,
  // `resolveSelection`), but `applyNavigator` never reconciled
  // `pendingSubmissions` against it — only a full connection drop
  // (`offStatus`) ever cleared an entry, and that clears every sid
  // indiscriminately rather than the one sid the navigator just dropped. A
  // session's own unacknowledged `session.submit` therefore outlived that
  // session's removal/exit from the navigator with no bound at all, and a
  // late/stale `session.submit.result` that still happened to arrive for the
  // already-gone sid would pass `applySubmitResult`'s requestId+sid guard
  // unopposed and could clear that removed session's own retained draft —
  // state for a session the navigator has already disavowed and the user
  // can no longer act on.
  describe('pruning pending submissions on navigator removal (follow-up B)', () => {
    function liveModel(): SessionNavigatorModel {
      return navigatorModel({
        activeSessionId: null,
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
      });
    }

    // s1 is entirely absent (e.g. deleted/archived on the desktop), not
    // merely marked exited. Production actually produces this shape —
    // `buildSessionNavigatorModel` drops non-live sids outright rather than
    // ever emitting `state: 'exited'` — but the type still allows the other
    // shape below, which the store must treat identically.
    function removedModel(): SessionNavigatorModel {
      return navigatorModel({
        activeSessionId: null,
        groups: [
          {
            id: 'g1',
            name: 'Group 1',
            order: 0,
            collapsed: false,
            sessions: [{ id: 's2', name: 's2', cwd: '/repo', state: 'idle', order: 0 }],
          },
        ],
      });
    }

    // s1 is still listed but flagged exited — the other "removed" shape
    // `collectLiveSessionIds` recognizes; there is no separate
    // `session.exited` protocol message (see `MobileServerMessage`), only
    // this per-session `state` field carried inside `sessions.navigator`.
    function exitedModel(): SessionNavigatorModel {
      return navigatorModel({
        activeSessionId: null,
        groups: [
          {
            id: 'g1',
            name: 'Group 1',
            order: 0,
            collapsed: false,
            sessions: [
              { id: 's1', name: 's1', cwd: '/repo', state: 'exited', order: 0 },
              { id: 's2', name: 's2', cwd: '/repo', state: 'idle', order: 1 },
            ],
          },
        ],
      });
    }

    it("prunes a removed session's pending submission when the removal also changes the current selection, leaving a still-live session's own pending submission and every draft untouched", async () => {
      let requestSequence = 0;
      const { store, client } = createTestStore({ requestId: () => `req-${(requestSequence += 1)}` });
      connect(store, client);
      store.getState().receive({ type: 'sessions.navigator', version: 1, model: liveModel() });

      store.getState().selectSession('s1');
      store.getState().setDraft('from s1');
      await store.getState().submitDraft(); // s1 stays unacknowledged for the whole test

      store.getState().selectSession('s2');
      store.getState().setDraft('from s2');
      await store.getState().submitDraft(); // s2 stays unacknowledged too
      store.getState().selectSession('s1'); // s1 is selected again when its removal arrives

      const s2Pending = store.getState().pendingSubmissions.s2;
      expect(store.getState().pendingSubmissions.s1).toBeDefined();
      expect(s2Pending).toBeDefined();

      // The authoritative navigator now says s1 no longer exists at all;
      // selection must move off it since it was the current selection.
      store.getState().receive({ type: 'sessions.navigator', version: 1, model: removedModel() });

      expect(store.getState().selectedSessionId).toBe('s2');
      expect(store.getState().pendingSubmissions.s1).toBeUndefined();
      expect(store.getState().pendingSubmissions.s2).toEqual(s2Pending);
      expect(store.getState().drafts).toEqual({ s1: 'from s1', s2: 'from s2' });
    });

    it("prunes a session's pending submission when the navigator still lists it but flags it exited, not only when it is fully absent", async () => {
      const { store, client } = createTestStore();
      connect(store, client);
      store.getState().receive({ type: 'sessions.navigator', version: 1, model: liveModel() });

      store.getState().selectSession('s1');
      store.getState().setDraft('from s1');
      await store.getState().submitDraft();
      expect(store.getState().pendingSubmissions.s1).toBeDefined();

      store.getState().receive({ type: 'sessions.navigator', version: 1, model: exitedModel() });

      expect(store.getState().pendingSubmissions.s1).toBeUndefined();
      expect(store.getState().drafts.s1).toBe('from s1');
    });

    it("prunes a non-selected session's pending submission even on a routine navigator refresh that keeps the current selection", async () => {
      const { store, client } = createTestStore();
      connect(store, client);
      store.getState().receive({ type: 'sessions.navigator', version: 1, model: liveModel() });

      store.getState().selectSession('s1');
      store.getState().setDraft('from s1');
      await store.getState().submitDraft(); // s1 unacknowledged, then the user moves on

      store.getState().selectSession('s2'); // s2 is selected when the removal arrives
      expect(store.getState().pendingSubmissions.s1).toBeDefined();

      // s2 stays selected and stays live, so this hits the "selection
      // retained" refresh branch, not a selection-change branch — yet s1's
      // now-stale correlation must still be pruned.
      store.getState().receive({ type: 'sessions.navigator', version: 1, model: removedModel() });

      expect(store.getState().selectedSessionId).toBe('s2');
      expect(store.getState().pendingSubmissions.s1).toBeUndefined();
    });

    it("prunes the sole session's pending submission when it exits and no live sessions remain", async () => {
      const { store, client } = createTestStore();
      connect(store, client);
      store.getState().receive({
        type: 'sessions.navigator',
        version: 1,
        model: navigatorModel({
          activeSessionId: null,
          groups: [
            {
              id: 'g1',
              name: 'Group 1',
              order: 0,
              collapsed: false,
              sessions: [{ id: 's1', name: 's1', cwd: '/repo', state: 'idle', order: 0 }],
            },
          ],
        }),
      });

      store.getState().selectSession('s1');
      store.getState().setDraft('from s1');
      await store.getState().submitDraft();
      expect(store.getState().pendingSubmissions.s1).toBeDefined();

      store.getState().receive({
        type: 'sessions.navigator',
        version: 1,
        model: {
          groups: [
            {
              id: 'g1',
              name: 'Group 1',
              order: 0,
              collapsed: false,
              sessions: [{ id: 's1', name: 's1', cwd: '/repo', state: 'exited', order: 0 }],
            },
          ],
          activeSessionId: null,
        },
      });

      expect(store.getState().selectedSessionId).toBeNull();
      expect(store.getState().pendingSubmissions.s1).toBeUndefined();
      expect(store.getState().drafts.s1).toBe('from s1');
    });

    it('makes a stale session.submit.result for an already-pruned session inert: it cannot resurrect its pending entry, clear its retained draft, or touch a different, still-live session', async () => {
      let requestSequence = 0;
      const { store, client } = createTestStore({ requestId: () => `req-${(requestSequence += 1)}` });
      connect(store, client);
      store.getState().receive({ type: 'sessions.navigator', version: 1, model: liveModel() });

      store.getState().selectSession('s1');
      store.getState().setDraft('from s1');
      await store.getState().submitDraft();
      const s1Submit = client.sent
        .filter(
          (message): message is Extract<MobileClientMessage, { type: 'session.submit' }> =>
            message.type === 'session.submit' && message.sid === 's1',
        )
        .at(-1)!;

      store.getState().selectSession('s2');
      store.getState().setDraft('from s2');
      await store.getState().submitDraft();
      const s2Submit = client.sent
        .filter(
          (message): message is Extract<MobileClientMessage, { type: 'session.submit' }> =>
            message.type === 'session.submit' && message.sid === 's2',
        )
        .at(-1)!;

      store.getState().receive({ type: 'sessions.navigator', version: 1, model: removedModel() });
      expect(store.getState().pendingSubmissions.s1).toBeUndefined();

      // The desktop's ack for s1's original submission finally arrives —
      // late, after s1 is already gone from the navigator.
      store.getState().receive({
        type: 'session.submit.result',
        sid: 's1',
        requestId: s1Submit.requestId,
        ok: true,
      });

      expect(store.getState().pendingSubmissions.s1).toBeUndefined();
      expect(store.getState().drafts.s1).toBe('from s1'); // never cleared by the stale ack
      expect(store.getState().drafts.s2).toBe('from s2');
      expect(store.getState().pendingSubmissions.s2).toMatchObject({ requestId: s2Submit.requestId });

      // A stale late rejection for the same gone sid must be equally inert.
      store.getState().receive({
        type: 'session.submit.result',
        sid: 's1',
        requestId: s1Submit.requestId,
        ok: false,
        error: 'session_not_found',
      });
      expect(store.getState().submissionErrors.s1).toBeUndefined();
      expect(store.getState().drafts.s1).toBe('from s1');
      expect(store.getState().pendingSubmissions.s2).toMatchObject({ requestId: s2Submit.requestId });
    });

    it("leaves a removed session's own prior submissionErrors entry alone, consistent with follow-up A's survives-navigation design", async () => {
      const { store, client } = createTestStore();
      connect(store, client);
      store.getState().receive({ type: 'sessions.navigator', version: 1, model: liveModel() });

      store.getState().selectSession('s1');
      store.getState().setDraft('from s1');
      await store.getState().submitDraft();
      const s1Submit = client.sent
        .filter(
          (message): message is Extract<MobileClientMessage, { type: 'session.submit' }> =>
            message.type === 'session.submit' && message.sid === 's1',
        )
        .at(-1)!;
      store.getState().receive({
        type: 'session.submit.result',
        sid: 's1',
        requestId: s1Submit.requestId,
        ok: false,
        error: 'alpha_rejected',
      });
      expect(store.getState().submissionErrors.s1).toBe('alpha_rejected');

      store.getState().receive({ type: 'sessions.navigator', version: 1, model: removedModel() });

      // Follow-up A made submissionErrors sticky across reconnects; this
      // fix only prunes pendingSubmissions, so navigator reconciliation
      // must not start pruning submissionErrors either.
      expect(store.getState().submissionErrors.s1).toBe('alpha_rejected');
    });
  });

  it('does not select an exited session when resolving navigator selection', () => {
    const { store, client } = createTestStore();
    connect(store, client);
    const model = navigatorModel({
      activeSessionId: 's1',
      groups: [
        {
          id: 'g1',
          name: 'Group 1',
          order: 0,
          collapsed: false,
          sessions: [
            { id: 's1', name: 's1', cwd: '/repo', state: 'exited', order: 0 },
            { id: 's2', name: 's2', cwd: '/repo', state: 'idle', order: 1 },
          ],
        },
      ],
    });
    store.getState().receive({ type: 'sessions.navigator', version: 1, model });
    expect(store.getState().selectedSessionId).toBe('s2');
  });

  it('falls back to a non-exited session and disables input when the current selection exits', () => {
    const { store, client } = createTestStore();
    connect(store, client);
    store.getState().selectSession('s1');
    expect(store.getState().inputEnabled).toBe(true);

    const model = navigatorModel({
      activeSessionId: null,
      groups: [
        {
          id: 'g1',
          name: 'Group 1',
          order: 0,
          collapsed: false,
          sessions: [
            { id: 's1', name: 's1', cwd: '/repo', state: 'exited', order: 0 },
            { id: 's2', name: 's2', cwd: '/repo', state: 'idle', order: 1 },
          ],
        },
      ],
    });
    store.getState().receive({ type: 'sessions.navigator', version: 1, model });

    expect(store.getState().selectedSessionId).toBe('s2');
    expect(store.getState().exitedSessionId).toBe('s1');
    expect(store.getState().inputEnabled).toBe(true);
  });

  it('clears the selection and disables input when the only session exits with no live sessions left', () => {
    const { store, client } = createTestStore();
    connect(store, client);
    store.getState().selectSession('s1');

    const model: SessionNavigatorModel = {
      groups: [
        {
          id: 'g1',
          name: 'Group 1',
          order: 0,
          collapsed: false,
          sessions: [{ id: 's1', name: 's1', cwd: '/repo', state: 'exited', order: 0 }],
        },
      ],
      activeSessionId: null,
    };
    store.getState().receive({ type: 'sessions.navigator', version: 1, model });

    expect(store.getState().selectedSessionId).toBeNull();
    expect(store.getState().exitedSessionId).toBe('s1');
    expect(store.getState().inputEnabled).toBe(false);
  });

  it('disables input and blocks input/submit sends when selecting a session marked exited in the navigator', async () => {
    const { store, client } = createTestStore();
    connect(store, client);
    const model = navigatorModel({
      activeSessionId: null,
      groups: [
        {
          id: 'g1',
          name: 'Group 1',
          order: 0,
          collapsed: false,
          sessions: [
            { id: 's1', name: 's1', cwd: '/repo', state: 'exited', order: 0 },
            { id: 's2', name: 's2', cwd: '/repo', state: 'idle', order: 1 },
          ],
        },
      ],
    });
    store.getState().receive({ type: 'sessions.navigator', version: 1, model });

    // Force-select the exited sid directly (e.g. a stale UI affordance) to
    // prove the store itself gates it rather than relying on the caller
    // never offering it.
    store.getState().selectSession('s1');
    expect(store.getState().inputEnabled).toBe(false);

    store.getState().setDraft('nope');
    store.getState().sendControl('\x03');
    expect(client.sent.filter((message) => message.type === 'session.input')).toHaveLength(0);

    await store.getState().submitDraft();
    expect(client.sent.filter((message) => message.type === 'session.submit')).toHaveLength(0);
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
      snapshot: 'screen',
      geometry: { cols: 80, rows: 24, epoch: 0 },
    });
    const batch = store.getState().terminalBatch;
    expect(batch).toEqual({
      id: expect.any(Number),
      sid: 's1',
      effects: [{
        type: 'installSnapshot',
        sid: 's1',
        seq: 0,
        snapshot: 'screen',
        geometry: { cols: 80, rows: 24, epoch: 0 },
      }],
    });

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
      snapshot: 'first',
      geometry: { cols: 80, rows: 24, epoch: 0 },
    });
    const first = store.getState().terminalBatch!;
    store.getState().receive({
      type: 'pty.data',
      sid: 's1',
      seq: 1,
      chunk: 'more',
      geometryEpoch: 0,
    });
    const second = store.getState().terminalBatch!;
    expect(second.id).toBeGreaterThan(first.id);
    expect(second.sid).toBe('s1');
    expect(second.effects).toEqual([
      {
        type: 'installSnapshot',
        sid: 's1',
        seq: 0,
        snapshot: 'first',
        geometry: { cols: 80, rows: 24, epoch: 0 },
      },
      { type: 'write', sid: 's1', seq: 1, data: 'more' },
    ]);
  });

  it('replaces an unconsumed batch rather than merging effects across sessions', () => {
    const { store } = createTestStore();
    store.getState().selectSession('s2');
    store.setState({
      terminalBatch: {
        id: 40,
        sid: 's1',
        effects: [{
          type: 'write',
          sid: 's1',
          seq: 40,
          data: 'must-not-leak',
        }],
      },
    });

    store.getState().receive({
      type: 'session.snapshot',
      sid: 's2',
      seq: 0,
      snapshot: 'screen-s2',
      geometry: { cols: 100, rows: 30, epoch: 0 },
    });

    expect(store.getState().terminalBatch).toEqual({
      id: expect.any(Number),
      sid: 's2',
      effects: [{
        type: 'installSnapshot',
        sid: 's2',
        seq: 0,
        snapshot: 'screen-s2',
        geometry: { cols: 100, rows: 30, epoch: 0 },
      }],
    });
  });

  it('never applies the same batch id twice', () => {
    const { store } = createTestStore();
    store.getState().selectSession('s1');
    store.getState().receive({
      type: 'session.snapshot',
      sid: 's1',
      seq: 0,
      snapshot: 'screen',
      geometry: { cols: 80, rows: 24, epoch: 0 },
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
      snapshot: 'screen',
      geometry: { cols: 80, rows: 24, epoch: 0 },
    });
    client.sent.length = 0;
    store.getState().receive({
      type: 'pty.data',
      sid: 's1',
      seq: 5,
      chunk: 'later',
      geometryEpoch: 0,
    });
    store.getState().receive({
      type: 'pty.data',
      sid: 's1',
      seq: 6,
      chunk: 'still-later',
      geometryEpoch: 0,
    });
    expect(
      client.sent.filter((message) => message.type === 'session.snapshot' && message.sid === 's1'),
    ).toHaveLength(1);
  });

  it('publishes a barrier and its contiguous buffered tail as one atomic batch', () => {
    const { store, client } = createTestStore();
    store.getState().selectSession('s1');
    store.getState().receive({
      type: 'session.snapshot',
      sid: 's1',
      seq: 10,
      snapshot: 'old-screen',
      geometry: { cols: 80, rows: 24, epoch: 2 },
    });
    store.getState().consumeTerminalBatch(store.getState().terminalBatch!.id);
    client.sent.length = 0;
    store.getState().receive({
      type: 'pty.data',
      sid: 's1',
      seq: 12,
      chunk: 'tail-12',
      geometryEpoch: 3,
    });
    store.getState().receive({
      type: 'pty.data',
      sid: 's1',
      seq: 11,
      chunk: 'tail-11',
      geometryEpoch: 3,
    });
    expect(client.sent).toEqual([{ type: 'session.snapshot', sid: 's1' }]);

    store.getState().receive({
      type: 'session.snapshot',
      sid: 's1',
      seq: 10,
      snapshot: 'new-screen',
      geometry: { cols: 100, rows: 30, epoch: 3 },
    });

    expect(store.getState().terminalBatch).toEqual({
      id: expect.any(Number),
      sid: 's1',
      effects: [
        {
          type: 'installSnapshot',
          sid: 's1',
          seq: 10,
          snapshot: 'new-screen',
          geometry: { cols: 100, rows: 30, epoch: 3 },
        },
        { type: 'write', sid: 's1', seq: 11, data: 'tail-11' },
        { type: 'write', sid: 's1', seq: 12, data: 'tail-12' },
      ],
    });
  });

  // A fresh (re)connection's desktop peer never fans out live pty.data on
  // its own — production (`electron/remote/ptyFanout.ts`) only forwards it
  // once a `session.snapshot` request has recorded that peer's
  // `subscribedSid`, and a reconnect changes neither the navigator nor the
  // phone's own retained selection, so nothing else would ever send one.
  // Without re-subscribing here, a reconnected phone would keep showing
  // `phase: 'live'` forever while silently never receiving another byte.
  it('re-subscribes exactly once and restarts terminal sync when a retained selection reconnects', () => {
    const { store, client } = createTestStore();
    client.emitStatus('connected');
    store.getState().receive({
      type: 'sessions.navigator',
      version: 1,
      model: navigatorModel(),
    });
    expect(store.getState().selectedSessionId).toBe('s1');

    // Live before the (simulated) outage: a snapshot already answered and
    // its render batch left unconsumed by the (simulated) xterm adapter —
    // exactly the stale, queued batch a reconnect must discard rather than
    // ever hand to the terminal after the fact.
    store.getState().receive({
      type: 'session.snapshot',
      sid: 's1',
      seq: 0,
      snapshot: 'before-outage',
      geometry: { cols: 80, rows: 24, epoch: 0 },
    });
    expect(store.getState().terminalSync).toMatchObject({ sid: 's1', phase: 'live', lastSeq: 0 });
    expect(store.getState().terminalBatch).not.toBeNull();
    store.getState().setDraft('kept-across-reconnect');

    client.sent.length = 0; // isolate exactly what the reconnect below triggers.

    client.emitStatus('reconnecting');
    client.emitStatus('connected');

    expect(client.sent).toEqual([{ type: 'session.snapshot', sid: 's1' }]);
    expect(store.getState().terminalSync).toMatchObject({ sid: 's1', phase: 'syncing', lastSeq: -1 });
    // Cleared, not replaced with a fresh reset — the reconnect itself must
    // never directly touch what's already on screen; only the eventual
    // snapshot answer may do that.
    expect(store.getState().terminalBatch).toBeNull();
    expect(store.getState().drafts.s1).toBe('kept-across-reconnect');

    client.sent.length = 0;
    client.emitStatus('connected'); // already connected — must never resend.
    expect(client.sent).toEqual([]);
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
    expect(store.getState().pendingSubmissions).toEqual({});
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
      snapshot: 'via-message',
      geometry: { cols: 80, rows: 24, epoch: 0 },
    });
    expect(store.getState().terminalBatch?.effects).toEqual([
      {
        type: 'installSnapshot',
        sid: 's1',
        seq: 0,
        snapshot: 'via-message',
        geometry: { cols: 80, rows: 24, epoch: 0 },
      },
    ]);
    expect(() => store.getState().dispose()).not.toThrow();
  });

  it('dispose() is idempotent — calling it more than once never throws or double-unsubscribes', () => {
    const client = createFakeClient();
    const store = createMobileRemoteStore(client);
    store.getState().dispose();
    expect(() => store.getState().dispose()).not.toThrow();
    expect(() => store.getState().dispose()).not.toThrow();
    // Disposed handlers must stay detached: emitting afterwards must not
    // throw and must not resurrect any state.
    expect(() => client.emitStatus('connected')).not.toThrow();
    expect(() => client.emitMessage({ type: 'sessions.list', sessions: [] })).not.toThrow();
  });
});
