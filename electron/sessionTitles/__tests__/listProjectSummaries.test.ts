import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  listProjectSummaries,
  __setSdkForTests,
} from '../index';

// listSessions returns the SDK's session shape; listProjectSummaries only
// reads sessionId / summary / lastModified, so the fakes carry just those.
function fakeSessions(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `s${i}`,
    summary: `summary ${i}`,
    lastModified: i,
  }));
}

function injectListSessions(rows: unknown[]) {
  __setSdkForTests({
    getSessionInfo: (async () => {
      throw new Error('not used');
    }) as never,
    renameSession: (async () => {
      throw new Error('not used');
    }) as never,
    listSessions: (async () => rows) as never,
  });
}

afterEach(() => {
  __setSdkForTests(null);
});

describe('listProjectSummaries cap (DEBT #12)', () => {
  it('caps the returned list at MAX_PROJECT_SUMMARIES (2000), silently truncating', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    injectListSessions(fakeSessions(2001));
    const rows = await listProjectSummaries('/tmp/proj');
    expect(rows).toHaveLength(2000);
    expect(rows[0].sid).toBe('s0');
    expect(rows[1999].sid).toBe('s1999');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('does NOT warn or truncate at exactly MAX_PROJECT_SUMMARIES', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    injectListSessions(fakeSessions(2000));
    const rows = await listProjectSummaries('/tmp/proj');
    expect(rows).toHaveLength(2000);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
