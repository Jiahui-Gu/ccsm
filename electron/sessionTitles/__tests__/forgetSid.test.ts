// Unit tests for `forgetSid` — the per-sid Map releaser added for tech-debt
// H1 (audit #876, task #881). Verifies that all three internal Maps
// (titleCache / opChains / pendingRenames) drop their entry for a sid, that
// in-flight renames don't throw on cleanup, and that repeat calls are
// idempotent. SDK is fully mocked via the same `__setSdkForTests` seam used
// by the rest of the bridge suite.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sdkMocks = {
  getSessionInfo: vi.fn(),
  renameSession: vi.fn(),
  listSessions: vi.fn(),
};

import {
  getSessionTitle,
  renameSessionTitle,
  enqueuePendingRename,
  forgetSid,
  __resetForTests,
  __setSdkForTests,
  __hasSidStateForTests,
} from '../index';

beforeEach(() => {
  __resetForTests();
  sdkMocks.getSessionInfo.mockReset();
  sdkMocks.renameSession.mockReset();
  sdkMocks.listSessions.mockReset();
  __setSdkForTests(
    sdkMocks as unknown as Parameters<typeof __setSdkForTests>[0]
  );
});

describe('forgetSid releases all three per-sid Maps', () => {
  it('drops titleCache, opChains, and pendingRenames for the sid', async () => {
    sdkMocks.getSessionInfo.mockResolvedValue({
      sessionId: 'sid-keep',
      summary: 'cached',
      lastModified: 1,
    });

    // 1. populate titleCache via a successful read
    await getSessionTitle('sid-keep');
    // 2. populate opChains via a settled rename (chain is held even after
    //    the op resolves, since the Map keeps the last-promise pointer)
    sdkMocks.renameSession.mockResolvedValue(undefined);
    await renameSessionTitle('sid-keep', 'new title');
    // 3. populate pendingRenames directly
    enqueuePendingRename('sid-keep', 'pending title');

    expect(__hasSidStateForTests('sid-keep')).toBe(true);

    forgetSid('sid-keep');

    expect(__hasSidStateForTests('sid-keep')).toBe(false);
  });

  it('does not affect entries for other sids', async () => {
    sdkMocks.getSessionInfo.mockResolvedValue({
      sessionId: 'whatever',
      summary: 's',
      lastModified: 1,
    });
    await getSessionTitle('sid-a');
    await getSessionTitle('sid-b');

    forgetSid('sid-a');

    expect(__hasSidStateForTests('sid-a')).toBe(false);
    expect(__hasSidStateForTests('sid-b')).toBe(true);
  });
});

describe('forgetSid does not break in-flight rename', () => {
  it('lets a pending rename resolve normally even when called mid-flight', async () => {
    let resolveRename: (() => void) | null = null;
    sdkMocks.renameSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = () => resolve();
        })
    );

    // start the rename but don't await it yet — the chain is in flight
    const renamePromise = renameSessionTitle('sid-flight', 'title');

    // wait until the SDK mock is actually invoked (chain() awaits loadSdk()
    // first, which yields a few microtasks)
    for (let i = 0; i < 50 && resolveRename === null; i++) {
      await Promise.resolve();
    }
    expect(__hasSidStateForTests('sid-flight')).toBe(true);

    // forget mid-flight: must not throw, must not reject the in-flight op
    expect(() => forgetSid('sid-flight')).not.toThrow();

    // now resolve the SDK call; the original caller should still get { ok: true }
    expect(resolveRename).not.toBeNull();
    resolveRename!();
    const result = await renamePromise;
    expect(result).toEqual({ ok: true });
  });
});

describe('forgetSid is idempotent and tolerant', () => {
  it('does not throw when called twice for the same sid', () => {
    enqueuePendingRename('sid-x', 't');
    expect(() => forgetSid('sid-x')).not.toThrow();
    expect(() => forgetSid('sid-x')).not.toThrow();
    expect(__hasSidStateForTests('sid-x')).toBe(false);
  });

  it('does not throw for a sid never seen by the module', () => {
    expect(() => forgetSid('sid-unseen')).not.toThrow();
  });

  it('ignores empty / non-string sid', () => {
    enqueuePendingRename('real-sid', 't');
    // bad inputs should be no-ops; the real sid stays intact
    forgetSid('');
    forgetSid(undefined as unknown as string);
    forgetSid(null as unknown as string);
    forgetSid(123 as unknown as string);
    expect(__hasSidStateForTests('real-sid')).toBe(true);
  });
});
