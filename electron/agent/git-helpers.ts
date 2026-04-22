// Git helpers for worktree support. Every shell-out goes through `execFile`
// (not `exec`) with `shell: false` so user-supplied paths / branch names can't
// trigger shell interpretation. Errors are re-thrown as structured
// `GitCommandError` instances so callers can surface the failing argv + stderr
// to the UI without having to parse raw strings.
//
// Scope: only what worktree-manager needs. Anything more general-purpose
// (diffs, commits, etc.) lives elsewhere — keep this file small.

import { execFile } from 'node:child_process';
import * as path from 'node:path';

/**
 * Structured error thrown by every exported helper. Wraps the underlying
 * spawn / non-zero-exit failure with the exact argv we ran and whatever
 * stderr we captured, so callers can log or display diagnostics without
 * having to reach into a raw Error message.
 */
export class GitCommandError extends Error {
  constructor(
    message: string,
    public readonly args: readonly string[],
    public readonly stderr: string,
    public readonly code: number | null
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

/** Minimum timeout applied to every git invocation. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Default per-repo-root rate-limit window for fetchOrigin. */
const FETCH_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Long-paths is always on on Windows to survive nested worktree dirs in
 * `.claude/worktrees/<name>`. LFS smudge/process is disabled for worktree
 * creation specifically — large-file pulls on every branch add minutes to
 * what should be a subsecond operation, and the user doesn't need LFS
 * artefacts materialised in the worktree to run most dev workflows.
 */
const WIN_LONGPATH_ARG = ['-c', 'core.longpaths=true'];
const LFS_SKIP_ARGS = [
  '-c',
  'filter.lfs.smudge=',
  '-c',
  'filter.lfs.process=',
  '-c',
  'filter.lfs.required=false',
];

interface RunGitOptions {
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Low-level wrapper around `execFile('git', args)`. Always uses `shell: false`;
 * callers must never interpolate user input into a single string here.
 */
function runGit(
  args: readonly string[],
  opts: RunGitOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args as string[],
      {
        cwd: opts.cwd,
        shell: false,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const exitCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          const numericCode =
            typeof exitCode === 'number' ? exitCode : null;
          reject(
            new GitCommandError(
              `git ${args.join(' ')} failed: ${err.message}`,
              args,
              typeof stderr === 'string' ? stderr : String(stderr ?? ''),
              numericCode
            )
          );
          return;
        }
        resolve({
          stdout: typeof stdout === 'string' ? stdout : String(stdout),
          stderr: typeof stderr === 'string' ? stderr : String(stderr),
        });
      }
    );
  });
}

/**
 * `git rev-parse --show-toplevel` for the given cwd. Returns the absolute
 * path of the enclosing git repo, or null if cwd is not inside a repo.
 */
export async function resolveRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--show-toplevel'], { cwd });
    const p = stdout.trim();
    return p.length > 0 ? path.resolve(p) : null;
  } catch {
    return null;
  }
}

/**
 * `git rev-parse --git-dir`. Cheap probe for "is this inside a git repo?".
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--git-dir'], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * In-memory rate-limit table for fetchOrigin. Keyed by the absolute repoRoot.
 * A module-level Map is fine: this file is loaded once per main-process
 * lifecycle, and the limit is purely a nice-to-have to avoid hammering
 * origin every time the user opens the new-session dialog.
 *
 * Exposed for tests via `__resetFetchThrottleForTests`.
 */
const lastFetchAt = new Map<string, number>();

/** Test-only: clear the throttle state between cases. */
export function __resetFetchThrottleForTests(): void {
  lastFetchAt.clear();
}

/**
 * `git fetch origin`, rate-limited to once per repo root per 5 minutes.
 * Best-effort: returns `{ fetched: false }` without throwing if fetch fails,
 * since a missing network or permission error shouldn't block worktree
 * creation from a local branch.
 */
export async function fetchOrigin(
  repoRoot: string,
  opts: { now?: number; throttleMs?: number } = {}
): Promise<{ fetched: boolean; throttled?: boolean; error?: string }> {
  const abs = path.resolve(repoRoot);
  const now = opts.now ?? Date.now();
  const throttleMs = opts.throttleMs ?? FETCH_THROTTLE_MS;
  const last = lastFetchAt.get(abs);
  if (last !== undefined && now - last < throttleMs) {
    return { fetched: false, throttled: true };
  }
  try {
    await runGit(['fetch', 'origin'], { cwd: abs, timeoutMs: 120_000 });
    lastFetchAt.set(abs, now);
    return { fetched: true };
  } catch (err) {
    // Don't surface as a hard failure — origin might be offline, unconfigured,
    // or forbidden. Caller treats this as non-fatal.
    lastFetchAt.set(abs, now);
    return {
      fetched: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Current branch name (short form). Returns null if HEAD is detached.
 */
export async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
  });
  const name = stdout.trim();
  if (name.length === 0 || name === 'HEAD') return null;
  return name;
}

export interface CreateWorktreeArgs {
  repoRoot: string;
  worktreePath: string;
  /** New branch name to create at the worktree. */
  branch: string;
  /**
   * Local start point — typically the source repo's current HEAD (branch
   * name returned by `getCurrentBranch`, or `HEAD` for detached state).
   * Passed verbatim to `git worktree add` as the start ref so worktrees
   * always branch off whatever the user currently has checked out, with
   * no dependency on `origin/` being reachable.
   */
  sourceBranch: string;
}

/**
 * `git worktree add -b <branch> <path> <sourceBranch>`, with our standard
 * longpath + LFS-skip overrides. Both paths are resolved to absolute form
 * before being passed to git so relative-path ambiguity can't bite us.
 */
export async function createWorktree(args: CreateWorktreeArgs): Promise<void> {
  const absRoot = path.resolve(args.repoRoot);
  const absPath = path.resolve(args.worktreePath);
  await runGit(
    [
      ...WIN_LONGPATH_ARG,
      ...LFS_SKIP_ARGS,
      'worktree',
      'add',
      '-b',
      args.branch,
      absPath,
      args.sourceBranch,
    ],
    { cwd: absRoot, timeoutMs: 300_000 }
  );
}

/**
 * `git worktree remove --force <path>`. `--force` because we expect to nuke
 * worktrees on session teardown regardless of dirty state — the session is
 * gone, so the local edits inside its worktree go with it.
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  const absPath = path.resolve(worktreePath);
  // We can't cwd into the worktree we're removing, so run from the worktree's
  // parent. git figures out the repo root from the path argument.
  await runGit(['worktree', 'remove', '--force', absPath]);
}

export interface WorktreeListEntry {
  /** Absolute path. */
  path: string;
  /** Commit SHA the worktree currently points at. */
  head?: string;
  /** Short branch name (if attached). */
  branch?: string;
  /** true for the main working tree. */
  isMain?: boolean;
  /** Detached HEAD. */
  detached?: boolean;
}

/**
 * Parse `git worktree list --porcelain`. Porcelain output has blank-line
 * separated records; each record is key/value-ish lines.
 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeListEntry[]> {
  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
  });
  const entries: WorktreeListEntry[] = [];
  let cur: WorktreeListEntry | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      if (cur) {
        entries.push(cur);
        cur = null;
      }
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: path.resolve(line.slice('worktree '.length)) };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      // Porcelain uses full refname (`refs/heads/foo`); normalise to short.
      cur.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line === 'bare') {
      cur.isMain = true;
    } else if (line === 'detached') {
      cur.detached = true;
    }
  }
  if (cur) entries.push(cur);
  if (entries.length > 0) entries[0].isMain = true;
  return entries;
}

/**
 * `git worktree prune`. Best-effort — used during reconcile to clean up
 * metadata for worktrees whose directories were deleted out-of-band.
 */
export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await runGit(['worktree', 'prune'], { cwd: repoRoot });
}
