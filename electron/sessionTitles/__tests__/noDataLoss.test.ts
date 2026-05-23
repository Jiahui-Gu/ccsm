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
//   I5  flushPendingRename DROPS the pending entry when the SDK threw a
//       non-ENOENT error — this is the candidate data-loss path. Pinned as
//       a documented characterization test, NOT marked .fails(), so it
//       lights up red the moment the production policy changes.
//   I6  enqueuePendingRename does not destroy a pending entry already there
//       for a different sid.
//   I7  forgetSid wipes the pending-rename entry for that sid without
//       flushing it — the user's typed-but-not-yet-written title intent is
//       discarded. Pinned as a documented characterization test.
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

// ─────────────────────── I5: drop on sdk_threw (CHARACTERIZATION) ───────

describe('flushPendingRename drops the pending entry on sdk_threw (characterization)', () => {
  it('discards the user-typed title when the SDK throws non-ENOENT', async () => {
    // This pins current behaviour. `decideRequeue` returns false for any
    // result whose reason is not 'no_jsonl', so after one transient SDK
    // throw (e.g. EBUSY, EACCES, a JSONL parse error) the pending entry is
    // gone and the user's typed title is silently lost.
    //
    // If we ever decide to re-queue on transient sdk_threw, this test will
    // fail and force a conscious update — preventing accidental data loss
    // from going unnoticed.
    // First flush throws non-ENOENT → drops the pending entry.
    // Second flush should be a no-op if the entry was dropped (the only way
    // to distinguish "entry dropped" from "entry preserved" since
    // __hasSidStateForTests is true either way thanks to the opChain Map).
    sdkMocks.renameSession.mockRejectedValue(new Error('transient EBUSY'));

    enqueuePendingRename('sid-i5', 'user-typed', '/cwd');
    await flushPendingRename('sid-i5');

    expect(sdkMocks.renameSession).toHaveBeenCalledTimes(1);

    // Second flush: if the pending entry had been re-queued, this would
    // call the SDK a second time. It does not — the user's title intent
    // was silently discarded after a single transient SDK throw.
    await flushPendingRename('sid-i5');
    expect(sdkMocks.renameSession).toHaveBeenCalledTimes(1);
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

// ─────────────────────── I7: forgetSid drops pending (CHARACTERIZATION) ─

describe('forgetSid discards a queued title intent without flushing it (characterization)', () => {
  it('removes the pending entry without ever calling renameSession', async () => {
    sdkMocks.renameSession.mockResolvedValue(undefined);

    enqueuePendingRename('sid-i7', 'user-typed-but-never-flushed', '/cwd');
    expect(__hasSidStateForTests('sid-i7')).toBe(true);

    forgetSid('sid-i7');

    expect(__hasSidStateForTests('sid-i7')).toBe(false);
    // The pending title was never written to disk: forgetSid is silent
    // about discarded intent. Documented; if we ever choose to flush
    // first, this test fails and forces a review.
    expect(sdkMocks.renameSession).not.toHaveBeenCalled();
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
