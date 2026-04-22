// WorktreeManager — the singleton responsible for binding a session to a
// disposable git worktree. Lifecycle:
//
//   SessionRunner.start()  →  (optional) worktreeManager.create(sessionId, ...)
//   SessionRunner close    →  worktreeManager.remove(sessionId)
//
// The manager persists a `WorktreeRecord` per session in SQLite via the
// injectable storage adapter; at boot, `reconcileOrphans()` walks every
// known repoRoot and reconciles sqlite rows against `git worktree list`,
// pruning anything that's drifted (directory vanished out-of-band, or
// directory exists without a record).
//
// Injection: storage + git are passed in at construction time so the unit
// tests can substitute in-memory / fake implementations without spinning up
// SQLite or shelling out to git. Production wiring (see main.ts in Commit
// B) hands in the real sqlite-backed adapter and the real git helpers.

import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as GitHelpers from './git-helpers';

export interface WorktreeRecord {
  sessionId: string;
  name: string;
  path: string;
  baseRepo: string;
  branch: string;
  sourceBranch: string | null;
  createdAt: number;
}

/**
 * Storage adapter contract. The production adapter in Commit B thin-wraps
 * better-sqlite3; tests use an in-memory Map. Kept synchronous because the
 * underlying sqlite calls are synchronous and we want `getBySession()` to
 * be cheap to call from anywhere.
 */
export interface WorktreeStorage {
  save(rec: WorktreeRecord): void;
  remove(sessionId: string): void;
  getBySession(sessionId: string): WorktreeRecord | null;
  listAll(): WorktreeRecord[];
}

/** Git surface the manager depends on. Mirrors `git-helpers` 1:1 so tests can
 * stub per-method without having to spawn a subprocess. */
export interface GitSurface {
  fetchOrigin(repoRoot: string): Promise<{ fetched: boolean; throttled?: boolean; error?: string }>;
  getCurrentBranch(repoRoot: string): Promise<string | null>;
  createWorktree(args: GitHelpers.CreateWorktreeArgs): Promise<void>;
  removeWorktree(worktreePath: string): Promise<void>;
  listWorktrees(repoRoot: string): Promise<GitHelpers.WorktreeListEntry[]>;
  pruneWorktrees(repoRoot: string): Promise<void>;
}

/** Production git surface — delegates straight through. */
export const defaultGitSurface: GitSurface = {
  fetchOrigin: GitHelpers.fetchOrigin,
  getCurrentBranch: GitHelpers.getCurrentBranch,
  createWorktree: GitHelpers.createWorktree,
  removeWorktree: GitHelpers.removeWorktree,
  listWorktrees: GitHelpers.listWorktrees,
  pruneWorktrees: GitHelpers.pruneWorktrees,
};

// ─────────────────────────── name generator ───────────────────────────────
//
// adjective-noun-<hex6>. 10×10=100 adjective/noun combos × 16^6 hex tails =
// enough entropy that collisions on the same host are astronomically rare
// for a dev's session count. The dictionary is intentionally small and
// English-safe: every pair yields a pronounceable, lowercase identifier
// that's also a valid directory name on every supported OS.

const ADJECTIVES = [
  'brisk', 'calm', 'dusky', 'eager', 'fair',
  'glad', 'keen', 'mild', 'proud', 'swift',
];

const NOUNS = [
  'badger', 'cedar', 'delta', 'ember', 'falcon',
  'grove', 'harbor', 'iris', 'juniper', 'kestrel',
];

interface RandomSource {
  pick(max: number): number;
  hex(bytes: number): string;
}

const cryptoRandom: RandomSource = {
  pick: (max) => {
    // Bias-safe: reject samples ≥ floor(256/max)*max. For our max=10, the
    // bias without rejection would be negligible, but it's two lines to do
    // this right.
    if (max <= 0) throw new Error('pick(max<=0)');
    const limit = Math.floor(256 / max) * max;
    for (;;) {
      const b = randomBytes(1)[0];
      if (b < limit) return b % max;
    }
  },
  hex: (bytes) => randomBytes(bytes).toString('hex'),
};

/**
 * Generate a `<adj>-<noun>-<hex>` name. Exposed for tests — callers should
 * normally go through `WorktreeManager.generateUniqueName()`.
 */
export function generateName(random: RandomSource = cryptoRandom): string {
  const adj = ADJECTIVES[random.pick(ADJECTIVES.length)];
  const noun = NOUNS[random.pick(NOUNS.length)];
  const tail = random.hex(3); // 3 bytes = 6 hex chars
  return `${adj}-${noun}-${tail}`;
}

/**
 * Resolve the filesystem parent dir under which a worktree `<name>` will be
 * created. MVP: always `<repoRoot>/.claude/worktrees/<name>`. Exposed for
 * tests and for Commit B's future settings override path.
 */
export function resolveWorktreePath(repoRoot: string, name: string): string {
  return path.resolve(repoRoot, '.claude', 'worktrees', name);
}

/**
 * Branch name we hand to `git worktree add -b <branch>`. Using the same
 * string as the worktree name keeps things traceable without adding another
 * identifier axis.
 */
export function branchNameForWorktree(name: string): string {
  return `worktree-${name}`;
}

// ─────────────────────────────── manager ──────────────────────────────────

export interface WorktreeManagerOptions {
  storage: WorktreeStorage;
  git?: GitSurface;
  random?: RandomSource;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injection point for logger spies; defaults to console.warn. */
  warn?: (msg: string, err?: unknown) => void;
}

export class WorktreeManager {
  private readonly storage: WorktreeStorage;
  private readonly git: GitSurface;
  private readonly random: RandomSource;
  private readonly now: () => number;
  private readonly warn: (msg: string, err?: unknown) => void;

  constructor(opts: WorktreeManagerOptions) {
    this.storage = opts.storage;
    this.git = opts.git ?? defaultGitSurface;
    this.random = opts.random ?? cryptoRandom;
    this.now = opts.now ?? (() => Date.now());
    this.warn = opts.warn ?? ((msg, err) => console.warn('[worktree]', msg, err));
  }

  /**
   * Pick a name that doesn't already exist in storage. Retries a small number
   * of times before falling back to the raw hex suffix — even at thousands
   * of worktrees the two-word dictionary only collides on the hex tail, so
   * in practice one try is enough.
   */
  generateUniqueName(): string {
    const known = new Set(this.storage.listAll().map((r) => r.name));
    for (let i = 0; i < 8; i++) {
      const candidate = generateName(this.random);
      if (!known.has(candidate)) return candidate;
    }
    // Pathological fallback: pure hex, longer.
    return `wt-${this.random.hex(8)}`;
  }

  /** Existing record for a session, or null. */
  getBySession(sessionId: string): WorktreeRecord | null {
    return this.storage.getBySession(sessionId);
  }

  /**
   * Create a worktree for the given session. Idempotent: calling twice for
   * the same sessionId returns the existing record without re-creating.
   * Rolls back the sqlite row if `git worktree add` throws.
   */
  async create(
    sessionId: string,
    repoRoot: string,
    sourceBranch?: string
  ): Promise<WorktreeRecord> {
    const existing = this.storage.getBySession(sessionId);
    if (existing) return existing;

    const absRepo = path.resolve(repoRoot);

    // Best-effort fetch; don't block creation on a failure (offline dev,
    // private mirror, etc.). The throttle lives inside fetchOrigin itself.
    await this.git.fetchOrigin(absRepo).catch((err) => {
      this.warn('fetchOrigin failed — proceeding without remote refresh', err);
      return { fetched: false };
    });

    const resolvedSource =
      sourceBranch?.trim() ||
      (await this.git.getCurrentBranch(absRepo)) ||
      'HEAD';

    const name = this.generateUniqueName();
    const worktreePath = resolveWorktreePath(absRepo, name);
    const branch = branchNameForWorktree(name);

    await this.git.createWorktree({
      repoRoot: absRepo,
      worktreePath,
      branch,
      sourceBranch: resolvedSource,
    });

    const record: WorktreeRecord = {
      sessionId,
      name,
      path: worktreePath,
      baseRepo: absRepo,
      branch,
      sourceBranch: resolvedSource,
      createdAt: this.now(),
    };

    try {
      this.storage.save(record);
    } catch (err) {
      // Storage failed post-create — nuke the worktree so we don't leak disk.
      await this.git.removeWorktree(worktreePath).catch((cleanupErr) => {
        this.warn('rollback: removeWorktree failed', cleanupErr);
      });
      throw err;
    }

    return record;
  }

  /**
   * Remove a session's worktree. Safe to call even if no record exists
   * (returns without error). Continues to delete the sqlite row even if
   * `git worktree remove` fails, so a stale sqlite entry never blocks the
   * session from being closed.
   */
  async remove(sessionId: string): Promise<void> {
    const record = this.storage.getBySession(sessionId);
    if (!record) return;
    try {
      await this.git.removeWorktree(record.path);
    } catch (err) {
      this.warn(`removeWorktree(${record.path}) failed — dropping DB row anyway`, err);
    }
    this.storage.remove(sessionId);
  }

  /**
   * Boot-time cleanup. For every distinct baseRepo we know about:
   *   1. `git worktree list --porcelain` → set of currently-registered paths
   *   2. For each sqlite record:
   *        - record.path NOT in the list → delete the sqlite row (the dir
   *          was already nuked externally; nothing to clean on disk).
   *   3. `git worktree prune` to sweep the git-side metadata for any
   *      directories users deleted by hand.
   *
   * We deliberately DON'T remove unknown worktrees that git knows about but
   * sqlite doesn't — those might be the user's own manual worktrees, and
   * this manager has no claim on them.
   *
   * Best-effort: any per-repo failure is logged and the next repo continues.
   */
  async reconcileOrphans(): Promise<void> {
    const records = this.storage.listAll();
    if (records.length === 0) return;

    const byRepo = new Map<string, WorktreeRecord[]>();
    for (const rec of records) {
      const key = path.resolve(rec.baseRepo);
      const list = byRepo.get(key) ?? [];
      list.push(rec);
      byRepo.set(key, list);
    }

    for (const [repoRoot, recs] of byRepo) {
      try {
        const live = await this.git.listWorktrees(repoRoot);
        const livePaths = new Set(live.map((e) => path.resolve(e.path)));
        for (const rec of recs) {
          if (!livePaths.has(path.resolve(rec.path))) {
            this.storage.remove(rec.sessionId);
          }
        }
        await this.git.pruneWorktrees(repoRoot).catch((err) => {
          this.warn(`pruneWorktrees(${repoRoot}) failed`, err);
        });
      } catch (err) {
        this.warn(`reconcileOrphans: repo ${repoRoot} skipped`, err);
      }
    }
  }
}

// ────────────────────────────── singleton ─────────────────────────────────
//
// Lazily initialised so main.ts can construct and install the sqlite-backed
// storage before anyone asks for the manager. Commit B wires the init.

let _instance: WorktreeManager | null = null;

export function installWorktreeManager(instance: WorktreeManager): void {
  _instance = instance;
}

export function getWorktreeManager(): WorktreeManager {
  if (!_instance) {
    throw new Error('WorktreeManager not installed — call installWorktreeManager() from main.ts');
  }
  return _instance;
}

/** Test-only — wipe the singleton between cases. */
export function __resetWorktreeManagerForTests(): void {
  _instance = null;
}
