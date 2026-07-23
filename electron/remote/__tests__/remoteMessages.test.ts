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
  resizePtySession: vi.fn(),
  submitPtySession: vi.fn(),
}));

vi.mock('../../ptyHost', () => ({
  getBufferSnapshot: vi.fn(),
  getPtySession: vi.fn(),
  inputPtySession: vi.fn(),
  listPtySessions: vi.fn(() => []),
  resizePtySession: mockedPty.resizePtySession,
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
  mockedPty.resizePtySession.mockReset();
  mockedPty.submitPtySession.mockReset();
});

describe('handleClientMessage — session.resize ownership', () => {
  it('keeps desktop PTY/headless dimensions authoritative when a legacy phone reports its viewport size', async () => {
    const peer = makePeer();

    await handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.resize', sid: 's1', cols: 42, rows: 28 }),
    );

    expect(mockedPty.resizePtySession).not.toHaveBeenCalled();
    expect(peer.send).not.toHaveBeenCalled();
  });

  it('still rejects malformed legacy resize messages', async () => {
    const peer = makePeer();

    await handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.resize', sid: 's1', cols: 0.5, rows: 28 }),
    );

    expect(mockedPty.resizePtySession).not.toHaveBeenCalled();
    expect(peer.send).toHaveBeenCalledWith({ type: 'error', message: 'invalid_resize' });
  });
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
