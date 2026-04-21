import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import {
  WorktreeManager,
  type WorktreeStorage,
  type WorktreeRecord,
  type GitSurface,
  generateName,
  resolveWorktreePath,
  branchNameForWorktree,
} from '../worktree-manager';
import type { WorktreeListEntry, CreateWorktreeArgs } from '../git-helpers';

// ───────────────────────────── helpers ─────────────────────────────────

function createMemoryStorage(): WorktreeStorage & { rows: Map<string, WorktreeRecord> } {
  const rows = new Map<string, WorktreeRecord>();
  return {
    rows,
    save: (rec) => {
      rows.set(rec.sessionId, { ...rec });
    },
    remove: (sessionId) => {
      rows.delete(sessionId);
    },
    getBySession: (sessionId) => {
      const r = rows.get(sessionId);
      return r ? { ...r } : null;
    },
    listAll: () => Array.from(rows.values()).map((r) => ({ ...r })),
  };
}

function createFakeGit(): GitSurface & {
  fetchOrigin: ReturnType<typeof vi.fn>;
  getCurrentBranch: ReturnType<typeof vi.fn>;
  createWorktree: ReturnType<typeof vi.fn>;
  removeWorktree: ReturnType<typeof vi.fn>;
  listWorktrees: ReturnType<typeof vi.fn>;
  pruneWorktrees: ReturnType<typeof vi.fn>;
} {
  return {
    fetchOrigin: vi.fn(async () => ({ fetched: true })),
    getCurrentBranch: vi.fn(async () => 'main'),
    createWorktree: vi.fn(async (_args: CreateWorktreeArgs) => {}),
    removeWorktree: vi.fn(async (_p: string) => {}),
    listWorktrees: vi.fn(async (_repo: string): Promise<WorktreeListEntry[]> => []),
    pruneWorktrees: vi.fn(async (_repo: string) => {}),
  };
}

// A deterministic "random" source: we hand it a canned sequence and it
// serves picks/hex in that order. Lets us assert generated names exactly.
function scriptedRandom(
  picks: number[],
  hexes: string[]
): { pick: (max: number) => number; hex: (bytes: number) => string } {
  let pi = 0;
  let hi = 0;
  return {
    pick: (max) => {
      const v = picks[pi++];
      return v % max;
    },
    hex: (_bytes) => hexes[hi++],
  };
}

// ────────────────────────────── name generator ───────────────────────

describe('generateName', () => {
  it('produces <adj>-<noun>-<hex>', () => {
    const random = scriptedRandom([0, 0], ['deadbe']);
    const name = generateName(random);
    expect(name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{6}$/);
    expect(name.endsWith('-deadbe')).toBe(true);
  });

  it('varies across calls when random is real crypto', () => {
    const a = generateName();
    const b = generateName();
    // Not a bulletproof test, but 1/100 * 1/16^6 collision is ~6e-11.
    expect(a).not.toBe(b);
  });
});

describe('resolveWorktreePath', () => {
  it('always returns an absolute path under .claude/worktrees/', () => {
    const p = resolveWorktreePath('/tmp/repo', 'swift-falcon-abc123');
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toContain(path.join('.claude', 'worktrees', 'swift-falcon-abc123'));
  });

  it('resolves relative repoRoot to absolute', () => {
    const p = resolveWorktreePath('./repo', 'x');
    expect(path.isAbsolute(p)).toBe(true);
  });
});

describe('branchNameForWorktree', () => {
  it('prefixes the name so it never shadows a user branch', () => {
    expect(branchNameForWorktree('swift-falcon-abc123')).toBe('worktree-swift-falcon-abc123');
  });
});

// ───────────────────────────── create() ──────────────────────────────

describe('WorktreeManager.create', () => {
  let storage: ReturnType<typeof createMemoryStorage>;
  let git: ReturnType<typeof createFakeGit>;
  let mgr: WorktreeManager;

  beforeEach(() => {
    storage = createMemoryStorage();
    git = createFakeGit();
    mgr = new WorktreeManager({
      storage,
      git,
      random: scriptedRandom([0, 0], ['abcdef']),
      now: () => 1_700_000_000_000,
      warn: () => {},
    });
  });

  it('fetches origin, creates the worktree, and persists a record', async () => {
    const rec = await mgr.create('sess-1', '/tmp/repo', 'working');

    expect(git.fetchOrigin).toHaveBeenCalledWith(path.resolve('/tmp/repo'));
    expect(git.createWorktree).toHaveBeenCalledTimes(1);
    const callArg = git.createWorktree.mock.calls[0][0] as CreateWorktreeArgs;
    expect(callArg.repoRoot).toBe(path.resolve('/tmp/repo'));
    expect(callArg.sourceBranch).toBe('working');
    expect(callArg.branch).toBe(rec.branch);
    expect(rec.name).toMatch(/^[a-z]+-[a-z]+-abcdef$/);
    expect(rec.path).toBe(callArg.worktreePath);
    expect(rec.createdAt).toBe(1_700_000_000_000);

    expect(storage.rows.get('sess-1')).toEqual(rec);
  });

  it('defaults sourceBranch to getCurrentBranch() when caller omits it', async () => {
    git.getCurrentBranch.mockResolvedValue('feature-x');
    await mgr.create('sess-1', '/tmp/repo');
    const callArg = git.createWorktree.mock.calls[0][0] as CreateWorktreeArgs;
    expect(callArg.sourceBranch).toBe('feature-x');
  });

  it('falls back to "main" when HEAD is detached and caller omits sourceBranch', async () => {
    git.getCurrentBranch.mockResolvedValue(null);
    await mgr.create('sess-1', '/tmp/repo');
    const callArg = git.createWorktree.mock.calls[0][0] as CreateWorktreeArgs;
    expect(callArg.sourceBranch).toBe('main');
  });

  it('is idempotent — second call returns the first record and does not touch git', async () => {
    const first = await mgr.create('sess-1', '/tmp/repo', 'working');
    git.createWorktree.mockClear();
    git.fetchOrigin.mockClear();
    const second = await mgr.create('sess-1', '/tmp/repo', 'working');
    expect(second).toEqual(first);
    expect(git.createWorktree).not.toHaveBeenCalled();
    expect(git.fetchOrigin).not.toHaveBeenCalled();
  });

  it('proceeds even when fetchOrigin rejects', async () => {
    git.fetchOrigin.mockRejectedValue(new Error('network down'));
    const rec = await mgr.create('sess-1', '/tmp/repo', 'working');
    expect(rec.sessionId).toBe('sess-1');
    expect(git.createWorktree).toHaveBeenCalled();
  });

  it('rolls back on storage failure by removing the freshly-made worktree', async () => {
    const badStorage: WorktreeStorage = {
      save: () => {
        throw new Error('disk full');
      },
      remove: () => {},
      getBySession: () => null,
      listAll: () => [],
    };
    const rollbackMgr = new WorktreeManager({
      storage: badStorage,
      git,
      random: scriptedRandom([0, 0], ['abcdef']),
      now: () => 1,
      warn: () => {},
    });
    await expect(rollbackMgr.create('s', '/tmp/repo', 'main')).rejects.toThrow('disk full');
    expect(git.removeWorktree).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────── remove() ──────────────────────────────

describe('WorktreeManager.remove', () => {
  it('deletes the git worktree and the sqlite row', async () => {
    const storage = createMemoryStorage();
    const git = createFakeGit();
    storage.save({
      sessionId: 'sess-1',
      name: 'swift-falcon-aaa111',
      path: '/tmp/repo/.claude/worktrees/swift-falcon-aaa111',
      baseRepo: '/tmp/repo',
      branch: 'worktree-swift-falcon-aaa111',
      sourceBranch: 'main',
      createdAt: 1,
    });
    const mgr = new WorktreeManager({ storage, git, warn: () => {} });

    await mgr.remove('sess-1');

    expect(git.removeWorktree).toHaveBeenCalledWith('/tmp/repo/.claude/worktrees/swift-falcon-aaa111');
    expect(storage.rows.has('sess-1')).toBe(false);
  });

  it('no-ops when no record exists', async () => {
    const storage = createMemoryStorage();
    const git = createFakeGit();
    const mgr = new WorktreeManager({ storage, git, warn: () => {} });
    await expect(mgr.remove('unknown')).resolves.toBeUndefined();
    expect(git.removeWorktree).not.toHaveBeenCalled();
  });

  it('still drops the sqlite row even if removeWorktree fails', async () => {
    const storage = createMemoryStorage();
    const git = createFakeGit();
    git.removeWorktree.mockRejectedValue(new Error('git borked'));
    storage.save({
      sessionId: 'sess-1',
      name: 'n',
      path: '/tmp/repo/.claude/worktrees/n',
      baseRepo: '/tmp/repo',
      branch: 'worktree-n',
      sourceBranch: 'main',
      createdAt: 1,
    });
    const mgr = new WorktreeManager({ storage, git, warn: () => {} });
    await mgr.remove('sess-1');
    expect(storage.rows.has('sess-1')).toBe(false);
  });
});

// ───────────────────────── reconcileOrphans() ────────────────────────

describe('WorktreeManager.reconcileOrphans', () => {
  it('drops sqlite rows for worktrees git no longer knows about, keeps live ones', async () => {
    const storage = createMemoryStorage();
    const git = createFakeGit();

    storage.save({
      sessionId: 'live',
      name: 'live-one',
      path: '/tmp/repo/.claude/worktrees/live-one',
      baseRepo: '/tmp/repo',
      branch: 'worktree-live-one',
      sourceBranch: 'main',
      createdAt: 1,
    });
    storage.save({
      sessionId: 'dead',
      name: 'dead-one',
      path: '/tmp/repo/.claude/worktrees/dead-one',
      baseRepo: '/tmp/repo',
      branch: 'worktree-dead-one',
      sourceBranch: 'main',
      createdAt: 2,
    });

    git.listWorktrees.mockResolvedValue([
      { path: '/tmp/repo', isMain: true },
      { path: '/tmp/repo/.claude/worktrees/live-one' },
    ]);

    const mgr = new WorktreeManager({ storage, git, warn: () => {} });
    await mgr.reconcileOrphans();

    expect(storage.rows.has('live')).toBe(true);
    expect(storage.rows.has('dead')).toBe(false);
    expect(git.pruneWorktrees).toHaveBeenCalledWith(path.resolve('/tmp/repo'));
  });

  it('groups by repoRoot and continues to the next repo if one throws', async () => {
    const storage = createMemoryStorage();
    const git = createFakeGit();

    storage.save({
      sessionId: 'r1',
      name: 'r1',
      path: '/tmp/repoA/.claude/worktrees/r1',
      baseRepo: '/tmp/repoA',
      branch: 'worktree-r1',
      sourceBranch: 'main',
      createdAt: 1,
    });
    storage.save({
      sessionId: 'r2',
      name: 'r2',
      path: '/tmp/repoB/.claude/worktrees/r2',
      baseRepo: '/tmp/repoB',
      branch: 'worktree-r2',
      sourceBranch: 'main',
      createdAt: 2,
    });

    git.listWorktrees.mockImplementation(async (repo: string) => {
      if (repo.endsWith('repoA')) throw new Error('A boom');
      return [{ path: '/tmp/repoB', isMain: true }]; // repoB's r2 is orphaned
    });

    const mgr = new WorktreeManager({ storage, git, warn: () => {} });
    await mgr.reconcileOrphans();

    // repoA skipped → row stays; repoB reconciled → r2 dropped.
    expect(storage.rows.has('r1')).toBe(true);
    expect(storage.rows.has('r2')).toBe(false);
  });

  it('no-ops cleanly when there are no records', async () => {
    const storage = createMemoryStorage();
    const git = createFakeGit();
    const mgr = new WorktreeManager({ storage, git, warn: () => {} });
    await mgr.reconcileOrphans();
    expect(git.listWorktrees).not.toHaveBeenCalled();
  });
});

// ─────────────── generateUniqueName collision avoidance ──────────────

describe('WorktreeManager.generateUniqueName', () => {
  it('skips names already present in storage', () => {
    const storage = createMemoryStorage();
    storage.save({
      sessionId: 's',
      name: 'brisk-badger-aaaaaa',
      path: '/p',
      baseRepo: '/r',
      branch: 'worktree-brisk-badger-aaaaaa',
      sourceBranch: 'main',
      createdAt: 1,
    });
    // picks [0,0] maps adjectives[0]=brisk nouns[0]=badger.
    // First hex collides with the stored name; second hex is fresh.
    const random = scriptedRandom([0, 0, 0, 0], ['aaaaaa', 'bbbbbb']);
    const mgr = new WorktreeManager({ storage, random, warn: () => {} });
    expect(mgr.generateUniqueName()).toBe('brisk-badger-bbbbbb');
  });
});
