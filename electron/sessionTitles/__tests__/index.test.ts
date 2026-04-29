// Unit tests for the main-process SDK title bridge. SDK is fully mocked so
// these tests don't touch ~/.claude/projects/.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted mock targets. `vi.mock` factories are hoisted to the top of the
// file, so the spies must be declared via `vi.hoisted` (or assigned inside
// the factory and re-imported) for the test bodies to control them.
const sdkMocks = vi.hoisted(() => ({
  getSessionInfo: vi.fn(),
  renameSession: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => sdkMocks);

import {
  getSessionTitle,
  renameSessionTitle,
  listProjectSummaries,
  enqueuePendingRename,
  flushPendingRename,
  __resetForTests,
} from '../index';

beforeEach(() => {
  __resetForTests();
  sdkMocks.getSessionInfo.mockReset();
  sdkMocks.renameSession.mockReset();
  sdkMocks.listSessions.mockReset();
});

describe('getSessionTitle cache TTL', () => {
  it('serves second call from cache within 2s window', async () => {
    sdkMocks.getSessionInfo.mockResolvedValue({
      sessionId: 'sid-1',
      summary: 'first prompt',
      lastModified: 1000,
    });

    const r1 = await getSessionTitle('sid-1');
    const r2 = await getSessionTitle('sid-1');

    expect(r1).toEqual({ summary: 'first prompt', mtime: 1000 });
    expect(r2).toEqual({ summary: 'first prompt', mtime: 1000 });
    expect(sdkMocks.getSessionInfo).toHaveBeenCalledTimes(1);
  });
});

describe('cache invalidation on rename', () => {
  it('refetches after a successful rename', async () => {
    sdkMocks.getSessionInfo
      .mockResolvedValueOnce({
        sessionId: 'sid-2',
        summary: 'before',
        lastModified: 1,
      })
      .mockResolvedValueOnce({
        sessionId: 'sid-2',
        summary: 'after',
        lastModified: 2,
      });
    sdkMocks.renameSession.mockResolvedValue(undefined);

    const r1 = await getSessionTitle('sid-2');
    expect(r1.summary).toBe('before');

    const renamed = await renameSessionTitle('sid-2', 'after');
    expect(renamed).toEqual({ ok: true });

    const r2 = await getSessionTitle('sid-2');
    expect(r2.summary).toBe('after');
    expect(sdkMocks.getSessionInfo).toHaveBeenCalledTimes(2);
  });
});

describe('per-sid serialization', () => {
  it('orders concurrent renames against the same sid FIFO', async () => {
    const observed: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    sdkMocks.renameSession.mockImplementation(async (_sid: string, title: string) => {
      if (title === 'A') {
        await firstGate;
      }
      observed.push(title);
    });

    const pA = renameSessionTitle('sid-3', 'A');
    const pB = renameSessionTitle('sid-3', 'B');

    // Give the microtask queue a chance to start A but not finish it.
    await Promise.resolve();
    expect(observed).toEqual([]);

    releaseFirst();
    await Promise.all([pA, pB]);

    expect(observed).toEqual(['A', 'B']);
  });
});

describe('error normalization', () => {
  it('classifies ENOENT as no_jsonl', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('not found'), {
      code: 'ENOENT',
    });
    sdkMocks.renameSession.mockRejectedValue(err);

    const result = await renameSessionTitle('sid-4', 'whatever');
    expect(result).toEqual({ ok: false, reason: 'no_jsonl' });
  });

  it('classifies non-ENOENT as sdk_threw with message', async () => {
    sdkMocks.renameSession.mockRejectedValue(new Error('boom'));

    const result = await renameSessionTitle('sid-5', 'whatever');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('sdk_threw');
    expect(result.message).toBe('boom');
  });
});

describe('pending rename flush', () => {
  it('replays the queued title via renameSession', async () => {
    sdkMocks.renameSession.mockResolvedValue(undefined);

    enqueuePendingRename('sid-6', 'pending-title', '/some/dir');
    expect(sdkMocks.renameSession).not.toHaveBeenCalled();

    await flushPendingRename('sid-6');

    expect(sdkMocks.renameSession).toHaveBeenCalledTimes(1);
    expect(sdkMocks.renameSession).toHaveBeenCalledWith(
      'sid-6',
      'pending-title',
      { dir: '/some/dir' }
    );
  });

  it('re-queues when JSONL is still missing', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('no file'), {
      code: 'ENOENT',
    });
    sdkMocks.renameSession.mockRejectedValueOnce(err).mockResolvedValueOnce(undefined);

    enqueuePendingRename('sid-7', 'queued');
    await flushPendingRename('sid-7');
    expect(sdkMocks.renameSession).toHaveBeenCalledTimes(1);

    // Second flush should retry because the previous attempt re-queued.
    await flushPendingRename('sid-7');
    expect(sdkMocks.renameSession).toHaveBeenCalledTimes(2);
  });
});

describe('listProjectSummaries', () => {
  it('maps SDK SessionInfo to {sid, summary, mtime}', async () => {
    sdkMocks.listSessions.mockResolvedValue([
      { sessionId: 'a', summary: 'one', lastModified: 100 },
      { sessionId: 'b', summary: 'two', lastModified: 200 },
    ]);

    const out = await listProjectSummaries('/proj');
    expect(out).toEqual([
      { sid: 'a', summary: 'one', mtime: 100 },
      { sid: 'b', summary: 'two', mtime: 200 },
    ]);
    expect(sdkMocks.listSessions).toHaveBeenCalledWith({ dir: '/proj' });
  });

  it('returns [] on SDK throw rather than escalating', async () => {
    sdkMocks.listSessions.mockRejectedValue(new Error('disk gone'));
    const out = await listProjectSummaries('/proj');
    expect(out).toEqual([]);
  });
});
