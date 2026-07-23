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
  getCoordinatedSnapshot: vi.fn(),
  listPtySessions: vi.fn(() => []),
  resizePtySession: vi.fn(),
  submitPtySession: vi.fn(),
}));

vi.mock('../../ptyHost', () => ({
  getCoordinatedSnapshot: mockedPty.getCoordinatedSnapshot,
  inputPtySession: vi.fn(),
  listPtySessions: mockedPty.listPtySessions,
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
  mockedPty.getCoordinatedSnapshot.mockReset();
  mockedPty.listPtySessions.mockReset();
  mockedPty.listPtySessions.mockReturnValue([]);
  mockedPty.resizePtySession.mockReset();
  mockedPty.submitPtySession.mockReset();
});

describe('handleClientMessage — coordinated session snapshot', () => {
  it('subscribes before awaiting and sends the complete coordinated result', async () => {
    let resolveSnapshot!: (value: {
      type: 'session.snapshot';
      sid: string;
      seq: number;
      snapshot: string;
      geometry: { cols: number; rows: number; epoch: number };
    }) => void;
    mockedPty.getCoordinatedSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const peer = makePeer();

    const handling = handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.snapshot', sid: 's1' }),
    );

    expect(peer.subscribedSid).toBe('s1');
    expect(mockedPty.getCoordinatedSnapshot).toHaveBeenCalledWith('s1');
    expect(peer.send).not.toHaveBeenCalled();

    const response = {
      type: 'session.snapshot' as const,
      sid: 's1',
      seq: 9,
      snapshot: 'screen',
      geometry: { cols: 150, rows: 40, epoch: 3 },
    };
    resolveSnapshot(response);
    await handling;
    expect(peer.send).toHaveBeenCalledWith(response);
  });

  it('reports missing_sid when the coordinated snapshot has no live entry', async () => {
    mockedPty.getCoordinatedSnapshot.mockResolvedValue(null);
    const peer = makePeer();

    await handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.snapshot', sid: 'missing' }),
    );

    expect(peer.subscribedSid).toBe('missing');
    expect(peer.send).toHaveBeenCalledWith({ type: 'error', message: 'missing_sid' });
  });
});

describe('handleClientMessage — sessions.list geometry catalog', () => {
  it('publishes canonical geometry entries without legacy cols/rows fields', async () => {
    mockedPty.listPtySessions.mockReturnValue([
      {
        sid: 's1',
        pid: 7,
        cwd: '/work',
        geometry: { cols: 120, rows: 30, epoch: 2 },
      },
    ]);
    const peer = makePeer();

    await handleClientMessage(peer, JSON.stringify({ type: 'sessions.list' }));

    expect(peer.send).toHaveBeenCalledWith({
      type: 'sessions.list',
      sessions: [
        {
          sid: 's1',
          cwd: '/work',
          geometry: { cols: 120, rows: 30, epoch: 2 },
        },
      ],
    });
  });
});

describe('handleClientMessage — session.resize ownership', () => {
  it('rejects legacy session.resize as invalid_message and never mutates PTY geometry', async () => {
    const peer = makePeer();

    await handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.resize', sid: 's1', cols: 42, rows: 28 }),
    );

    expect(mockedPty.resizePtySession).not.toHaveBeenCalled();
    expect(peer.send).toHaveBeenCalledWith({ type: 'error', message: 'invalid_message' });
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
    { sid: '', requestId: 'r', draft: 'x' },
    { sid: 's', requestId: '', draft: 'x' },
    { sid: 's', requestId: 'r', draft: '' },
  ])('rejects malformed submissions %j as invalid_message without calling the PTY', async (payload) => {
    const peer = makePeer();

    await handleClientMessage(peer, JSON.stringify({ type: 'session.submit', ...payload }));

    expect(mockedPty.submitPtySession).not.toHaveBeenCalled();
    expect(peer.send).toHaveBeenCalledWith({ type: 'error', message: 'invalid_message' });
  });

  it('rejects a draft longer than MAX_MOBILE_SUBMIT_CHARS as invalid_message', async () => {
    const peer = makePeer();
    const draft = 'x'.repeat(MAX_MOBILE_SUBMIT_CHARS + 1);

    await handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.submit', sid: 's1', requestId: 'req-3', draft }),
    );

    expect(mockedPty.submitPtySession).not.toHaveBeenCalled();
    expect(peer.send).toHaveBeenCalledWith({ type: 'error', message: 'invalid_message' });
  });

  it('rejects a non-string requestId as invalid_message', async () => {
    const peer = makePeer();

    await handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.submit', sid: 's1', requestId: 42, draft: 'hi' }),
    );

    expect(mockedPty.submitPtySession).not.toHaveBeenCalled();
    expect(peer.send).toHaveBeenCalledWith({ type: 'error', message: 'invalid_message' });
  });

  it('rejects a non-string sid as invalid_message', async () => {
    const peer = makePeer();

    await handleClientMessage(
      peer,
      JSON.stringify({ type: 'session.submit', sid: null, requestId: 'req-4', draft: 'hi' }),
    );

    expect(mockedPty.submitPtySession).not.toHaveBeenCalled();
    expect(peer.send).toHaveBeenCalledWith({ type: 'error', message: 'invalid_message' });
  });
});
