// Acknowledged complete-draft submission — `session.submit` protocol
// handler (Task 1, mobile composer + terminal sync plan).
//
// The mobile composer sends one COMPLETE draft per request, correlated by
// `requestId` so the phone can resolve/reject its pending Send button
// without ambiguity. This suite pins:
//   - malformed submissions (non-string / empty / oversized fields) get
//     exactly one correlated failure response and NEVER reach the PTY;
//   - valid submissions call `submitPtySession` exactly once and map its
//     explicit `PtySubmitResult` to exactly one `session.submit.result`;
//   - success (`ok: true`) is only sent when the PTY layer reports `'ok'`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedPty = vi.hoisted(() => ({
  submitPtySession: vi.fn(),
}));

vi.mock('../../ptyHost', () => ({
  getBufferSnapshot: vi.fn(),
  getPtySession: vi.fn(),
  inputPtySession: vi.fn(),
  listPtySessions: vi.fn(() => []),
  resizePtySession: vi.fn(),
  submitPtySession: mockedPty.submitPtySession,
}));

vi.mock('../navigationSource', () => ({
  readRemoteNavigationModel: vi.fn(() => ({ groups: [], activeSessionId: null })),
}));

import { handleClientMessage } from '../remoteMessages';
import { MAX_MOBILE_SUBMIT_CHARS } from '../../../src/shared/mobileRemote';
import type { RemotePeer } from '../remotePeer';

function makePeer(): RemotePeer {
  return { subscribedSid: null, send: vi.fn() };
}

beforeEach(() => {
  mockedPty.submitPtySession.mockReset();
});

describe('handleClientMessage — session.submit', () => {
  it('acknowledges a complete draft only after the PTY accepts it', async () => {
    mockedPty.submitPtySession.mockReturnValue('ok');
    const peer = makePeer();

    await handleClientMessage(
      peer,
      JSON.stringify({
        type: 'session.submit',
        sid: 's1',
        requestId: 'req-1',
        draft: '你好\nworld',
      }),
    );

    expect(mockedPty.submitPtySession).toHaveBeenCalledTimes(1);
    expect(mockedPty.submitPtySession).toHaveBeenCalledWith('s1', '你好\nworld');
    expect(peer.send).toHaveBeenCalledWith({
      type: 'session.submit.result',
      sid: 's1',
      requestId: 'req-1',
      ok: true,
    });
  });

  it.each([
    ['session_not_found' as const],
    ['pty_write_failed' as const],
  ])('maps an explicit %s PTY result to a correlated failure', async (error) => {
    mockedPty.submitPtySession.mockReturnValue(error);
    const peer = makePeer();

    await handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.submit', sid: 's1', requestId: 'req-2', draft: 'hi' }),
    );

    expect(peer.send).toHaveBeenCalledWith({
      type: 'session.submit.result',
      sid: 's1',
      requestId: 'req-2',
      ok: false,
      error,
    });
  });

  // `submitPtySession` is now async (Promise<PtySubmitResult>) — the ordered
  // FIFO barrier fix lives in `lifecycle.submit`. This pins that
  // `handleClientMessage` actually awaits it rather than firing the ack
  // off a still-pending Promise: no `session.submit.result` may reach the
  // phone until the ptyHost Promise settles, exactly one `submitPtySession`
  // call happens per valid message, and a rejected-then-`pty_write_failed`
  // resolution maps to exactly one correlated failure.
  it('does not ack a deferred submitPtySession Promise until it resolves', async () => {
    let resolveSubmit!: (value: 'ok') => void;
    mockedPty.submitPtySession.mockReturnValue(
      new Promise<'ok'>((resolve) => {
        resolveSubmit = resolve;
      }),
    );
    const peer = makePeer();

    const handled = handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.submit', sid: 's1', requestId: 'req-deferred', draft: 'hi' }),
    );

    // Give any stray microtasks a chance to run before the Promise settles.
    await Promise.resolve();
    await Promise.resolve();
    expect(peer.send).not.toHaveBeenCalled();

    resolveSubmit('ok');
    await handled;

    expect(mockedPty.submitPtySession).toHaveBeenCalledTimes(1);
    expect(peer.send).toHaveBeenCalledTimes(1);
    expect(peer.send).toHaveBeenCalledWith({
      type: 'session.submit.result',
      sid: 's1',
      requestId: 'req-deferred',
      ok: true,
    });
  });

  it('maps a deferred pty_write_failed resolution to exactly one correlated failure', async () => {
    let resolveSubmit!: (value: 'pty_write_failed') => void;
    mockedPty.submitPtySession.mockReturnValue(
      new Promise<'pty_write_failed'>((resolve) => {
        resolveSubmit = resolve;
      }),
    );
    const peer = makePeer();

    const handled = handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.submit', sid: 's1', requestId: 'req-deferred-fail', draft: 'hi' }),
    );

    await Promise.resolve();
    expect(peer.send).not.toHaveBeenCalled();

    resolveSubmit('pty_write_failed');
    await handled;

    expect(mockedPty.submitPtySession).toHaveBeenCalledTimes(1);
    expect(peer.send).toHaveBeenCalledTimes(1);
    expect(peer.send).toHaveBeenCalledWith({
      type: 'session.submit.result',
      sid: 's1',
      requestId: 'req-deferred-fail',
      ok: false,
      error: 'pty_write_failed',
    });
  });

  it.each([
    [{ sid: '', requestId: 'r', draft: 'x' }, 'invalid_submission'],
    [{ sid: 's', requestId: '', draft: 'x' }, 'invalid_submission'],
    [{ sid: 's', requestId: 'r', draft: '' }, 'invalid_submission'],
  ])('rejects malformed submissions %j without calling the PTY', async (payload, error) => {
    const peer = makePeer();

    await handleClientMessage(peer, JSON.stringify({ type: 'session.submit', ...payload }));

    expect(mockedPty.submitPtySession).not.toHaveBeenCalled();
    expect(peer.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.submit.result', ok: false, error }),
    );
  });

  it('rejects a draft longer than MAX_MOBILE_SUBMIT_CHARS without calling the PTY', async () => {
    const peer = makePeer();
    const draft = 'x'.repeat(MAX_MOBILE_SUBMIT_CHARS + 1);

    await handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.submit', sid: 's1', requestId: 'req-3', draft }),
    );

    expect(mockedPty.submitPtySession).not.toHaveBeenCalled();
    expect(peer.send).toHaveBeenCalledWith({
      type: 'session.submit.result',
      sid: 's1',
      requestId: 'req-3',
      ok: false,
      error: 'invalid_submission',
    });
  });

  it('preserves a valid sid but empties a non-string requestId in the correlated failure', async () => {
    const peer = makePeer();

    await handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.submit', sid: 's1', requestId: 42, draft: 'hi' }),
    );

    expect(mockedPty.submitPtySession).not.toHaveBeenCalled();
    expect(peer.send).toHaveBeenCalledWith({
      type: 'session.submit.result',
      sid: 's1',
      requestId: '',
      ok: false,
      error: 'invalid_submission',
    });
  });

  it('empties a non-string sid while preserving a valid requestId in the correlated failure', async () => {
    const peer = makePeer();

    await handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.submit', sid: null, requestId: 'req-4', draft: 'hi' }),
    );

    expect(mockedPty.submitPtySession).not.toHaveBeenCalled();
    expect(peer.send).toHaveBeenCalledWith({
      type: 'session.submit.result',
      sid: '',
      requestId: 'req-4',
      ok: false,
      error: 'invalid_submission',
    });
  });
});
