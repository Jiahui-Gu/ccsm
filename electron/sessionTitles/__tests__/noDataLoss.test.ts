// No-data-loss invariant tests for the session-title bridge.
//
// Audit PR-B3 flagged the worry that when the SDK-derived title machinery
// fails (SDK throws, ENOENT, transient fs error, rename race), some
// previously-correct title might be silently overwritten with a worse value
// (empty string, null, stale fallback). This file pins the invariants that
// must hold across every failure path so regressions surface immediately.
//
// Invariants pinned here (see PR body for full taxonomy):
//
//   I1  renameSessionTitle never claims success when the SDK throws.
//   I2  renameSessionTitle forwards the user's title verbatim to the SDK
//       (no substitution / trimming / fallback) on both the first attempt
//       and the dir-less retry.
//   I3  A failed rename does NOT invalidate the titleCache (so a previously
//       cached good summary keeps being served).
//   I4  flushPendingRename preserves the pending entry when the JSONL is
//       still missing (decideRequeue path).
//   I5  flushPendingRename re-queues the pending entry on a transient
//       non-ENOENT SDK throw (bounded retry: initial + 1 retry). After
//       MAX_SDK_THREW_ATTEMPTS the entry is dropped but a console.warn
//       records the loss — never a silent discard.
//   I6  enqueuePendingRename does not destroy a pending entry already there
//       for a different sid.
//   I7  forgetSid flushes any queued title intent before clearing per-sid
//       state. If the flush fails, the loss is logged via console.warn —
//       never silently discarded.
//   I8  getSessionTitle returns { summary: null, mtime: null } on SDK
//       throw — it never falls back to a stale or hallucinated string.
//   I9  listProjectSummaries returns [] on SDK throw — it never returns
//       partial/half-mapped data on failure.
//
// All tests use the same `__setSdkForTests` seam as the existing suite.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sdkMocks = {
  getSessionInfo: vi.fn(),
  renameSession: vi.fn(),
  listSessions: vi.fn(),
};

import {
  getSessionTitle,
  renameSessionTitle,
  listProjectSummaries,
  enqueuePendingRename,
  flushPendingRename,
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

// ─────────────────────── I1: never spuriously ok ────────────────────────

describe('renameSessionTitle never claims success on SDK throw', () => {
  it('returns ok:false for a generic Error', async () => {
    sdkMocks.renameSession.mockRejectedValue(new Error('disk full'));
    const r = await renameSessionTitle('sid-i1a', 'new');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false for ENOENT', async () => {
    const err = Object.assign(new Error('no'), { code: 'ENOENT' });
    sdkMocks.renameSession.mockRejectedValue(err);
    const r = await renameSessionTitle('sid-i1b', 'new');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false when retry also throws', async () => {
    sdkMocks.renameSession
      .mockRejectedValueOnce(
        new Error('Session sid-i1c not found in project directory for /x')
      )
      .mockRejectedValueOnce(new Error('still broken'));
    const r = await renameSessionTitle('sid-i1c', 'new', '/x');
    expect(r.ok).toBe(false);
  });

  it('rejects non-Error throws as ok:false too', async () => {
    sdkMocks.renameSession.mockRejectedValue('weird string throw');
    const r = await renameSessionTitle('sid-i1d', 'new');
    expect(r.ok).toBe(false);
  });
});

// ─────────────────────── I2: title forwarded verbatim ───────────────────

describe('renameSessionTitle forwards the title verbatim', () => {
  it('passes the exact string to SDK on the first attempt', async () => {
    sdkMocks.renameSession.mockResolvedValue(undefined);
    await renameSessionTitle('sid-i2a', '  My Title  ');
    expect(sdkMocks.renameSession).toHaveBeenCalledWith(
      'sid-i2a',
      '  My Title  ',
      undefined
    );
  });

  it('passes empty string verbatim — bridge does NOT sanitize', async () => {
    // Documented: the bridge is a transparent wrapper; if upstream allows an
    // empty title to reach it, the SDK call is made with empty string. This
    // test pins that contract so a renderer guard is the only thing
    // standing between the user and an empty title on disk.
    sdkMocks.renameSession.mockResolvedValue(undefined);
    await renameSessionTitle('sid-i2b', '');
    expect(sdkMocks.renameSession).toHaveBeenCalledWith('sid-i2b', '', undefined);
  });

  it('uses the same title on the dir-less retry', async () => {
    sdkMocks.renameSession
      .mockRejectedValueOnce(
        new Error('Session sid-i2c not found in project directory for /x')
      )
      .mockResolvedValueOnce(undefined);
    const r = await renameSessionTitle('sid-i2c', 'preserved', '/x');
    expect(r).toEqual({ ok: true });
    expect(sdkMocks.renameSession).toHaveBeenNthCalledWith(
      1,
      'sid-i2c',
      'preserved',
      { dir: '/x' }
    );
    expect(sdkMocks.renameSession).toHaveBeenNthCalledWith(
      2,
      'sid-i2c',
      'preserved',
      undefined
    );
  });
});

// ─────────────────────── I3: failed rename keeps cache ──────────────────

describe('failed rename does not poison the read-side cache', () => {
  it('cached summary still served when a subsequent rename throws', async () => {
    sdkMocks.getSessionInfo.mockResolvedValue({
      sessionId: 'sid-i3',
      summary: 'good-summary',
      lastModified: 42,
    });
    const r1 = await getSessionTitle('sid-i3');
    expect(r1.summary).toBe('good-summary');

    sdkMocks.renameSession.mockRejectedValue(new Error('sdk boom'));
    const renamed = await renameSessionTitle('sid-i3', 'new');
    expect(renamed.ok).toBe(false);

    // The cache must NOT have been invalidated by the failed rename — the
    // user's previously-correct title is still served.
    const r2 = await getSessionTitle('sid-i3');
    expect(r2.summary).toBe('good-summary');
    // Only the initial getSessionInfo call; the second read came from cache.
    expect(sdkMocks.getSessionInfo).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────── I4: requeue on no_jsonl ────────────────────────

describe('flushPendingRename preserves intent on no_jsonl', () => {
  it('keeps the pending entry verbatim across two ENOENT replays', async () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
    sdkMocks.renameSession.mockRejectedValue(err);

    enqueuePendingRename('sid-i4', 'user-typed-title', '/cwd');
    await flushPendingRename('sid-i4');
    await flushPendingRename('sid-i4');
    await flushPendingRename('sid-i4');

    // The pending entry survived three failed flushes — the title intent
    // was not lost.
    expect(__hasSidStateForTests('sid-i4')).toBe(true);
    // And every replay forwarded the SAME title to the SDK (no truncation,
    // no fallback to '').
    expect(sdkMocks.renameSession).toHaveBeenCalledTimes(3);
    for (const call of sdkMocks.renameSession.mock.calls) {
      expect(call[1]).toBe('user-typed-title');
      expect(call[2]).toEqual({ dir: '/cwd' });
    }
  });
});

// ─────────────────────── I5: bounded retry on sdk_threw ─────────────────

describe('flushPendingRename re-queues on transient sdk_threw (bounded)', () => {
  it('re-queues the pending entry once after a non-ENOENT SDK throw', async () => {
    // First attempt: SDK throws transient (e.g. EBUSY). The pending entry
    // must NOT be silently dropped — it gets re-queued so the next watcher
    // tick retries with the user's original typed title.
    sdkMocks.renameSession.mockRejectedValueOnce(new Error('transient EBUSY'));

    enqueuePendingRename('sid-i5', 'user-typed', '/cwd');
    await flushPendingRename('sid-i5');

    expect(sdkMocks.renameSession).toHaveBeenCalledTimes(1);
    // Entry is still queued; second flush will call the SDK again with the
    // same title.
    expect(__hasSidStateForTests('sid-i5')).toBe(true);

    sdkMocks.renameSession.mockResolvedValueOnce(undefined);
    await flushPendingRename('sid-i5');

    expect(sdkMocks.renameSession).toHaveBeenCalledTimes(2);
    expect(sdkMocks.renameSession).toHaveBeenLastCalledWith(
      'sid-i5',
      'user-typed',
      { dir: '/cwd' }
    );
  });

  it('gives up after bounded retries and logs the loss', async () => {
    // Two consecutive non-ENOENT throws exhausts the retry budget
    // (initial + 1 retry = 2 attempts). The pending entry is dropped,
    // but the loss is recorded via console.warn — never silent.
    sdkMocks.renameSession
      .mockRejectedValueOnce(new Error('transient EBUSY'))
      .mockRejectedValueOnce(new Error('still busy'));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      enqueuePendingRename('sid-i5b', 'user-typed', '/cwd');
      await flushPendingRename('sid-i5b');
      await flushPendingRename('sid-i5b');

      expect(sdkMocks.renameSession).toHaveBeenCalledTimes(2);
      // After exhaustion the entry must be cleared from the pending map,
      // and a loud log must record the dropped title.
      const warnedAboutLoss = warn.mock.calls.some((args) =>
        args.some(
          (a) =>
            typeof a === 'string' &&
            a.includes('sid-i5b') &&
            a.includes('user-typed')
        )
      );
      expect(warnedAboutLoss).toBe(true);

      // A third flush call must be a no-op (nothing left to flush).
      await flushPendingRename('sid-i5b');
      expect(sdkMocks.renameSession).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not clobber a newer pending entry that arrived during await (requeue race)', async () => {
    // Bug found in #1334 review: between the synchronous
    // `pendingRenames.delete(sid)` and the awaited `renameSessionTitle`,
    // the renderer can call `enqueuePendingRename(sid, newer)`. If the SDK
    // then returns no_jsonl, the OLD captured pending would overwrite the
    // newer entry. Fix: skip the re-queue when a newer entry is already
    // present.
    let resolveRename: ((v: unknown) => void) | null = null;
    sdkMocks.renameSession.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          resolveRename = (_v: unknown) =>
            reject(Object.assign(new Error('nope'), { code: 'ENOENT' }));
        })
    );

    enqueuePendingRename('sid-i5c', 'older-title', '/cwd');
    const flushPromise = flushPendingRename('sid-i5c');

    // Wait until the SDK mock is invoked, then race in a newer enqueue.
    for (let i = 0; i < 50 && resolveRename === null; i++) {
      await Promise.resolve();
    }
    enqueuePendingRename('sid-i5c', 'newer-title', '/cwd');

    // Now let the SDK call reject with ENOENT.
    resolveRename!(undefined);
    await flushPromise;

    // The newer title must still be the queued entry. Flush again to
    // confirm what gets sent on the next watcher tick is "newer-title".
    sdkMocks.renameSession.mockResolvedValueOnce(undefined);
    await flushPendingRename('sid-i5c');
    expect(sdkMocks.renameSession).toHaveBeenLastCalledWith(
      'sid-i5c',
      'newer-title',
      { dir: '/cwd' }
    );
  });
});

// ─────────────────────── I6: enqueue isolation ──────────────────────────

describe('enqueuePendingRename does not clobber other sids', () => {
  it('overwrites only the matching sid', async () => {
    enqueuePendingRename('sid-i6-a', 'title-a', '/a');
    enqueuePendingRename('sid-i6-b', 'title-b', '/b');
    enqueuePendingRename('sid-i6-a', 'title-a2', '/a');

    sdkMocks.renameSession.mockResolvedValue(undefined);

    await flushPendingRename('sid-i6-a');
    await flushPendingRename('sid-i6-b');

    // sid-i6-a got the latest title; sid-i6-b's pending entry survived.
    expect(sdkMocks.renameSession).toHaveBeenNthCalledWith(1, 'sid-i6-a', 'title-a2', {
      dir: '/a',
    });
    expect(sdkMocks.renameSession).toHaveBeenNthCalledWith(2, 'sid-i6-b', 'title-b', {
      dir: '/b',
    });
  });
});

// ─────────────────────── I7: forgetSid flushes pending before clearing ──

describe('forgetSid flushes any queued title intent before clearing state', () => {
  it('attempts to write the pending title via the SDK before forgetting the sid', async () => {
    sdkMocks.renameSession.mockResolvedValue(undefined);

    enqueuePendingRename('sid-i7', 'user-typed-but-never-flushed', '/cwd');
    expect(__hasSidStateForTests('sid-i7')).toBe(true);

    forgetSid('sid-i7');

    // forgetSid is sync (its caller, the sessionWatcher 'unwatched'
    // handler, is sync), but it kicks off an async best-effort flush.
    // Wait long enough for the chain → SDK call to settle.
    for (let i = 0; i < 100 && sdkMocks.renameSession.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }

    expect(sdkMocks.renameSession).toHaveBeenCalledWith(
      'sid-i7',
      'user-typed-but-never-flushed',
      { dir: '/cwd' }
    );
  });

  it('logs loudly when the pending flush fails — never silent data loss', async () => {
    sdkMocks.renameSession.mockRejectedValue(new Error('disk full'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      enqueuePendingRename('sid-i7b', 'last-chance-title', '/cwd');
      forgetSid('sid-i7b');

      // Wait for the async flush kicked off by forgetSid to settle.
      for (let i = 0; i < 200 && warn.mock.calls.length === 0; i++) {
        await Promise.resolve();
      }

      // forgetSid must surface the loss via console.warn rather than
      // discarding the user's typed title in silence.
      const loggedLoss = warn.mock.calls.some((args) =>
        args.some(
          (a) =>
            typeof a === 'string' &&
            a.includes('sid-i7b') &&
            a.includes('last-chance-title')
        )
      );
      expect(loggedLoss).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('bails the deferred flush if a newer enqueue arrives in the same tick (race)', async () => {
    // forgetSid race mirror of the I5 requeue-race. Between forgetSid's
    // synchronous `pendingRenames.delete(sid)` and the microtask that
    // calls `renameSessionTitle(sid, capturedOlderTitle)`, the renderer
    // may call `enqueuePendingRename(sid, newerTitle)`. If the deferred
    // flush ran unconditionally, it would write the OLD title to disk
    // for a moment before the next watcher tick overwrites it with the
    // newer value — a brief stale write the user can observe.
    //
    // Expected: the microtask sees the newer entry already present and
    // bails. No SDK call happens for the old title. The next flush
    // (simulating the watcher tick) writes the newer title.
    sdkMocks.renameSession.mockResolvedValue(undefined);

    enqueuePendingRename('sid-i7c', 'older-title', '/cwd');
    forgetSid('sid-i7c');
    // Same-tick re-enqueue, before the microtask fires.
    enqueuePendingRename('sid-i7c', 'newer-title', '/cwd');

    // Drain microtasks; the deferred flush should bail without calling SDK.
    for (let i = 0; i < 100; i++) {
      await Promise.resolve();
    }
    expect(sdkMocks.renameSession).not.toHaveBeenCalled();

    // Next watcher tick: the newer entry is the one that gets written.
    await flushPendingRename('sid-i7c');
    expect(sdkMocks.renameSession).toHaveBeenCalledTimes(1);
    expect(sdkMocks.renameSession).toHaveBeenCalledWith(
      'sid-i7c',
      'newer-title',
      { dir: '/cwd' }
    );
  });
});

// ─────────────────────── I8: read-side never hallucinates ───────────────

describe('getSessionTitle returns null fields on SDK throw, never stale data', () => {
  it('returns { summary: null, mtime: null } when SDK throws', async () => {
    sdkMocks.getSessionInfo.mockRejectedValue(new Error('disk gone'));
    const r = await getSessionTitle('sid-i8a');
    expect(r).toEqual({ summary: null, mtime: null });
  });

  it('returns { summary: null, mtime: null } on ENOENT', async () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
    sdkMocks.getSessionInfo.mockRejectedValue(err);
    const r = await getSessionTitle('sid-i8b');
    expect(r).toEqual({ summary: null, mtime: null });
  });

  it('returns null fields when SDK resolves to null/undefined info', async () => {
    sdkMocks.getSessionInfo.mockResolvedValue(null);
    const r = await getSessionTitle('sid-i8c');
    expect(r).toEqual({ summary: null, mtime: null });
  });

  it('coerces missing summary fields to null rather than empty string', async () => {
    sdkMocks.getSessionInfo.mockResolvedValue({
      sessionId: 'sid-i8d',
      // summary intentionally missing
      lastModified: 'not-a-number',
    });
    const r = await getSessionTitle('sid-i8d');
    expect(r.summary).toBeNull();
    expect(r.mtime).toBeNull();
  });
});

// ─────────────────────── I9: list never partial on failure ──────────────

describe('listProjectSummaries returns [] on SDK throw', () => {
  it('returns empty array, never partial mapping', async () => {
    sdkMocks.listSessions.mockRejectedValue(new Error('disk gone'));
    const r = await listProjectSummaries('/proj');
    expect(r).toEqual([]);
  });

  it('coerces missing mtime to 0 and missing summary to null without invented data', async () => {
    sdkMocks.listSessions.mockResolvedValue([
      { sessionId: 'a' /* no summary, no lastModified */ },
      { sessionId: 'b', summary: '', lastModified: 0 },
    ]);
    const r = await listProjectSummaries('/proj');
    expect(r).toEqual([
      { sid: 'a', summary: null, mtime: 0 },
      // Empty string is preserved verbatim (mirrors I2 transparency
      // policy on the write side).
      { sid: 'b', summary: '', mtime: 0 },
    ]);
  });
});
