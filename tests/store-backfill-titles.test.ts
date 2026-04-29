import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../src/stores/store';
import type { Session } from '../src/types';

// Covers `_backfillTitles` action wired in PR4 (#593):
//   1. Default-named sessions get patched with the SDK summary
//   2. User-renamed sessions are NEVER touched
//   3. Multiple sessions in the same projectKey use ONE listForProject call
//      (batch by projectKey, not per-session)
//   4. listForProject error → silent, no crash, other projects still patched
//   5. No bridge installed (jsdom path) → no-op
//   6. Empty summary string is ignored (counts as "no derived title yet")

type Summary = { sid: string; summary: string | null; mtime: number };

function installBridge(impl: (projectKey: string) => Promise<Summary[]>) {
  const listForProject = vi.fn(impl);
  (window as unknown as { ccsmSessionTitles: unknown }).ccsmSessionTitles = {
    rename: vi.fn(async () => ({ ok: true })),
    enqueuePending: vi.fn(async () => {}),
    flushPending: vi.fn(async () => {}),
    get: vi.fn(async () => ({ summary: null, mtime: null })),
    listForProject,
  };
  return { listForProject };
}

function seed(id: string, name: string, cwd: string): Session {
  const session: Session = {
    id,
    name,
    state: 'idle',
    cwd,
    model: '',
    groupId: 'g1',
    agentType: 'claude-code',
  };
  useStore.setState((s) => ({ sessions: [...s.sessions, session] }));
  return session;
}

describe('store._backfillTitles', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useStore.setState({ sessions: [] });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles;
    warnSpy.mockRestore();
    useStore.setState({ sessions: [] });
  });

  it('patches default-named session with SDK summary', async () => {
    installBridge(async () => [
      { sid: 'sid-A', summary: 'Refactor login page', mtime: 1 },
    ]);
    seed('sid-A', 'New session', '/home/u/proj-A');

    await useStore.getState()._backfillTitles();

    expect(useStore.getState().sessions.find((s) => s.id === 'sid-A')?.name).toBe(
      'Refactor login page'
    );
  });

  it('also patches Chinese default name 新会话', async () => {
    installBridge(async () => [
      { sid: 'sid-zh', summary: 'Localized summary', mtime: 1 },
    ]);
    seed('sid-zh', '新会话', '/home/u/proj-zh');

    await useStore.getState()._backfillTitles();

    expect(useStore.getState().sessions.find((s) => s.id === 'sid-zh')?.name).toBe(
      'Localized summary'
    );
  });

  it('never overwrites a user-renamed session, even if SDK has a summary', async () => {
    installBridge(async () => [
      { sid: 'sid-keep', summary: 'auto-derived', mtime: 1 },
    ]);
    seed('sid-keep', 'My custom name', '/home/u/proj-keep');

    await useStore.getState()._backfillTitles();

    expect(useStore.getState().sessions.find((s) => s.id === 'sid-keep')?.name).toBe(
      'My custom name'
    );
  });

  it('batches sessions by projectKey: ONE IPC call for many sids in same project', async () => {
    const { listForProject } = installBridge(async () => [
      { sid: 'sid-1', summary: 's1', mtime: 1 },
      { sid: 'sid-2', summary: 's2', mtime: 2 },
      { sid: 'sid-3', summary: 's3', mtime: 3 },
    ]);
    seed('sid-1', 'New session', '/home/u/shared-proj');
    seed('sid-2', 'New session', '/home/u/shared-proj');
    seed('sid-3', 'New session', '/home/u/shared-proj');

    await useStore.getState()._backfillTitles();

    expect(listForProject).toHaveBeenCalledTimes(1);
    // projectKey is `cwd.replace(/[\\/:]/g, '-')`.
    expect(listForProject).toHaveBeenCalledWith('-home-u-shared-proj');
    const after = useStore.getState().sessions;
    expect(after.find((s) => s.id === 'sid-1')?.name).toBe('s1');
    expect(after.find((s) => s.id === 'sid-2')?.name).toBe('s2');
    expect(after.find((s) => s.id === 'sid-3')?.name).toBe('s3');
  });

  it('makes one IPC per unique projectKey when sessions span multiple projects', async () => {
    const { listForProject } = installBridge(async (key) => {
      if (key === '-a') return [{ sid: 'sid-a', summary: 'sum-a', mtime: 1 }];
      if (key === '-b') return [{ sid: 'sid-b', summary: 'sum-b', mtime: 2 }];
      return [];
    });
    seed('sid-a', 'New session', '/a');
    seed('sid-b', 'New session', '/b');

    await useStore.getState()._backfillTitles();

    expect(listForProject).toHaveBeenCalledTimes(2);
    const keys = listForProject.mock.calls.map((c) => c[0]).sort();
    expect(keys).toEqual(['-a', '-b']);
  });

  it('listForProject rejects → silent warn, other projects still patched', async () => {
    installBridge(async (key) => {
      if (key === '-bad') throw new Error('boom');
      if (key === '-good') return [{ sid: 'sid-g', summary: 'good-sum', mtime: 1 }];
      return [];
    });
    seed('sid-bad', 'New session', '/bad');
    seed('sid-g', 'New session', '/good');

    await useStore.getState()._backfillTitles();

    // Bad project: name unchanged.
    expect(useStore.getState().sessions.find((s) => s.id === 'sid-bad')?.name).toBe(
      'New session'
    );
    // Good project: still patched.
    expect(useStore.getState().sessions.find((s) => s.id === 'sid-g')?.name).toBe(
      'good-sum'
    );
    expect(warnSpy).toHaveBeenCalled();
  });

  it('no bridge available: no-op, no throw', async () => {
    delete (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles;
    seed('sid-x', 'New session', '/x');

    await expect(useStore.getState()._backfillTitles()).resolves.toBeUndefined();
    expect(useStore.getState().sessions.find((s) => s.id === 'sid-x')?.name).toBe(
      'New session'
    );
  });

  it('null/empty summary is ignored (no overwrite with empty string)', async () => {
    installBridge(async () => [
      { sid: 'sid-null', summary: null, mtime: 1 },
      { sid: 'sid-empty', summary: '', mtime: 2 },
    ]);
    seed('sid-null', 'New session', '/proj-empty');
    seed('sid-empty', 'New session', '/proj-empty');

    await useStore.getState()._backfillTitles();

    expect(useStore.getState().sessions.find((s) => s.id === 'sid-null')?.name).toBe(
      'New session'
    );
    expect(useStore.getState().sessions.find((s) => s.id === 'sid-empty')?.name).toBe(
      'New session'
    );
  });

  it('skips sessions with empty cwd (no projectKey to look up)', async () => {
    const { listForProject } = installBridge(async () => []);
    seed('sid-no-cwd', 'New session', '');

    await useStore.getState()._backfillTitles();

    expect(listForProject).not.toHaveBeenCalled();
    expect(useStore.getState().sessions.find((s) => s.id === 'sid-no-cwd')?.name).toBe(
      'New session'
    );
  });

  it('summary for a sid not in our store is silently ignored', async () => {
    installBridge(async () => [
      { sid: 'unknown-sid', summary: 'dangling', mtime: 1 },
      { sid: 'sid-known', summary: 'known-sum', mtime: 2 },
    ]);
    seed('sid-known', 'New session', '/proj-mixed');

    await useStore.getState()._backfillTitles();

    const sessions = useStore.getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('known-sum');
  });
});
