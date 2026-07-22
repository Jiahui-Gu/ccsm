import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSessionTitleBackfillSlice } from '../../../src/stores/slices/sessionTitleBackfillSlice';
import {
  setPendingManualRename,
  _resetPendingManualRenamesForTests,
} from '../../../src/stores/lib/pendingManualRenames';
import type { RootStore } from '../../../src/stores/slices/types';
import type { Session } from '../../../src/types';

// Title backfill slice owns `_applyExternalTitle` (raw name patch) and
// `_backfillTitles` (one-shot SDK pull). Backfill consumes the patch
// helper via `get()._applyExternalTitle`, so the harness mounts only
// the backfill slice on a minimal root.
function harness(initial?: Partial<RootStore>) {
  let state: Partial<RootStore> = {
    sessions: [],
    ...initial,
  };
  const set = (
    partial: Partial<RootStore> | ((s: RootStore) => Partial<RootStore> | RootStore)
  ) => {
    const patch = typeof partial === 'function' ? partial(state as RootStore) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state as RootStore;
  const titles = createSessionTitleBackfillSlice(set, get);
  state = { ...state, ...titles, ...initial };
  return { state: () => state, titles, set, get };
}

function mkSession(id: string, groupId: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    name: `s-${id}`,
    state: 'idle',
    cwd: '/tmp',
    model: '',
    groupId,
    agentType: 'claude-code',
    ...extra,
  };
}

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

describe('sessionTitleBackfillSlice', () => {
  beforeEach(() => {
    (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles = undefined;
    _resetPendingManualRenamesForTests();
  });
  afterEach(() => {
    (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles = undefined;
    _resetPendingManualRenamesForTests();
  });

  it('_applyExternalTitle patches matching default-named session, no-op for unknowns', () => {
    const h = harness({
      sessions: [mkSession('a', 'g1', { name: 'New session' })],
    });
    h.titles._applyExternalTitle('a', 'new');
    expect(h.state().sessions[0].name).toBe('new');
    h.titles._applyExternalTitle('zzz', 'ignored');
    expect(h.state().sessions[0].name).toBe('new');
  });

  it('_applyExternalTitle is a no-op when name unchanged (reference stable)', () => {
    const h = harness({ sessions: [mkSession('a', 'g1', { name: 'same' })] });
    const before = h.state().sessions;
    h.titles._applyExternalTitle('a', 'same');
    expect(h.state().sessions).toBe(before);
  });

  it('_applyExternalTitle is a no-op once the session has a non-default name', () => {
    // claude TUI re-emits the OSC title every prompt; before the
    // first-write-wins guard the session name flickered between turns.
    // Only the default placeholder ('New session' / '新会话') is
    // overwritable — anything else is treated as authoritative.
    const h = harness({
      sessions: [mkSession('a', 'g1', { name: 'first turn summary' })],
    });
    const before = h.state().sessions;
    h.titles._applyExternalTitle('a', 'second turn rewrites the title');
    expect(h.state().sessions).toBe(before);
    expect(h.state().sessions[0].name).toBe('first turn summary');
  });

  it('_applyExternalTitle overwrites the legacy zh default placeholder', () => {
    const h = harness({
      sessions: [mkSession('a', 'g1', { name: '新会话' })],
    });
    h.titles._applyExternalTitle('a', 'auto-named');
    expect(h.state().sessions[0].name).toBe('auto-named');
  });

  it('_backfillTitles is a no-op when no bridge is present', async () => {
    const h = harness({
      sessions: [mkSession('a', 'g1', { name: 'New session', cwd: '/some/proj' })],
    });
    await h.titles._backfillTitles();
    // No bridge -> name remains the default placeholder.
    expect(h.state().sessions[0].name).toBe('New session');
  });

  it('_applyExternalTitle drops stale auto-summary while a manual rename is pending', () => {
    // User just renamed sid 'a' to 'My label'; the titleEmitter races a
    // stale summary 'Old summary' before the JSONL rewrite lands. Without
    // the pending-manual-rename guard the user's name flicks back.
    const h = harness({
      sessions: [mkSession('a', 'g1', { name: 'My label' })],
    });
    setPendingManualRename('a', 'My label');
    h.titles._applyExternalTitle('a', 'Old summary');
    expect(h.state().sessions[0].name).toBe('My label');
  });

  it('_applyExternalTitle clears the guard on round-trip then ignores later OSC titles', () => {
    const h = harness({
      sessions: [mkSession('a', 'g1', { name: 'My label' })],
    });
    setPendingManualRename('a', 'My label');
    // First the JSONL rewrite lands: external title matches desired -> guard clears.
    h.titles._applyExternalTitle('a', 'My label');
    expect(h.state().sessions[0].name).toBe('My label');
    // Later claude TUI re-emits the OSC title for a new prompt. The
    // session already has a non-default name (user-renamed), so the
    // first-write-wins guard drops the patch — the user's label sticks.
    h.titles._applyExternalTitle('a', 'Renamed by claude');
    expect(h.state().sessions[0].name).toBe('My label');
  });
});

// `_backfillTitles` bridge-driven cases. `_backfillTitles` only depends on
// `get().sessions` and `get()._applyExternalTitle` (see
// src/stores/slices/sessionTitleBackfillSlice.ts), both present on the
// harness, so the full-store-only cases formerly in
// tests/store-backfill-titles.test.ts port cleanly onto the slice harness.
describe('_backfillTitles (bridge-driven)', () => {
  beforeEach(() => {
    (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles = undefined;
    _resetPendingManualRenamesForTests();
  });
  afterEach(() => {
    delete (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles;
    _resetPendingManualRenamesForTests();
  });

  it('patches default-named session with SDK summary', async () => {
    installBridge(async () => [
      { sid: 'sid-A', summary: 'Refactor login page', mtime: 1 },
    ]);
    const h = harness({
      sessions: [mkSession('sid-A', 'g1', { name: 'New session', cwd: '/home/u/proj-A' })],
    });

    await h.titles._backfillTitles();

    expect(h.state().sessions.find((s) => s.id === 'sid-A')?.name).toBe(
      'Refactor login page'
    );
  });

  it('also patches Chinese default name 新会话', async () => {
    installBridge(async () => [
      { sid: 'sid-zh', summary: 'Localized summary', mtime: 1 },
    ]);
    const h = harness({
      sessions: [mkSession('sid-zh', 'g1', { name: '新会话', cwd: '/home/u/proj-zh' })],
    });

    await h.titles._backfillTitles();

    expect(h.state().sessions.find((s) => s.id === 'sid-zh')?.name).toBe(
      'Localized summary'
    );
  });

  it('never overwrites a user-renamed session, even if SDK has a summary', async () => {
    installBridge(async () => [
      { sid: 'sid-keep', summary: 'auto-derived', mtime: 1 },
    ]);
    const h = harness({
      sessions: [mkSession('sid-keep', 'g1', { name: 'My custom name', cwd: '/home/u/proj-keep' })],
    });

    await h.titles._backfillTitles();

    expect(h.state().sessions.find((s) => s.id === 'sid-keep')?.name).toBe(
      'My custom name'
    );
  });

  it('batches sessions by projectKey: ONE IPC call for many sids in same project', async () => {
    const { listForProject } = installBridge(async () => [
      { sid: 'sid-1', summary: 's1', mtime: 1 },
      { sid: 'sid-2', summary: 's2', mtime: 2 },
      { sid: 'sid-3', summary: 's3', mtime: 3 },
    ]);
    const h = harness({
      sessions: [
        mkSession('sid-1', 'g1', { name: 'New session', cwd: '/home/u/shared-proj' }),
        mkSession('sid-2', 'g1', { name: 'New session', cwd: '/home/u/shared-proj' }),
        mkSession('sid-3', 'g1', { name: 'New session', cwd: '/home/u/shared-proj' }),
      ],
    });

    await h.titles._backfillTitles();

    expect(listForProject).toHaveBeenCalledTimes(1);
    // projectKey is `cwd.replace(/[\\/:]/g, '-')`.
    expect(listForProject).toHaveBeenCalledWith('-home-u-shared-proj');
    const after = h.state().sessions;
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
    const h = harness({
      sessions: [
        mkSession('sid-a', 'g1', { name: 'New session', cwd: '/a' }),
        mkSession('sid-b', 'g1', { name: 'New session', cwd: '/b' }),
      ],
    });

    await h.titles._backfillTitles();

    expect(listForProject).toHaveBeenCalledTimes(2);
    const keys = listForProject.mock.calls.map((c) => c[0]).sort();
    expect(keys).toEqual(['-a', '-b']);
  });

  it('listForProject rejects -> silent warn, other projects still patched', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installBridge(async (key) => {
      if (key === '-bad') throw new Error('boom');
      if (key === '-good') return [{ sid: 'sid-g', summary: 'good-sum', mtime: 1 }];
      return [];
    });
    const h = harness({
      sessions: [
        mkSession('sid-bad', 'g1', { name: 'New session', cwd: '/bad' }),
        mkSession('sid-g', 'g1', { name: 'New session', cwd: '/good' }),
      ],
    });

    await h.titles._backfillTitles();

    // Bad project: name unchanged.
    expect(h.state().sessions.find((s) => s.id === 'sid-bad')?.name).toBe(
      'New session'
    );
    // Good project: still patched.
    expect(h.state().sessions.find((s) => s.id === 'sid-g')?.name).toBe(
      'good-sum'
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('null/empty summary is ignored (no overwrite with empty string)', async () => {
    installBridge(async () => [
      { sid: 'sid-null', summary: null, mtime: 1 },
      { sid: 'sid-empty', summary: '', mtime: 2 },
    ]);
    const h = harness({
      sessions: [
        mkSession('sid-null', 'g1', { name: 'New session', cwd: '/proj-empty' }),
        mkSession('sid-empty', 'g1', { name: 'New session', cwd: '/proj-empty' }),
      ],
    });

    await h.titles._backfillTitles();

    expect(h.state().sessions.find((s) => s.id === 'sid-null')?.name).toBe(
      'New session'
    );
    expect(h.state().sessions.find((s) => s.id === 'sid-empty')?.name).toBe(
      'New session'
    );
  });

  it('skips sessions with empty cwd (no projectKey to look up)', async () => {
    const { listForProject } = installBridge(async () => []);
    const h = harness({
      sessions: [mkSession('sid-no-cwd', 'g1', { name: 'New session', cwd: '' })],
    });

    await h.titles._backfillTitles();

    expect(listForProject).not.toHaveBeenCalled();
    expect(h.state().sessions.find((s) => s.id === 'sid-no-cwd')?.name).toBe(
      'New session'
    );
  });

  it('summary for a sid not in our store is silently ignored', async () => {
    installBridge(async () => [
      { sid: 'unknown-sid', summary: 'dangling', mtime: 1 },
      { sid: 'sid-known', summary: 'known-sum', mtime: 2 },
    ]);
    const h = harness({
      sessions: [mkSession('sid-known', 'g1', { name: 'New session', cwd: '/proj-mixed' })],
    });

    await h.titles._backfillTitles();

    const sessions = h.state().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('known-sum');
  });
});
