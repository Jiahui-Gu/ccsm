// Pure deciders for resolving Claude CLI JSONL transcript paths.
//
// Extracted from electron/ptyHost/index.ts (Task #729 Phase A) to enforce SRP:
// these functions take env + filesystem state in, return paths/booleans out.
// No side effects beyond fs reads (and the import-resume copy in
// `ensureResumeJsonlAtSpawnCwd`, which is the one intentional sink kept here
// because it's a thin wrapper around the path resolution).

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { createHash } from 'node:crypto';
import { cwdToProjectKey } from '../sessionWatcher/projectKey.js';

// Project an arbitrary ccsm sid onto a deterministic UUID v4 string so claude
// (which requires a valid UUID for --session-id / --resume) accepts it.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Defense-in-depth (#804 risk #6): the ccsm sid eventually lands in
// `pty.spawn(claudePath, [flag, claudeSid], …)` as a real argv slot. node-pty
// does NOT shell-interpret, but a sid like `--dangerous-flag` would be picked
// up by the CLI as a real flag. Constrain the input character set + length to
// the shape the renderer's `crypto.randomUUID()` (and the legacy
// `<prefix>-<random>` fallback) actually produce — alphanumerics, dashes, and
// underscores, 8-64 chars, AND require an alphanumeric first char so a sid
// starting with `-` cannot be smuggled into argv as a CLI flag.
const VALID_SID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,63}$/;

export function toClaudeSid(ccsmSessionId: string): string {
  if (typeof ccsmSessionId !== 'string' || !VALID_SID_RE.test(ccsmSessionId)) {
    throw new Error(`invalid sid: ${JSON.stringify(ccsmSessionId)}`);
  }
  if (UUID_V4_RE.test(ccsmSessionId)) return ccsmSessionId.toLowerCase();
  const hex = createHash('sha256').update(ccsmSessionId).digest('hex');
  const yNibble = (parseInt(hex[16]!, 16) & 0x3) | 0x8;
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${yNibble.toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

// Scan both possible JSONL roots (CLAUDE_CONFIG_DIR override + USERPROFILE
// default) for `<sid>.jsonl` with non-zero size. Mirrors the .cmd wrapper in
// cliBridge/processManager.ts, just expressed in Node. Non-zero size guards
// against the empty-file race where claude has created but not yet written
// the transcript. Returns the absolute path to the first matching file
// found (so callers can locate the SOURCE for the import-resume copy-into-
// place fix in `makeEntry`), or null when no transcript exists.
export function findJsonlForSid(sid: string): string | null {
  const filename = `${sid}.jsonl`;
  const roots: string[] = [];
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (cfg) roots.push(pathJoin(cfg, 'projects'));
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) roots.push(pathJoin(home, '.claude', 'projects'));

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const candidate = pathJoin(root, name, filename);
      try {
        const st = statSync(candidate);
        if (st.isFile() && st.size > 0) return candidate;
      } catch {
        /* not present in this project dir */
      }
    }
  }
  return null;
}

// Back-compat boolean wrapper.
export function jsonlExistsForSid(sid: string): boolean {
  return findJsonlForSid(sid) !== null;
}

// Resolve the absolute path the CLI will write the session JSONL to:
//   <root>/projects/<projectKey>/<claudeSid>.jsonl
// where `<root>` is `$CLAUDE_CONFIG_DIR` (if set) else `~/.claude`, and
// `<projectKey>` is `cwdToProjectKey(cwd)`. Returns null when we can't
// determine a usable root (no env, no $HOME / $USERPROFILE).
export function resolveJsonlPath(claudeSid: string, cwd: string): string | null {
  const projectKey = cwdToProjectKey(cwd);
  if (!projectKey) return null;
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const home = process.env.USERPROFILE || process.env.HOME;
  const root = cfg ? cfg : home ? pathJoin(home, '.claude') : null;
  if (!root) return null;
  return pathJoin(root, 'projects', projectKey, `${claudeSid}.jsonl`);
}

// Resolve the CLI's projects ROOT directory (parent of every projectDir).
export function resolveProjectsRoot(): string | null {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (cfg) return pathJoin(cfg, 'projects');
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) return pathJoin(home, '.claude', 'projects');
  return null;
}

export interface EnsureResumeJsonlResult {
  /** True when a copy actually happened on this call (source path differed
   *  from target AND target didn't already exist). False otherwise. */
  copied: boolean;
  /** The canonical target path under the spawn cwd's projectDir, even when
   *  no copy happened. Null when we couldn't resolve a projectsRoot or
   *  projectKey. */
  targetPath: string | null;
}

// Import-resume fix (#603). `claude --resume <sid>` only finds a session
// when the JSONL lives under the projectDir matching the CURRENT cwd's
// projectKey. When the source JSONL exists but isn't already under the spawn
// cwd's projectDir, copy it into place so `--resume` succeeds. Idempotent —
// once the destination exists with non-zero size we leave it alone.
export function ensureResumeJsonlAtSpawnCwd(
  claudeSid: string,
  spawnCwd: string,
  sourceJsonlPath: string,
): EnsureResumeJsonlResult {
  const projectsRoot = resolveProjectsRoot();
  if (!projectsRoot) return { copied: false, targetPath: null };
  const projectKey = cwdToProjectKey(spawnCwd);
  if (!projectKey) return { copied: false, targetPath: null };
  const targetPath = pathJoin(projectsRoot, projectKey, `${claudeSid}.jsonl`);
  if (targetPath === sourceJsonlPath) return { copied: false, targetPath };
  try {
    const st = statSync(targetPath);
    if (st.isFile() && st.size > 0) return { copied: false, targetPath };
  } catch {
    /* not present → fall through to copy */
  }
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourceJsonlPath, targetPath);
    return { copied: true, targetPath };
  } catch (err) {
    console.warn(
      `[ptyHost] failed to copy import JSONL ${JSON.stringify(sourceJsonlPath)} → ` +
        `${JSON.stringify(targetPath)} (${err instanceof Error ? err.message : String(err)}); ` +
        `claude --resume may report 'No conversation found'`,
    );
    return { copied: false, targetPath };
  }
}
